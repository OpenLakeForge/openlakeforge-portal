// The Platform API contract for Monitoring (openlakeforge #1127, ADR 0021): GET /api/v1/stages/{stage}/health.
// Same-origin and cookie-authenticated, read-only. Types follow the committed OpenAPI document
// (docs/schema/platform-api.openapi.json: StageHealth, ServiceHealth, IntegrationStatus).
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

function explain(status: number, stage: string, detail?: string): string {
  if (status === 0) return "The monitoring API isn’t answering, so nothing on this page can be shown as healthy.";
  if (status === 401) return "Your session has expired. Reload the page to sign in again.";
  if (status === 403) return detail || `You have no monitoring access on stage ${stage.toUpperCase()}.`;
  if (status === 404) return detail || `Stage ${stage.toUpperCase()} is not known to the Platform API.`;
  return `The monitoring API failed (${status}), so nothing on this page can be shown as healthy.`;
}

export async function getStageHealth(stage: string, signal?: AbortSignal): Promise<StageHealth> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/stages/${encodeURIComponent(stage)}/health`, { credentials: "same-origin", signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError(0, explain(0, stage));
  }
  const body = await res.json().catch(() => undefined);
  const detail = typeof body?.detail === "string" ? body.detail : undefined;
  if (!res.ok) throw new ApiError(res.status, explain(res.status, stage, detail));
  return body as StageHealth;
}

const SEVERITY: Record<HealthState, number> = { disabled: 0, healthy: 1, unknown: 2, warning: 3, critical: 4 };
/** The worst state, as `rollup` ranks them: unknown outranks healthy, so a gap is never hidden by a green neighbour. */
export const worst = (states: HealthState[]): HealthState =>
  states.reduce<HealthState>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "disabled");

/** A healthy answer past its expiry is no longer evidence: it reads unknown, never green. */
export function effective(s: ServiceHealth, now: number): HealthState {
  return s.state === "healthy" && s.expires_at && Date.parse(s.expires_at) < now ? "unknown" : s.state;
}
