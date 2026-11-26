// Monitoring · what to act on: one list of every pipeline signal and service that is warning, critical or unknown and
// every open alert incident, each item once. An incident that is about a listed signal (same job, matching condition)
// or service component joins that row, so its notification is read beside it; an incident about nothing listed is its
// own row. A row is one line; its reason, times, notification and runbook open under it. Read-only (ADR 0023, decision 3).

import { useEffect, useRef, useState } from "react";
import { getRunQuality, worst, type AlertIncident, type HealthSignal, type HealthState, type QualityCheck } from "../lib/health-api";
import { Link, useSearchParams } from "react-router";
import { Icon } from "./FilesIcons";
import { Delivery, denied, IncidentRunbook, type Alerts } from "./MonitoringAlerts";
import { attention, Breakable, JobLink, RANK, RunLink, type Pipes, type Row } from "./MonitoringPipelines";
import { countsLine, qualityTitle, type Quality } from "./MonitoringQuality";
import { StatusBadge } from "./StatusBadge";
import { Ago, Time } from "./Time";

/** The search parameters of the overview's alerts filter (`focus=alerts`) and of an incident's own row (`incident=<id>`),
 * which an alert notification links to: `/monitoring?stage=<stage>&incident=<id>`. */
export const FOCUS = "focus";
export const INCIDENT = "incident";
/** The search of the current address with `focus=alerts` toggled, the rest (the stage) kept. */
export function alertsToggle(params: URLSearchParams): string {
  const q = new URLSearchParams(params);
  if (q.get(FOCUS) === "alerts") q.delete(FOCUS);
  else q.set(FOCUS, "alerts");
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** The pipeline signal each alert condition is about (`AlertKind` in openlakeforge_core.alerts, with the older names
 * the mock and early evaluators used). A condition not listed here is about no signal, so its incident stands alone. */
const CONDITION_KIND: Record<string, HealthSignal["kind"]> = {
  run_failed: "execution", failed_run: "execution",
  missed_run: "expected_run", schedule_mismatch: "expected_run",
  stale_output: "freshness", freshness: "freshness",
  quality: "quality", quality_blocking: "quality",
};

export type Item = Row & {
  runs: string[]; scope?: string; incident?: AlertIncident; lastSeen?: string; gap?: "pipelines" | "alerts";
  /** What the row is about when it is not a job: a service's name, with its probes' ids and a link to its logs. */
  name?: string; components?: string[]; logs?: string;
};

const scopeOf = (i: AlertIncident) => [i.domain, i.product, i.table].filter(Boolean).join(" · ") || i.component || undefined;

/** A quality row in the words of its pipeline's counts, as its row of the pipelines table reads them: a failed check
 * that did not stop the pipeline is a non-blocking failure, never "warned". The quality answer has counts only, not
 * the checks' names: those are on the run's own screen, which the row links. */
function withCounts(r: Item, q?: Quality): Item {
  if (r.kind !== "quality" || !r.job || !q?.ok) return r;
  const found = q.data.pipelines.find((x) => x.job === r.job);
  // The two reads are separate: a run that finished between them leaves counts of another run, which must not reword
  // this signal, and nor must counts that name no run. A signal that names no run takes the job's counts.
  if (r.run && found?.run_id !== r.run) return r;
  const c = found?.counts;
  const title = c && qualityTitle(c);
  return title && c ? { ...r, title, detail: `${r.detail}\n${countsLine(c)}` } : r;
}

/** Pipeline rows and open incidents as one list, each item once, worst first. */
export function actOn(p: Pipes, a: Alerts, stage: string, services: Item[] = [], q?: Quality): Item[] {
  const rows: Item[] = [
    ...attention(p, stage).map((r): Item => withCounts({ ...r, runs: r.run ? [r.run] : [], gap: r.key === "gap" ? "pipelines" : undefined }, q)),
    ...services.map((s): Item => ({ ...s })),
  ];
  const incidents = a.ok ? a.data.incidents : [];
  for (const i of incidents) {
    const kind = CONDITION_KIND[i.condition];
    const row = kind && i.job ? rows.find((r) => !r.incident && r.job === i.job && r.kind === kind)
      : i.component ? rows.find((r) => !r.incident && r.components?.includes(i.component!)) : undefined;
    if (row) {
      row.incident = i;
      row.state = worst([row.state, i.severity]);
      row.sort = RANK[row.state];
      row.runs = [...new Set([...row.runs, ...i.run_ids.slice(-3)])];
      row.scope = row.components ? undefined : scopeOf(i);
      // A service's row reads its probe's words, so the incident's own summary leads what opens under it.
      if (row.components) {
        row.detail = `${i.summary}\n${row.detail}`;
        row.at = i.opened_at; // when the incident opened, not when the probe was last read
      }
      row.lastSeen = i.last_seen_at;
      continue;
    }
    rows.push({
      // The condition's signal kind, so an incident-only quality row still reads its run's checks when opened.
      key: `incident/${i.id}`, kind, state: i.severity, title: i.summary, detail: i.condition, job: i.job ?? undefined, at: i.opened_at,
      runs: i.run_ids.slice(-3), scope: scopeOf(i), incident: i, lastSeen: i.last_seen_at, sort: RANK[i.severity],
    });
  }
  if (!a.ok) {
    rows.push({
      key: "alerts-gap", state: a.state, title: a.state === "disabled" ? "Alert incidents are not available" : "Incidents cannot be read",
      detail: a.reason, name: "Alerts", runs: [], gap: "alerts", sort: RANK[a.state],
    });
  }
  const at = (r: Item) => (r.at ? Date.parse(r.at) : 0);
  return rows.sort((x, y) => x.sort - y.sort || at(y) - at(x));
}

const CHECK_RANK = (c: QualityCheck) => (c.pipeline_outcome === "blocked" ? 0 : c.outcome === "error" ? 1 : 2);
const checkName = (c: QualityCheck) => `${c.check_id}${c.table && !c.check_id.includes(c.table) ? ` (${c.table})` : ""}`;

/** The checks that failed or warned in a quality row's run, by name, read when the row is opened: the overview's quality
 * answer has counts only. Blocking ones first; three at most, then how many more. Nothing when they cannot be read:
 * the row's run link still leads to them. */
export function RunChecks({ stage, run }: { stage: string; run: string }) {
  const [checks, setChecks] = useState<QualityCheck[] | null | undefined>(undefined);
  useEffect(() => {
    const ctl = new AbortController();
    setChecks(undefined);
    getRunQuality(stage, run, ctl.signal).then(
      (q) => setChecks((q.checks ?? []).filter((c) => c.outcome === "error" || c.outcome === "warn").sort((x, y) => CHECK_RANK(x) - CHECK_RANK(y))),
      () => { if (!ctl.signal.aborted) setChecks(null); },
    );
    return () => ctl.abort();
  }, [stage, run]);
  if (checks === undefined) return <span className="mon-why">Reading the run's checks…</span>;
  if (!checks?.length) return null;
  return (
    <span className="mon-why mon-checks">
      {checks.length === 1 ? "Check" : "Checks"}{" "}
      {checks.slice(0, 3).map((c, n) => (
        <span key={`${c.check_id}/${c.table ?? ""}/${n}`}>
          {n ? ", " : ""}<code className="f-mono">{checkName(c)}</code>{c.pipeline_outcome === "blocked" ? " (blocking)" : c.outcome === "warn" ? " (warned)" : ""}
        </span>
      ))}
      {checks.length > 3 ? ` +${checks.length - 3} more` : ""}
    </span>
  );
}

/** The notification cell: the incident's delivery, or why there is none, never a silent blank, and the runbook section
 * its notification links to, when it has one. */
function Notification({ r, a }: { r: Item; a: Alerts }) {
  if (r.incident) {
    return (
      <>
        <Delivery d={r.incident.delivery} />
        <IncidentRunbook incident={r.incident} />
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

export function ActOn({ p, a, q, now, stage, checks = false, services, heading, state, retryPipes, retryAlerts }: {
  p: Pipes; a: Alerts; q?: Quality; now: number; stage: string; services?: Item[]; heading: React.ReactNode; state?: HealthState;
  /** Whether the role may read a run's quality checks on this stage (`runGate`); without it no row reads them. */
  checks?: boolean;
  retryPipes?: { onRetry(): void; lastGood?: number }; retryAlerts?(): void;
}) {
  const [params] = useSearchParams();
  const focus = params.get(FOCUS) === "alerts";
  const wanted = params.get(INCIDENT);
  const all = actOn(p, a, stage, services, q);
  // The alerts filter keeps the rows an incident is open for, and the row that says incidents cannot be read.
  const rows = focus ? all.filter((r) => r.incident || r.gap === "alerts") : all;
  // An incident's own address opens its row and scrolls to it, once per incident asked for.
  const target = useRef<HTMLLIElement>(null);
  const scrolled = useRef<string | null>(null);
  // Rows opened so far: a quality row reads its run's checks only once it is opened.
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set());
  const toggled = (key: string) => (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const isOpen = e.currentTarget.open;
    setOpenRows((s) => (isOpen === s.has(key) ? s : isOpen ? new Set(s).add(key) : new Set([...s].filter((k) => k !== key))));
  };
  useEffect(() => {
    if (!wanted || !target.current || scrolled.current === wanted) return;
    scrolled.current = wanted;
    target.current.scrollIntoView?.({ block: "center" });
  });
  return (
    <section className="q-card mon-list mon-act" data-state={state} aria-labelledby="mon-attention-h">
      <div className="f-card-head">
        <h2 id="mon-attention-h">{heading}</h2>
        <span className="mon-act-end">
          {focus && (
            <Link className="mon-filter" to={{ search: alertsToggle(params) }} aria-label="Remove filter: Alerts only">
              Alerts only <span aria-hidden="true">×</span>
            </Link>
          )}
          <span className="f-count">{rows.length}</span>
        </span>
      </div>
      {a.ok && a.stale && (
        <p className="mon-stale" role="note">
          <StatusBadge state="unknown" /> Stale: {a.data.state.reason}. Its incidents and notifications may be out of date.
        </p>
      )}
      {rows.length === 0 && <p className="mon-clear">{a.ok && a.stale ? STALE_CLEAR : focus ? "No alert incident is open." : CLEAR}</p>}
      <ul className="mon-items" aria-label="What needs attention">
        {rows.map((r) => {
          const about = r.name ?? r.job ?? r.scope;
          const asked = !!wanted && r.incident?.id === wanted;
          // The signal's run, or else the latest the row keeps (`runs` is oldest first).
          const checksRun = checks && r.kind === "quality" ? r.run ?? r.runs.at(-1) : undefined;
          return (
            <li key={r.key} className="mon-item" ref={asked ? target : undefined} data-asked={asked || undefined}>
              <details open={asked || undefined} onToggle={toggled(r.key)}>
                <summary>
                  <StatusBadge state={r.state} />
                  {/* A slot on every row, so the names line up whether or not a bell is in it. */}
                  {r.incident
                    ? <span className="mon-bell" role="img" aria-label="Open alert incident" title="Open alert incident"><Icon name="bell" size={14} /></span>
                    : <span className="mon-bell" aria-hidden="true" />}
                  {about && <strong className="mon-about"><Breakable text={about} /></strong>}
                  <span className="mon-what">{r.title}</span>
                </summary>
                <div className="mon-item-body">
                  <span className="mon-why f-mono mon-reason">{r.detail}</span>
                  {checksRun && (asked || openRows.has(r.key)) && <RunChecks stage={stage} run={checksRun} />}
                  {r.job &&<span className="mon-why"><JobLink stage={stage} job={r.job} />{r.scope ? ` · ${r.scope}` : ""}</span>}
                  {(r.due || r.at) && <span className="mon-why mon-when">{r.due ? <>due <Time at={r.due} now={now} /></> : <Time at={r.at} now={now} />}</span>}
                  {r.runs.length > 0 && (
                    <span className="mon-why run-ids">
                      {r.runs.map((id, n) => <span key={id}>{n ? " · " : ""}<RunLink stage={stage} run={id} /></span>)}
                      {r.incident && r.incident.run_ids.length > 3 ? ` · +${r.incident.run_ids.length - 3} earlier` : ""}
                    </span>
                  )}
                  {(r.key.startsWith("incident/") || r.components) && r.lastSeen && <span className="mon-why">last seen <Ago at={r.lastSeen} now={now} /></span>}
                  <div className="mon-notify"><span className="mon-why">Notification</span><Notification r={r} a={a} /></div>
                </div>
              </details>
              {r.logs && <Link className="f-btn f-outline mon-item-action" to={r.logs} aria-label={`View logs of ${about}`}>View logs</Link>}
              {r.gap === "pipelines" && retryPipes && (
                <span className="mon-item-action">
                  {retryPipes.lastGood ? <span className="mon-why">Last good snapshot <Time at={retryPipes.lastGood} now={now} /></span> : null}
                  <button type="button" className="f-btn f-outline" onClick={retryPipes.onRetry}><span aria-hidden="true">↻</span> Retry</button>
                </span>
              )}
              {r.gap === "alerts" && !a.ok && a.error && !denied(a.error) && retryAlerts && (
                <button type="button" className="f-btn f-outline mon-item-action" onClick={retryAlerts}><span aria-hidden="true">↻</span> Retry</button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
