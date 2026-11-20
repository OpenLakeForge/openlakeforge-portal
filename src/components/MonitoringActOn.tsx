// Monitoring · what to act on: one list of every pipeline signal that is warning or critical and every open alert
// incident, each item once. An incident that is about a listed signal (same job, matching condition) joins that
// signal's row, so its notification is read beside it; an incident about nothing listed is its own row. Each row says
// whether a notification went out and how it was delivered, in the API's words. Read-only (ADR 0023, decision 3).

import { worst, type AlertIncident, type HealthSignal } from "../lib/health-api";
import { DELIVERY, deliveryLine, denied, type Alerts } from "./MonitoringAlerts";
import { attention, Breakable, JobLink, RANK, RunLink, type Pipes, type Row } from "./MonitoringPipelines";
import { StatusBadge } from "./StatusBadge";
import { Ago, Time, Zoned } from "./Time";

/** The pipeline signal each alert condition is about (`AlertKind` in openlakeforge_core.alerts, with the older names
 * the mock and early evaluators used). A condition not listed here is about no signal, so its incident stands alone. */
const CONDITION_KIND: Record<string, HealthSignal["kind"]> = {
  run_failed: "execution", failed_run: "execution",
  missed_run: "expected_run", schedule_mismatch: "expected_run",
  stale_output: "freshness", freshness: "freshness",
  quality: "quality", quality_blocking: "quality",
};

export type Item = Row & { runs: string[]; scope?: string; incident?: AlertIncident; lastSeen?: string; gap?: "pipelines" | "alerts" };

const scopeOf = (i: AlertIncident) => [i.domain, i.product, i.table].filter(Boolean).join(" · ") || i.component || undefined;

/** Pipeline rows and open incidents as one list, each item once, worst first. */
export function actOn(p: Pipes, a: Alerts, stage: string): Item[] {
  const rows: Item[] = attention(p, stage).map((r) => ({ ...r, runs: r.run ? [r.run] : [], gap: r.key === "gap" ? "pipelines" : undefined }));
  const incidents = a.ok ? a.data.incidents : [];
  for (const i of incidents) {
    const kind = CONDITION_KIND[i.condition];
    const row = kind && i.job ? rows.find((r) => !r.incident && r.job === i.job && r.kind === kind) : undefined;
    if (row) {
      row.incident = i;
      row.state = worst([row.state, i.severity]);
      row.sort = RANK[row.state];
      row.runs = [...new Set([...row.runs, ...i.run_ids.slice(-3)])];
      row.scope = scopeOf(i);
      row.lastSeen = i.last_seen_at;
      continue;
    }
    rows.push({
      key: `incident/${i.id}`, state: i.severity, title: i.summary, detail: i.condition, job: i.job ?? undefined, at: i.opened_at,
      runs: i.run_ids.slice(-3), scope: scopeOf(i), incident: i, lastSeen: i.last_seen_at, sort: RANK[i.severity],
    });
  }
  if (!a.ok) {
    rows.push({
      key: "alerts-gap", state: a.state, title: a.state === "disabled" ? "Alert incidents are not available" : "Incidents cannot be read",
      detail: a.reason, runs: [], gap: "alerts", sort: RANK[a.state],
    });
  }
  const at = (r: Item) => (r.at ? Date.parse(r.at) : 0);
  return rows.sort((x, y) => x.sort - y.sort || at(y) - at(x));
}

/** The notification cell: the incident's delivery, or why there is none, never a silent blank. */
function Notification({ r, a }: { r: Item; a: Alerts }) {
  if (r.incident) {
    return (
      <>
        <span className="mon-delivery" data-status={r.incident.delivery.status}>{DELIVERY[r.incident.delivery.status]}</span>
        <span className="mon-why">{deliveryLine(r.incident.delivery)}</span>
      </>
    );
  }
  if (r.gap === "alerts") return <span className="mon-delivery" data-status="unknown">—</span>;
  if (!a.ok) {
    return (
      <>
        <span className="mon-delivery" data-status="unknown">{a.state === "disabled" ? "Not available" : "Unknown"}</span>
        <span className="mon-why">alert incidents {a.state === "disabled" ? "are not available" : "cannot be read"}</span>
      </>
    );
  }
  if (a.stale) {
    return (
      <>
        <span className="mon-delivery" data-status="unknown">Unknown</span>
        <span className="mon-why">the alert evaluation is stale</span>
      </>
    );
  }
  return (
    <>
      <span className="mon-delivery" data-status="none">None</span>
      <span className="mon-why">no incident is open for it, so none was sent</span>
    </>
  );
}

const CLEAR = "Nothing needs attention: no pipeline signal is warning or critical and no alert incident is open.";
const STALE_CLEAR = "No open incident in the last evaluation, but it is stale, so none can be ruled out.";

export function ActOn({ p, a, now, stage, retryPipes, retryAlerts }: {
  p: Pipes; a: Alerts; now: number; stage: string; retryPipes?: { onRetry(): void; lastGood?: number }; retryAlerts?(): void;
}) {
  const rows = actOn(p, a, stage);
  return (
    <section className="q-card mon-list" aria-labelledby="mon-attention-h">
      <div className="f-card-head">
        <h2 id="mon-attention-h">Needs attention</h2>
        <span className="f-count">{rows.length}</span>
      </div>
      {a.ok && a.stale && (
        <p className="mon-stale" role="note">
          <StatusBadge state="unknown" /> Stale: {a.data.state.reason}. Its incidents and notifications may be out of date.
        </p>
      )}
      <div className="f-scroll" role="region" aria-label="What needs attention" tabIndex={0}>
        <table className="f-table mon-table mon-attention">
          <thead>
            <tr><th scope="col">State</th><th scope="col">What happened</th><th scope="col">Scope</th><th scope="col"><Zoned>When</Zoned></th><th scope="col">Notification</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td><StatusBadge state={r.state} /></td>
                <th scope="row">
                  <span className="mon-what">{r.title}</span>
                  <span className="mon-why f-mono">{r.detail}</span>
                  {r.gap === "pipelines" && retryPipes && (
                    <span className="mon-why">
                      {retryPipes.lastGood ? <>Last good snapshot <Time at={retryPipes.lastGood} now={now} />. </> : ""}
                      <button type="button" className="f-btn f-outline" onClick={retryPipes.onRetry}><span aria-hidden="true">↻</span> Retry</button>
                    </span>
                  )}
                  {r.gap === "alerts" && !a.ok && a.error && !denied(a.error) && retryAlerts && (
                    <span className="mon-why"><button type="button" className="f-btn f-outline" onClick={retryAlerts}><span aria-hidden="true">↻</span> Retry</button></span>
                  )}
                </th>
                <td className="f-mono mon-scope">
                  {r.job ? <JobLink stage={stage} job={r.job} /> : r.scope ? <Breakable text={r.scope} /> : "—"}
                  {r.job && r.scope && <span className="mon-why">{r.scope}</span>}
                </td>
                <td className="f-mono mon-when">
                  {r.due ? <>due <Time at={r.due} now={now} bare /></> : r.at ? <Time at={r.at} now={now} bare /> : "—"}
                  {r.runs.length > 0 && (
                    <span className="mon-why run-ids">
                      {r.runs.map((id, n) => <span key={id}>{n ? " · " : ""}<RunLink stage={stage} run={id} /></span>)}
                      {r.incident && r.incident.run_ids.length > 3 ? ` · +${r.incident.run_ids.length - 3} earlier` : ""}
                    </span>
                  )}
                  {r.key.startsWith("incident/") && r.lastSeen && <span className="mon-why">last seen <Ago at={r.lastSeen} now={now} /></span>}
                </td>
                <td className="mon-notify"><Notification r={r} a={a} /></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><th scope="row" colSpan={5} className="mon-clear">{a.ok && a.stale ? STALE_CLEAR : CLEAR}</th></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
