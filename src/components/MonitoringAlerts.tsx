// Monitoring · alerts: the Alerts card and how an incident's notification reads, from GET /api/v1/stages/{stage}/alerts/incidents.
// The open incidents themselves are listed with what needs attention (MonitoringActOn).
// Read-only: there is no acknowledgement (ADR 0023, decision 3). `incidents: null` is unknown, never "none open", and a
// stale evaluator's list is shown as stale, never as current.

import { ApiError, worst, type AlertDelivery, type HealthState, type StageAlertIncidents } from "../lib/health-api";
import { ago } from "./Monitoring";
import { type Part } from "./MonitoringPipelines";
import { StatusBadge } from "./StatusBadge";

export type Alerts =
  | { ok: true; data: StageAlertIncidents & { incidents: NonNullable<StageAlertIncidents["incidents"]> }; state: HealthState; stale: boolean }
  | { ok: false; state: HealthState; reason: string; error?: ApiError };

export const denied = (e: ApiError) => e.status === 401 || e.status === 403 || e.status === 404;

export function alerts(load: Part<StageAlertIncidents>): Alerts {
  if (load.status === "error") return { ok: false, state: denied(load.error) ? "disabled" : "unknown", reason: load.error.message, error: load.error };
  if (load.status === "off") return { ok: false, state: load.state, reason: load.reason };
  const { state, incidents } = load.data;
  if (state.status === "not_provided") return { ok: false, state: "disabled", reason: state.reason };
  if (state.status !== "available" || incidents === null) return { ok: false, state: "unknown", reason: state.reason };
  // A state that does not say it is current is not: an old list can neither clear nor confirm anything.
  const stale = state.stale !== false;
  const severities = incidents.map((i) => i.severity);
  const shown = stale ? worst([...severities, "unknown"]) : severities.length ? worst(severities) : "healthy";
  return { ok: true, data: { ...load.data, incidents }, state: shown, stale };
}

const plural = (n: number | null, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
export const DELIVERY: Record<AlertDelivery["status"], string> = {
  pending: "Pending", delivered: "Delivered", undeliverable: "Undeliverable", unrouted: "Unrouted", unknown: "Unknown",
};

/** The delivery's own words, with its counts when the evaluator kept them. */
export function deliveryLine(d: AlertDelivery): string {
  const event = d.event ? `${d.event} notification` : "notification";
  if (d.status === "unrouted") return `${event} · no receiver is routed for it`;
  if (d.status === "unknown") return `${event} · the evaluator kept no outcome`;
  const counts = d.receivers === null ? "" : ` · ${d.delivered ?? "?"} of ${plural(d.receivers, "receiver")}`;
  const attempts = d.attempts === null ? "" : ` · ${plural(d.attempts, "attempt")}`;
  return `${event}${counts}${attempts}`;
}

export function AlertsCard({ a, now }: { a: Alerts; now: number }) {
  const n = a.ok ? a.data.incidents.length : 0;
  return (
    <section className="mon-card" aria-label="Alerts summary">
      <div className="mon-card-top"><h2 className="label">Alerts</h2><StatusBadge state={a.state} /></div>
      {a.ok ? <p className="mon-value"><strong>{n}</strong> open incident{n === 1 ? "" : "s"}</p> : <p className="mon-value"><strong>—</strong></p>}
      <p className="mon-note">
        {!a.ok ? a.reason : a.stale ? `Stale: ${a.data.state.reason}` : `Evaluated ${ago(a.data.state.evaluated_at, now)}`}
      </p>
    </section>
  );
}
