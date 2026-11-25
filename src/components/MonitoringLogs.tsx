// Monitoring · Logs (portal#39): a stage's archived pod logs, browsed by UTC day and hour and narrowed by level, product,
// pod, container and component, from GET /api/v1/stages/{stage}/logs; or one run's window, paged with "Load more", from
// GET /api/v1/stages/{stage}/runs/{run_id}/logs. Free-text search is the API's `q` (openlakeforge#1349); an API from
// before it ignores `q`, and then the page filters the lines already read, in the browser, and says so. Nothing here
// claims a line it did not read.
//
// Its address is a contract other pages link to: /monitoring/<stage>/logs?date=YYYY-MM-DD&hour=HH&run=<run_id>&pod=
// &container=&component=&product=&level=info|warning|error|critical&q=<text>, and in run mode match_run=true (only the
// run's own lines). With no date and no run it opens on the current UTC hour; a date with no hour is the whole UTC day.

import { message, plain } from "../lib/log-line";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  ApiError, gate, getMonitoringCapabilities, getRun, listLogs, listRunLogs, LOGS_LIMIT, runGate,
  type HealthState, type LogLine, type MonitoringCapabilities,
} from "../lib/health-api";
import { DEADLINE_MS } from "./Monitoring";
import { runHref } from "./MonitoringPipelines";
import { OLDER_FLOORS, RUN_DEADLINE_MS, SEVERITY_LABEL, type Floor } from "./MonitoringRun";
import { dayKey, formatDate, useTimeZone } from "../lib/time";
import { MonitoringHead } from "./MonitoringHead";
import { Time, Zoned } from "./Time";
import { MonitoringViews } from "./MonitoringViews";
import { StatusBadge } from "./StatusBadge";

const FLOORS = Object.keys(SEVERITY_LABEL) as Floor[];
const short = (run: string) => run.slice(0, 8);
const pad = (n: number) => String(n).padStart(2, "0");
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A run window's page, as on the failed-run screen: it has a cursor, so "Load more" reads on. */
const RUN_PAGE = 200;
/** How often the clock behind the day and hour bounds (today, the latest hour, "Next hour") moves on. */
export const CLOCK_MS = 30_000;
/** How long typing pauses before the search is sent to the API. */
export const Q_DEBOUNCE_MS = 300;
/** The longest `q` the API takes (openlakeforge#1349); a longer one, or one with control characters, is a 422. */
const Q_MAX = 200;

/** What the page shows, as its address says it. `hour` undefined is the whole day. */
export type LogsView = {
  date?: string; hour?: number; run?: string;
  pod?: string; container?: string; component?: string; product?: string;
  level?: Floor; q?: string;
  /** Run mode only: the API's `match_run`, the lines tagged with the run and no other workload's. */
  matchRun?: boolean;
};

/** The address of a stage's Logs page; empty filters are left out, the hour is two digits. */
export function logsHref(stage: string, v: LogsView = {}): string {
  const q = new URLSearchParams();
  if (v.run) q.set("run", v.run);
  if (v.date) q.set("date", v.date);
  if (v.hour !== undefined) q.set("hour", pad(v.hour));
  for (const k of ["product", "pod", "container", "component", "level", "q"] as const) if (v[k]) q.set(k, v[k]!);
  if (v.run && v.matchRun) q.set("match_run", "true");
  const s = q.toString();
  return `/monitoring/${encodeURIComponent(stage)}/logs${s ? `?${s}` : ""}`;
}

const isDay = (d: string) => /^\d{4}-\d\d-\d\d$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))
  && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
export const utcToday = (now: number) => new Date(now).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The address read back: values it does not understand are dropped and named in `ignored`, never guessed at. With no
 * date and no run, the current UTC hour. */
export function readLogsParams(params: URLSearchParams, now: number): LogsView & { ignored: string[] } {
  const ignored: string[] = [];
  const text = (k: string) => (params.get(k) ?? "").trim() || undefined;
  const run = text("run");
  let date = text("date");
  if (date && !isDay(date)) { ignored.push(`date=${date}`); date = undefined; }
  let hour: number | undefined;
  const h = text("hour");
  if (h !== undefined) {
    if (/^\d{1,2}$/.test(h) && Number(h) <= 23) hour = Number(h);
    else ignored.push(`hour=${h}`);
  }
  if (!date && hour !== undefined && run) { ignored.push(`hour=${h}`); hour = undefined; }
  if (!date && !run) {
    date = utcToday(now);
    if (hour === undefined && h === undefined) hour = new Date(now).getUTCHours();
  }
  const l = text("level");
  let level: Floor | undefined;
  if (l) { if ((FLOORS as string[]).includes(l)) level = l as Floor; else ignored.push(`level=${l}`); }
  return {
    date, hour, run, level, q: params.get("q") ?? undefined, matchRun: !!run && params.get("match_run") === "true",
    pod: text("pod"), container: text("container"), component: text("component"), product: text("product"), ignored,
  };
}

/** The UTC span a day, or an hour of it, covers: `since` inclusive, `until` exclusive. */
export function span(date: string, hour?: number): { since: string; until: string } {
  const start = Date.parse(`${date}T00:00:00Z`) + (hour ?? 0) * HOUR_MS;
  return { since: new Date(start).toISOString(), until: new Date(start + (hour === undefined ? DAY_MS : HOUR_MS)).toISOString() };
}

/** The lines among those read that contain `q`, ignoring case: the line itself, or why it could not be parsed. */
export function search(lines: LogLine[], q: string): LogLine[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return lines;
  return lines.filter((l) => (l.line ?? l.error ?? "").toLowerCase().includes(needle));
}

/** The text sent as the API's `q`, or undefined when there is none or the API would refuse it (too long, control
 * characters): then the lines read are filtered here instead. */
export function sendable(q: string): string | undefined {
  const t = q.trim();
  // eslint-disable-next-line no-control-regex
  return t && t.length <= Q_MAX && !/[\u0000-\u001f\u007f]/.test(t) ? t : undefined;
}

/** Whether an answer to `q` was searched by the API. There is no capability flag for a parameter, and an API from before
 * openlakeforge#1349 ignores `q` rather than refusing it: an answer in which every line contains the text, ignoring case,
 * was searched; one with any other line was not (an unreadable record has no message, so it never matches). An empty
 * answer says nothing either way and is taken as searched. */
export function searchedBy(lines: LogLine[], q: string): boolean {
  const needle = q.toLowerCase();
  return lines.every((l) => (l.line ?? "").toLowerCase().includes(needle));
}

/** The stages whose log archive the role may read: `list_logs` (which a run's window shares) is listed there. */
export function logStages(caps: MonitoringCapabilities): string[] {
  return caps.stages.filter((s) => s.operations.includes("list_logs")).map((s) => s.stage);
}

const failure = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, String(e)));
const denied = (e: ApiError) => e.status === 401 || e.status === 403 || e.status === 404;
const timedOut = (ms: number) => new ApiError(0, `The monitoring API did not answer within ${ms / 1000} s, so no line can be shown.`);
/** The UTC day of an instant: the archive is partitioned by UTC day and hour, so its pickers stay in UTC. */
const dayOf = (iso: string) => { const t = Date.parse(iso); return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10); };
const fmt = (n: number) => n.toLocaleString("en-US");

type Caps = { status: "loading" } | { status: "ok"; data: MonitoringCapabilities } | { status: "error"; error: ApiError };
/** One read: the browse route (no cursor) or a run's window (`next`). `day` is set when an older API's run was read
 * from the stage route by its UTC day. */
type Page = {
  lines: LogLine[]; truncated: boolean; next: string | null; since?: string; until?: string; day?: string; levelIgnored?: Floor;
  /** The text the API searched for, when it did: the lines are its matches across the window, not a filter of a page. */
  searched?: string;
};
type Load = { status: "loading"; key: string } | { status: "ok"; key: string; data: Page } | { status: "error"; key: string; error: ApiError };
type More = { status: "idle" } | { status: "loading" } | { status: "error"; error: ApiError };

function Problem({ state, title, error, onRetry }: { state: HealthState; title: string; error: ApiError; onRetry?(): void }) {
  const retryable = !denied(error) && onRetry;
  return (
    <section className="mon-banner mon-state" data-state={state} aria-labelledby="lg-problem-h">
      <div>
        <h2 id="lg-problem-h"><StatusBadge state={state} /> {title}</h2>
        <p role="alert">{error.message}</p>
        {retryable && <button type="button" className="f-btn f-outline" onClick={onRetry}><span aria-hidden="true">↻</span> Retry</button>}
      </div>
    </section>
  );
}

/** Monitoring · Logs: one stage's archived lines, by day and hour or by run, filtered and searchable. */
export function MonitoringLogs({ stage, stages }: { stage: string; stages: string[] }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  // `opened` fixes what an address without a date means (the hour the page opened on); `now` moves on, for the bounds
  // only (today, the latest hour, "Next hour"), so an open page crossing an hour or midnight never changes its lines.
  const [opened] = useState(() => Date.now());
  const [now, setNow] = useState(opened);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(tick);
  }, []);
  const [caps, setCaps] = useState<Caps>({ status: "loading" });
  const [capsAttempt, setCapsAttempt] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: "loading", key: "" });
  const [more, setMore] = useState<More>({ status: "idle" });
  const moreCtl = useRef<AbortController | null>(null);

  const view = readLogsParams(params, opened);
  const { date, hour, run, pod, container, component, product, level } = view;
  const q = view.q ?? "";
  const matchRun = !!view.matchRun;
  // The search reaches the API once typing pauses; until then, and on an API that does not search, the lines read are
  // filtered here. Once an answer shows the API ignored `q`, it is not sent again on this page.
  const [qSent, setQSent] = useState(() => sendable(q));
  const [noSearch, setNoSearch] = useState(false);
  useEffect(() => {
    const next = sendable(q);
    if (next === qSent) return;
    const t = setTimeout(() => setQSent(next), Q_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, qSent]);
  const adopted = useRef<string | null>(null);
  const STAGE = stage.toUpperCase();
  const access = caps.status === "ok" ? caps.data.stages.find((s) => s.stage === stage) : undefined;
  const offered = caps.status === "ok" ? logStages(caps.data) : [];
  const g = access ? gate(access, "logs", "list_logs", "logs") : undefined;
  // An API from before #1324/#1326 (no `log_retention_days`) has no run window: a run is read from the stage route by
  // its UTC day, and that route takes only the warning and error floors.
  const older = access?.log_retention_days === undefined;
  const levelSent = level && older && !OLDER_FLOORS.includes(level) ? undefined : level;

  useEffect(() => {
    if (!stages.length) return;
    const ctl = new AbortController();
    const deadline = setTimeout(() => { ctl.abort(); setCaps({ status: "error", error: timedOut(DEADLINE_MS) }); }, DEADLINE_MS);
    setCaps({ status: "loading" });
    getMonitoringCapabilities(ctl.signal).then(
      (data) => setCaps({ status: "ok", data }),
      (e) => { if (!ctl.signal.aborted) setCaps({ status: "error", error: failure(e) }); },
    ).finally(() => clearTimeout(deadline));
    return () => { clearTimeout(deadline); ctl.abort(); };
  }, [stages.length, capsAttempt]);

  // One read per view: the key holds every value the read depends on, and only primitives, so a capabilities answer
  // that is equal but new, or a re-render, never reads again. A filter change starts again from the top.
  const runOpen = access ? runGate(access, "get_run", "this run") : undefined;
  const runMode = run ? (older ? "day" : "window") : "";
  const keyOf = (qr: string | undefined) => JSON.stringify([
    stage, run, date, hour, pod, container, component, run ? "" : product, levelSent, older, runOpen?.open ?? null,
    runMode === "window" && matchRun, qr ?? "", attempt,
  ]);
  const qRead = noSearch ? undefined : qSent;
  const key = keyOf(qRead);
  const open = !!access && !!g?.open;
  useEffect(() => {
    if (!access || !g?.open) return;
    // An answer already adopted for this key (an API that ignored `q`: its lines are the unsearched read) is not read again.
    if (adopted.current === key) { adopted.current = null; return; }
    const ctl = new AbortController();
    const deadline = setTimeout(() => { ctl.abort(); setLoad({ status: "error", key, error: timedOut(RUN_DEADLINE_MS) }); }, RUN_DEADLINE_MS);
    moreCtl.current?.abort();
    setMore({ status: "idle" });
    setLoad({ status: "loading", key });
    const severity = levelSent || undefined;
    let read: Promise<Page>;
    if (run && !older) {
      const window = date ? span(date, hour) : {};
      read = listRunLogs(stage, run, { severity, pod, container, component, ...window, matchRun, q: qRead, limit: RUN_PAGE }, ctl.signal);
    } else if (run) {
      // The run's day, as the failed-run screen reads it on an older API: its start, else its creation.
      const day: Promise<string> = date ? Promise.resolve(date)
        : runOpen?.open ? getRun(stage, run, ctl.signal).then((r) => new Date((r.started_at ?? r.created_at) * 1000).toISOString().slice(0, 10))
        : Promise.reject(new ApiError(403, runOpen?.open === false ? runOpen.reason : "This run cannot be read."));
      read = day.then((d) => listLogs(stage, { date: d, hour, pod, container, component, runId: run, severity, q: qRead, limit: LOGS_LIMIT }, ctl.signal)
        .then((r) => ({ ...r, next: null, day: d })));
    } else {
      read = listLogs(stage, { date: date!, hour, pod, container, component, product, severity, q: qRead, limit: LOGS_LIMIT }, ctl.signal)
        .then((r) => ({ ...r, next: null }));
    }
    read.then(
      (answer) => {
        const data: Page = { ...answer, levelIgnored: level && level !== levelSent ? level : undefined };
        if (qRead && !searchedBy(data.lines, qRead)) {
          // The API ignored `q`: these are the unsearched lines, kept as the read without `q`, and filtered here.
          const plain = keyOf(undefined);
          adopted.current = plain;
          setNoSearch(true);
          setLoad({ status: "ok", key: plain, data });
          return;
        }
        setLoad({ status: "ok", key, data: { ...data, searched: qRead } });
      },
      (e) => { if (!ctl.signal.aborted) setLoad({ status: "error", key, error: failure(e) }); },
    ).finally(() => clearTimeout(deadline));
    return () => { clearTimeout(deadline); ctl.abort(); moreCtl.current?.abort(); };
    // `access`, `g` and `runOpen` are rebuilt from each capabilities answer; whether the archive is open and the key
    // (which holds `older` and the run gate) say when to read again.
  }, [open, key]);

  /** The run window's next page, with the same filters, after the last line shown: appended, never re-read. */
  const loadMore = () => {
    if (load.status !== "ok" || !load.data.next || !run) return;
    const ctl = new AbortController();
    moreCtl.current = ctl;
    const deadline = setTimeout(() => { ctl.abort(); setMore({ status: "error", error: timedOut(RUN_DEADLINE_MS) }); }, RUN_DEADLINE_MS);
    setMore({ status: "loading" });
    const window = date ? span(date, hour) : {};
    const searched = load.data.searched;
    listRunLogs(stage, run, { severity: levelSent || undefined, pod, container, component, ...window, matchRun, q: searched, after: load.data.next, limit: RUN_PAGE }, ctl.signal).then(
      (page) => {
        setLoad((prev) => prev.status === "ok" && prev.key === key
          ? { ...prev, data: { ...prev.data, ...page, lines: [...prev.data.lines, ...page.lines], since: prev.data.since, searched } }
          : prev);
        setMore({ status: "idle" });
      },
      (e) => { if (!ctl.signal.aborted) setMore({ status: "error", error: failure(e) }); },
    ).finally(() => clearTimeout(deadline));
  };

  /** Changes the address; the effective day and hour are written out, so a link copied from here opens the same lines. */
  const pick = (next: Partial<LogsView>, opts: { replace?: boolean } = {}) => {
    const merged: LogsView = { date, hour, run, pod, container, component, product, level, q: q || undefined, matchRun, ...next };
    navigate(logsHref(stage, merged), { replace: opts.replace });
  };
  const switchStage = (s: string) => navigate(logsHref(s, { date, hour, level }));

  const data = load.status === "ok" && load.key === key ? load.data : undefined;
  const loadError = load.status === "error" && load.key === key ? load.error : undefined;
  const shown = data ? search(data.lines, q) : [];

  let body;
  let stagePicker: React.ReactNode;
  if (stages.length === 0) {
    body = <p className="empty"><span className="label">No stages</span>This deployment has no stage to monitor yet.</p>;
  } else if (caps.status === "loading") {
    body = <p className="mon-loading" role="status">Reading your monitoring access…</p>;
  } else if (caps.status === "error") {
    body = <Problem state={denied(caps.error) ? "disabled" : "unknown"} title="Monitoring access cannot be read" error={caps.error} onRetry={() => setCapsAttempt((n) => n + 1)} />;
  } else if (!offered.length && !access) {
    body = (
      <p className="empty">
        <span className="label">No log access</span>
        Your role may not read the log archive of any stage of this deployment, so no line is read or shown.
      </p>
    );
  } else {
    let result;
    if (!access) {
      result = <Problem state="disabled" title={`${STAGE} logs are not available`} error={new ApiError(403, `Your role has no monitoring access on stage ${STAGE}.`)} />;
    } else if (!g!.open && g!.state === "disabled" && access.operations.includes("list_logs")) {
      // The role may read logs, but the stage keeps none: no archive is configured.
      result = (
        <p className="empty lg-empty">
          <span className="label">No log archive</span>
          {STAGE} keeps no archived logs: {g!.reason}.
        </p>
      );
    } else if (!g!.open) {
      result = <Problem state={g!.state} title={g!.state === "disabled" ? `${STAGE} logs are not available` : `${STAGE} logs cannot be read`} error={new ApiError(403, g!.reason)} />;
    } else if (loadError) {
      const e = loadError;
      result = <Problem state={denied(e) ? "disabled" : "unknown"} title={denied(e) ? `${STAGE} logs are not available` : `${STAGE} logs cannot be read`} error={e} onRetry={() => setAttempt((n) => n + 1)} />;
    } else if (!data) {
      result = <p className="mon-loading" role="status">Reading {STAGE}'s archived lines…</p>;
    } else {
      result = <Lines stage={stage} view={view} data={data} shown={shown} older={older} more={more} onMore={loadMore}
        retention={access.log_retention_days ?? null} now={now} pick={pick} noSearch={noSearch} />;
    }
    const refused = !offered.includes(stage);
    const today = utcToday(now);
    const retention = access?.log_retention_days ?? null;
    const floors = older ? OLDER_FLOORS : FLOORS;
    const lines = data?.lines ?? [];
    const seen = (f: (l: LogLine) => string | null | undefined) => [...new Set(lines.map(f).filter((x): x is string => !!x))].sort();
    const active = ([["product", run ? undefined : product], ["pod", pod], ["container", container], ["component", component]] as const)
      .filter((f): f is [typeof f[0], string] => !!f[1]);
    const searchWarns = noSearch || !!(q.trim() && !sendable(q));
    stagePicker = (
      <label className="mon-stage">
        <span className="q-label">Stage</span>
        <select className="q-select" value={stage} onChange={(e) => switchStage(e.target.value)}>
          {offered.map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}
          {refused && <option value={stage}>{STAGE} · no access</option>}
        </select>
      </label>
    );
    body = (
      <>
        {open && (
          <>
            <div className="lg-bar">
              <label className="lg-search">
                <span className="sr-only">Search</span>
                <input className="q-select lg-q" type="search" value={q} placeholder="Search log lines…" aria-describedby="lg-search-note"
                  onChange={(e) => pick({ q: e.target.value || undefined }, { replace: true })} />
              </label>
              <details className="lg-add">
                <summary className="f-btn f-outline">+ Filter</summary>
                <form className="lg-filters" aria-label="Filters"
                  key={JSON.stringify([product, pod, container, component, run])}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    const val = (k: string) => String(f.get(k) ?? "").trim() || undefined;
                    e.currentTarget.closest("details")?.removeAttribute("open");
                    pick({ product: run ? product : val("product"), pod: val("pod"), container: val("container"), component: val("component") });
                  }}>
                  {!run && <Field name="product" label="Product" value={product} options={seen((l) => l.product)} />}
                  <Field name="pod" label="Pod" value={pod} options={seen((l) => l.pod)} />
                  <Field name="container" label="Container" value={container} options={seen((l) => l.container)} />
                  <Field name="component" label="Component" value={component} options={seen((l) => l.component)} />
                  <button type="submit" className="f-btn f-outline">Apply</button>
                </form>
              </details>
              <label>
                <span className="sr-only">Level</span>
                <select className="q-select" value={levelSent ?? ""} onChange={(e) => pick({ level: (e.target.value || undefined) as Floor | undefined })}>
                  {floors.map((k) => <option key={k} value={k}>{SEVERITY_LABEL[k]}</option>)}
                </select>
              </label>
              <label>
                <span className="sr-only">Day (UTC)</span>
                <input className="q-select lg-date" type="date" value={date ?? ""} max={today} min={retention !== null ? addDays(today, -retention) : undefined}
                  onChange={(e) => e.target.value && isDay(e.target.value) ? pick({ date: e.target.value }) : run && pick({ date: undefined, hour: undefined })} />
              </label>
              <label>
                <span className="sr-only">Hour (UTC)</span>
                <select className="q-select lg-hour" value={hour === undefined ? "" : String(hour)} disabled={!date}
                  onChange={(e) => pick({ date, hour: e.target.value === "" ? undefined : Number(e.target.value) })}>
                  <option value="">{run && !date ? "The run's window" : "Whole day"}</option>
                  {Array.from({ length: 24 }, (_, h) => h).map((h) => (
                    <option key={h} value={h} disabled={date === today && h > new Date(now).getUTCHours()}>{pad(h)}:00–{pad((h + 1) % 24)}:00</option>
                  ))}
                </select>
              </label>
              <span className="q-label lg-utc" aria-hidden="true">UTC</span>
            </div>
            {(run || active.length > 0) && (
              <div className="lg-chips">
                {run && (
                  <div className="lg-run" role="group" aria-label="Run">
                    <span className="lg-run-chip">
                      <span className="f-mono">run {short(run)}</span>
                      <Link className="run-link" to={runHref(stage, run)}>Run screen</Link>
                      <button type="button" className="f-link" onClick={() => pick({ run: undefined, date: date ?? data?.day ?? (data?.since ? dayOf(data.since) : undefined) })}>
                        Browse the stage instead
                      </button>
                    </span>
                  </div>
                )}
                {active.map(([name, value]) => (
                  <button key={name} type="button" className="lg-chip f-mono" aria-label={`Remove filter ${name} ${value}`} onClick={() => pick({ [name]: undefined })}>
                    {name}: {value} <span aria-hidden="true">×</span>
                  </button>
                ))}
                {active.length > 0 && (
                  <button type="button" className="f-link" onClick={() => pick({ product: undefined, pod: undefined, container: undefined, component: undefined })}>Clear filters</button>
                )}
              </div>
            )}
            {/* What the search covers is worth a visible line only when it does not cover the archive. */}
            <p className={searchWarns ? "mon-note" : "sr-only"} id="lg-search-note">
              <SearchNote q={q} data={data} noSearch={noSearch} />
            </p>
            {runMode === "window" && (
              <div className="lg-match">
                <label className="run-filter f-check">
                  <input type="checkbox" checked={matchRun} onChange={(e) => pick({ matchRun: e.target.checked })} aria-describedby="lg-match-why" />
                  <span className="q-label">Only this run's lines</span>
                </label>
                <span className="sr-only" id="lg-match-why">
                  The window holds every workload's lines from the run's start to its end; this hides other workloads' lines,
                  and older records that carry no run tag.
                </span>
              </div>
            )}
          </>
        )}
        {view.ignored.length > 0 && (
          <p className="mon-note lg-ignored">Not understood, so not applied: <span className="f-mono">{view.ignored.join(", ")}</span>.</p>
        )}
        {result}
      </>
    );
  }

  return (
    <>
      <MonitoringHead />
      <div className="mon-bar">
        <MonitoringViews stage={stage} />
        {stagePicker}
      </div>
      {body}
    </>
  );
}

/** What the search covers, in words: the archive (the API searched), or only the lines loaded (it cannot). */
function SearchNote({ q, data, noSearch }: { q: string; data?: Page; noSearch: boolean }) {
  const t = q.trim();
  const loaded = data ? <>the {fmt(data.lines.length)} {data.lines.length === 1 ? "line" : "lines"} loaded</> : <>the lines loaded</>;
  const past = data?.truncated ? ": lines past them are not searched" : "";
  if (noSearch) return <>This Platform API does not search, so search filters {loaded}, not the whole archive{past}.</>;
  if (t && !sendable(t)) return <>The archive is searched for at most {Q_MAX} characters with no control characters, so this search filters {loaded}, not the whole archive{past}.</>;
  if (t && data?.searched && data.searched === sendable(t)) {
    return <>The archive was searched for lines containing “{data.searched}”, ignoring case, over the whole time asked.</>;
  }
  return <>Search asks the archive for lines containing the text, ignoring case.</>;
}

function Field({ name, label, value, options }: { name: string; label: string; value?: string; options: string[] }) {
  const list = `lg-${name}-seen`;
  return (
    <label>
      <span className="q-label">{label}</span>
      <input className="q-select lg-field" name={name} defaultValue={value ?? ""} list={options.length ? list : undefined} autoComplete="off" spellCheck={false} />
      {options.length > 0 && <datalist id={list}>{options.map((o) => <option key={o} value={o} />)}</datalist>}
    </label>
  );
}

/** Highlights each occurrence of `q` in `text`, ignoring case. */
function Marked({ text, q }: { text: string; q: string }) {
  const needle = q.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, at)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<mark key={i}>{text.slice(i, i + needle.length)}</mark>);
    at = i + needle.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function Lines({ stage, view, data, shown, older, more, onMore, retention, now, pick, noSearch }: {
  stage: string; view: LogsView; data: Page; shown: LogLine[]; older: boolean; more: More; onMore(): void;
  retention: number | null; now: number; pick(next: Partial<LogsView>): void; noSearch: boolean;
}) {
  const { run, date, hour, level } = view;
  const q = view.q ?? "";
  const STAGE = stage.toUpperCase();
  const tz = useTimeZone();
  const today = utcToday(now);
  const region = useRef<HTMLDivElement | null>(null);
  const [openLines, setOpenLines] = useState<number[]>([]);
  useEffect(() => setOpenLines([]), [data.lines[0]]);
  const toggle = (i: number) => setOpenLines((o) => (o.includes(i) ? o.filter((x) => x !== i) : [...o, i]));
  const filtered = !!(view.pod || view.container || view.component || (!run && view.product));

  // Where the lines come from, in words: the day and hour, or the run's window.
  const day = data.day ?? date;
  const where = run && !data.day
    ? <>run <span className="f-mono">{short(run)}</span>'s window{data.since && data.until ? <>, <Time at={data.since} now={now} /> → <Time at={data.until} now={now} /></> : ""}</>
    : <>{run ? <>run <span className="f-mono">{short(run)}</span> on </> : null}{day}{hour !== undefined ? `, ${pad(hour)}:00–${pad((hour + 1) % 24)}:00` : ", whole day"} (UTC)</>;
  const expired = retention !== null && day !== undefined && day < addDays(today, -retention);
  const step = (n: number) => hour !== undefined
    ? (() => { const t = Date.parse(`${date}T00:00:00Z`) + (hour + n) * HOUR_MS; return { date: utcToday(t), hour: new Date(t).getUTCHours() }; })()
    : { date: addDays(date!, n), hour: undefined };
  const later = (() => { if (!date) return false; const s = step(1); return Date.parse(span(s.date, s.hour).since) <= now; })();
  const nav = !run && date && (
    <div className="lg-step" role="group" aria-label={hour !== undefined ? "Hour" : "Day"}>
      <button type="button" className="f-btn f-outline" onClick={() => pick(step(-1))}>
        <span aria-hidden="true">←</span> {hour !== undefined ? "Previous hour" : "Previous day"}
      </button>
      <button type="button" className="f-btn f-outline" onClick={() => pick(step(1))} disabled={!later}>
        {hour !== undefined ? "Next hour" : "Next day"} <span aria-hidden="true">→</span>
      </button>
    </div>
  );

  /** ↑ ↓ Home End move between lines once one has focus, or from the region itself. */
  const keys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(region.current?.querySelectorAll<HTMLTableRowElement>("tr[data-line]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLTableRowElement);
    if (at >= 0 && e.key === "Enter") { e.preventDefault(); toggle(Number(rows[at].dataset.line)); return; }
    if (!rows.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const to = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : at < 0 ? (e.key === "ArrowDown" ? 0 : -1) : at + (e.key === "ArrowDown" ? 1 : -1);
    if (to < 0 || to >= rows.length) return;
    e.preventDefault();
    rows[to].focus();
    rows[to].scrollIntoView?.({ block: "nearest" });
  };

  const notes: React.ReactNode[] = [];
  if (data.day) {
    notes.push(<>This Platform API has no run window: these are run <span className="f-mono">{short(run!)}</span>'s lines of {data.day} (UTC) from the stage's archive, with no paging.</>);
  }
  if (run && !data.day) {
    notes.push(view.matchRun
      ? <>Only the lines tagged with this run: other workloads' lines in its window, and older records with no run tag, are hidden.</>
      : <>The window holds every workload's lines from the run's start to its end; "Only this run's lines" hides the others.</>);
  }
  if (data.levelIgnored) {
    notes.push(<>This Platform API filters at warning or error only, so “{SEVERITY_LABEL[data.levelIgnored]}” is not applied: every level is shown.</>);
  }
  if (older && data.lines.length && data.lines.every((l) => !l.timestamp && !l.level)) {
    notes.push(<>This Platform API gives the lines no time and no level of their own.</>);
  }
  if (expired) notes.push(<>{day} is older than the {retention} days {STAGE}'s archive keeps lines, so it holds none.</>);

  let table;
  if (!data.lines.length && !data.truncated) {
    table = (
      <div className="lg-none">
        <p className="run-step">
          The archive holds no {level ? `${SEVERITY_LABEL[level].toLowerCase()} ` : ""}line{data.searched ? <> containing “{data.searched}”</> : null}{filtered ? " matching these filters" : ""} for {where}.
          {!expired && " Lines still in the collector's spool are not archived yet."}
        </p>
        {(filtered || level || data.searched) && <p className="mon-why"><Link className="run-link" to={logsHref(stage, { run, date, hour })}>Show every line of {run ? "this run" : "this time"}</Link></p>}
      </div>
    );
  } else if (!shown.length) {
    table = (
      <p className="run-step lg-none">
        None of the {fmt(data.lines.length)} lines loaded contains “{q.trim()}”.
        {(noSearch || !sendable(q)) && " The archive may hold it elsewhere: search filters the lines loaded only."}
      </p>
    );
  } else {
    // Day rows follow the zone the times are shown in, so each clock time sits under its own date: on UTC an archive
    // hour or day needs none, a run across midnight gets one per day; on a local zone they split where its days do.
    const days = new Set(shown.map((l) => (l.timestamp ? dayKey(l.timestamp, tz.zone) : undefined)).filter(Boolean));
    let shownDay = days.size > 1 ? undefined : [...days][0];
    const rows: React.ReactNode[] = [];
    shown.forEach((l, i) => {
      const ts = l.timestamp ?? null;
      const lineDay = ts ? dayKey(ts, tz.zone) : undefined;
      if (ts && lineDay && lineDay !== shownDay) {
        shownDay = lineDay;
        rows.push(<tr key={`day-${i}`} className="run-day"><th scope="rowgroup" colSpan={4}><time dateTime={lineDay}>{formatDate(ts, tz.zone, now)}</time> ({tz.label})</th></tr>);
      }
      const lv = l.level ?? null;
      const open = openLines.includes(i);
      rows.push(
        <tr key={i} data-line={i} tabIndex={-1} className={open ? "lg-open" : undefined}>
          <td className="f-mono run-time">{ts && <Time at={ts} now={now} bare clock precision="millisecond" />}</td>
          <td>{lv && <span className="run-level" data-level={lv}>{lv.toUpperCase()}</span>}</td>
          <td className="lg-where">
            <span className="mon-why f-mono lg-container">{l.container}</span>
            <span className="lg-extra">
              <Link className="run-link f-mono" to={logsHref(stage, { run, date, hour, pod: l.pod, level })} aria-label={`Filter to ${l.pod}`}>{l.pod}</Link>
              {l.run_id && l.run_id !== run && (
                <Link className="run-link lg-run-link" to={logsHref(stage, { run: l.run_id })} aria-label={`Run ${short(l.run_id)}'s window`}>run {short(l.run_id)}</Link>
              )}
            </span>
          </td>
          <td className="f-mono run-line">
            {l.line !== null
              ? <button type="button" className="lg-msg" tabIndex={-1} aria-expanded={open} onClick={() => toggle(i)}><Marked text={open ? plain(l.line) : message(l.line)} q={q} /></button>
              : <span className="mon-why">Unreadable record: {l.error ?? "no reason given"}</span>}
          </td>
        </tr>,
      );
    });
    table = (
      <div className="f-scroll run-log lg-log" role="region" aria-label={`${STAGE} log lines`} aria-describedby="lg-keys" tabIndex={0} ref={region} onKeyDown={keys}>
        <table className="f-table mon-table">
          <thead><tr><th scope="col"><Zoned>Time</Zoned></th><th scope="col">Level</th><th scope="col">Source</th><th scope="col">Line</th></tr></thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
    );
  }

  let truncation = null;
  if (data.truncated) {
    const narrow = run ? "Narrow by level, pod, container or component, or pick a day and hour." : hour === undefined
      ? "Pick an hour, or narrow by level, product, pod, container or component."
      : "Narrow by level, product, pod, container or component.";
    truncation = (
      <div className="run-more">
        <p className="mon-why">
          {data.next
            ? <>{fmt(data.lines.length)} lines loaded: the window has more.</>
            : <>The first {fmt(data.lines.length)} lines only: {run && !data.day ? "the window has more, but the API gave no way to read on." : "the archive holds more, and this route has no way to read on."} {narrow}</>}
        </p>
        {data.next && (
          <button type="button" className="f-btn f-outline" onClick={onMore} disabled={more.status === "loading"} aria-describedby="lg-count">
            {more.status === "loading" ? "Loading…" : "Load more"}
          </button>
        )}
        {more.status === "error" && (
          <p className="run-gap">
            <StatusBadge state={denied(more.error) ? "disabled" : "unknown"} />
            <span><span className="mon-what">More lines cannot be read</span><span className="mon-why">{more.error.message}</span>
              {!denied(more.error) && <span className="mon-why"><button type="button" className="f-btn f-outline" onClick={onMore}><span aria-hidden="true">↻</span> Retry</button></span>}
            </span>
          </p>
        )}
      </div>
    );
  }

  const count = q.trim() ? `${fmt(shown.length)} of ${fmt(data.lines.length)}${data.truncated ? "+" : ""} lines` : `${fmt(data.lines.length)}${data.truncated ? "+" : ""} lines`;
  return (
    <section className="q-card mon-list run-card lg-card" aria-labelledby="lg-h">
      <div className="f-card-head">
        <div className="mc-head">
          <h2 id="lg-h">Lines</h2>
          <span className="mon-why">{STAGE} · {where}</span>
        </div>
        <span className="f-count" id="lg-count">{count}</span>
      </div>
      <div className="run-body">
        {nav}
        {notes.length > 0 && <div className="lg-notes">{notes.map((n, i) => <p key={i} className="mon-note">{n}</p>)}</div>}
        {table}
        {truncation}
        <p className="mon-why run-foot" id="lg-keys">
          <span className="label">Archive</span> Oldest first{retention !== null ? ` · Kept ${retention} day${retention === 1 ? "" : "s"}` : ""}
          <span className="sr-only"> · Tab to the lines, then ↑ ↓ to move between them and Enter to open one</span>
        </p>
      </div>
    </section>
  );
}
