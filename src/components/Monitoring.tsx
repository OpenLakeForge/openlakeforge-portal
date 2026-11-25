import { useCallback, useEffect, useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  ApiError, effective, gate, getAlertIncidents, getMonitoringCapabilities, getPipelinesHealth, getQualityHealth, getStageHealth,
  listRuns, runsGate, RUNS_LIMIT, worst,
  type Gate, type HealthState, type MonitoringCapabilities, type MonitoringStage, type Runs, type ServiceHealth,
  type StageAlertIncidents, type StageHealth, type StageQualityHealth,
} from "../lib/health-api";
import { coverage, matchesStatus } from "../lib/runs";
import { ActOn, type Item } from "./MonitoringActOn";
import { alerts, AlertsCard } from "./MonitoringAlerts";
import { Gauge } from "./MonitoringGauges";
import { Fresh, MonitoringHead } from "./MonitoringHead";
import { absent, pipes, PipelinesTable, RANK, type Part, type PipesLoad } from "./MonitoringPipelines";
import { quality, QualityCard } from "./MonitoringQuality";
import { MonitoringViews } from "./MonitoringViews";
import { LABEL, StatusBadge } from "./StatusBadge";
import { Ago, Time } from "./Time";

const REFRESH_MS = 30_000;
/** How long one snapshot (the stage, pipelines, quality and incidents reads, together) may take before the page calls the API unreachable. */
export const DEADLINE_MS = 10_000;
const timedOut = () =>
  new ApiError(0, `The monitoring API did not answer within ${DEADLINE_MS / 1000} s, so nothing on this page can be shown as healthy.`);
const failure = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, String(e)));


const TITLE: Record<HealthState, string> = {
  healthy: "is healthy", warning: "needs attention", critical: "needs attention", unknown: "status unknown", disabled: "monitoring is off",
};

type Load =
  | { status: "loading" }
  | { status: "ok"; stage: string; data: StageHealth | null; pipes: PipesLoad; quality: Part<StageQualityHealth>; alerts: Part<StageAlertIncidents>; runs: Part<Runs>; at: number }
  | { status: "error"; error: ApiError };
type Caps = { status: "loading" } | { status: "ok"; data: MonitoringCapabilities } | { status: "error"; error: ApiError };
const retryable = (e: ApiError) => !(e.status === 401 || e.status === 403 || e.status === 404);

type Shown = ServiceHealth & { shown: HealthState };
export type ServiceGroup = { service: string; name: string; state: HealthState; rows: Shown[] };

/** Probe rows grouped by `service`, in the API's order. A group reads its worst row, so one bad probe is never hidden. */
export function groupServices(rows: Shown[]): ServiceGroup[] {
  const groups = new Map<string, ServiceGroup>();
  for (const r of rows) {
    const g = groups.get(r.service) ?? { service: r.service, name: r.service_display_name, state: r.shown, rows: [] };
    g.rows.push(r);
    g.state = worst(g.rows.map((x) => x.shown));
    groups.set(r.service, g);
  }
  return [...groups.values()];
}

type Retry = { onRetry(): void; lastGood?: number };

type Snapshot = Extract<Load, { status: "ok" }>;

/** The oldest answer in a group: the group is only as recent as its least recent probe. */
const oldest = (rows: Shown[]) =>
  rows.some((r) => !r.observed_at) ? null : rows.map((r) => r.observed_at!).sort((a, b) => Date.parse(a) - Date.parse(b))[0];

/** The services whose pods run in the stage's namespace, named as their log records' `component`. The others run in the
 * platform namespace, whose logs the API does not serve yet. */
const SERVICE_LOGS = new Set(["dagster", "trino"]);
/** How far before its alert opened a failing service's lines start: the evaluator runs every 5 minutes. */
const BEFORE_ALERT_MS = 10 * 60_000;
/** And before the check, for a failing service no alert is open for: when it began is not known. */
const BEFORE_CHECK_MS = 15 * 60_000;

/** The Logs address of one service. A failing one opens just before the failure, from its open alert when there is one:
 * the archive answers oldest first, 500 lines at most, so the start of the hour can be far from it. A healthy one
 * opens the UTC hour it was checked in. */
function serviceLogs(stage: string, service: string, healthy: boolean, observed: string | null | undefined, opened: string | undefined, now: number): string {
  const read = observed ? Date.parse(observed) : NaN;
  const checked = Number.isNaN(read) ? now : read;
  // A healthy service's alert is history (recovered, or a stale evaluation): only a failing one starts from it.
  const alert = !healthy && opened ? Date.parse(opened) : NaN;
  const event = Number.isNaN(alert) ? checked : alert;
  const date = new Date(event).toISOString().slice(0, 10);
  const q = new URLSearchParams({ date });
  if (healthy) q.set("hour", String(new Date(event).getUTCHours()));
  else {
    const from = event - (Number.isNaN(alert) ? BEFORE_CHECK_MS : BEFORE_ALERT_MS);
    // Not before the day shown: a day's read never reaches into the one before.
    q.set("since", new Date(Math.max(from, Date.parse(`${date}T00:00:00Z`))).toISOString());
  }
  q.set("component", service);
  return `/monitoring/${encodeURIComponent(stage)}/logs?${q}`;
}

/** One probe's line: what it is, how it reads, and why; a stale answer says since when. */
function Probe({ s, now }: { s: Shown; now: number }) {
  return (
    <span className="mon-part">
      <span className="mon-what">{s.display_name} · {LABEL[s.shown]}</span>
      <span className="mon-why">{s.shown !== s.state ? <>Stale: no fresh answer since <Ago at={s.observed_at} now={now} />. {s.reason}</> : s.reason}</span>
      {EVIDENCE[s.component] && <span className="mon-why">{EVIDENCE[s.component]} {s.last_success_at ? <Ago at={s.last_success_at} now={now} /> : "unknown"}</span>}
    </span>
  );
}
/** The components that carry their own evidence of a last success. A null one reads unknown, never as a time. */
const EVIDENCE: Record<string, string> = { "log-archive.newest-object": "Last durable write", "quality-sync.publication": "Last publication" };

/** A service that is not healthy, as a row of the list to act on: its worst probe's words. */
function serviceItem(g: ServiceGroup, logs: string | undefined): Item {
  const rows = g.rows as Shown[];
  const first = rows.find((r) => r.shown === g.state) ?? rows[0];
  const stale = first.shown !== first.state;
  return {
    key: `service/${g.service}`, name: g.name, state: g.state, sort: RANK[g.state], runs: [], components: rows.map((r) => r.component), logs,
    title: stale ? "No fresh answer" : first.reason,
    detail: rows.map((r) => `${r.display_name} · ${LABEL[r.shown]}: ${r.reason}`).join("\n"),
    at: oldest(rows) ?? undefined,
  };
}

/** Every service as a chip with its state; one opens its probes. A gap (no probe answer, metrics not readable) is a chip
 * or a line of its own, never folded away. */
function ServicesPanel({ groups, gap, metricsGap, metricsReason, now, logs }: {
  groups: ServiceGroup[]; gap?: { state: HealthState; reason?: string }; metricsGap?: HealthState; metricsReason?: string; now: number;
  logs(g: ServiceGroup): string | undefined;
}) {
  const [picked, setPicked] = useState<string>();
  const id = useId();
  const all = metricsGap ? [...groups, { service: "metrics", name: "Resource metrics", state: metricsGap, rows: [] as Shown[] }] : groups;
  const open = all.find((g) => g.service === picked);
  const href = open && open.rows.length ? logs(open) : undefined;
  return (
    <section className="q-card mon-list mon-svc" aria-labelledby="mon-services-h">
      <div className="f-card-head">
        <h2 id="mon-services-h">Services</h2>
        <span className="f-count">{all.length}</span>
      </div>
      {gap && <p className="mon-clear"><StatusBadge state={gap.state} /> Service probes: {gap.reason ?? "The API reported no services for this stage."}</p>}
      <div className="mon-chips">
        {all.map((g) => (
          <button key={g.service} type="button" className="mon-chip" aria-expanded={picked === g.service} aria-controls={id}
            onClick={() => setPicked((x) => (x === g.service ? undefined : g.service))}>
            {g.name} <StatusBadge state={g.state} />
          </button>
        ))}
      </div>
      <div id={id} role="region" aria-label="Service detail" hidden={!open} className="mon-chip-detail">
        {open && <>
          <p className="mon-chip-title"><strong>{open.name}</strong> <StatusBadge state={open.state} /></p>
          {open.rows.length ? (open.rows as Shown[]).map((s) => <Probe key={s.component} s={s} now={now} />) : <span className="mon-why">{metricsReason}</span>}
          {open.rows.length > 0 && <span className="mon-why">Last checked <Ago at={oldest(open.rows as Shown[])} now={now} /></span>}
          {href ? <Link className="f-btn f-outline" to={href} aria-label={`View logs of ${open.name}`}>View logs</Link>
            : open.rows.length > 0 && <span className="mon-why">The portal cannot show this service's logs yet.</span>}
        </>}
      </div>
    </section>
  );
}

/** The last day's runs of the stage by how they ended. Counts cover the runs read: a read that stopped short says so. */
function RunsCard({ load, stage, now }: { load: Part<Runs>; stage: string; now: number }) {
  const common = { label: "Pipeline runs summary", title: "Runs · 24 h" };
  if (load.status !== "ok") {
    const error = load.status === "error" ? load.error : undefined;
    const state: HealthState = load.status === "off" ? load.state : error && !retryable(error) ? "disabled" : "unknown";
    return <Gauge {...common} center="—" slices={[]} state={state} note={load.status === "off" ? load.reason : error!.message} />;
  }
  const since = now / 1000 - 86_400;
  const runs = load.data.runs.filter((r) => r.created_at >= since);
  const count = (f: "failed" | "succeeded" | "in_progress") => runs.filter((r) => matchesStatus(r.status, f)).length;
  const succeeded = count("succeeded");
  const failed = count("failed");
  const running = count("in_progress");
  const cover = coverage(load.data.runs, RUNS_LIMIT, since);
  return (
    <Gauge {...common} to={`/monitoring/${encodeURIComponent(stage)}/runs`} center={String(runs.length)} unit={runs.length === 1 ? "run" : "runs"}
      slices={[
        { label: "Succeeded", value: succeeded, tone: "ok" }, { label: "Failed", value: failed, tone: "bad" },
        { label: "Running", value: running, tone: "run" }, { label: "Canceled", value: runs.length - succeeded - failed - running, tone: "warn", optional: true },
      ]}
      note={cover.coveredFrom !== null ? `Only the newest ${RUNS_LIMIT} runs were read: older ones of this day are not counted.` : undefined} />
  );
}

function Overview({ access, snap, now, retry }: { access: MonitoringStage; snap: Snapshot; now: number; retry: Retry }) {
  const stage = access.stage.toUpperCase();
  const health = snap.data;
  const p = pipes(snap.pipes, now);
  const q = quality(snap.quality);
  const a = alerts(snap.alerts);
  const pipesRetry = !p.ok && p.error && retryable(p.error) ? retry : undefined;
  const cards = (
    <>
      <RunsCard load={snap.runs} stage={access.stage} now={now} />
      <QualityCard q={q} retry={retry.onRetry} />
      <AlertsCard a={a} />
    </>
  );
  const table = <PipelinesTable p={p} q={q} now={now} stage={access.stage} />;
  const act = { p, a, now, stage: access.stage, retryPipes: pipesRetry, retryAlerts: retry.onRetry };
  // A role without get_stage_health: no rollup to show, so the page says so and keeps the panels it may read.
  if (!health) {
    return (
      <>
        <section className="mon-banner" data-state="disabled" aria-labelledby="mon-banner-h">
          <div>
            <h2 id="mon-banner-h"><StatusBadge state="disabled" /> {stage} health is not available</h2>
            <p>Your role may not read the stage health of {stage}, so no rollup or service row can be shown.</p>
          </div>
        </section>
        <div className="mon-summary">
          <div className="mon-cards">
            <Gauge label="Services summary" title="Services" center="—" slices={[]} state="disabled" note="Your role may not read the stage health." />
            {cards}
          </div>
        </div>
        <ActOn {...act} heading="Needs attention" />
        {table}
      </>
    );
  }

  const integration = (n: string) => health.integrations.find((i) => i.name === n);
  // The capabilities route decides whether service probes are configured; /health's own integration is the fallback.
  const svcCap = access.capabilities.find((c) => c.name === "services");
  const capGap = absent(svcCap);
  const servicesGap = capGap ?? absent(integration("services"));
  const servicesReason = capGap ? svcCap?.reason : integration("services")?.reason;
  const services = (servicesGap ? [] : health.services).map((s) => ({ ...s, shown: effective(s, now) }));
  const groups = groupServices(services);
  // An expired probe is no evidence: the stage reads at least unknown, and a worse API rollup always stands.
  const expired = services.filter((s) => s.shown !== s.state).length;
  // A pipelines answer that is missing or has expired signals is no evidence either: the stage reads at least unknown.
  // A stage with no Dagster (a 404, or a source the capabilities call disabled) is not a gap, nor is a read the role
  // may not make: /health's own rollup already counts the pipelines.
  const noDagster = !p.ok && p.state === "disabled" && integration("dagster")?.status === "disabled";
  const pipesGap = (!p.ok && !noDagster && !(p.off && p.state === "disabled")) || (p.ok && p.expired > 0);
  // The two reads are separate evaluations: a pipeline verdict worse than /health's rollup (a run that failed in
  // between) still colours the stage, and a worse /health answer always stands.
  const stageState = worst([
    health.state,
    ...(expired || pipesGap ? ["unknown" as const] : []),
    ...(p.ok ? p.pipelines.map((x) => x.shown) : []),
  ]);
  const metrics = integration("metrics");
  const metricsGap = absent(metrics);
  /** When the open alert about one of a service's probes opened: the earliest, when there are several. */
  const alerted = (g: ServiceGroup) => (a.ok
    ? a.data.incidents.filter((i) => g.rows.some((r) => r.component === i.component)).map((i) => i.opened_at).sort()[0] : undefined);
  const logs = (g: ServiceGroup) => (SERVICE_LOGS.has(g.service) && access.operations.includes("list_logs")
    ? serviceLogs(access.stage, g.service, g.state === "healthy", oldest(g.rows as Shown[]), alerted(g), now) : undefined);
  const troubled = groups.filter((g) => g.state !== "healthy" && g.state !== "disabled").map((g) => serviceItem(g, logs(g)));
  // A disabled service is switched off, not down: it is not counted.
  const counted = groups.filter((g) => g.state !== "disabled");
  const of = (state: HealthState) => counted.filter((g) => g.state === state).length;
  const cardState = worst(groups.map((g) => g.state));

  return (
    <>
      <div className="mon-summary">
        <div className="mon-cards">
          <Gauge label="Services summary" title="Services"
            center={servicesGap || !counted.length ? "—" : `${of("healthy")}/${counted.length}`} unit={servicesGap || !counted.length ? undefined : "up"}
            state={servicesGap ?? (!groups.length ? "unknown" : cardState === "healthy" ? undefined : cardState)}
            note={servicesGap ? servicesReason : groups.length ? undefined : "No services reported."}
            slices={servicesGap || !groups.length ? [] : [
              { label: "Up", value: of("healthy"), tone: "ok" }, { label: "Warning", value: of("warning"), tone: "warn" },
              { label: "Critical", value: of("critical"), tone: "bad" }, { label: "Unknown", value: of("unknown"), tone: "none", optional: true },
            ]} />
          {cards}
        </div>
      </div>

      <ActOn {...act} services={troubled} state={stageState} heading={<><StatusBadge state={stageState} /> {stage} {TITLE[stageState]}</>} />
      {table}

      <ServicesPanel
        groups={groups} now={now} metricsGap={metricsGap} metricsReason={metrics?.reason} logs={logs}
        gap={servicesGap || groups.length === 0 ? { state: servicesGap ?? "unknown", reason: servicesReason } : undefined}
      />
    </>
  );
}

function Unavailable({ name, what = "health", error, lastGood, now = Date.now(), onRetry }: {
  name: string; what?: string; error: ApiError; lastGood?: number; now?: number; onRetry?(): void;
}) {
  const denied = !retryable(error);
  return (
    <section className="mon-banner mon-state" data-state={denied ? "disabled" : "unknown"} aria-labelledby="mon-banner-h">
      <div>
        <h2 id="mon-banner-h">
          <StatusBadge state={denied ? "disabled" : "unknown"} /> {name} {denied ? `${what} is not available` : "status unknown"}
        </h2>
        <p role="alert">{error.message}{!denied && lastGood ? <> Last good snapshot <Time at={lastGood} now={now} />.</> : ""}</p>
        {!denied && onRetry && <button type="button" className="f-btn f-outline" onClick={onRetry}><span aria-hidden="true">↻</span> Retry</button>}
      </div>
    </section>
  );
}

/** Monitoring · Overview (Figma "Screens — v0.4 · Monitoring"): platform health per stage, from the Platform API only.
 * GET /monitoring-capabilities decides which stages and panels exist; a route the role may not call is never called. */
export function Monitoring({ stages }: { stages: string[] }) {
  const [params, setParams] = useSearchParams();
  const [caps, setCaps] = useState<Caps>({ status: "loading" });
  const [capsAttempt, setCapsAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [lastGood, setLastGood] = useState<number>();
  const [lastGoodPipes, setLastGoodPipes] = useState<number>();
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const offered = caps.status === "ok" ? caps.data.stages.map((s) => s.stage) : [];
  const asked = params.get("stage");
  // A deployed stage the capabilities leave out is one the role may not monitor: say so, and call nothing for it.
  const refused = offered.length && asked && !offered.includes(asked) && stages.includes(asked) ? asked : undefined;
  const stage = refused ?? (asked && offered.includes(asked) ? asked : offered[0]);
  const access = caps.status === "ok" ? caps.data.stages.find((s) => s.stage === stage) : undefined;

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

  useEffect(() => {
    if (!access) return;
    const stage = access.stage;
    const ctl = new AbortController();
    // Each request settles once: an answer, a failure, its own deadline, or a silent cancel (stage switch, unmount).
    // The next refresh is scheduled only once it has settled, so a stalled read is never restarted unreported.
    let done = false;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const settle = (next: Load) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      setLoad(next);
      if (next.status === "ok") {
        setLastGood(next.at);
        setNow(next.at);
        if (next.pipes.status === "ok") setLastGoodPipes(next.at);
      }
      refresh = setTimeout(retry, REFRESH_MS);
    };
    // A snapshot past its deadline is unreachable: Unknown with Retry, and the old snapshot goes. When the stage
    // answered in time but a panel's read did not, only that read is unreachable.
    let stageAnswered = false;
    let late: () => void = () => {};
    const lateness = new Promise<Part<never>>((resolve) => { late = () => resolve({ status: "error", error: timedOut() }); });
    const deadline = setTimeout(() => {
      late();
      if (!stageAnswered) settle({ status: "error", error: timedOut() });
      ctl.abort();
    }, DEADLINE_MS);
    /** A panel's read, raced against the deadline; a closed gate makes no request at all. */
    const part = <T,>(g: Gate, read: () => Promise<T>): Promise<Part<T>> => g.open
      ? Promise.race([read().then((data): Part<T> => ({ status: "ok", data }), (e): Part<T> => ({ status: "error", error: failure(e) })), lateness])
      : Promise.resolve({ status: "off", state: g.state, reason: g.reason });
    setLoad((l) => (l.status === "ok" && l.stage === stage ? l : { status: "loading" }));
    const pipesRead = part(gate(access, "dagster", "list_pipeline_health", "pipeline health"), () => getPipelinesHealth(stage, ctl.signal));
    // Quality counts come from the same Dagster pass as the pipelines: they need both sources.
    const qualityGate = gate(access, "quality", "get_stage_quality_health", "quality counts");
    const qualityRead = part(qualityGate.open ? gate(access, "dagster", "get_stage_quality_health", "quality counts") : qualityGate,
      () => getQualityHealth(stage, ctl.signal));
    const alertsRead = part(gate(access, "alerts", "list_alert_incidents", "alert incidents"), () => getAlertIncidents(stage, ctl.signal));
    const runsRead = part(runsGate(access), () => listRuns(stage, { limit: RUNS_LIMIT }, ctl.signal));
    const healthRead = access.operations.includes("get_stage_health") ? getStageHealth(stage, ctl.signal) : Promise.resolve(null);
    healthRead.then(
      async (data) => {
        stageAnswered = true;
        const [pipesLoad, qualityLoad, alertsLoad, runsLoad] = await Promise.all([pipesRead, qualityRead, alertsRead, runsRead]);
        settle({ status: "ok", stage, data, pipes: pipesLoad, quality: qualityLoad, alerts: alertsLoad, runs: runsLoad, at: Date.now() });
      },
      (e) => settle({ status: "error", error: failure(e) }),
    );
    return () => { done = true; ctl.abort(); clearTimeout(deadline); clearTimeout(refresh); };
  }, [access, attempt, retry]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(tick);
  }, []);

  const pick = (s: string) => { setLastGood(undefined); setLastGoodPipes(undefined); setParams({ stage: s }); };
  const ready = load.status === "ok" && access && load.stage === access.stage ? load : undefined;

  const choices = [...offered.map((s) => ({ stage: s, label: s.toUpperCase() })), ...(refused ? [{ stage: refused, label: `${refused.toUpperCase()} · no access` }] : [])];
  // Up to three stages are a segmented switch (native radios: Tab reaches it, the arrow keys move it); more are a list.
  const picker = stage && caps.status === "ok" && (choices.length <= 3
    ? (
      <fieldset className="mc-range mon-stage">
        <legend className="q-label">Stage</legend>
        <div className="mc-segments">
          {choices.map((c) => (
            <label key={c.stage}>
              <input type="radio" name="mon-stage" value={c.stage} checked={c.stage === stage} onChange={() => pick(c.stage)} aria-label={c.label} />
              <span aria-hidden="true">{c.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    )
    : (
      <label className="mon-stage">
        <span className="q-label">Stage</span>
        <select className="q-select" value={stage} onChange={(e) => pick(e.target.value)}>
          {choices.map((c) => <option key={c.stage} value={c.stage}>{c.label}</option>)}
        </select>
      </label>
    ));

  let body;
  if (stages.length === 0) {
    body = <p className="empty"><span className="label">No stages</span>This deployment has no stage to monitor yet.</p>;
  } else if (caps.status === "loading") {
    body = <p className="mon-loading" role="status">Reading your monitoring access…</p>;
  } else if (caps.status === "error") {
    body = <Unavailable name="Monitoring" what="access" error={caps.error} onRetry={() => setCapsAttempt((n) => n + 1)} />;
  } else if (!stage) {
    body = (
      <p className="empty">
        <span className="label">No monitoring access</span>
        Your role may not monitor any stage of this deployment, so no health is read or shown.
      </p>
    );
  } else {
    body = (
      <>
        {refused || !access
          ? <Unavailable name={stage.toUpperCase()} error={new ApiError(403, `Your role has no monitoring access on stage ${stage.toUpperCase()}.`)} />
          : load.status === "error"
            ? <Unavailable name={stage.toUpperCase()} error={load.error} lastGood={lastGood} now={now} onRetry={retry} />
            : ready
              ? <Overview key={access.stage} access={access} snap={ready} now={now} retry={{ onRetry: retry, lastGood: lastGoodPipes }} />
              : <p className="mon-loading" role="status">Reading {stage.toUpperCase()} health…</p>}
      </>
    );
  }

  return (
    <>
      <MonitoringHead>
        {ready && <Fresh at={ready.data?.evaluated_at ?? ready.at} now={now} onRefresh={retry} title="Refreshes every 30 s" />}
      </MonitoringHead>
      <div className="mon-bar">
        <MonitoringViews stage={stage ?? asked ?? undefined} />
        {picker}
      </div>
      {body}
    </>
  );
}
