// Monitoring · Failed run (Figma "Screens — v0.4 · Monitoring", Failed run): what one run's failure was, from
// GET /api/v1/stages/{stage}/runs/{run_id}/failure, with its scope, quality evidence, open incidents and archived lines.
// Read-only: there is no Re-run in v0.7 (openlakeforge#333, 2026-11-16); the next step is the run in Dagster.
// Nothing here is inferred. A part the API could not read says so in its own words, and none of it reads green.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  ApiError, gate, getAlertIncidents, getMonitoringCapabilities, getPipelinesHealth, getQualityHealth, getRun, getRunFailure, getRunLogs,
  type AlertIncident, type Gate, type HealthState, type Integration, type LogSeverity, type Logs, type MonitoringCapabilities,
  type MonitoringStage, type PipelinesHealth, type Run, type RunFailure, type StageAlertIncidents, type StageQualityHealth,
} from "../lib/health-api";
import { ago, DEADLINE_MS } from "./Monitoring";
import { alerts, DELIVERY, deliveryLine } from "./MonitoringAlerts";
import { absent, pipes, runHref, when, type Part } from "./MonitoringPipelines";
import { StatusBadge } from "./StatusBadge";

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

/** The run's UTC day, as the log archive is laid out; the run's start, else its creation. */
export const runDay = (r: Run) => new Date((r.started_at ?? r.created_at) * 1000).toISOString().slice(0, 10);

type Snap = {
  failure: Part<RunFailure>;
  run: Part<Run>;
  pipes: Part<PipelinesHealth>;
  quality: Part<StageQualityHealth>;
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

function WhatFailed({ f }: { f: RunFailure }) {
  const dagster = source(f, "dagster");
  let body;
  if (f.steps === null) {
    // An unreadable event log is no evidence that nothing failed.
    body = <Gap what="The failed steps" part={{ status: "off", state: absent(dagster) ?? "unknown", reason: dagster?.reason ?? "the run's event log could not be read" }} />;
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
  return (
    <Card id="run-failed-h" title="What failed">
      {body}
      {f.steps_truncated && <p className="mon-why">More steps failed than are shown here: open the run in Dagster for all of them.</p>}
    </Card>
  );
}

const SEVERITY_LABEL: Record<"" | LogSeverity, string> = { "": "All levels", warning: "Warning and above", error: "Error and above" };

function RunLogs({ access, stage, runId, run }: { access: MonitoringStage; stage: string; runId: string; run: Part<Run> }) {
  const g = gate(access, "logs", "list_logs", "logs");
  const day = run.status === "ok" ? runDay(run.data) : undefined;
  const [severity, setSeverity] = useState<"" | LogSeverity>("");
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<{ status: "loading" } | Part<Logs>>({ status: "loading" });
  useEffect(() => {
    if (!g.open || !day) return;
    const ctl = new AbortController();
    const deadline = setTimeout(() => { ctl.abort(); setLoad({ status: "error", error: timedOut(DEADLINE_MS) }); }, DEADLINE_MS);
    setLoad({ status: "loading" });
    getRunLogs(stage, runId, day, { severity: severity || undefined }, ctl.signal).then(
      (data) => setLoad({ status: "ok", data }),
      (e) => { if (!ctl.signal.aborted) setLoad({ status: "error", error: failure(e) }); },
    ).finally(() => clearTimeout(deadline));
    return () => { clearTimeout(deadline); ctl.abort(); };
  }, [g.open, stage, runId, day, severity, attempt]);

  let body;
  if (!g.open) body = <Gap what="Archived logs" part={{ status: "off", state: g.state, reason: g.reason }} />;
  else if (!day) {
    body = <Gap what="Archived logs" part={{ status: "off", state: "unknown", reason: "The run's start time could not be read, so its day in the log archive is not known." }} />;
  } else if (load.status === "loading") body = <p className="mon-loading" role="status">Reading the run's archived lines…</p>;
  else if (load.status !== "ok") body = <Gap what="Archived logs" part={load} retry={() => setAttempt((n) => n + 1)} />;
  else if (!load.data.lines.length) {
    body = (
      <p className="run-step">
        The archive holds no {severity ? `${SEVERITY_LABEL[severity].toLowerCase()} ` : ""}line of this run for {day} (UTC).
        Lines still in the collector's spool are not archived yet.
      </p>
    );
  } else {
    body = (
      <>
        <div className="f-scroll run-log" role="region" aria-label="Run log lines" tabIndex={0}>
          <table className="f-table mon-table">
            <thead><tr><th scope="col">Container</th><th scope="col">Line</th></tr></thead>
            <tbody>
              {load.data.lines.map((l, i) => (
                <tr key={i}>
                  <td className="f-mono">{l.container}</td>
                  <td className="f-mono run-line">{l.line ?? <span className="mon-why">Unreadable record: {l.error ?? "no reason given"}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mon-why run-foot">
          <span className="label">Archived</span> {day} (UTC) · run {short(runId)}
          {load.data.truncated ? ` · the first ${load.data.lines.length} lines only: the rest are in Dagster` : ""}
        </p>
      </>
    );
  }
  const count = load.status === "ok" && g.open && day ? `${load.data.lines.length}${load.data.truncated ? "+" : ""} lines` : undefined;
  return (
    <Card
      id="run-logs-h"
      title="Logs"
      aside={<>
        {count && <span className="f-count">{count}</span>}
        {g.open && day && (
          <label className="run-filter">
            <span className="q-label">Level</span>
            <select className="q-select" value={severity} onChange={(e) => setSeverity(e.target.value as "" | LogSeverity)}>
              {(Object.keys(SEVERITY_LABEL) as ("" | LogSeverity)[]).map((k) => <option key={k} value={k}>{SEVERITY_LABEL[k]}</option>)}
            </select>
          </label>
        )}
      </>}
    >
      {body}
    </Card>
  );
}

const fmt = (n: number) => n.toLocaleString("en-US");

function Quality({ f, quality, stage, runId, now, retry }: { f?: RunFailure; quality: Part<StageQualityHealth>; stage: string; runId: string; now: number; retry(): void }) {
  const q = f && source(f, "quality");
  const rows = f?.rows;
  const entry = quality.status === "ok" && f ? quality.data.pipelines.find((p) => p.job === f.job) : undefined;
  // As the overview's quality(): a Dagster that could not be read, or a manifest reader that is not there, gives no
  // counts at all, and says why, rather than reading as a pipeline with no evidence.
  const missing = quality.status === "ok"
    ? (["dagster", "quality"] as const).map((name) => quality.data.integrations.find((i) => i.name === name) ?? { name, status: "unavailable" as const, reason: `the API did not say whether ${name} could be read` })
        .find((i) => absent(i))
    : undefined;
  let counts;
  if (quality.status !== "ok") counts = <Gap what="Quality counts" part={quality} retry={retry} />;
  else if (missing) counts = <Gap what="Quality counts" part={{ status: "off", state: absent(missing)!, reason: missing.reason }} />;
  else if (!entry) counts = <p className="mon-why">The API reports no quality evidence for this pipeline.</p>;
  else if (entry.run_id !== runId) {
    counts = (
      <p className="mon-why">
        The stage's quality counts are for {entry.run_id ? <>run <Link className="run-link" to={runHref(stage, entry.run_id)}>{short(entry.run_id)}</Link></> : "no run"} of this pipeline, not this one.
      </p>
    );
  } else if (!entry.counts) {
    counts = <p className="run-gap"><StatusBadge state="unknown" /><span><span className="mon-what">Counts unknown</span><span className="mon-why">{entry.reason}</span></span></p>;
  } else {
    const c = entry.counts;
    counts = (
      <div className="run-gap">
        <StatusBadge state={entry.state} />
        <span>
          <span className="mon-what">{c.error} error · {c.warn} warn · {c.passed} passed{c.blocking ? ` · ${c.blocking} blocking` : ""}</span>
          <span className="mon-why">
            {c.not_run ? `${c.not_run} not run · ` : ""}{c.unknown ? `${c.unknown} unknown · ` : ""}{entry.reason}
            {entry.complete === false ? " · manifest incomplete" : ""}{entry.observed_at ? ` · ${ago(entry.observed_at, now)}` : ""}
          </span>
        </span>
      </div>
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
                    <span className="mon-why f-mono">{i.condition}{i.table ? ` · ${i.table}` : ""} · opened {when(i.opened_at, now)} · last seen {ago(i.last_seen_at, now)}</span>
                    <span className="mon-why"><span className="mon-delivery" data-status={i.delivery.status}>{DELIVERY[i.delivery.status]}</span> {deliveryLine(i.delivery)}</span>
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

function NextStep({ f, dagster, runId }: { f?: RunFailure; dagster?: string; runId: string }) {
  const failed = f?.status === "FAILURE";
  return (
    <Card id="run-next-h" title="Next step">
      <p className="run-step">{failed ? "Fix the cause, then re-run in Dagster" : "Look at the run in Dagster"}</p>
      <p className="mon-why">
        {failed
          ? `${f.steps === null ? "The failed steps could not be read here: Dagster's event log has them." : "Read what the failing step reports above and in the run's logs."} Run control is not in the portal: once the cause is fixed, re-run ${f.job} from Dagster.`
          : "Run control is not in the portal: the run, its full event log and its re-execution are in Dagster."}
      </p>
      <OpenInDagster url={dagster} runId={runId} />
    </Card>
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
    // get_run_failure and get_run are not monitoring operations, so the capabilities cannot say whether the role may
    // call them: they are asked, and a 403 is shown in the API's words.
    const always: Gate = { open: true };
    const qualityGate = gate(access, "quality", "get_stage_quality_health", "quality counts");
    let live = true;
    setLoad({ status: "loading" });
    Promise.all([
      part(always, () => getRunFailure(stage, runId, ctl.signal)),
      part(always, () => getRun(stage, runId, ctl.signal)),
      part(gate(access, "dagster", "list_pipeline_health", "pipeline health"), () => getPipelinesHealth(stage, ctl.signal)),
      part(qualityGate.open ? gate(access, "dagster", "get_stage_quality_health", "quality counts") : qualityGate, () => getQualityHealth(stage, ctl.signal)),
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
  const domain = pipeline?.domain ?? incident?.domain ?? null;
  const product = pipeline?.product ?? incident?.product ?? null;
  const scope = domain && product ? `${domain} · ${product}` : product ?? domain;
  const status = f?.status ?? run?.status;
  const state: HealthState = status ? runState(status) : "unknown";
  const firstStep = f?.steps?.[0]?.step;
  // Why the scope is not known, in words: the API's, or that the job declares none.
  const scopeWhy = !snap ? "" : snap.pipes.status === "off" ? snap.pipes.reason
    : snap.pipes.status === "error" ? snap.pipes.error.message
    : pipeline ? "the job declares no data product" : "the pipelines answer does not list this job";

  let body;
  if (caps.status === "loading") body = <p className="mon-loading" role="status">Reading your monitoring access…</p>;
  else if (caps.status === "error") body = <Problem state="unknown" title="Monitoring access cannot be read" error={caps.error} onRetry={() => setCapsAttempt((n) => n + 1)} />;
  else if (!access) {
    body = <Problem state="disabled" title={`${STAGE} monitoring is not available`} error={new ApiError(403, `Your role has no monitoring access on stage ${STAGE}, so this run is not read.`)} />;
  } else if (!snap) body = <p className="mon-loading" role="status">Reading run {short(runId)}…</p>;
  else if (snap.failure.status !== "ok") {
    const e = snap.failure.status === "error" ? snap.failure.error : new ApiError(0, "");
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
      <div className="run-cols">
        <div className="run-col">
          <WhatFailed f={fd} />
          <RunLogs access={access} stage={stage} runId={runId} run={snap.run} />
        </div>
        <div className="run-col">
          <Quality f={fd} quality={snap.quality} stage={stage} runId={runId} now={now} retry={retry} />
          <Incidents a={snap.alerts} runId={runId} job={fd.job} now={now} retry={retry} />
          <NextStep f={fd} dagster={dagster} runId={runId} />
        </div>
      </div>
    );
  }

  // Only Dagster's own start time is a start: a run with none has not started, or its start is unknown. Its creation
  // time picks the log archive's day (runDay) and is never shown, or used for a duration, as a start.
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
            {started !== undefined && ` · started ${when(started, now)}`}
            {status && ` · ${RUN_WORD[status] ?? status.toLowerCase()}`}
            {run?.ended_at != null && started !== undefined && ` after ${duration(run.ended_at - started)}`}
          </p>
        </div>
        <OpenInDagster url={dagster} runId={runId} />
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
          <Fact term="Started">{started !== undefined ? when(started, now)
            : notYet ? <span className="mon-why">Not started</span>
            : <span className="mon-why">{run ? "Start unknown: Dagster recorded no start time for this run" : `Not known: ${snap.run.status === "error" ? snap.run.error.message : "no start time"}`}</span>}</Fact>
          <Fact term="Ended">{run?.ended_at != null ? when(run.ended_at, now) : <span className="mon-why">{run ? "Not ended, or no end time recorded" : "Not known"}</span>}</Fact>
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
