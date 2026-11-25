// Monitoring · alerts: the Alerts card and how an incident's notification reads, from GET /api/v1/stages/{stage}/alerts/incidents.
// The open incidents themselves are listed with what needs attention (MonitoringActOn).
// Read-only: there is no acknowledgement (ADR 0023, decision 3). `incidents: null` is unknown, never "none open", and a
// stale evaluator's list is shown as stale, never as current.

import { ApiError, worst, type AlertDelivery, type AlertIncident, type HealthState, type StageAlertIncidents } from "../lib/health-api";
import { Gauge } from "./MonitoringGauges";
import { type Part } from "./MonitoringPipelines";

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

/** A runbook is linked only when the API names one as a web address: a run's quality answer (#1325) and each incident
 * (#1344) carry one when the deployment sets a runbook page, null when it sets none, and an older API leaves it out.
 * A bare scheme with no host is not one, and the scheme is matched as the API writes it, lower case. */
export const runbookUrl = (r: string | null | undefined) => (r && /^https?:\/\/[^\s/]/.test(r) ? r : undefined);

/** The incident's runbook section, the link its notification carries, on a line of its own; nothing at all, not even a
 * placeholder, when it has none. Its name says which condition's section it opens, as the page can list several. */
export function IncidentRunbook({ incident }: { incident: AlertIncident }) {
  const href = runbookUrl(incident.runbook);
  if (!href) return null;
  return (
    <span className="mon-why">
      <a className="run-link" href={href} target="_blank" rel="noopener noreferrer">
        Runbook <span aria-hidden="true">↗</span><span className="sr-only">{` for ${incident.condition} (opens in a new tab)`}</span>
      </a>
    </span>
  );
}

export function AlertsCard({ a }: { a: Alerts }) {
  const n = a.ok ? a.data.incidents.length : 0;
  const of = (severity: HealthState) => (a.ok ? a.data.incidents.filter((i) => i.severity === severity).length : 0);
  // No open incident is a whole green ring only for a current evaluation; a stale one proves nothing.
  const clear = a.ok && !a.stale && n === 0;
  return (
    <Gauge
      label="Alerts summary" title="Alerts" state={a.state === "healthy" ? undefined : a.state}
      center={a.ok ? String(n) : "—"} unit={a.ok ? `incident${n === 1 ? "" : "s"}` : undefined}
      fill={clear ? "ok" : undefined}
      slices={a.ok ? [
        { label: "Critical", value: of("critical"), tone: "bad" }, { label: "Warning", value: of("warning"), tone: "warn" },
        { label: "Other", value: n - of("critical") - of("warning"), tone: "none", optional: true },
      ] : []}
      note={!a.ok ? a.reason : a.stale ? `Stale: ${a.data.state.reason}` : undefined}
    />
  );
}
