// The Platform API contract for Monitoring (openlakeforge #1127, #1259, ADR 0021): GET /api/v1/monitoring-capabilities,
// GET /api/v1/stages/{stage}/health and GET /api/v1/stages/{stage}/health/pipelines, and for one run (#1271)
// GET /api/v1/stages/{stage}/runs/{run_id}, GET /api/v1/stages/{stage}/runs/{run_id}/failure and the run's lines from
// GET /api/v1/stages/{stage}/logs; a run's quality and log window (#1325, #1326) beside them. Same-origin and
// cookie-authenticated, read-only. Types follow the committed OpenAPI document (docs/schema/platform-api.openapi.json:
// MonitoringCapabilities, StageHealth, ServiceHealth, IntegrationStatus, PipelinesHealth, PipelineHealth, HealthSignal, Run,
// RunFailure, FailedStep, RunRows, Logs, LogLine, AlertIncident). Metrics (#21, #1268, #1269, ADR 0024): GET /api/v1/stages/{stage}/metrics,
// GET /api/v1/stages/{stage}/metrics/{series}?range= and GET /api/v1/platform/metrics/{series}?range= (MetricCatalog,
// MetricSeriesInfo, MetricSeriesData, MetricLine).
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
/** The range the health routes' counts cover, ending now (openlakeforge#1319). */
export type HealthRange = "1h" | "6h" | "24h" | "7d";
/** The span the counts cover: runs created after `from`, up to `to`. `covered_from` is set when the API's bounded
 * Dagster read stopped short of `from`: the counts then start there, never at the window's start. A state and its
 * signals are never windowed. */
export type HealthWindow = { range: string; from: string; to: string; covered_from: string | null };
export type StageHealth = {
  stage: string;
  state: HealthState;
  evaluated_at: string;
  /** Null from an API before openlakeforge#1319, which counts no window. */
  window?: HealthWindow | null;
  /** Failed runs over every pipeline in the window; null when any count could not be read, never 0. */
  failed_runs?: number | null;
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
  /** The occurrence an `expected_run` signal judged (#1273); null on every other kind and when none was expected. */
  due: string | null;
};
export type PipelineHealth = {
  job: string;
  /** The job's domain and data product from its definition's tags (#1272); null for a job of no product. */
  domain: string | null;
  product: string | null;
  state: HealthState;
  latest_run: Run | null;
  last_success: Run | null;
  /** Failed runs created in the window (openlakeforge#1319), or, from an older API with no `window`, among the
   * `thresholds.run_window` most recent. Null when the count could not be read, never 0. A missed run is the
   * `expected_run` signal. */
  failed_runs: number | null;
  /** Set when this job's bounded read did not reach back to the window's start: `failed_runs` counts from here on. */
  covered_from: string | null;
  schedule: { name: string | null; status: "running" | "stopped" | "absent"; last_expected_at: string | null };
  freshness: { last_success_at: string | null; age_seconds: number | null };
  signals: HealthSignal[];
};
export type PipelinesHealth = {
  stage: string;
  evaluated_at: string;
  /** Null from an API before openlakeforge#1319: its counts are over the last `thresholds.run_window` runs. */
  window: HealthWindow | null;
  /** Failed runs over every pipeline in the window; null when any count could not be read, never 0. */
  failed_runs: number | null;
  thresholds: { run_max_age_seconds: number; schedule_max_age_seconds: number; schedule_grace_seconds: number; run_window: number };
  integrations: Integration[];
  pipelines: PipelineHealth[];
};

/** The stage-scoped monitoring routes (`MONITORING_OPERATIONS` in platform-api monitoring.py). */
export type MonitoringOperation =
  | "get_stage_health" | "get_stage_service_health" | "list_pipeline_health" | "get_stage_quality_health"
  | "list_logs" | "list_stage_metrics" | "get_stage_metric" | "list_alert_incidents"
  // One run's reads (#1324, #1325). `list_run_logs` and `get_run_quality_report` are not listed: they share `list_logs`'s row.
  | "get_run" | "get_run_failure" | "get_run_quality";
export type SourceName = "dagster" | "services" | "quality" | "quality-sync" | "logs" | "metrics" | "alerts";
/** Whether a stage is configured with one source. Configuration only: `available` is not an answer, let alone a healthy one. */
export type MonitoringCapability = { name: SourceName; status: Integration["status"]; reason: string };
/** A stage the caller may monitor: the routes its role may call there, and the sources the stage has. */
export type MonitoringStage = {
  stage: string;
  operations: string[];
  capabilities: MonitoringCapability[];
  /** How many days the stage's log archive keeps lines (#1328); null with no archive or no retention applied. Absent
   * (undefined) only from an API before #1324/#1328, which did not list `get_run` and `get_run_failure` either. */
  log_retention_days?: number | null;
};
export type MonitoringCapabilities = { stages: MonitoringStage[] };

function explain(status: number, stage: string, detail?: string): string {
  if (status === 0) return "The monitoring API isn’t answering, so nothing on this page can be shown as healthy.";
  if (status === 401) return "Your session has expired. Reload the page to sign in again.";
  if (status === 403) return detail || (stage ? `You have no monitoring access on stage ${stage.toUpperCase()}.` : "You have no monitoring access.");
  // A refused range (past the metrics retention) is a 400 whose detail says why.
  if (status === 400 && detail) return detail;
  if (status === 404) return detail || `Stage ${stage.toUpperCase()} is not known to the Platform API.`;
  return `The monitoring API failed (${status}), so nothing on this page can be shown as healthy.`;
}

async function get(url: string, stage: string, signal?: AbortSignal, notFound?: string): Promise<Json | undefined> {
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
  if (!res.ok) throw new ApiError(res.status, explain(res.status, stage, detail ?? (res.status === 404 ? notFound : undefined)));
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
  // `due`, `domain` and `product` are additive (#1272, #1273): an API from before them answers none, which is null.
  // `window`, `failed_runs` (stage) and `covered_from` are additive too (#1319): absent is an older API, read as null.
  return {
    ...body,
    window: body.window ?? null,
    failed_runs: body.failed_runs ?? null,
    pipelines: body.pipelines.map((p) => ({
      ...p, domain: p.domain ?? null, product: p.product ?? null, covered_from: p.covered_from ?? null,
      signals: p.signals.map((s) => ({ ...s, due: s.due ?? null })),
    })),
  };
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
/** An additive field: absent (an older API) or the given shape. The reader turns absent into null. */
const isOptional = (check: (v: unknown) => boolean) => (v: unknown) => v === undefined || check(v);
const isSignal = (v: unknown) =>
  isObject(v) && isText(v.kind) && STATES.has(v.state) && isText(v.reason) && isTextOrNull(v.run) && isTextOrNull(v.observed_at) && isTextOrNull(v.expires_at)
  && isOptional(isTextOrNull)(v.due);
const isPipeline = (v: unknown) =>
  isObject(v) && isText(v.job) && isOptional(isTextOrNull)(v.domain) && isOptional(isTextOrNull)(v.product) && STATES.has(v.state) && isNumberOrNull(v.failed_runs) && isOptional(isTextOrNull)(v.covered_from) && isRunOrNull(v.latest_run) && isRunOrNull(v.last_success)
  && isObject(v.schedule) && ["running", "stopped", "absent"].includes(v.schedule.status as string) && isTextOrNull(v.schedule.name) && isTextOrNull(v.schedule.last_expected_at)
  && isObject(v.freshness) && isTextOrNull(v.freshness.last_success_at) && isNumberOrNull(v.freshness.age_seconds)
  && Array.isArray(v.signals) && v.signals.every(isSignal);
const isWindow = (v: unknown) => isObject(v) && isText(v.range) && isText(v.from) && isText(v.to) && isTextOrNull(v.covered_from);
/** A window, or none: omitted (an API before #1319) and null both read as no window, so counts keep the run-window wording. */
const isWindowOrNull = (v: unknown) => v === null || isWindow(v);
const SOURCE_STATUS = new Set<unknown>(["available", "disabled", "unavailable", "not_provided"]);
const isIntegration = (v: unknown) => isObject(v) && isText(v.name) && SOURCE_STATUS.has(v.status) && isText(v.reason);
const isService = (v: unknown) =>
  isObject(v) && isText(v.component) && isText(v.display_name) && isText(v.service) && isText(v.service_display_name)
  && STATES.has(v.state) && isText(v.reason) && isTextOrNull(v.observed_at) && isTextOrNull(v.expires_at) && isTextOrNull(v.last_success_at);
const isMonitoringStage = (v: unknown) =>
  isObject(v) && isText(v.stage) && Array.isArray(v.operations) && v.operations.every(isText)
  && Array.isArray(v.capabilities) && v.capabilities.every(isIntegration)
  && isOptional((d) => d === null || (Number.isInteger(d) && (d as number) >= 0))(v.log_retention_days);

export function isMonitoringCapabilities(body: unknown): body is MonitoringCapabilities {
  return isObject(body) && Array.isArray(body.stages) && body.stages.every(isMonitoringStage);
}

/** Whether `body` is a StageHealth with every nested field the page reads. */
export function isStageHealth(body: unknown): body is StageHealth {
  return isObject(body) && isText(body.stage) && STATES.has(body.state) && isText(body.evaluated_at)
    && isOptional(isWindowOrNull)(body.window) && isOptional(isNumberOrNull)(body.failed_runs)
    && Array.isArray(body.pipelines) && body.pipelines.every((p) => isObject(p) && isText(p.job) && STATES.has(p.state) && isOptional(isNumberOrNull)(p.failed_runs))
    && Array.isArray(body.services) && body.services.every(isService)
    && Array.isArray(body.integrations) && body.integrations.every(isIntegration);
}

/** Whether `body` is a PipelinesHealth with every nested field the page reads. */
export function isPipelinesHealth(body: unknown): body is PipelinesHealth {
  return isObject(body) && isText(body.stage) && isText(body.evaluated_at)
    && isObject(body.thresholds) && isNumber(body.thresholds.run_window)
    && isOptional(isWindowOrNull)(body.window) && isOptional(isNumberOrNull)(body.failed_runs)
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

// ── Quality counts (#1257) and alert incidents (#1258) ──────────────────────────────────────────────────

/** Results of one quality manifest, or a sum of them, by outcome. `blocking` sits beside `error`, not inside it. */
export type QualityCounts = { passed: number; warn: number; error: number; not_run: number; unknown: number; blocking: number };
/** The manifest behind one pipeline's quality signal. `counts: null` is no manifest (unknown), never zero checks. */
export type PipelineQuality = {
  job: string;
  domain: string | null;
  /** Null for a job of no product, or one deployed before the product tag (#1272). */
  product: string | null;
  run_id: string | null;
  observed_at: string | null;
  complete: boolean | null;
  state: HealthState;
  counts: QualityCounts | null;
  reason: string;
};
export type StageQualityHealth = { stage: string; evaluated_at: string; integrations: Integration[]; totals: QualityCounts | null; pipelines: PipelineQuality[] };

export type DeliveryStatus = "pending" | "delivered" | "undeliverable" | "unrouted" | "unknown";
/** The incident's latest notification: queued, or how it left the outbox. Counts only, never a receiver. */
export type AlertDelivery = {
  status: DeliveryStatus;
  event: "opened" | "escalated" | "resolved" | null;
  attempts: number | null;
  receivers: number | null;
  delivered: number | null;
};
export type AlertIncident = {
  id: string;
  condition: string;
  severity: "warning" | "critical";
  /** The Dagster job the incident is scoped to (#1272); null for a service incident. */
  job: string | null;
  /** The job's domain and product, null when the job has none or Dagster could not be read. */
  domain: string | null;
  product: string | null;
  table: string | null;
  component: string | null;
  opened_at: string;
  last_seen_at: string;
  summary: string;
  run_ids: string[];
  delivery: AlertDelivery;
};
/** `incidents: null` is "could not be read", never "none open"; `stale` says the evaluator has stopped running. */
export type StageAlertIncidents = {
  stage: string;
  state: { status: "available" | "unavailable" | "not_provided"; reason: string; evaluated_at: string | null; stale: boolean | null };
  incidents: AlertIncident[] | null;
};

const COUNTS = ["passed", "warn", "error", "not_run", "unknown", "blocking"] as const;
const isCounts = (v: unknown) => isObject(v) && COUNTS.every((k) => Number.isInteger(v[k]) && (v[k] as number) >= 0);
const isCountsOrNull = (v: unknown) => v === null || isCounts(v);
const isPipelineQuality = (v: unknown) =>
  isObject(v) && isText(v.job) && isTextOrNull(v.domain) && isTextOrNull(v.product) && isTextOrNull(v.run_id) && isTextOrNull(v.observed_at)
  && (v.complete === null || typeof v.complete === "boolean") && STATES.has(v.state) && isCountsOrNull(v.counts) && isText(v.reason);
const DELIVERY = new Set<unknown>(["pending", "delivered", "undeliverable", "unrouted", "unknown"]);
const isDelivery = (v: unknown) =>
  isObject(v) && DELIVERY.has(v.status) && (v.event === null || ["opened", "escalated", "resolved"].includes(v.event as string))
  && isNumberOrNull(v.attempts) && isNumberOrNull(v.receivers) && isNumberOrNull(v.delivered);
const isIncident = (v: unknown) =>
  isObject(v) && isText(v.id) && isText(v.condition) && (v.severity === "warning" || v.severity === "critical")
  && isOptional(isTextOrNull)(v.job) && isTextOrNull(v.domain) && isTextOrNull(v.product) && isTextOrNull(v.table) && isTextOrNull(v.component)
  && isText(v.opened_at) && isText(v.last_seen_at) && isText(v.summary) && Array.isArray(v.run_ids) && v.run_ids.every(isText) && isDelivery(v.delivery);

export function isStageQualityHealth(body: unknown): body is StageQualityHealth {
  return isObject(body) && isText(body.stage) && isText(body.evaluated_at)
    && Array.isArray(body.integrations) && body.integrations.every(isIntegration)
    && isCountsOrNull(body.totals) && Array.isArray(body.pipelines) && body.pipelines.every(isPipelineQuality);
}

export function isStageAlertIncidents(body: unknown): body is StageAlertIncidents {
  const s = isObject(body) ? body.state : undefined;
  return isObject(body) && isText(body.stage)
    && isObject(s) && ["available", "unavailable", "not_provided"].includes(s.status as string) && isText(s.reason)
    && isTextOrNull(s.evaluated_at) && (s.stale === null || typeof s.stale === "boolean")
    && (body.incidents === null || (Array.isArray(body.incidents) && body.incidents.every(isIncident)));
}

/** Each pipeline's quality outcome counts and their sum. A stage without Dagster is a 404. */
export async function getQualityHealth(stage: string, signal?: AbortSignal): Promise<StageQualityHealth> {
  const body = await read("health/quality", stage, signal);
  if (!isStageQualityHealth(body)) throw new ApiError(200, explain(500, stage));
  return body;
}

/** The stage's open incidents and their latest notification's delivery. There is no acknowledgement, by decision. */
export async function getAlertIncidents(stage: string, signal?: AbortSignal): Promise<StageAlertIncidents> {
  const body = await read("alerts/incidents", stage, signal);
  if (!isStageAlertIncidents(body)) throw new ApiError(200, explain(500, stage));
  return { ...body, incidents: body.incidents && body.incidents.map((i) => ({ ...i, job: i.job ?? null })) };
}

// ── One run: its failure summary (#1271), its times and its archived lines ──────────────────────────────────

/** One failed step: its Dagster step key and the first line of its innermost cause, redacted and bounded. */
export type FailedStep = { step: string; error_class: string | null; message: string; message_truncated: boolean };
/** Rows Floe rejected and accepted in the run, from its quality manifest; `complete: false` means partial sums. */
export type RunRows = { rejected: number; accepted: number; complete: boolean };
/** What went wrong in one run. `steps: null` is an unreadable event log, never "no step failed"; `rows: null` is no
 * readable manifest, never zero rows. `sources` says why either is missing. */
export type RunFailure = {
  run_id: string;
  job: string;
  /** The job's domain and data product from its definition's tags (#1327); null for a job of none, or an older API. */
  domain: string | null;
  product: string | null;
  status: string;
  steps: FailedStep[] | null;
  run_message: string | null;
  steps_truncated: boolean;
  rows: RunRows | null;
  sources: Integration[];
};
/** One archived pod log line. `line` is null when the record could not be parsed, and `error` then says why. */
export type LogLine = {
  archived_at: string;
  namespace: string;
  pod: string;
  container: string;
  line: string | null;
  error: string | null;
  component?: string | null;
  /** The data product a v2 record names (portal#39); null or absent on v1 and on a workload of no product. */
  product?: string | null;
  run_id?: string | null;
  /** The line's own event time and level, as the collector parsed them (#1326); null when it recorded none, never guessed. */
  timestamp?: string | null;
  level?: LogLevel | null;
};
export type Logs = { lines: LogLine[]; truncated: boolean };
/** A line's level, and the floor a `severity` filter sets (#1326). */
export type LogLevel = "debug" | "info" | "warning" | "error" | "critical";
export type LogSeverity = LogLevel;

const isFailedStep = (v: unknown) =>
  isObject(v) && isText(v.step) && isTextOrNull(v.error_class) && isText(v.message) && typeof v.message_truncated === "boolean";
const isRows = (v: unknown) =>
  isObject(v) && Number.isInteger(v.rejected) && Number.isInteger(v.accepted) && typeof v.complete === "boolean";
const LEVELS = new Set<unknown>(["debug", "info", "warning", "error", "critical"]);
const isLogLine = (v: unknown) =>
  isObject(v) && isText(v.archived_at) && isText(v.namespace) && isText(v.pod) && isText(v.container) && isTextOrNull(v.line) && isTextOrNull(v.error)
  && isOptional(isTextOrNull)(v.timestamp) && isOptional((l) => l === null || LEVELS.has(l))(v.level);
/** `timestamp` and `level` are additive (#1326): an API from before them answers none, which is null. */
const withLevel = (l: LogLine): LogLine => ({ ...l, timestamp: l.timestamp ?? null, level: l.level ?? null });

export function isRunFailure(body: unknown): body is RunFailure {
  return isObject(body) && isText(body.run_id) && isText(body.job) && isText(body.status)
    && isOptional(isTextOrNull)(body.domain) && isOptional(isTextOrNull)(body.product)
    && (body.steps === null || (Array.isArray(body.steps) && body.steps.every(isFailedStep)))
    && isTextOrNull(body.run_message) && typeof body.steps_truncated === "boolean"
    && (body.rows === null || isRows(body.rows))
    && Array.isArray(body.sources) && body.sources.every(isIntegration);
}

export function isRun(body: unknown): body is Run {
  return isRunOrNull(body) && body !== null && isText((body as Json).job_name);
}

export function isLogs(body: unknown): body is Logs {
  return isObject(body) && Array.isArray(body.lines) && body.lines.every(isLogLine) && typeof body.truncated === "boolean";
}

const runPath = (stage: string, runId: string) => `/api/v1/stages/${encodeURIComponent(stage)}/runs/${encodeURIComponent(runId)}`;

/** The run's failed steps, its own failure message and its rejected rows. 404 when the stage has no such run. */
export async function getRunFailure(stage: string, runId: string, signal?: AbortSignal): Promise<RunFailure> {
  const body = await get(`${runPath(stage, runId)}/failure`, stage, signal, `Run ${runId} is not known on stage ${stage.toUpperCase()}.`);
  if (!isRunFailure(body)) throw new ApiError(200, explain(500, stage));
  // `domain` and `product` are additive (#1327): an API from before them answers none, which is null.
  return { ...body, domain: body.domain ?? null, product: body.product ?? null };
}

/** The run as Dagster reports it: its status and times. */
export async function getRun(stage: string, runId: string, signal?: AbortSignal): Promise<Run> {
  const body = await get(runPath(stage, runId), stage, signal, `Run ${runId} is not known on stage ${stage.toUpperCase()}.`);
  if (!isRun(body)) throw new ApiError(200, explain(500, stage));
  return body;
}

// ── One run's quality checks and reports (#1325) and the lines of its window (#1326) ──────────────────────────
// GET /api/v1/stages/{stage}/runs/{run_id}/quality (RunQuality, QualityCheck, QualityReport) and
// GET /api/v1/stages/{stage}/runs/{run_id}/logs (RunLogs). Both read what the run left; nothing is re-run or inferred.

export type QualityOutcome = "passed" | "warn" | "error" | "not_run" | "unknown";
/** What the pipeline did with the check's result: a `blocked` error is the blocking one. */
export type PipelineOutcome = "continued" | "quarantined" | "blocked" | "unknown";
/** One check result of the run's quality manifest, as the engine adapter recorded it: aggregates only, never a row.
 * A count the engine did not record is null, never 0. */
export type QualityCheck = {
  engine: string;
  check_id: string;
  table: string | null;
  column: string | null;
  /** The engine's own word for the check's severity (dbt `warn`/`error`, Floe's policy), shown as given. */
  engine_severity: string;
  outcome: QualityOutcome;
  pipeline_outcome: PipelineOutcome;
  observed_at: string;
  rows: number | null;
  accepted_rows: number | null;
  rejected_rows: number | null;
  violations: number | null;
  failures: number | null;
  report_id: string | null;
};
/** A report the run retained: a Floe entity's run report, or dbt's run results (`table: null`). `href` is a same-origin
 * download, null when the caller may not download it or the API holds no key to read it. */
export type QualityReport = { id: string; engine: string; table: string | null; href: string | null };
/** `checks: null` and `counts: null` are "no usable manifest" (`sources` says why), never no checks or passes.
 * `complete: false` is a manifest the run did not finish. `runbook` is the runbook's web address the signal catalog
 * names for the run's failure, or null when it names none. */
export type RunQuality = {
  run_id: string;
  job: string;
  status: string;
  complete: boolean | null;
  counts: QualityCounts | null;
  checks: QualityCheck[] | null;
  reports: QualityReport[];
  runbook: string | null;
  sources: Integration[];
};
/** The archived lines of the run's window, `since` to `until`, oldest first. `truncated` with `next`: pass `next` back
 * as `after`, with the same filters, to read on. */
export type RunLogs = { lines: LogLine[]; truncated: boolean; since: string; until: string; next: string | null };
export type RunLogsQuery = {
  severity?: LogSeverity; matchRun?: boolean; after?: string; limit?: number;
  /** list_logs's filters, which the run window takes too (portal#39); `since`/`until` narrow the window, never widen it. */
  pod?: string; container?: string; component?: string; since?: string; until?: string;
};

const OUTCOMES = new Set<unknown>(["passed", "warn", "error", "not_run", "unknown"]);
const PIPELINE_OUTCOMES = new Set<unknown>(["continued", "quarantined", "blocked", "unknown"]);
const isCount = (v: unknown) => v === null || (Number.isInteger(v) && (v as number) >= 0);
/** Only a path on this origin is a download link: the report streams through the API, never from elsewhere. */
const isSameOriginPath = (v: unknown) => typeof v === "string" && v.startsWith("/") && !v.startsWith("//") && !v.includes("\\");
const isQualityCheck = (v: unknown) =>
  isObject(v) && isText(v.engine) && isText(v.check_id) && isTextOrNull(v.table) && isTextOrNull(v.column) && isText(v.engine_severity)
  && OUTCOMES.has(v.outcome) && PIPELINE_OUTCOMES.has(v.pipeline_outcome) && isText(v.observed_at)
  && isCount(v.rows) && isCount(v.accepted_rows) && isCount(v.rejected_rows) && isCount(v.violations) && isCount(v.failures)
  && isTextOrNull(v.report_id);
const isQualityReport = (v: unknown) =>
  isObject(v) && isText(v.id) && isText(v.engine) && isTextOrNull(v.table) && (v.href === null || isSameOriginPath(v.href));

export function isRunQuality(body: unknown): body is RunQuality {
  return isObject(body) && isText(body.run_id) && isText(body.job) && isText(body.status)
    && (body.complete === null || typeof body.complete === "boolean") && isCountsOrNull(body.counts)
    && (body.checks === null || (Array.isArray(body.checks) && body.checks.every(isQualityCheck)))
    && Array.isArray(body.reports) && body.reports.every(isQualityReport)
    && isTextOrNull(body.runbook) && Array.isArray(body.sources) && body.sources.every(isIntegration);
}

export function isRunLogs(body: unknown): body is RunLogs {
  return isLogs(body) && isText((body as Json).since) && isText((body as Json).until) && isOptional(isTextOrNull)((body as Json).next);
}

/** Every check of the run's quality manifest, its outcome counts and the reports it retained. */
export async function getRunQuality(stage: string, runId: string, signal?: AbortSignal): Promise<RunQuality> {
  const body = await get(`${runPath(stage, runId)}/quality`, stage, signal, `Run ${runId} is not known on stage ${stage.toUpperCase()}.`);
  if (!isRunQuality(body)) throw new ApiError(200, explain(500, stage));
  return body;
}

/** At most `limit` archived lines of the run's start-to-end window, across UTC days, from `severity` up. */
export async function listRunLogs(stage: string, runId: string, opts: RunLogsQuery = {}, signal?: AbortSignal): Promise<RunLogs> {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 200) });
  if (opts.severity) q.set("severity", opts.severity);
  if (opts.matchRun) q.set("match_run", "true");
  if (opts.after) q.set("after", opts.after);
  for (const k of ["pod", "container", "component", "since", "until"] as const) if (opts[k]) q.set(k, opts[k]!);
  const body = await get(`${runPath(stage, runId)}/logs?${q}`, stage, signal, `Run ${runId} is not known on stage ${stage.toUpperCase()}.`);
  if (!isRunLogs(body)) throw new ApiError(200, explain(500, stage));
  return { ...body, next: body.next ?? null, lines: body.lines.map((l) => ({ ...l, timestamp: l.timestamp ?? null, level: l.level ?? null })) };
}

/** Whether the run screen may call one of a run's own reads. An API from before #1324 lists none of them (it sends no
 * `log_retention_days` either): there `get_run` and `get_run_failure` are asked and a 403 is shown in the API's words,
 * and `get_run_quality` does not exist. */
export function runGate(access: MonitoringStage, op: "get_run" | "get_run_failure" | "get_run_quality", what: string): Gate {
  const older = access.log_retention_days === undefined;
  if (op === "get_run_quality") {
    if (older) return { open: false, state: "unknown", reason: "This Platform API does not serve a run's quality checks yet." };
    return gate(access, "quality", op, what);
  }
  if (older || access.operations.includes(op)) return { open: true };
  return { open: false, state: "disabled", reason: `Your role may not read ${what} on stage ${access.stage.toUpperCase()}.` };
}

/** At most `limit` archived lines of one run on one UTC day (`YYYY-MM-DD`), oldest first, from `severity` up. */
export async function getRunLogs(
  stage: string, runId: string, date: string, opts: { severity?: LogSeverity; limit?: number } = {}, signal?: AbortSignal,
): Promise<Logs> {
  const q = new URLSearchParams({ date, run_id: runId, limit: String(opts.limit ?? 200) });
  if (opts.severity) q.set("severity", opts.severity);
  const body = await get(`/api/v1/stages/${encodeURIComponent(stage)}/logs?${q}`, stage, signal);
  if (!isLogs(body)) throw new ApiError(200, explain(500, stage));
  return body;
}

// ── Metrics (ADR 0024, decision 4): named series over a fixed range, never a query ─────────────────────────

/** One of the catalog's ranges, the same vocabulary as the health routes' window. */
export type MetricRange = HealthRange;
export const METRIC_RANGES: readonly MetricRange[] = ["1h", "6h", "24h", "7d"];
/** `disabled`: the profile turns metrics off; `not_provided`: the provider has none; `unavailable`: the backend did not
 * answer, or holds no samples for the range. Never a line of zeros. */
export type MetricState = "available" | "disabled" | "unavailable" | "not_provided";
/** One catalog entry: a series the API serves for the stage, the ranges this deployment keeps for it, and whether its
 * source answers now. */
export type MetricSeriesInfo = {
  name: string;
  unit: string;
  source: "prometheus" | "dagster";
  labels: string[];
  ranges: MetricRange[];
  state: MetricState;
  reason: string;
};
export type MetricCatalog = { stage: string; observed_at: string; series: MetricSeriesInfo[] };
/** One [time, value] pair per step, oldest first; a step without a sample is null, never 0. */
export type MetricLine = { labels: Record<string, string>; points: [string, number | null][] };
export type MetricSeriesData = {
  series: string;
  /** Null for a platform series: the nodes and olf-system components serve every stage. */
  stage: string | null;
  source: "prometheus" | "dagster";
  state: MetricState;
  reason: string;
  range: MetricRange;
  step_seconds: number;
  unit: string;
  observed_at: string;
  /** False only for a Dagster series whose read reached its run cap: every step before `covered_from` is null. */
  complete: boolean;
  covered_from: string | null;
  lines: MetricLine[];
};

const RANGE_SET = new Set<unknown>(METRIC_RANGES);
const METRIC_STATES = new Set<unknown>(["available", "disabled", "unavailable", "not_provided"]);
const METRIC_SOURCES = new Set<unknown>(["prometheus", "dagster"]);
const isSeriesInfo = (v: unknown) =>
  isObject(v) && isText(v.name) && isText(v.unit) && METRIC_SOURCES.has(v.source) && Array.isArray(v.labels) && v.labels.every(isText)
  && Array.isArray(v.ranges) && v.ranges.every((r) => RANGE_SET.has(r)) && METRIC_STATES.has(v.state) && isText(v.reason);
const isPoint = (v: unknown) => Array.isArray(v) && v.length === 2 && isText(v[0]) && isNumberOrNull(v[1]);
const isLine = (v: unknown) =>
  isObject(v) && isObject(v.labels) && Object.values(v.labels).every(isText) && Array.isArray(v.points) && v.points.every(isPoint);

export function isMetricCatalog(body: unknown): body is MetricCatalog {
  return isObject(body) && isText(body.stage) && isText(body.observed_at) && Array.isArray(body.series) && body.series.every(isSeriesInfo);
}

export function isMetricSeriesData(body: unknown): body is MetricSeriesData {
  return isObject(body) && isText(body.series) && isTextOrNull(body.stage) && METRIC_SOURCES.has(body.source) && METRIC_STATES.has(body.state)
    && isText(body.reason) && RANGE_SET.has(body.range) && Number.isInteger(body.step_seconds) && (body.step_seconds as number) > 0
    && isText(body.unit) && isText(body.observed_at) && typeof body.complete === "boolean" && isTextOrNull(body.covered_from)
    && Array.isArray(body.lines) && body.lines.every(isLine);
}

/** The stage's series, the ranges each is kept for, and whether its source answers now. Configuration, not history. */
export async function getMetricCatalog(stage: string, signal?: AbortSignal): Promise<MetricCatalog> {
  const body = await read("metrics", stage, signal);
  if (!isMetricCatalog(body)) throw new ApiError(200, explain(500, stage));
  return body;
}

/** One stage series over `range`. A range past the retention is a 400, an unknown series a 404. */
export async function getStageMetric(stage: string, series: string, range: MetricRange, signal?: AbortSignal): Promise<MetricSeriesData> {
  const body = await get(`/api/v1/stages/${encodeURIComponent(stage)}/metrics/${encodeURIComponent(series)}?range=${range}`, stage, signal);
  if (!isMetricSeriesData(body)) throw new ApiError(200, explain(500, stage));
  return body;
}

/** One platform series (the nodes and the olf-system components) over `range`. */
export async function getPlatformMetric(series: string, range: MetricRange, signal?: AbortSignal): Promise<MetricSeriesData> {
  const body = await get(`/api/v1/platform/metrics/${encodeURIComponent(series)}?range=${range}`, "", signal);
  if (!isMetricSeriesData(body)) throw new ApiError(200, explain(500, ""));
  return body;
}

// ── A stage's runs (portal#37): GET /api/v1/stages/{stage}/runs?job=&limit= (Runs) ─────────────────────────────
// The route filters by job only and answers the newest `limit` runs (at most 100), newest first: no status, no time
// window and no cursor. Anything narrower is filtered in the browser among the runs read, and the page says so.

/** The most runs one read may ask for: `MAX_RUNS` in platform-api reads.py. */
export const RUNS_LIMIT = 100;
export type Runs = { runs: Run[] };

export function isRuns(body: unknown): body is Runs {
  return isObject(body) && Array.isArray(body.runs) && body.runs.every(isRun);
}

/** The stage's newest runs, of one job when `job` is set, newest first. A stage without Dagster is a 404. */
export async function listRuns(stage: string, opts: { job?: string; limit?: number } = {}, signal?: AbortSignal): Promise<Runs> {
  const q = new URLSearchParams({ limit: String(opts.limit ?? RUNS_LIMIT) });
  if (opts.job) q.set("job", opts.job);
  const body = await get(`/api/v1/stages/${encodeURIComponent(stage)}/runs?${q}`, stage, signal);
  if (!isRuns(body)) throw new ApiError(200, explain(500, stage));
  return body;
}

/** Whether the Runs page may call `list_runs`. The capabilities do not list `list_runs` (it is not a monitoring
 * operation in platform-api), so its row's twin stands in: `get_run`, with the same floor and stages in
 * permissions.toml. An API from before #1324 lists neither: there the list is asked and a 403 is shown in the API's
 * words. The runs come from Dagster, so a stage without it is not asked either. */
export function runsGate(access: MonitoringStage): Gate {
  const older = access.log_retention_days === undefined;
  if (!older && !access.operations.includes("get_run")) {
    return { open: false, state: "disabled", reason: `Your role may not read runs on stage ${access.stage.toUpperCase()}.` };
  }
  const dagster = access.capabilities.find((c) => c.name === "dagster");
  if (!dagster || dagster.status === "available") return { open: true };
  return { open: false, state: dagster.status === "unavailable" ? "unknown" : "disabled", reason: dagster.reason };
}

// ── The log archive (portal#39): GET /api/v1/stages/{stage}/logs?date=&hour=&pod=&container=&component=&product=
// &run_id=&severity=&limit= (Logs). One UTC day, or one hour of it, oldest first; no cursor: a truncated answer is the
// first `limit` lines. Free-text search is not served yet (openlakeforge#1347): the Logs page filters the lines read.

/** The lines the Logs page asks for at once: the API's default. */
export const LOGS_LIMIT = 500;
export type LogsQuery = {
  /** The UTC day, `YYYY-MM-DD`. */
  date: string;
  hour?: number;
  pod?: string; container?: string; component?: string; product?: string; runId?: string;
  severity?: LogSeverity;
  limit?: number;
};

/** At most `limit` archived lines of the stage for a UTC day or one hour of it, oldest first, from `severity` up. */
export async function listLogs(stage: string, opts: LogsQuery, signal?: AbortSignal): Promise<Logs> {
  const q = new URLSearchParams({ date: opts.date });
  if (opts.hour !== undefined) q.set("hour", String(opts.hour));
  for (const k of ["pod", "container", "component", "product"] as const) if (opts[k]) q.set(k, opts[k]!);
  if (opts.runId) q.set("run_id", opts.runId);
  if (opts.severity) q.set("severity", opts.severity);
  q.set("limit", String(opts.limit ?? LOGS_LIMIT));
  const body = await get(`/api/v1/stages/${encodeURIComponent(stage)}/logs?${q}`, stage, signal, `Stage ${stage.toUpperCase()} has no log archive.`);
  if (!isLogs(body)) throw new ApiError(200, explain(500, stage));
  return { ...body, lines: body.lines.map(withLevel) };
}
