// The Platform API contract for Monitoring (openlakeforge #1127, #1259, ADR 0021): GET /api/v1/monitoring-capabilities,
// GET /api/v1/stages/{stage}/health and GET /api/v1/stages/{stage}/health/pipelines. Same-origin and
// cookie-authenticated, read-only. Types follow the committed OpenAPI document (docs/schema/platform-api.openapi.json:
// MonitoringCapabilities, StageHealth, ServiceHealth, IntegrationStatus, PipelinesHealth, PipelineHealth, HealthSignal, Run).
// shortcut: hand-written types; generate them from the OpenAPI spec.

import { ApiError } from "./query-api";

export { ApiError };

/** `HealthState` in openlakeforge_core.health: the five states of the `MON / Status badge`. */
export type HealthState = "healthy" | "warning" | "critical" | "unknown" | "disabled";
export type IntegrationName = "dagster" | "services" | "quality" | "quality-sync" | "metrics";
/** Whether a source of health is present. Never a health state: an absent source is not green. */
export type Integration = { name: IntegrationName; status: "available" | "disabled" | "unavailable" | "not_provided"; reason: string };
/** One probe's answer. `component` and `service` are the keys; `display_name` and `service_display_name` are for people. */
export type ServiceHealth = {
  component: string;
  display_name: string;
  service: string;
  service_display_name: string;
  source: string;
  state: HealthState;
  reason: string;
  observed_at: string | null;
  expires_at: string | null;
  max_age_seconds: number | null;
  /** The component's own evidence of its last success (`log-archive.newest-object`, `quality-sync.publication`); null when there is none. */
  last_success_at: string | null;
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

/** The stage-scoped monitoring routes (`MONITORING_OPERATIONS` in platform-api monitoring.py). */
export type MonitoringOperation =
  | "get_stage_health" | "get_stage_service_health" | "list_pipeline_health" | "get_stage_quality_health"
  | "list_logs" | "list_stage_metrics" | "get_stage_metric" | "list_alert_incidents";
export type SourceName = "dagster" | "services" | "quality" | "quality-sync" | "logs" | "metrics" | "alerts";
/** Whether a stage is configured with one source. Configuration only: `available` is not an answer, let alone a healthy one. */
export type MonitoringCapability = { name: SourceName; status: Integration["status"]; reason: string };
/** A stage the caller may monitor: the routes its role may call there, and the sources the stage has. */
export type MonitoringStage = { stage: string; operations: string[]; capabilities: MonitoringCapability[] };
export type MonitoringCapabilities = { stages: MonitoringStage[] };

function explain(status: number, stage: string, detail?: string): string {
  if (status === 0) return "The monitoring API isn’t answering, so nothing on this page can be shown as healthy.";
  if (status === 401) return "Your session has expired. Reload the page to sign in again.";
  if (status === 403) return detail || (stage ? `You have no monitoring access on stage ${stage.toUpperCase()}.` : "You have no monitoring access.");
  if (status === 404) return detail || `Stage ${stage.toUpperCase()} is not known to the Platform API.`;
  return `The monitoring API failed (${status}), so nothing on this page can be shown as healthy.`;
}

async function get(url: string, stage: string, signal?: AbortSignal): Promise<Json | undefined> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", signal });
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
  return isObject(body) ? body : undefined;
}

async function read(path: string, stage: string, signal?: AbortSignal): Promise<Json> {
  const body = await get(`/api/v1/stages/${encodeURIComponent(stage)}/${path}`, stage, signal);
  if (typeof body?.stage !== "string") throw new ApiError(200, explain(500, stage));
  return body;
}

/** What the caller may monitor, per stage. Built from the API's settings alone: it says nothing about health. */
export async function getMonitoringCapabilities(signal?: AbortSignal): Promise<MonitoringCapabilities> {
  const body = await get("/api/v1/monitoring-capabilities", "", signal);
  // A malformed answer offers nothing: the page reads Unknown with Retry, never a guessed set of panels.
  if (!isMonitoringCapabilities(body)) throw new ApiError(200, explain(500, ""));
  return body;
}

export async function getStageHealth(stage: string, signal?: AbortSignal): Promise<StageHealth> {
  const body = await read("health", stage, signal);
  // A 200 without a readable StageHealth, service rows included, is no evidence either.
  if (!isStageHealth(body)) throw new ApiError(200, explain(500, stage));
  return body;
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
const SOURCE_STATUS = new Set<unknown>(["available", "disabled", "unavailable", "not_provided"]);
const isIntegration = (v: unknown) => isObject(v) && isText(v.name) && SOURCE_STATUS.has(v.status) && isText(v.reason);
const isService = (v: unknown) =>
  isObject(v) && isText(v.component) && isText(v.display_name) && isText(v.service) && isText(v.service_display_name)
  && STATES.has(v.state) && isText(v.reason) && isTextOrNull(v.observed_at) && isTextOrNull(v.expires_at) && isTextOrNull(v.last_success_at);
const isMonitoringStage = (v: unknown) =>
  isObject(v) && isText(v.stage) && Array.isArray(v.operations) && v.operations.every(isText)
  && Array.isArray(v.capabilities) && v.capabilities.every(isIntegration);

export function isMonitoringCapabilities(body: unknown): body is MonitoringCapabilities {
  return isObject(body) && Array.isArray(body.stages) && body.stages.every(isMonitoringStage);
}

/** Whether `body` is a StageHealth with every nested field the page reads. */
export function isStageHealth(body: unknown): body is StageHealth {
  return isObject(body) && isText(body.stage) && STATES.has(body.state) && isText(body.evaluated_at)
    && Array.isArray(body.pipelines) && body.pipelines.every((p) => isObject(p) && isText(p.job) && STATES.has(p.state))
    && Array.isArray(body.services) && body.services.every(isService)
    && Array.isArray(body.integrations) && body.integrations.every(isIntegration);
}

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

/** Why a panel is not shown, or that it may be: its source must be configured and the role allowed its route. */
export type Gate = { open: true } | { open: false; state: "disabled" | "unknown"; reason: string };

/** Whether a panel may call `op` for `source` on this stage. A route the role lacks is never called. */
export function gate(access: MonitoringStage, source: SourceName, op: MonitoringOperation, what: string): Gate {
  if (!access.operations.includes(op)) return { open: false, state: "disabled", reason: `Your role may not read ${what} on stage ${access.stage.toUpperCase()}.` };
  const c = access.capabilities.find((x) => x.name === source);
  if (!c) return { open: false, state: "unknown", reason: `The API did not say whether ${what} is configured on this stage.` };
  if (c.status === "available") return { open: true };
  // `unavailable` is configured but missing a piece (a key, the probes): a gap, not a choice.
  return { open: false, state: c.status === "unavailable" ? "unknown" : "disabled", reason: c.reason };
}
