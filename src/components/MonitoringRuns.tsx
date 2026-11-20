// Monitoring · Runs (portal#37): a stage's runs, newest first, each linked to its run screen. From
// GET /api/v1/stages/{stage}/runs (job filter and a limit of at most 100, nothing else) and, for each job's domain and
// product, GET /api/v1/stages/{stage}/health/pipelines. Status, product and time window are filtered here, among the
// runs read, and the page says how far back that read reaches: it never claims a run it did not read.
//
// Its address is a contract other pages link to: /monitoring/<stage>/runs?job=<job>&status=failed|succeeded|in_progress
// &window=1h|6h|24h|7d (24h by default), plus product=<product>.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  ApiError, gate, getMonitoringCapabilities, getPipelinesHealth, listRuns, runsGate, RUNS_LIMIT,
  type Gate, type HealthRange, type HealthState, type MonitoringCapabilities, type PipelinesHealth, type Run, type Runs,
} from "../lib/health-api";
import { seconds } from "../lib/time";
import { DEADLINE_MS } from "./Monitoring";
import { pipes, RunLink, type Part } from "./MonitoringPipelines";
import { duration, runState } from "./MonitoringRun";
import { MonitoringViews } from "./MonitoringViews";
import { StatusBadge } from "./StatusBadge";
import { Ago, Time, Zoned, ZoneSwitch } from "./Time";

export const RUN_WINDOWS: readonly HealthRange[] = ["1h", "6h", "24h", "7d"];
/** The window a page opens with: the health routes' default. */
export const DEFAULT_WINDOW: HealthRange = "24h";
const WINDOW_SECONDS: Record<HealthRange, number> = { "1h": 3600, "6h": 6 * 3600, "24h": 24 * 3600, "7d": 7 * 24 * 3600 };
const WINDOW_WORDS: Record<HealthRange, string> = { "1h": "1 hour", "6h": "6 hours", "24h": "24 hours", "7d": "7 days" };

export type RunFilter = "failed" | "succeeded" | "in_progress";
export const RUN_FILTERS: readonly RunFilter[] = ["failed", "succeeded", "in_progress"];
const FILTER_WORDS: Record<RunFilter | "", string> = { "": "All", failed: "Failed", succeeded: "Succeeded", in_progress: "In progress" };
/** Dagster's statuses of a run that has not ended. `CANCELED` ends a run without success or failure: it shows under All only. */
const IN_PROGRESS = new Set(["QUEUED", "NOT_STARTED", "MANAGED", "STARTING", "STARTED", "CANCELING"]);
const NOT_STARTED = new Set(["QUEUED", "NOT_STARTED", "MANAGED", "STARTING"]);

/** Whether a run's Dagster status is the one `filter` asks for. */
export function matchesStatus(status: string, filter: RunFilter | ""): boolean {
  if (filter === "failed") return status === "FAILURE";
  if (filter === "succeeded") return status === "SUCCESS";
  if (filter === "in_progress") return IN_PROGRESS.has(status);
  return true;
}

const STATUS_WORD: Record<string, string> = {
  SUCCESS: "Succeeded", FAILURE: "Failed", CANCELED: "Canceled", CANCELING: "Canceling", STARTED: "Running", QUEUED: "Queued",
  STARTING: "Starting", NOT_STARTED: "Not started", MANAGED: "Managed",
};

/** The address of a stage's Runs page with these filters; the default window and empty filters are left out. */
export function runsHref(stage: string, f: { job?: string; product?: string; status?: RunFilter | ""; window?: HealthRange } = {}): string {
  const q = new URLSearchParams();
  if (f.job) q.set("job", f.job);
  if (f.product) q.set("product", f.product);
  if (f.status) q.set("status", f.status);
  if (f.window && f.window !== DEFAULT_WINDOW) q.set("window", f.window);
  const s = q.toString();
  return `/monitoring/${encodeURIComponent(stage)}/runs${s ? `?${s}` : ""}`;
}

/** What the read covers of the window: everything, or only back to its oldest run when it reached the limit first. */
export function coverage(runs: Run[], limit: number, windowStart: number): { complete: boolean; oldest: number | null; coveredFrom: number | null } {
  const oldest = runs.length ? Math.min(...runs.map((r) => r.created_at)) : null;
  const complete = runs.length < limit;
  return { complete, oldest, coveredFrom: !complete && oldest !== null && oldest > windowStart ? oldest : null };
}

const failure = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, String(e)));
const denied = (e: ApiError) => e.status === 401 || e.status === 403 || e.status === 404;
const timedOut = () => new ApiError(0, `The monitoring API did not answer within ${DEADLINE_MS / 1000} s, so no run can be listed.`);

type Caps = { status: "loading" } | { status: "ok"; data: MonitoringCapabilities } | { status: "error"; error: ApiError };
type Snap = { runs: Part<Runs>; pipes: Part<PipelinesHealth>; at: number };
type Load = { status: "loading" } | { status: "ok"; key: string; snap: Snap };

/** A run's Dagster status in words, with the colour of the state it reads as. The word carries the meaning. */
function RunStatus({ status }: { status: string }) {
  return (
    <span className="mon-badge" data-state={IN_PROGRESS.has(status) ? "unknown" : runState(status)}>
      <span className="mon-dot" aria-hidden="true" />
      {STATUS_WORD[status] ?? status}
    </span>
  );
}

function Problem({ state, title, error, onRetry }: { state: HealthState; title: string; error: ApiError; onRetry?(): void }) {
  const retryable = !denied(error) && onRetry;
  return (
    <section className="mon-banner mon-state" data-state={state} aria-labelledby="rl-problem-h">
      <div>
        <h2 id="rl-problem-h"><StatusBadge state={state} /> {title}</h2>
        <p role="alert">{error.message}</p>
        {retryable && <button type="button" className="f-btn f-outline" onClick={onRetry}><span aria-hidden="true">↻</span> Retry</button>}
      </div>
    </section>
  );
}

function Segments<T extends string>({ legend, name, value, options, words, label, onPick }: {
  legend: string; name: string; value: T; options: readonly T[]; words: Record<T, string>; label(o: T): string; onPick(o: T): void;
}) {
  return (
    <fieldset className="mc-range">
      <legend className="q-label">{legend}</legend>
      <div className="mc-segments">
        {options.map((o) => (
          <label key={o || "all"}>
            <input type="radio" name={name} value={o} checked={o === value} onChange={() => onPick(o)} aria-label={label(o)} />
            <span aria-hidden="true">{words[o]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Monitoring · Runs: one stage's runs, filtered by pipeline, product, status and window, each linked to its run screen. */
export function MonitoringRuns({ stage, stages }: { stage: string; stages: string[] }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [caps, setCaps] = useState<Caps>({ status: "loading" });
  const [capsAttempt, setCapsAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  const job = params.get("job") ?? "";
  const product = params.get("product") ?? "";
  const askedStatus = params.get("status") ?? "";
  const status: RunFilter | "" = (RUN_FILTERS as readonly string[]).includes(askedStatus) ? (askedStatus as RunFilter) : "";
  const askedWindow = params.get("window") ?? "";
  const win: HealthRange = (RUN_WINDOWS as readonly string[]).includes(askedWindow) ? (askedWindow as HealthRange) : DEFAULT_WINDOW;

  const offered = caps.status === "ok" ? caps.data.stages.map((s) => s.stage) : [];
  const access = caps.status === "ok" ? caps.data.stages.find((s) => s.stage === stage) : undefined;
  const runsOpen = access ? runsGate(access) : undefined;
  const STAGE = stage.toUpperCase();

  useEffect(() => {
    if (!stages.length) return;
    const ctl = new AbortController();
    const deadline = setTimeout(() => { ctl.abort(); setCaps({ status: "error", error: timedOut() }); }, DEADLINE_MS);
    setCaps({ status: "loading" });
    getMonitoringCapabilities(ctl.signal).then(
      (data) => setCaps({ status: "ok", data }),
      (e) => { if (!ctl.signal.aborted) setCaps({ status: "error", error: failure(e) }); },
    ).finally(() => clearTimeout(deadline));
    return () => { clearTimeout(deadline); ctl.abort(); };
  }, [stages.length, capsAttempt]);

  // One read of the runs (of `job` when one is picked) and one of the pipelines, together, under the page's deadline.
  // Status, product and window change nothing here: they filter the runs already read.
  const key = `${stage}\n${job}\n${attempt}`;
  useEffect(() => {
    if (!access || !runsOpen?.open) return;
    const ctl = new AbortController();
    let late: () => void = () => {};
    const lateness = new Promise<Part<never>>((resolve) => { late = () => resolve({ status: "error", error: timedOut() }); });
    const deadline = setTimeout(() => { late(); ctl.abort(); }, DEADLINE_MS);
    const part = <T,>(g: Gate, read: () => Promise<T>): Promise<Part<T>> => g.open
      ? Promise.race([read().then((data): Part<T> => ({ status: "ok", data }), (e): Part<T> => ({ status: "error", error: failure(e) })), lateness])
      : Promise.resolve({ status: "off", state: g.state, reason: g.reason });
    let live = true;
    setLoad({ status: "loading" });
    Promise.all([
      part({ open: true }, () => listRuns(stage, { job: job || undefined, limit: RUNS_LIMIT }, ctl.signal)),
      part(gate(access, "dagster", "list_pipeline_health", "pipeline health"), () => getPipelinesHealth(stage, ctl.signal)),
    ]).then(([runs, pipes]) => {
      clearTimeout(deadline);
      if (!live) return;
      const at = Date.now();
      setNow(at);
      setLoad({ status: "ok", key, snap: { runs, pipes, at } });
    });
    return () => { live = false; clearTimeout(deadline); ctl.abort(); };
    // `runsOpen` is rebuilt on every render; `access` and the key say when to read again.
  }, [access, key]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(tick);
  }, []);

  /** Changes the filters in the address; a stage switch drops the job and product, which belong to the old stage. */
  const pick = (next: { stage?: string; job?: string; product?: string; status?: RunFilter | ""; window?: HealthRange }) => {
    if (next.stage !== undefined && next.stage !== stage) {
      navigate(runsHref(next.stage, { status, window: win }));
      return;
    }
    const merged = { job, product, status, window: win, ...next };
    const q = new URLSearchParams(runsHref(stage, merged).split("?")[1] ?? "");
    setParams(q);
  };

  const snap = load.status === "ok" && load.key === key ? load.snap : undefined;
  // Read as the overview reads it: a 200 whose Dagster integration is unavailable or disabled lists no pipeline, and
  // says why; the runs' scope is then unknown, never "no product".
  const pipesRead = snap ? pipes(snap.pipes, now) : undefined;
  const pipelines = pipesRead?.ok ? pipesRead.pipelines : undefined;
  const scopeOf = new Map(pipelines?.map((p) => [p.job, p]) ?? []);
  const runs = snap?.runs.status === "ok" ? snap.runs.data.runs : undefined;
  const jobs = [...new Set([...(pipelines?.map((p) => p.job) ?? []), ...(runs?.map((r) => r.job_name) ?? []), ...(job ? [job] : [])])].sort();
  const products = [...new Map((pipelines ?? []).filter((p) => p.product).map((p) => [p.product!, p.domain ? `${p.domain} · ${p.product}` : p.product!])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  if (product && !products.some(([p]) => p === product)) products.push([product, product]);
  const pipesWhy = pipesRead && !pipesRead.ok ? pipesRead.reason : "";

  let body;
  if (stages.length === 0) {
    body = <p className="empty"><span className="label">No stages</span>This deployment has no stage to monitor yet.</p>;
  } else if (caps.status === "loading") {
    body = <p className="mon-loading" role="status">Reading your monitoring access…</p>;
  } else if (caps.status === "error") {
    body = <Problem state={denied(caps.error) ? "disabled" : "unknown"} title="Monitoring access cannot be read" error={caps.error} onRetry={() => setCapsAttempt((n) => n + 1)} />;
  } else if (!offered.length) {
    body = (
      <p className="empty">
        <span className="label">No monitoring access</span>
        Your role may not monitor any stage of this deployment, so no run is read or shown.
      </p>
    );
  } else {
    let list;
    if (!access) {
      list = <Problem state="disabled" title={`${STAGE} runs are not available`} error={new ApiError(403, `Your role has no monitoring access on stage ${STAGE}.`)} />;
    } else if (runsOpen && !runsOpen.open) {
      list = <Problem state={runsOpen.state} title={runsOpen.state === "disabled" ? `${STAGE} runs are not available` : `${STAGE} runs cannot be read`} error={new ApiError(403, runsOpen.reason)} />;
    } else if (!snap) {
      list = <p className="mon-loading" role="status">Reading {STAGE}'s runs…</p>;
    } else if (snap.runs.status !== "ok") {
      const e = snap.runs.status === "error" ? snap.runs.error : new ApiError(403, snap.runs.reason);
      list = <Problem state={denied(e) ? "disabled" : "unknown"} title={denied(e) ? `${STAGE} runs are not available` : `${STAGE} runs cannot be read`} error={e} onRetry={refresh} />;
    } else {
      list = <RunsTable stage={stage} runs={snap.runs.data.runs} at={snap.at} now={now} filters={{ job, product, status, window: win }}
        scopeOf={scopeOf} pipesWhy={pipesWhy} productKnown={!!pipelines} />;
    }
    const refused = !offered.includes(stage);
    body = (
      <>
        <div className="q-context mc-context rl-context">
          <label>
            <span className="q-label">Stage</span>
            <select className="q-select" value={stage} onChange={(e) => pick({ stage: e.target.value })}>
              {offered.map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}
              {refused && <option value={stage}>{STAGE} · no access</option>}
            </select>
          </label>
          {access && runsOpen?.open && (
            <>
              <label>
                <span className="q-label">Pipeline</span>
                <select className="q-select" value={job} onChange={(e) => pick({ job: e.target.value })}>
                  <option value="">All pipelines</option>
                  {jobs.map((j) => <option key={j} value={j}>{j}</option>)}
                </select>
              </label>
              {(products.length > 0 || product) && (
                <label>
                  <span className="q-label">Product</span>
                  <select className="q-select" value={product} onChange={(e) => pick({ product: e.target.value })} disabled={!pipelines}
                    aria-describedby={!pipelines ? "rl-product-why" : undefined}>
                    <option value="">All products</option>
                    {products.map(([p, words]) => <option key={p} value={p}>{words}</option>)}
                  </select>
                </label>
              )}
              <Segments legend="Status" name="rl-status" value={status} options={["", ...RUN_FILTERS] as (RunFilter | "")[]} words={FILTER_WORDS}
                label={(o) => (o ? `${FILTER_WORDS[o]} runs` : "All statuses")} onPick={(o) => pick({ status: o })} />
              <Segments legend="Window" name="rl-window" value={win} options={RUN_WINDOWS} words={{ "1h": "1h", "6h": "6h", "24h": "24h", "7d": "7d" }}
                label={(o) => `Last ${WINDOW_WORDS[o]}`} onPick={(o) => pick({ window: o })} />
            </>
          )}
        </div>
        {list}
      </>
    );
  }

  return (
    <>
      <div className="q-head">
        <div>
          <h1>Monitoring</h1>
          <p className="f-sub">Every run of the stage's pipelines, newest first, each linked to what happened in it.</p>
        </div>
        <div className="mon-head-end">
          <ZoneSwitch />
          {snap?.runs.status === "ok" && (
            <div className="mc-actions">
              <div className="q-engine" role="status">
                <span className="icon"><img src="/icons/clock.svg" alt="" width="20" height="20" loading="lazy" /></span>
                <span><strong>Read <Ago at={snap.at} now={now} /></strong><span className="label">Last {WINDOW_WORDS[win]}</span></span>
              </div>
              <button type="button" className="f-btn f-outline" onClick={refresh}><span aria-hidden="true">↻</span> Refresh</button>
            </div>
          )}
        </div>
      </div>
      <MonitoringViews stage={stage} />
      {body}
    </>
  );
}

type Filters = { job: string; product: string; status: RunFilter | ""; window: HealthRange };

function RunsTable({ stage, runs, at, now, filters, scopeOf, pipesWhy, productKnown }: {
  stage: string; runs: Run[]; at: number; now: number; filters: Filters;
  scopeOf: Map<string, { domain: string | null; product: string | null }>; pipesWhy: string; productKnown: boolean;
}) {
  const { job, status, window: win } = filters;
  // A product filter needs each job's product: without the pipelines answer it is not applied, and the card says so.
  const product = productKnown ? filters.product : "";
  const productIgnored = !!filters.product && !productKnown;
  const windowStart = at / 1000 - WINDOW_SECONDS[win];
  const cover = coverage(runs, RUNS_LIMIT, windowStart);
  const shown = runs
    .filter((r) => r.created_at >= windowStart)
    .filter((r) => matchesStatus(r.status, status))
    .filter((r) => !product || scopeOf.get(r.job_name)?.product === product);
  const of = job ? <> of <span className="f-mono">{job}</span></> : null;
  const what = <>{status ? `${FILTER_WORDS[status]} runs` : "Runs"}{of}{product && <> in product <span className="f-mono">{product}</span></>} created in the last {WINDOW_WORDS[win]}</>;
  const read = cover.complete
    ? <>Read all {runs.length} {runs.length === 1 ? "run" : "runs"} Dagster holds{of}, so none of this window is missing.</>
    : cover.coveredFrom === null
      ? <>Read the newest {runs.length} runs{of}, the most the API answers at once; they reach back to <Time at={cover.oldest === null ? null : seconds(cover.oldest)} now={now} />, before this window starts.</>
      : <>Read the newest {runs.length} runs{of}, the most the API answers at once; they reach back to <Time at={cover.oldest === null ? null : seconds(cover.oldest)} now={now} /> only.{" "}
        <strong className="rl-short">Runs of this window created before then were not read, so they are not listed{job ? "" : "; pick a pipeline to reach further back"}.</strong></>;
  const clear = runsHref(stage, { window: win });

  let table;
  if (!runs.length) {
    table = (
      <p className="empty">
        <span className="label">No runs</span>
        Dagster has no run{of} on {stage.toUpperCase()}.
      </p>
    );
  } else if (!shown.length) {
    table = (
      <p className="empty">
        <span className="label">No matching runs</span>
        No run read matches: {what}.{cover.coveredFrom !== null && " Older runs in this window were not read."}{" "}
        {(job || product || status) && <Link className="run-link" to={clear}>Show all runs of the last {WINDOW_WORDS[win]}</Link>}
      </p>
    );
  } else {
    table = (
      <div className="f-scroll" role="region" aria-label={`${stage.toUpperCase()} runs`} tabIndex={0}>
        <table className="f-table mon-table rl-table">
          <thead>
            <tr><th scope="col">Pipeline</th><th scope="col">Domain · product</th><th scope="col">Status</th><th scope="col"><Zoned>Started</Zoned></th><th scope="col">Duration</th><th scope="col">Run</th></tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const scope = scopeOf.get(r.job_name);
              const scopeText = scope ? (scope.domain && scope.product ? `${scope.domain} · ${scope.product}` : scope.product ?? scope.domain) : null;
              // Only Dagster's own start time is a start: a creation time is never shown, or used for a duration, as one.
              const ended = r.ended_at !== null && r.started_at !== null;
              return (
                <tr key={r.run_id}>
                  <th scope="row"><span className="f-mono">{r.job_name}</span></th>
                  <td>{scopeText ?? <span className="mon-why">{scope ? "No data product" : "Not known"}</span>}</td>
                  <td><RunStatus status={r.status} /></td>
                  <td>{r.started_at !== null
                    ? <Time at={seconds(r.started_at)} now={now} bare />
                    : <span className="mon-why">{NOT_STARTED.has(r.status) ? "Not started" : "No start recorded"}</span>}</td>
                  <td className="f-mono">{ended ? duration(r.ended_at! - r.started_at!)
                    : r.started_at !== null && IN_PROGRESS.has(r.status) ? <>{duration(now / 1000 - r.started_at)}<span className="mon-why">so far</span></>
                    : <span className="mon-why">—</span>}</td>
                  <td><RunLink stage={stage} run={r.run_id} label={r.run_id.slice(0, 8)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section className="q-card mon-list rl-list" aria-labelledby="rl-h">
      <div className="f-card-head">
        <div className="mc-head">
          <h2 id="rl-h">Runs</h2>
          <span className="mon-why">{what}</span>
        </div>
        <span className="f-count" aria-label={`${shown.length} shown`}>{shown.length}</span>
      </div>
      <div className="rl-notes">
        <p className="mon-note">{read}</p>
        <p className="mon-note">The API filters runs by pipeline only: status{productKnown ? ", product" : ""} and window are applied here, to the runs read.</p>
        {pipesWhy && <p className="mon-note">Domain and product cannot be shown: {pipesWhy}</p>}
        {productIgnored && (
          <p className="mon-note" id="rl-product-why">
            <StatusBadge state="unknown" />{" "}
            <strong className="rl-short">The product filter <span className="f-mono">{filters.product}</span> is not applied</strong>: a run's product cannot be determined, so runs of every product are listed.
          </p>
        )}
      </div>
      {table}
    </section>
  );
}
