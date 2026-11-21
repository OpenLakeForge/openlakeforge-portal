// Monitoring · Failed run (Figma "Screens — v0.4 · Monitoring", Failed run): what one run's failure was, from
// GET /api/v1/stages/{stage}/runs/{run_id}/failure, with its scope, its quality checks and reports (.../quality, #1325),
// open incidents and the archived lines of its window (.../logs, #1326).
// Read-only: there is no Re-run in v0.7 (openlakeforge#333, 2026-11-16); the next step is the run in Dagster.
// Nothing here is inferred. A part the API could not read says so in its own words, and none of it reads green.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  ApiError, gate, getAlertIncidents, getMonitoringCapabilities, getPipelinesHealth, getRun, getRunFailure, getRunLogs, getRunQuality, listRunLogs, runGate,
  type AlertIncident, type Gate, type HealthState, type Integration, type LogLine, type LogSeverity, type MonitoringCapabilities,
  type MonitoringStage, type PipelineOutcome, type PipelinesHealth, type QualityCheck, type QualityOutcome, type QualityReport, type Run,
  type RunFailure, type RunQuality, type StageAlertIncidents,
} from "../lib/health-api";
import { dayKey, formatClock, formatDate, seconds, toMs, useTimeZone } from "../lib/time";
import { DEADLINE_MS } from "./Monitoring";
import { alerts, DELIVERY, deliveryLine, IncidentRunbook, runbookUrl } from "./MonitoringAlerts";
import { absent, pipes, runHref, type Part } from "./MonitoringPipelines";
import { StatusBadge } from "./StatusBadge";
import { Ago, Time, Zoned, ZoneSwitch } from "./Time";

/** The failure read is held to 20 s by the API itself (#1271); the page waits a little longer before calling it unreachable. */
export const RUN_DEADLINE_MS = 25_000;
const timedOut = (s: number) =>
  new ApiError(0, `The monitoring API did not answer within ${s / 1000} s, so nothing on this page can be shown as healthy.`);
const failure = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, String(e)));
const denied = (e: ApiError) => e.status === 401 || e.status === 403 || e.status === 404;
const short = (run: string) => run.slice(0, 8);

/** Dagster's run status as one of the five `HealthState`s, as the execution signal reads it. Anything else is unknown. */
export function runState(status: string): HealthState {
  if (status === "FAILURE") return "critical";
  if (status === "CANCELED" || status === "CANCELING") return "warning";
  if (status === "SUCCESS") return "healthy";
  return "unknown";
}
const RUN_WORD: Record<string, string> = { SUCCESS: "succeeded", FAILURE: "failed", CANCELED: "was canceled", CANCELING: "is canceling", STARTED: "is running", QUEUED: "is queued", STARTING: "is starting", NOT_STARTED: "has not started" };

/** "1 min 54 s", "2 h 5 min". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ""}`;
}

type Snap = {
  failure: Part<RunFailure>;
  run: Part<Run>;
  pipes: Part<PipelinesHealth>;
  quality: Part<RunQuality>;
  alerts: Part<StageAlertIncidents>;
};
type Load = { status: "loading" } | { status: "ok"; snap: Snap; at: number };
type Caps = { status: "loading" } | { status: "ok"; data: MonitoringCapabilities } | { status: "error"; error: ApiError };

const source = (f: RunFailure, name: Integration["name"]) => f.sources.find((s) => s.name === name);

function Card({ id, title, aside, children }: { id: string; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="q-card mon-list run-card" aria-labelledby={id}>
      <div className="f-card-head">
        <h2 id={id}>{title}</h2>
        {aside}
      </div>
      <div className="run-body">{children}</div>
    </section>
  );
}

/** A part the page could not show, and why: off (no source, not the role's), refused, or unreachable with Retry. */
function Gap({ what, part, retry }: { what: string; part: Exclude<Part<unknown>, { status: "ok" }>; retry?(): void }) {
  const state: HealthState = part.status === "off" ? part.state : denied(part.error) ? "disabled" : "unknown";
  const reason = part.status === "off" ? part.reason : part.error.message;
  return (
    <p className="run-gap">
      <StatusBadge state={state} />
      <span><span className="mon-what">{state === "disabled" ? `${what} are not available` : `${what} cannot be read`}</span>
        <span className="mon-why">{reason}</span>
        {part.status === "error" && !denied(part.error) && retry && (
          <span className="mon-why"><button type="button" className="f-btn f-outline" onClick={retry}><span aria-hidden="true">↻</span> Retry</button></span>
        )}
      </span>
    </p>
  );
}

/** "Ended 09:32 UTC, after 1 min 55 s", or why the time is not known: the run's own end, never its creation. */
function Ended({ run, now }: { run: Part<Run>; now: number }) {
  if (run.status !== "ok") {
    return <span className="mon-why">Not known: {run.status === "off" ? run.reason : run.error.message}</span>;
  }
  const r = run.data;
  if (r.ended_at == null) return <span className="mon-why">Not ended, or no end time recorded</span>;
  return <>Ended <Time at={seconds(r.ended_at)} now={now} />{r.started_at != null && `, after ${duration(r.ended_at - r.started_at)}`}</>;
}

/** The failure summary: what failed and why, when, and where to look next (logs, reports, runbook, Dagster, the job's
 * other runs). It replaces the former "Next step" card: run control stays in Dagster in v0.7 (openlakeforge#333). */
function WhatFailed({ f, run, quality, stage, runId, dagster, now }: {
  f: RunFailure; run: Part<Run>; quality: Part<RunQuality>; stage: string; runId: string; dagster?: string; now: number;
}) {
  const dagsterSrc = source(f, "dagster");
  let body;
  if (f.steps === null) {
    // An unreadable event log is no evidence that nothing failed.
    body = <Gap what="The failed steps" part={{ status: "off", state: absent(dagsterSrc) ?? "unknown", reason: dagsterSrc?.reason ?? "the run's event log could not be read" }} />;
  } else if (f.steps.length) {
    body = (
      <ol className="run-steps">
        {f.steps.map((s, i) => (
          <li key={`${s.step}-${i}`}>
            <p className="run-step">Step <span className="f-mono">{s.step || "unnamed"}</span> failed</p>
            <div className="run-error f-mono">
              {s.error_class && <span className="run-class">{s.error_class}</span>}
              <span>{s.message || "Dagster kept no message for this error."}</span>
            </div>
            {s.message_truncated && <p className="mon-why">First line only: the full error is in the run's logs in Dagster.</p>}
          </li>
        ))}
      </ol>
    );
  } else if (f.run_message) {
    body = (
      <>
        <p className="run-step">The run failed outside any step</p>
        <div className="run-error f-mono"><span>{f.run_message}</span></div>
      </>
    );
  } else if (f.status === "SUCCESS") {
    body = <p className="run-step">This run succeeded: nothing failed.</p>;
  } else {
    body = <p className="run-step">Dagster recorded no failed step and no run message for this run ({f.status}).</p>;
  }
  const book = quality.status === "ok" ? runbookUrl(quality.data.runbook) : undefined;
  const failed = f.status === "FAILURE";
  return (
    <Card id="run-failed-h" title="What failed">
      {body}
      {f.steps_truncated && <p className="mon-why">More steps failed than are shown here: open the run in Dagster for all of them.</p>}
      <dl className="run-summary-facts">
        <Fact term="When"><Ended run={run} now={now} /></Fact>
      </dl>
      <div className="run-actions">
        <a className="f-btn f-outline run-dagster" href="#run-logs-h">Logs <span aria-hidden="true">↓</span><span className="sr-only"> (on this page)</span></a>
        <OpenInDagster url={dagster} runId={runId} />
        {book && (
          <a className="f-btn f-outline run-dagster" href={book} target="_blank" rel="noopener noreferrer">
            Runbook <span aria-hidden="true">↗</span><span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        <Link className="run-link run-all" to={`/monitoring/${encodeURIComponent(stage)}/runs?job=${encodeURIComponent(f.job)}`}>
          All runs of <span className="f-mono">{f.job}</span>
        </Link>
      </div>
      {quality.status === "ok" && quality.data.checks !== null && <Reports reports={quality.data.reports} />}
      <p className="mon-why">
        {failed
          ? `Run control is not in the portal: once the cause is fixed, re-run ${f.job} from Dagster.`
          : "Run control is not in the portal: the run, its full event log and its re-execution are in Dagster."}
      </p>
    </Card>
  );
}

/** The level floors offered; `debug` adds nothing a reader of a failure needs. */
export const SEVERITY_LABEL: Record<"" | Exclude<LogSeverity, "debug">, string> = {
  "": "All levels", info: "Info and above", warning: "Warning and above", error: "Error and above", critical: "Critical only",
};
export type Floor = keyof typeof SEVERITY_LABEL;
const DEFAULT_FLOOR: Floor = "warning";
const FLOOR_WORDS: Record<Exclude<Floor, "">, string> = { info: "info lines and above", warning: "warnings and above", error: "errors and above", critical: "critical lines" };

const kept = (days: number) => `Kept ${days} day${days === 1 ? "" : "s"}`;

/** `day` is set only for a page read the older way (one UTC day of `list_logs`), which has no window and no `next`. */
type Page = { lines: LogLine[]; next: string | null; truncated: boolean; since: string; until: string; day?: string };

/** The run's UTC day, as an older API's log archive is read (`list_logs`, one day): its start, else its creation. */
const runDay = (r: Run) => new Date((r.started_at ?? r.created_at) * 1000).toISOString().slice(0, 10);
/** The level floors an API from before #1326 accepts on `list_logs`. */
export const OLDER_FLOORS: Floor[] = ["", "warning", "error"];
type More = { status: "idle" } | { status: "loading" } | { status: "error"; error: ApiError };

/** The run's archived lines, from its start to its end across UTC days (#1326), with each line's own time and level. */
function RunLogs({ access, stage, runId, run, now }: { access: MonitoringStage; stage: string; runId: string; run: Part<Run>; now: number }) {
  const tz = useTimeZone();
  // list_run_logs has list_logs's permission row (#1326) and is not listed on its own: list_logs gates it.
  const g = gate(access, "logs", "list_logs", "logs");
  // An API from before #1324/#1326 (no `log_retention_days`) has no run log route: its lines are read, as before this
  // screen moved to list_run_logs, from list_logs for the run's UTC day, with no window, no time or level, no paging.
  const older = access.log_retention_days === undefined;
  const day = older && run.status === "ok" ? runDay(run.data) : undefined;
  const retention = access.log_retention_days ?? null;
  // The logs open on what matters (#38): warning and above. When the run's window holds no such line, the page falls
  // back to all levels once, and says so; a floor the reader picks is kept as picked.
  const [severity, setSeverity] = useState<Floor>(DEFAULT_FLOOR);
  const [fellBack, setFellBack] = useState(false);
  const auto = useRef(true);
  const [matchRun, setMatchRun] = useState(false);
  const firstError = useRef<HTMLTableRowElement | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<{ status: "loading" } | Part<Page>>({ status: "loading" });
  const [more, setMore] = useState<More>({ status: "idle" });
  const moreCtl = useRef<AbortController | null>(null);
  const filters = { severity: severity || undefined, matchRun };

  useEffect(() => {
    if (!g.open || (older && !day)) return;
    const ctl = new AbortController();
    const deadline = setTimeout(() => { ctl.abort(); setLoad({ status: "error", error: timedOut(RUN_DEADLINE_MS) }); }, RUN_DEADLINE_MS);
    moreCtl.current?.abort();
    setMore({ status: "idle" });
    setLoad({ status: "loading" });
    const read: Promise<Page> = older && day
      ? getRunLogs(stage, runId, day, { severity: severity === "warning" || severity === "error" ? severity : undefined }, ctl.signal).then((d) => ({
          lines: d.lines.map((l) => ({ ...l, timestamp: l.timestamp ?? null, level: l.level ?? null })), truncated: d.truncated, next: null,
          since: `${day}T00:00:00Z`, until: new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString(), day,
        }))
      : listRunLogs(stage, runId, { severity: severity || undefined, matchRun }, ctl.signal);
    read.then(
      (data) => {
        if (auto.current && severity === DEFAULT_FLOOR && !data.lines.length && !data.truncated) {
          auto.current = false;
          setFellBack(true);
          setSeverity("");
          return;
        }
        setLoad({ status: "ok", data });
      },
      (e) => { if (!ctl.signal.aborted) setLoad({ status: "error", error: failure(e) }); },
    ).finally(() => clearTimeout(deadline));
    return () => { clearTimeout(deadline); ctl.abort(); moreCtl.current?.abort(); };
  }, [g.open, older, day, stage, runId, severity, matchRun, attempt]);

  /** The next page, with the same filters, after the last line shown; its lines are appended, never re-read. */
  const loadMore = () => {
    if (load.status !== "ok" || !load.data.next) return;
    const ctl = new AbortController();
    moreCtl.current = ctl;
    const deadline = setTimeout(() => { ctl.abort(); setMore({ status: "error", error: timedOut(RUN_DEADLINE_MS) }); }, RUN_DEADLINE_MS);
    setMore({ status: "loading" });
    listRunLogs(stage, runId, { ...filters, after: load.data.next }, ctl.signal).then(
      (page) => {
        setLoad((prev) => prev.status === "ok"
          ? { status: "ok", data: { ...page, lines: [...prev.data.lines, ...page.lines], since: prev.data.since } }
          : prev);
        setMore({ status: "idle" });
      },
      (e) => { if (!ctl.signal.aborted) setMore({ status: "error", error: failure(e) }); },
    ).finally(() => clearTimeout(deadline));
  };

  /** A floor the reader picked: no fallback from here on. */
  const pick = (floor: Floor) => { auto.current = false; setFellBack(false); setSeverity(floor); };
  const jump = () => {
    const row = firstError.current;
    if (!row) return;
    row.scrollIntoView?.({ block: "center" });
    row.focus();
  };

  const keptNote = retention !== null ? <span className="run-kept">{kept(retention)}</span> : null;
  let body;
  if (!g.open) {
    body = <>
      <Gap what="Archived logs" part={{ status: "off", state: g.state, reason: g.reason }} />
      {keptNote && <p className="mon-why run-foot"><span className="label">Archive</span> {keptNote}</p>}
    </>;
  } else if (older && !day) {
    body = <Gap what="Archived logs" part={{ status: "off", state: "unknown", reason: "The run's start time could not be read, so its day in the log archive is not known." }} />;
  } else if (load.status === "loading") body = <p className="mon-loading" role="status">Reading the run's archived lines…</p>;
  else if (load.status !== "ok") body = <Gap what="Archived logs" part={load} retry={() => setAttempt((n) => n + 1)} />;
  else {
    const d = load.data;
    // Days, and midnight, are the reader's zone's: a window crosses midnight where its first and last instants fall on two days.
    const first = dayKey(d.since, tz.zone);
    const last = dayKey(toMs(d.until) - 1, tz.zone);
    const crosses = !!first && !!last && first !== last;
    const window = d.day ? (
      <p className="mon-why run-foot">
        <span className="label">Archived</span> {d.day} (UTC) · run {short(runId)}
        {d.truncated ? ` · the first ${d.lines.length} lines only: the rest are in Dagster` : ""}
      </p>
    ) : (
      <p className="mon-why run-foot">
        <span className="label">Window</span> <Time at={d.since} now={now} bare /> → <Time at={d.until} now={now} />{crosses ? " · crosses midnight" : ""}
        {keptNote && <> · {keptNote}</>}
      </p>
    );
    if (!d.lines.length && !d.truncated) {
      body = (
        <>
          <p className="run-step">
            The archive holds no {severity ? `${SEVERITY_LABEL[severity].toLowerCase()} ` : ""}line {matchRun ? "tagged with this run " : ""}{d.day ? `of this run for ${d.day} (UTC)` : "in the run's window"}.
            Lines still in the collector's spool are not archived yet.
          </p>
          {severity && <p className="mon-why"><button type="button" className="f-link" onClick={() => pick("")}>Show all levels</button></p>}
          {window}
        </>
      );
    } else {
      // A window within one day names it in the footer; one that crosses midnight names each day above its lines.
      let shownDay = crosses ? undefined : first;
      const rows: React.ReactNode[] = [];
      const errorAt = d.lines.findIndex((l) => l.level === "error" || l.level === "critical");
      d.lines.forEach((l, i) => {
        const ts = l.timestamp ?? null;
        const lineDay = ts ? dayKey(ts, tz.zone) : undefined;
        if (ts && lineDay && lineDay !== shownDay) {
          shownDay = lineDay;
          rows.push(<tr key={`day-${i}`} className="run-day"><th scope="rowgroup" colSpan={4}><time dateTime={lineDay}>{formatDate(ts, tz.zone, now)}</time></th></tr>);
        }
        const level = l.level ?? null;
        rows.push(
          <tr key={i} {...(i === errorAt ? { ref: firstError, tabIndex: -1, className: "run-first-error" } : {})}>
            <td className="f-mono run-time">{ts && (lineDay ? <Time at={ts} now={now} precision="millisecond" bare clock /> : ts)}</td>
            <td>{level && <span className="run-level" data-level={level}>{level.toUpperCase()}</span>}</td>
            <td className="f-mono">{l.container}</td>
            <td className="f-mono run-line">{l.line ?? <span className="mon-why">Unreadable record: {l.error ?? "no reason given"}</span>}</td>
          </tr>,
        );
      });
      body = (
        <>
          <LevelNote severity={severity} fellBack={fellBack} onAll={() => pick("")} onJump={errorAt >= 0 ? jump : undefined} />
          <div className="f-scroll run-log" role="region" aria-label="Run log lines" tabIndex={0}>
            <table className="f-table mon-table">
              <thead><tr><th scope="col"><Zoned>Time</Zoned></th><th scope="col">Level</th><th scope="col">Container</th><th scope="col">Line</th></tr></thead>
              <tbody>{rows}</tbody>
            </table>
          </div>
          {d.truncated && !d.day && (
            <div className="run-more">
              <p className="mon-why">
                {d.lines.length.toLocaleString("en-US")} lines shown: the window has more{d.next ? "." : ", but the API gave no way to read on: the rest are in Dagster."}
              </p>
              {d.next && (
                <button type="button" className="f-btn f-outline" onClick={loadMore} disabled={more.status === "loading"} aria-describedby="run-logs-count">
                  {more.status === "loading" ? "Loading…" : "Load more"}
                </button>
              )}
              {more.status === "error" && <Gap what="More lines" part={more} retry={loadMore} />}
            </div>
          )}
          {window}
        </>
      );
    }
  }
  const count = load.status === "ok" && g.open ? `${load.data.lines.length.toLocaleString("en-US")}${load.data.truncated ? "+" : ""} lines` : undefined;
  return (
    <Card
      id="run-logs-h"
      title="Logs"
      aside={<>
        {count && <span className="f-count" id="run-logs-count">{count}</span>}
        {g.open && (!older || day) && (
          <div className="run-filters">
            <label className="run-filter">
              <span className="q-label">Level</span>
              <select className="q-select" value={severity} onChange={(e) => pick(e.target.value as Floor)}>
                {(older ? OLDER_FLOORS : (Object.keys(SEVERITY_LABEL) as Floor[])).map((k) => <option key={k} value={k}>{SEVERITY_LABEL[k]}</option>)}
              </select>
            </label>
            {!older && (
              <label className="run-filter f-check">
                <input type="checkbox" checked={matchRun} onChange={(e) => setMatchRun(e.target.checked)} aria-describedby="run-match-why" />
                <span className="q-label">Only this run's lines</span>
              </label>
            )}
          </div>
        )}
        {g.open && (
          <Link className="f-btn f-outline run-dagster" to={`/monitoring/${encodeURIComponent(stage)}/logs?run=${encodeURIComponent(runId)}`}>
            Open in Logs <span aria-hidden="true">↗</span>
          </Link>
        )}
      </>}
    >
      {g.open && !older && (
        <p className="mon-why run-filter-help" id="run-match-why">
          The window holds every workload's lines from the run's start to its end. "Only this run's lines" hides other
          workloads' lines from that window, and older records that carry no run tag.
        </p>
      )}
      {body}
    </Card>
  );
}

/** Which floor the lines are read at, the way back to all levels, and a jump to the first error line. */
function LevelNote({ severity, fellBack, onAll, onJump }: { severity: Floor; fellBack: boolean; onAll(): void; onJump?(): void }) {
  if (!severity && !fellBack && !onJump) return null;
  return (
    <p className="mon-why run-level-note">
      {fellBack
        ? <>No line at warning or above in the run's window, so all levels are shown.</>
        : severity
          ? <>Showing {FLOOR_WORDS[severity]} only. <button type="button" className="f-link" onClick={onAll}>Show all levels</button></>
          : null}
      {onJump && <>{severity || fellBack ? " · " : ""}<button type="button" className="f-link" onClick={onJump}>Jump to first error</button></>}
    </p>
  );
}

const fmt = (n: number) => n.toLocaleString("en-US");
const OUTCOME_WORD: Record<QualityOutcome, string> = { error: "ERROR", warn: "WARN", passed: "PASS", not_run: "NOT RUN", unknown: "UNKNOWN" };
const OUTCOME_RANK: Record<QualityOutcome, number> = { error: 0, warn: 1, unknown: 2, not_run: 3, passed: 4 };
const PIPELINE_WORD: Record<PipelineOutcome, string> = { blocked: "Blocked the run", quarantined: "Rows quarantined", continued: "Run continued", unknown: "Not recorded" };
const ENGINE: Record<string, string> = { floe: "Floe", dbt: "dbt" };
const engineName = (e: string) => ENGINE[e] ?? e;

/** Why a run has no checks to list: no manifest, one that cannot be read, or a source that is off, in the API's words. */
function noManifest(q: RunQuality): { state: HealthState; what: string; reason: string } {
  const src = q.sources.find((s) => s.name === "quality");
  if (!src) return { state: "unknown", what: "Quality checks cannot be read", reason: "The API did not say why the run has no quality manifest." };
  if (src.status === "not_provided") return { state: "disabled", what: "No quality manifest", reason: src.reason };
  if (src.status === "unavailable") return { state: "unknown", what: "The quality manifest cannot be read", reason: src.reason };
  return { state: absent(src) ?? "unknown", what: "Quality checks are not available", reason: src.reason };
}

function Manifestless({ q }: { q: RunQuality }) {
  const m = noManifest(q);
  return <p className="run-gap"><StatusBadge state={m.state} /><span><span className="mon-what">{m.what}</span><span className="mon-why">{m.reason}</span></span></p>;
}

/** The counts the engine recorded for one check; one it did not record is left out, never shown as 0. */
function checkCounts(c: QualityCheck): string[] {
  const out: string[] = [];
  if (c.rejected_rows !== null) out.push(`${fmt(c.rejected_rows)} rejected`);
  if (c.accepted_rows !== null) out.push(`${fmt(c.accepted_rows)} accepted`);
  if (c.rows !== null) out.push(`of ${fmt(c.rows)} rows`);
  if (c.violations !== null) out.push(`${fmt(c.violations)} violation${c.violations === 1 ? "" : "s"}`);
  if (c.failures !== null) out.push(`${fmt(c.failures)} failure${c.failures === 1 ? "" : "s"}`);
  return out;
}

function CheckTable({ label, checks }: { label: string; checks: QualityCheck[] }) {
  return (
    <div className="f-scroll run-checks" role="region" aria-label={label} tabIndex={0}>
      <table className="f-table mon-table">
        <thead><tr><th scope="col">Outcome</th><th scope="col">Check · table · column</th><th scope="col">Pipeline</th><th scope="col">Counts</th></tr></thead>
        <tbody>
          {checks.map((c, i) => {
            const counts = checkCounts(c);
            return (
              <tr key={`${c.engine}-${c.check_id}-${i}`}>
                <td><span className="run-outcome" data-outcome={c.outcome}>{OUTCOME_WORD[c.outcome]}</span></td>
                <th scope="row">
                  <span className="mon-what f-mono">{c.check_id}</span>
                  <span className="mon-why f-mono">{c.table ?? "no table"}{c.column ? ` · ${c.column}` : ""}</span>
                  <span className="mon-why">{engineName(c.engine)} · severity {c.engine_severity}</span>
                </th>
                <td data-pipeline={c.pipeline_outcome}>{PIPELINE_WORD[c.pipeline_outcome]}</td>
                <td>{counts.length ? counts.join(" · ") : <span className="mon-why">No counts recorded</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Every check of the run's quality manifest (#1325): the ones that did not pass first, each with its engine, table,
 * column and counts; the passes collapsed behind their count. */
function QualityChecks({ quality, retry }: { quality: Part<RunQuality>; retry(): void }) {
  let body;
  let count: string | undefined;
  if (quality.status !== "ok") body = <Gap what="Quality checks" part={quality} retry={retry} />;
  else if (quality.data.checks === null) body = <Manifestless q={quality.data} />;
  else if (!quality.data.checks.length) {
    count = "0";
    body = <p className="run-step">The run's quality manifest lists no check.</p>;
  } else {
    const q = quality.data;
    const checks = [...q.checks!].sort((a, b) => OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome]);
    // What did not pass is what a reader of a failure needs; the passes stay one click away, behind their count (#38).
    const open = checks.filter((c) => c.outcome !== "passed");
    const passed = checks.filter((c) => c.outcome === "passed");
    count = open.length ? `${fmt(open.length)} of ${fmt(checks.length)} did not pass` : `${fmt(checks.length)}`;
    body = (
      <>
        {q.complete === false && (
          <p className="run-gap">
            <StatusBadge state="unknown" />
            <span><span className="mon-what">Manifest incomplete</span>
              <span className="mon-why">The run did not finish its quality manifest, so checks may be missing from this list and its counts may be partial.</span></span>
          </p>
        )}
        {open.length ? <CheckTable label="Quality check results" checks={open} /> : (
          <p className="run-step">No check in the run's quality manifest failed, warned, was skipped or is unknown.</p>
        )}
        {passed.length > 0 && (
          <details className="run-passed">
            <summary>
              <span className="run-outcome" data-outcome="passed">{fmt(passed.length)} passed</span>
              <span className="mon-why run-show"> · show them</span>
              <span className="mon-why run-hide"> · hide them</span>
            </summary>
            <CheckTable label="Passed quality checks" checks={passed} />
          </details>
        )}
      </>
    );
  }
  return (
    <Card id="run-checks-h" title="Quality checks" aside={<span className="f-count">{count ?? "—"}</span>}>
      {body}
    </Card>
  );
}

const reportName = (r: QualityReport) => (r.engine === "dbt" ? "dbt results" : `${engineName(r.engine)} report`);

/** The reports the run retained, each a same-origin download; one the API gives no link for says why, never a dead link. */
function Reports({ reports }: { reports: QualityReport[] }) {
  if (!reports.length) return <p className="mon-why">The run retained no Floe or dbt report.</p>;
  const hidden = reports.filter((r) => r.href === null);
  return (
    <div className="run-reports">
      <ul aria-label="Quality reports">
        {reports.map((r) => (
          <li key={r.id}>
            {r.href ? (
              <a className="f-btn f-outline run-report" href={r.href} download>
                {reportName(r)} <span aria-hidden="true">↗</span>
                <span className="sr-only">{`${r.table ? ` for ${r.table}` : ""} (downloads a JSON file)`}</span>
              </a>
            ) : (
              <span className="run-report-off">{reportName(r)}</span>
            )}
            {r.table && <span className="mon-why f-mono">{r.table}</span>}
          </li>
        ))}
      </ul>
      {hidden.length > 0 && (
        <p className="mon-why">
          {hidden.length === reports.length ? (reports.length === 1 ? "This report is" : "These reports are") : `${hidden.map(reportName).join(", ")}:`} not
          downloadable here. The API gives no link to your role on this stage (a report can quote values the run read), or it holds no key to read reports.
        </p>
      )}
    </div>
  );
}

/** Floe's rows from the failure answer and this run's outcome counts from get_run_quality (its reports are linked
 * from the failure summary). */
function Quality({ f, quality, retry }: { f?: RunFailure; quality: Part<RunQuality>; retry(): void }) {
  const q = f && source(f, "quality");
  const rows = f?.rows;
  let counts;
  if (quality.status !== "ok") counts = <Gap what="Quality counts" part={quality} retry={retry} />;
  else if (!quality.data.counts) counts = <Manifestless q={quality.data} />;
  else {
    const c = quality.data.counts;
    counts = (
      <p className="run-counts">
        <span className="mon-what">
          <span className="run-outcome" data-outcome={c.error ? "error" : undefined}>{c.error} error</span> ·{" "}
          <span className="run-outcome" data-outcome={c.warn ? "warn" : undefined}>{c.warn} warn</span> · {c.passed} passed
          {c.blocking ? ` · ${c.blocking} blocking` : ""}
        </span>
        <span className="mon-why">
          {c.not_run ? `${c.not_run} not run · ` : ""}{c.unknown ? `${c.unknown} unknown · ` : ""}
          {quality.data.complete === false ? "manifest incomplete, so these counts may be partial" : "from the run's quality manifest"}
        </span>
      </p>
    );
  }
  return (
    <Card id="run-quality-h" title="Data quality">
      {rows ? (
        <p className="run-rows">
          <strong>{fmt(rows.rejected)}</strong> rows rejected · {fmt(rows.accepted)} accepted
          <span className="mon-why">{rows.complete ? "Floe's counts, from the run's quality manifest." : "The run did not finish its quality manifest, so these sums may be partial."}</span>
        </p>
      ) : f ? (
        <Gap what="Row counts" part={{ status: "off", state: absent(q) ?? "unknown", reason: q?.status === "available" ? "No Floe result in the run's quality manifest reports its rows." : q?.reason ?? "The API did not say why." }} />
      ) : null}
      {counts}
    </Card>
  );
}

function Incidents({ a, runId, job, now, retry }: { a: Part<StageAlertIncidents>; runId: string; job?: string; now: number; retry(): void }) {
  const view = alerts(a);
  const mine = (i: AlertIncident) => i.run_ids.includes(runId) || (!!job && i.job === job);
  const rows = view.ok ? view.data.incidents.filter(mine) : [];
  return (
    <Card id="run-incidents-h" title="Open incidents" aside={<span className="f-count">{view.ok ? rows.length : "—"}</span>}>
      {!view.ok ? (
        a.status === "ok"
          ? <Gap what="Alert incidents" part={{ status: "off", state: view.state, reason: view.reason }} />
          : <Gap what="Alert incidents" part={a} retry={retry} />
      ) : (
        <>
          {view.stale && <p className="mon-why"><StatusBadge state="unknown" /> Stale: {view.data.state.reason}. This list may be out of date.</p>}
          {rows.length ? (
            <ul className="run-incidents">
              {rows.map((i) => (
                <li key={i.id}>
                  <StatusBadge state={i.severity} />
                  <span>
                    <span className="mon-what">{i.summary}</span>
                    <span className="mon-why f-mono">{i.condition}{i.table ? ` · ${i.table}` : ""} · opened <Time at={i.opened_at} now={now} /> · last seen <Ago at={i.last_seen_at} now={now} /></span>
                    <span className="mon-why"><span className="mon-delivery" data-status={i.delivery.status}>{DELIVERY[i.delivery.status]}</span> {deliveryLine(i.delivery)}</span>
                    <IncidentRunbook incident={i} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mon-why">{view.stale ? "No open incident for this run in the last evaluation, but it is stale." : "No open incident names this run or its pipeline."}</p>
          )}
        </>
      )}
    </Card>
  );
}

function OpenInDagster({ url, runId }: { url?: string; runId: string }) {
  if (!url) return <p className="mon-why">No Dagster address is published for this stage, so the run cannot be linked.</p>;
  return (
    <a className="f-btn f-outline run-dagster" href={`${url.replace(/\/$/, "")}/runs/${encodeURIComponent(runId)}`} target="_blank" rel="noopener noreferrer">
      Open in Dagster <span aria-hidden="true">↗</span><span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return <div><dt className="label">{term}</dt><dd>{children}</dd></div>;
}

/** Monitoring · Failed run: one run of `stage`, reached from Needs attention, the pipelines table or an incident. */
export function MonitoringRun({ stage, runId, dagster }: { stage: string; runId: string; dagster?: string }) {
  const [caps, setCaps] = useState<Caps>({ status: "loading" });
  const [capsAttempt, setCapsAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const access = caps.status === "ok" ? caps.data.stages.find((s) => s.stage === stage) : undefined;

  // The clock advances as on the overview, so a healthy pipeline signal that expires while the page is open turns
  // Unknown: evidence past its expiry is never shown as current.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    const deadline = setTimeout(() => { ctl.abort(); setCaps({ status: "error", error: timedOut(DEADLINE_MS) }); }, DEADLINE_MS);
    setCaps({ status: "loading" });
    getMonitoringCapabilities(ctl.signal).then(
      (data) => setCaps({ status: "ok", data }),
      (e) => { if (!ctl.signal.aborted) setCaps({ status: "error", error: failure(e) }); },
    ).finally(() => clearTimeout(deadline));
    return () => { clearTimeout(deadline); ctl.abort(); };
  }, [capsAttempt]);

  useEffect(() => {
    if (!access) return;
    const ctl = new AbortController();
    let late: () => void = () => {};
    const lateness = new Promise<Part<never>>((resolve) => { late = () => resolve({ status: "error", error: timedOut(RUN_DEADLINE_MS) }); });
    const deadline = setTimeout(() => { late(); ctl.abort(); }, RUN_DEADLINE_MS);
    /** One read, raced against the deadline; a closed gate makes no request at all. */
    const part = <T,>(g: Gate, read: () => Promise<T>): Promise<Part<T>> => g.open
      ? Promise.race([read().then((data): Part<T> => ({ status: "ok", data }), (e): Part<T> => ({ status: "error", error: failure(e) })), lateness])
      : Promise.resolve({ status: "off", state: g.state, reason: g.reason });
    // The capabilities list get_run, get_run_failure and get_run_quality (#1324, #1325): a read the role lacks is not
    // made, and the card says why. A route the capabilities offered that still answers 403 is shown in the API's words.
    let live = true;
    setLoad({ status: "loading" });
    Promise.all([
      part(runGate(access, "get_run_failure", "this run's failure"), () => getRunFailure(stage, runId, ctl.signal)),
      part(runGate(access, "get_run", "this run"), () => getRun(stage, runId, ctl.signal)),
      part(gate(access, "dagster", "list_pipeline_health", "pipeline health"), () => getPipelinesHealth(stage, ctl.signal)),
      part(runGate(access, "get_run_quality", "this run's quality checks"), () => getRunQuality(stage, runId, ctl.signal)),
      part(gate(access, "alerts", "list_alert_incidents", "alert incidents"), () => getAlertIncidents(stage, ctl.signal)),
    ]).then(([failureLoad, run, pipes, quality, alertsLoad]) => {
      clearTimeout(deadline);
      if (!live) return;
      const at = Date.now();
      setNow(at);
      setLoad({ status: "ok", snap: { failure: failureLoad, run, pipes, quality, alerts: alertsLoad }, at });
    });
    return () => { live = false; clearTimeout(deadline); ctl.abort(); };
  }, [access, stage, runId, attempt]);

  const STAGE = stage.toUpperCase();
  const snap = load.status === "ok" ? load.snap : undefined;
  const f = snap?.failure.status === "ok" ? snap.failure.data : undefined;
  const run = snap?.run.status === "ok" ? snap.run.data : undefined;
  const job = f?.job ?? run?.job_name;
  const pipeline = snap?.pipes.status === "ok" && job ? snap.pipes.data.pipelines.find((p) => p.job === job) : undefined;
  // The pipeline's state now, as the overview reads it: an expired signal is unknown, never green.
  const read = snap ? pipes(snap.pipes, now) : undefined;
  const shown = read?.ok ? read.pipelines.find((p) => p.job === job)?.shown : undefined;
  const incident = snap?.alerts.status === "ok" && job ? snap.alerts.data.incidents?.find((i) => i.job === job && (i.domain || i.product)) : undefined;
  // The failure answer names the run's own domain and product (#1327); the pipelines answer, then an incident of the
  // job, stand in only where it has none (an older API, or a failure that could not be read).
  const domain = f?.domain ?? pipeline?.domain ?? incident?.domain ?? null;
  const product = f?.product ?? pipeline?.product ?? incident?.product ?? null;
  const scope = domain && product ? `${domain} · ${product}` : product ?? domain;
  const status = f?.status ?? run?.status;
  const state: HealthState = status ? runState(status) : "unknown";
  const firstStep = f?.steps?.[0]?.step;
  // Why the scope is not known, in words: the API's, or that the job declares none.
  // A failure answer from an API with #1327 that names none is the job's own word; an older one says nothing either way.
  const scopeWhy = !snap ? "" : f && access?.log_retention_days !== undefined ? "the job declares no data product"
    : snap.pipes.status === "off" ? snap.pipes.reason
    : snap.pipes.status === "error" ? snap.pipes.error.message
    : pipeline ? "the job declares no data product" : "the pipelines answer does not list this job";

  let body;
  if (caps.status === "loading") body = <p className="mon-loading" role="status">Reading your monitoring access…</p>;
  else if (caps.status === "error") body = <Problem state="unknown" title="Monitoring access cannot be read" error={caps.error} onRetry={() => setCapsAttempt((n) => n + 1)} />;
  else if (!access) {
    body = <Problem state="disabled" title={`${STAGE} monitoring is not available`} error={new ApiError(403, `Your role has no monitoring access on stage ${STAGE}, so this run is not read.`)} />;
  } else if (!snap) body = <p className="mon-loading" role="status">Reading run {short(runId)}…</p>;
  else if (snap.failure.status === "off") {
    body = <Problem state={snap.failure.state} title="This run's failure is not available" error={new ApiError(403, snap.failure.reason)} />;
  } else if (snap.failure.status !== "ok") {
    const e = snap.failure.error;
    body = (
      <Problem
        state={denied(e) ? "disabled" : "unknown"}
        title={e.status === 404 ? `Run ${short(runId)} was not found` : denied(e) ? "This run's failure is not available" : "This run's failure cannot be read"}
        error={e}
        onRetry={retry}
      />
    );
  } else {
    const fd = snap.failure.data;
    body = (
      // The failure summary first, then the logs at full width, then the checks beside the counts and incidents (#38).
      <div className="run-col">
        <WhatFailed f={fd} run={snap.run} quality={snap.quality} stage={stage} runId={runId} dagster={dagster} now={now} />
        <RunLogs access={access} stage={stage} runId={runId} run={snap.run} now={now} />
        <div className="run-cols">
          <div className="run-col">
            <QualityChecks quality={snap.quality} retry={retry} />
          </div>
          <div className="run-col">
            <Quality f={fd} quality={snap.quality} retry={retry} />
            <Incidents a={snap.alerts} runId={runId} job={fd.job} now={now} retry={retry} />
          </div>
        </div>
      </div>
    );
  }

  // Only Dagster's own start time is a start: a run with none has not started, or its start is unknown. Its creation
  // time is never shown, or used for a duration, as a start.
  const started = run?.started_at ?? undefined;
  const notYet = run && run.started_at === null && ["QUEUED", "NOT_STARTED", "STARTING"].includes(run.status);
  return (
    <>
      <nav aria-label="Breadcrumb">
        <ol className="f-crumbs run-crumbs label">
          <li><Link to="/monitoring">Monitoring</Link></li>
          <li aria-hidden="true">/</li>
          <li><Link to={`/monitoring?stage=${encodeURIComponent(stage)}`}>{STAGE}</Link></li>
          {scope && <><li aria-hidden="true">/</li><li>{scope}</li></>}
          <li aria-hidden="true">/</li>
          <li className="f-current" aria-current="page">Run {short(runId)}</li>
        </ol>
      </nav>
      <div className="q-head run-head">
        <div>
          <h1>{scope ?? job ?? `Run ${short(runId)}`}</h1>
          <p className="f-sub">
            {job ? <>Pipeline <span className="f-mono">{job}</span></> : <>Run <span className="f-mono">{runId}</span></>}
            {started !== undefined && <> · started <Time at={seconds(started)} now={now} /></>}
            {status && ` · ${RUN_WORD[status] ?? status.toLowerCase()}`}
            {run?.ended_at != null && started !== undefined && ` after ${duration(run.ended_at - started)}`}
          </p>
        </div>
        {/* With a failure to summarize, its card carries the link; otherwise the run is still one click from Dagster. */}
        <div className="mon-head-end">
          <ZoneSwitch />
          {snap?.failure.status !== "ok" && <OpenInDagster url={dagster} runId={runId} />}
        </div>
      </div>
      <ul className="run-chips" aria-label="Run">
        <li><StatusBadge state={state} /></li>
        <li className="run-chip"><span className="label">Stage</span> {STAGE}</li>
        {firstStep && <li className="run-chip"><span className="label">Step</span> <span className="f-mono">{firstStep}</span></li>}
        <li className="run-chip"><span className="label">Dagster run</span> <span className="f-mono">{short(runId)}</span></li>
      </ul>
      {snap && (
        <dl className="run-facts">
          <Fact term="Domain · product">{scope ?? <span className="mon-why">Not known: {scopeWhy}</span>}</Fact>
          <Fact term="Started">{started !== undefined ? <Time at={seconds(started)} now={now} />
            : notYet ? <span className="mon-why">Not started</span>
            : <span className="mon-why">{run ? "Start unknown: Dagster recorded no start time for this run" : `Not known: ${snap.run.status === "error" ? snap.run.error.message : "no start time"}`}</span>}</Fact>
          <Fact term="Ended">{run?.ended_at != null ? <Time at={seconds(run.ended_at)} now={now} /> : <span className="mon-why">{run ? "Not ended, or no end time recorded" : "Not known"}</span>}</Fact>
          <Fact term="Pipeline now">{shown ? <StatusBadge state={shown} /> : <span className="mon-why">Not known</span>}</Fact>
        </dl>
      )}
      {body}
    </>
  );
}

function Problem({ state, title, error, onRetry }: { state: HealthState; title: string; error: ApiError; onRetry?(): void }) {
  const retryable = !denied(error) && onRetry;
  return (
    <section className="mon-banner mon-state" data-state={state} aria-labelledby="run-problem-h">
      <div>
        <h2 id="run-problem-h"><StatusBadge state={state} /> {title}</h2>
        <p role="alert">{error.message}</p>
        {retryable && <button type="button" className="f-btn f-outline" onClick={onRetry}><span aria-hidden="true">↻</span> Retry</button>}
      </div>
    </section>
  );
}
