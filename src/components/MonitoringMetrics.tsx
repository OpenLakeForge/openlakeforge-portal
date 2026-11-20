// Monitoring · Metrics: a small curated set of history charts per stage (openlakeforge#333 item 5), from the metrics
// routes of the Platform API (#21, ADR 0024): GET /api/v1/stages/{stage}/metrics (the catalog),
// GET /api/v1/stages/{stage}/metrics/{series}?range= and GET /api/v1/platform/metrics/{series}?range=. The browser never
// reaches Prometheus or Dagster. Only series the catalog lists are charted. A backend the profile turns off reads
// Disabled, an outage Unknown, a range with no samples "No samples": never a line of zeros, and never green.

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import {
  ApiError, getMetricCatalog, getMonitoringCapabilities, getPlatformMetric, getStageMetric, METRIC_RANGES,
  type HealthState, type MetricCatalog, type MetricRange, type MetricSeriesData, type MetricSeriesInfo, type MonitoringCapabilities,
  type MonitoringStage,
} from "../lib/health-api";
import { hasSamples, MetricPlot, shape, stepTime, type LineRule } from "./MetricChart";
import { ago, DEADLINE_MS } from "./Monitoring";
import { MonitoringViews } from "./MonitoringViews";
import { StatusBadge } from "./StatusBadge";

/** The range a page opens with: the health routes' default window. */
export const DEFAULT_RANGE: MetricRange = "24h";
const RANGE_WORDS: Record<MetricRange, string> = { "1h": "1 hour", "6h": "6 hours", "24h": "24 hours", "7d": "7 days" };

/** One chart: a catalog series, what it shows, and how its lines are named. */
type ChartDef = { series: string; title: string; what: string; rule: LineRule; perStep?: boolean };
type Section = { id: string; title: string; scope: "stage" | "platform"; charts: ChartDef[] };

/** The curated set: resources, the query engine, pipelines and the cluster. A series the catalog does not list is not
 * drawn; the catalog's other series (restarts, queued queries, heap, disks) are left to expert tools. */
export const SECTIONS: Section[] = [
  {
    id: "resources", title: "Stage resources", scope: "stage", charts: [
      { series: "cpu_usage_cores", title: "CPU", what: "Cores used, per component", rule: { by: "component", single: "CPU" } },
      { series: "memory_working_set_bytes", title: "Memory", what: "Working set, per component", rule: { by: "component", single: "Memory" } },
      { series: "object_store_bucket_bytes", title: "Storage", what: "Bytes stored in the stage's buckets", rule: { single: "Stored" } },
    ],
  },
  {
    id: "query", title: "Query engine", scope: "stage", charts: [
      { series: "trino_running_queries", title: "Trino load", what: "Queries running on the coordinator", rule: { single: "Running" } },
      { series: "trino_failed_queries", title: "Trino query errors", what: "Queries that failed in each step", rule: { single: "Failed" }, perStep: true },
    ],
  },
  {
    id: "pipelines", title: "Pipelines", scope: "stage", charts: [
      {
        series: "pipeline_runs", title: "Pipeline runs", what: "Runs created in each step, by outcome", perStep: true,
        rule: { by: "status", single: "Runs", order: ["succeeded", "failed", "canceled", "running"], hideZero: ["canceled", "running"] },
      },
      { series: "pipeline_run_duration_seconds", title: "Run duration", what: "The longest finished run in each step, per pipeline", rule: { by: "job", single: "Duration", combine: "max" } },
    ],
  },
  {
    id: "cluster", title: "Cluster · all stages", scope: "platform", charts: [
      { series: "node_cpu_usage_cores", title: "Node CPU", what: "Cores used by the cluster's nodes", rule: { single: "Nodes" } },
      { series: "node_memory_working_set_bytes", title: "Node memory", what: "Working set of the cluster's nodes", rule: { single: "Nodes" } },
    ],
  },
];

const failure = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, String(e)));
const denied = (e: ApiError) => e.status === 401 || e.status === 403 || e.status === 404;
const timedOut = () => new ApiError(0, `The monitoring API did not answer within ${DEADLINE_MS / 1000} s, so this cannot be shown.`);
const absentState = (s: MetricSeriesInfo["state"]) => s === "disabled" || s === "not_provided";

type Load<T> = { status: "loading" } | { status: "ok"; data: T } | { status: "error"; error: ApiError };

/** One read under the page's deadline: an answer, a failure, or a deadline that reads as unreachable. */
function useRead<T>(read: ((signal: AbortSignal) => Promise<T>) | undefined, deps: unknown[]): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ status: "loading" });
  useEffect(() => {
    if (!read) return;
    const ctl = new AbortController();
    const deadline = setTimeout(() => { ctl.abort(); setLoad({ status: "error", error: timedOut() }); }, DEADLINE_MS);
    setLoad({ status: "loading" });
    read(ctl.signal).then(
      (data) => setLoad({ status: "ok", data }),
      (e) => { if (!ctl.signal.aborted) setLoad({ status: "error", error: failure(e) }); },
    ).finally(() => clearTimeout(deadline));
    return () => { clearTimeout(deadline); ctl.abort(); };
    // `read` is rebuilt on every render; `deps` say when it asks for something else.
  }, deps);
  return load;
}

/** A chart that is not drawn, and why, with Retry when trying again could help. The card's head carries the badge. */
function Gap({ what, why, onRetry }: { state: HealthState; what: string; why: string; onRetry?(): void }) {
  return (
    <div className="mc-gap">
      <span>
        <span className="mon-what">{what}</span>
        <span className="mon-why">{why}</span>
        {onRetry && <button type="button" className="f-btn f-outline mon-retry" onClick={onRetry}><span aria-hidden="true">↻</span> Retry</button>}
      </span>
    </div>
  );
}

/** Why a chart is not read at all, or undefined when it may be. */
type Closed = { state: HealthState; what: string; why: string };

function MetricCard({ def, range, closed, read, attempt }: {
  def: ChartDef; range: MetricRange; closed?: Closed; read: (signal: AbortSignal) => Promise<MetricSeriesData>; attempt: number;
}) {
  const [retries, setRetries] = useState(0);
  const load = useRead(closed ? undefined : read, [def.series, range, attempt, retries, !!closed]);
  const retry = () => setRetries((n) => n + 1);
  const h = `mc-${def.series}`;

  let body;
  let state: HealthState | undefined;
  if (closed) { state = closed.state; body = <Gap {...closed} />; }
  else if (load.status === "loading") body = <p className="mon-loading" role="status">Reading {def.title.toLowerCase()}…</p>;
  else if (load.status === "error") {
    const e = load.error;
    state = denied(e) || e.status === 400 ? "disabled" : "unknown";
    body = state === "disabled"
      ? <Gap state={state} what={e.status === 400 ? `Not kept for the last ${range}` : `${def.title} is not available`} why={e.message} />
      : <Gap state={state} what={`${def.title} cannot be read`} why={e.message} onRetry={retry} />;
  } else {
    const d = load.data;
    if (d.state === "unavailable") {
      state = "unknown";
      body = <Gap state={state} what={`${def.title} cannot be read`} why={`The API answered: ${d.reason}. Nothing here is shown as zero.`} onRetry={retry} />;
    } else if (absentState(d.state)) {
      state = "disabled";
      body = <Gap state={state} what={`${def.title} is not collected`} why={d.reason} />;
    } else {
      const data = shape(d.lines, def.rule);
      if (!hasSamples(data)) {
        body = (
          <p className="mc-empty">
            <span className="label">No samples</span>
            {d.lines.length
              ? `Nothing was recorded in the last ${RANGE_WORDS[range]}.`
              : d.source === "dagster" ? "No pipeline is defined or ran on this stage in this range." : "The series has no line in this range."}
          </p>
        );
      } else {
        const step = d.step_seconds >= 3600 ? `${d.step_seconds / 3600} h` : `${Math.round(d.step_seconds / 60)} min`;
        body = (
          <>
            <MetricPlot title={def.title} unit={d.unit} range={range} data={data} perStep={def.perStep ? `Each point counts one ${step} step.` : undefined} />
            {!d.complete && d.covered_from && (
              <p className="mon-why">
                Covers from {stepTime(Date.parse(d.covered_from), range)} only: the read reached its run cap, so earlier steps are gaps, not zeros.
              </p>
            )}
          </>
        );
      }
    }
  }
  return (
    <section className="q-card mon-list mc-card" aria-labelledby={h} data-series={def.series}>
      <div className="f-card-head">
        <div className="mc-head">
          <h3 id={h}>{def.title}</h3>
          <span className="mon-why">{def.what}</span>
        </div>
        {state && <StatusBadge state={state} />}
      </div>
      <div className="mc-body">{body}</div>
    </section>
  );
}

/** Charts that are not drawn because the deployment collects no resource history: one notice, not a wall of gaps. */
function Absent({ stage, why, titles }: { stage: string; why: string; titles: string[] }) {
  return (
    <section className="mon-banner" data-state="disabled" aria-labelledby="mc-absent-h">
      <div>
        <h2 id="mc-absent-h"><StatusBadge state="disabled" /> Resource history is not collected</h2>
        <p>
          {why.charAt(0).toUpperCase() + why.slice(1)}, so {stage}'s resource charts are not drawn: {titles.join(", ")}.
          Nothing is shown as zero or as healthy. Status, pipelines, quality and logs on the Overview do not need it.
        </p>
      </div>
    </section>
  );
}

function Charts({ access, catalog, range, attempt }: { access: MonitoringStage; catalog: MetricCatalog; range: MetricRange; attempt: number }) {
  const STAGE = access.stage.toUpperCase();
  const mayRead = access.operations.includes("get_stage_metric");
  const metrics = access.capabilities.find((c) => c.name === "metrics");
  // Every Prometheus series shares one retention: a stage CPU entry says which ranges the platform series keep.
  const kept = catalog.series.find((s) => s.source === "prometheus")?.ranges;
  const absent: string[] = [];
  let absentWhy = "";
  const sections = SECTIONS.map((section) => {
    const cards = section.charts.flatMap((def) => {
      let closed: Closed | undefined;
      let read: (signal: AbortSignal) => Promise<MetricSeriesData>;
      if (section.scope === "platform") {
        // The cluster's series have no catalog: they are drawn when the stage says a metrics backend is configured.
        if (metrics && absentState(metrics.status)) { absent.push(def.title); absentWhy ||= metrics.reason; return []; }
        if (!metrics || metrics.status !== "available") closed = { state: "unknown", what: `${def.title} cannot be read`, why: metrics?.reason ?? "The API did not say whether metrics are configured." };
        else if (kept && !kept.includes(range)) closed = { state: "disabled", what: `Not kept for the last ${range}`, why: `This deployment keeps resource history for ${kept.join(", ")} only.` };
        read = (signal) => getPlatformMetric(def.series, range, signal);
      } else {
        const info = catalog.series.find((s) => s.name === def.series);
        if (!info) return [];
        if (info.source === "prometheus" && absentState(info.state)) { absent.push(def.title); absentWhy ||= info.reason; return []; }
        if (!mayRead) closed = { state: "disabled", what: `${def.title} is not available`, why: `Your role may not read metric series on stage ${STAGE}.` };
        else if (absentState(info.state)) closed = { state: "disabled", what: `${def.title} is not available`, why: info.reason };
        else if (!info.ranges.includes(range)) closed = { state: "disabled", what: `Not kept for the last ${range}`, why: `This deployment keeps this series for ${info.ranges.join(", ") || "no range"} only.` };
        read = (signal) => getStageMetric(access.stage, def.series, range, signal);
      }
      return [<MetricCard key={`${def.series}-${range}`} def={def} range={range} closed={closed} read={read} attempt={attempt} />];
    });
    return cards.length ? (
      <section key={section.id} className="mc-section" aria-labelledby={`mc-${section.id}-h`}>
        <h2 id={`mc-${section.id}-h`} className="mc-section-h">{section.title}</h2>
        <div className="mc-grid">{cards}</div>
      </section>
    ) : null;
  });
  const drawn = sections.some(Boolean);
  return (
    <>
      {absent.length > 0 && <Absent stage={STAGE} why={absentWhy} titles={absent} />}
      {sections}
      {!drawn && !absent.length && (
        <p className="empty"><span className="label">No charts</span>The API's catalog lists no series this page charts for {STAGE}.</p>
      )}
    </>
  );
}

function Problem({ state, title, error, onRetry }: { state: HealthState; title: string; error: ApiError; onRetry?(): void }) {
  const retryable = !denied(error) && onRetry;
  return (
    <section className="mon-banner mon-state" data-state={state} aria-labelledby="mc-problem-h">
      <div>
        <h2 id="mc-problem-h"><StatusBadge state={state} /> {title}</h2>
        <p role="alert">{error.message}</p>
        {retryable && <button type="button" className="f-btn f-outline" onClick={onRetry}><span aria-hidden="true">↻</span> Retry</button>}
      </div>
    </section>
  );
}

/** Monitoring · Metrics: the stage's history charts over one range, from the Platform API's named series only. */
export function MonitoringMetrics({ stages }: { stages: string[] }) {
  const [params, setParams] = useSearchParams();
  const [capsAttempt, setCapsAttempt] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  const caps = useRead<MonitoringCapabilities>(stages.length ? (signal) => getMonitoringCapabilities(signal) : undefined, [stages.length, capsAttempt]);

  const offered = caps.status === "ok" ? caps.data.stages.map((s) => s.stage) : [];
  const asked = params.get("stage");
  const refused = offered.length && asked && !offered.includes(asked) && stages.includes(asked) ? asked : undefined;
  const stage = refused ?? (asked && offered.includes(asked) ? asked : offered[0]);
  const access = caps.status === "ok" ? caps.data.stages.find((s) => s.stage === stage) : undefined;
  const askedRange = params.get("range");
  const range = (METRIC_RANGES as readonly string[]).includes(askedRange ?? "") ? (askedRange as MetricRange) : DEFAULT_RANGE;
  const mayList = !!access?.operations.includes("list_stage_metrics");
  const catalog = useRead<MetricCatalog>(access && mayList ? (signal) => getMetricCatalog(access.stage, signal) : undefined, [access?.stage, mayList, attempt]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(tick);
  }, []);

  const pick = (next: { stage?: string; range?: MetricRange }) =>
    setParams({ stage: next.stage ?? stage ?? "", range: next.range ?? range });
  const STAGE = stage?.toUpperCase() ?? "";

  let body;
  if (stages.length === 0) {
    body = <p className="empty"><span className="label">No stages</span>This deployment has no stage to monitor yet.</p>;
  } else if (caps.status === "loading") {
    body = <p className="mon-loading" role="status">Reading your monitoring access…</p>;
  } else if (caps.status === "error") {
    body = <Problem state={denied(caps.error) ? "disabled" : "unknown"} title="Monitoring access cannot be read" error={caps.error} onRetry={() => setCapsAttempt((n) => n + 1)} />;
  } else if (!stage) {
    body = (
      <p className="empty">
        <span className="label">No monitoring access</span>
        Your role may not monitor any stage of this deployment, so no metric is read or shown.
      </p>
    );
  } else {
    let charts;
    if (refused || !access) {
      charts = <Problem state="disabled" title={`${STAGE} metrics are not available`} error={new ApiError(403, `Your role has no monitoring access on stage ${STAGE}.`)} />;
    } else if (!mayList) {
      charts = <Problem state="disabled" title={`${STAGE} metrics are not available`} error={new ApiError(403, `Your role may not read metrics on stage ${STAGE}.`)} />;
    } else if (catalog.status === "loading") {
      charts = <p className="mon-loading" role="status">Reading {STAGE}'s metric series…</p>;
    } else if (catalog.status === "error") {
      const e = catalog.error;
      charts = <Problem state={denied(e) ? "disabled" : "unknown"} title={denied(e) ? `${STAGE} metrics are not available` : `${STAGE} metrics cannot be read`} error={e} onRetry={refresh} />;
    } else {
      charts = <Charts access={access} catalog={catalog.data} range={range} attempt={attempt} />;
    }
    body = (
      <>
        <div className="q-context mc-context">
          <label>
            <span className="q-label">Stage</span>
            <select className="q-select" value={stage} onChange={(e) => pick({ stage: e.target.value })}>
              {offered.map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}
              {refused && <option value={refused}>{refused.toUpperCase()} · no access</option>}
            </select>
          </label>
          <fieldset className="mc-range">
            <legend className="q-label">Range</legend>
            <div className="mc-segments">
              {METRIC_RANGES.map((r) => (
                <label key={r}>
                  <input type="radio" name="mc-range" value={r} checked={r === range} onChange={() => pick({ range: r })} aria-label={`Last ${RANGE_WORDS[r]}`} />
                  <span aria-hidden="true">{r}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        {charts}
      </>
    );
  }

  return (
    <>
      <div className="q-head">
        <div>
          <h1>Monitoring</h1>
          <p className="f-sub">History of the platform's resources, its query engine and its pipelines, per stage.</p>
        </div>
        {catalog.status === "ok" && access && (
          <div className="mc-actions">
            <div className="q-engine" role="status">
              <span className="icon"><img src="/icons/clock.svg" alt="" width="20" height="20" loading="lazy" /></span>
              <span><strong>Read {ago(catalog.data.observed_at, now)}</strong><span className="label">Last {RANGE_WORDS[range]}</span></span>
            </div>
            <button type="button" className="f-btn f-outline" onClick={refresh}><span aria-hidden="true">↻</span> Refresh</button>
          </div>
        )}
      </div>
      <MonitoringViews stage={stage ?? asked ?? undefined} />
      {body}
    </>
  );
}
