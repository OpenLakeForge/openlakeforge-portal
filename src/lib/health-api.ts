// The Platform API contract for Monitoring (openlakeforge #1127, ADR 0021): GET /api/v1/stages/{stage}/health and
// GET /api/v1/stages/{stage}/health/pipelines. Same-origin and cookie-authenticated, read-only. Types follow the
// committed OpenAPI document (docs/schema/platform-api.openapi.json: StageHealth, ServiceHealth, IntegrationStatus,
// PipelinesHealth, PipelineHealth, HealthSignal, Run).
// shortcut: hand-written types; generate them from the OpenAPI spec.

import { ApiError } from "./query-api";

export { ApiError };

/** `HealthState` in openlakeforge_core.health: the five states of the `MON / Status badge`. */
export type HealthState = "healthy" | "warning" | "critical" | "unknown" | "disabled";
export type IntegrationName = "dagster" | "services" | "quality" | "metrics";
/** Whether a source of health is present. Never a health state: an absent source is not green. */
export type Integration = { name: IntegrationName; status: "available" | "disabled" | "unavailable" | "not_provided"; reason: string };
export type ServiceHealth = {
  component: string;
  source: string;
  state: HealthState;
  reason: string;
  observed_at: string | null;
  expires_at: string | null;
  max_age_seconds: number | null;
};
export type StageHealth = {
  stage: string;
  state: HealthState;
  evaluated_at: string;
  pipelines: { job: string; state: HealthState }[];
  services: ServiceHealth[];
  integrations: Integration[];
};

/** A Dagster run as the API reports it. Times are Unix seconds; `status` is Dagster's own word (`FAILURE`, …). */
export type Run = {
  run_id: string;
  job_name: string;
  status: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  tags: Record<string, string>;
};
export type SignalKind = "execution" | "latest_success" | "expected_run" | "freshness" | "quality" | "service";
/** One rule's verdict on one pipeline (`openlakeforge_core.health`); `reason` is the rule's own words. */
export type HealthSignal = {
  kind: SignalKind;
  state: HealthState;
  reason: string;
  run: string | null;
  observed_at: string | null;
  expires_at: string | null;
};
export type PipelineHealth = {
  job: string;
  state: HealthState;
  latest_run: Run | null;
  last_success: Run | null;
  /** Failed runs among the `thresholds.run_window` most recent. A missed run is the `expected_run` signal. */
  failed_runs: number;
  schedule: { name: string | null; status: "running" | "stopped" | "absent"; last_expected_at: string | null };
  freshness: { last_success_at: string | null; age_seconds: number | null };
  signals: HealthSignal[];
};
export type PipelinesHealth = {
  stage: string;
  evaluated_at: string;
  thresholds: { run_max_age_seconds: number; schedule_max_age_seconds: number; schedule_grace_seconds: number; run_window: number };
  integrations: Integration[];
  pipelines: PipelineHealth[];
};

function explain(status: number, stage: string, detail?: string): string {
  if (status === 0) return "The monitoring API isn’t answering, so nothing on this page can be shown as healthy.";
  if (status === 401) return "Your session has expired. Reload the page to sign in again.";
  if (status === 403) return detail || `You have no monitoring access on stage ${stage.toUpperCase()}.`;
  if (status === 404) return detail || `Stage ${stage.toUpperCase()} is not known to the Platform API.`;
  return `The monitoring API failed (${status}), so nothing on this page can be shown as healthy.`;
}

async function read(path: string, stage: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/stages/${encodeURIComponent(stage)}/${path}`, { credentials: "same-origin", signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError(0, explain(0, stage));
  }
  // A cancelled read is cancelled, not an empty answer: rethrow it so the caller drops the result.
  const body = await res.json().catch((e) => {
    if (signal?.aborted || (e as Error)?.name === "AbortError") throw e;
    return undefined;
  });
  const detail = typeof body?.detail === "string" ? body.detail : undefined;
  if (!res.ok) throw new ApiError(res.status, explain(res.status, stage, detail));
  if (typeof body?.stage !== "string") throw new ApiError(res.status, explain(500, stage));
  return body;
}

export async function getStageHealth(stage: string, signal?: AbortSignal): Promise<StageHealth> {
  const body = await read("health", stage, signal);
  // A 200 without a readable StageHealth is no evidence either.
  if (typeof body.state !== "string") throw new ApiError(200, explain(500, stage));
  return body as StageHealth;
}

/** Each pipeline's latest run, last success, failed runs, schedule and signals. A stage without Dagster is a 404. */
export async function getPipelinesHealth(stage: string, signal?: AbortSignal): Promise<PipelinesHealth> {
  const body = await read("health/pipelines", stage, signal);
  // Every field the page renders is checked here: a malformed 200 is a failed pipelines read (Unknown, Retry), never
  // a crash of the whole view and never a partial answer.
  if (!isPipelinesHealth(body)) throw new ApiError(200, explain(500, stage));
  return body;
}

type Json = Record<string, unknown>;
const STATES = new Set<unknown>(["healthy", "warning", "critical", "unknown", "disabled"]);
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown) => typeof v === "string";
const isTextOrNull = (v: unknown) => v === null || typeof v === "string";
const isNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isNumberOrNull = (v: unknown) => v === null || isNumber(v);
const isRunOrNull = (v: unknown) =>
  v === null || (isObject(v) && isText(v.run_id) && isText(v.status) && isNumber(v.created_at) && isNumberOrNull(v.started_at) && isNumberOrNull(v.ended_at));
const isSignal = (v: unknown) =>
  isObject(v) && isText(v.kind) && STATES.has(v.state) && isText(v.reason) && isTextOrNull(v.run) && isTextOrNull(v.observed_at) && isTextOrNull(v.expires_at);
const isPipeline = (v: unknown) =>
  isObject(v) && isText(v.job) && STATES.has(v.state) && isNumber(v.failed_runs) && isRunOrNull(v.latest_run) && isRunOrNull(v.last_success)
  && isObject(v.schedule) && ["running", "stopped", "absent"].includes(v.schedule.status as string) && isTextOrNull(v.schedule.name) && isTextOrNull(v.schedule.last_expected_at)
  && isObject(v.freshness) && isTextOrNull(v.freshness.last_success_at) && isNumberOrNull(v.freshness.age_seconds)
  && Array.isArray(v.signals) && v.signals.every(isSignal);
const isIntegration = (v: unknown) => isObject(v) && isText(v.name) && isText(v.status) && isText(v.reason);

/** Whether `body` is a PipelinesHealth with every nested field the page reads. */
export function isPipelinesHealth(body: unknown): body is PipelinesHealth {
  return isObject(body) && isText(body.stage) && isText(body.evaluated_at)
    && isObject(body.thresholds) && isNumber(body.thresholds.run_window)
    && Array.isArray(body.integrations) && body.integrations.every(isIntegration)
    && Array.isArray(body.pipelines) && body.pipelines.every(isPipeline);
}

const SEVERITY: Record<HealthState, number> = { disabled: 0, healthy: 1, unknown: 2, warning: 3, critical: 4 };
/** The worst state, as `rollup` ranks them: unknown outranks healthy, so a gap is never hidden by a green neighbour. */
export const worst = (states: HealthState[]): HealthState =>
  states.reduce<HealthState>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "disabled");

/** A healthy answer past its expiry is no longer evidence: it reads unknown, never green. */
export function effective(s: { state: HealthState; expires_at: string | null }, now: number): HealthState {
  return s.state === "healthy" && s.expires_at && Date.parse(s.expires_at) < now ? "unknown" : s.state;
}
