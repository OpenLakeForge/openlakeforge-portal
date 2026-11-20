import { useCallback, useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router";
import {
  ApiError, effective, gate, getAlertIncidents, getMonitoringCapabilities, getPipelinesHealth, getQualityHealth, getStageHealth, worst,
  type Gate, type HealthState, type MonitoringCapabilities, type MonitoringStage, type ServiceHealth, type StageAlertIncidents,
  type StageHealth, type StageQualityHealth,
} from "../lib/health-api";
import { ActOn } from "./MonitoringActOn";
import { alerts, AlertsCard } from "./MonitoringAlerts";
import { absent, pipes, PipelinesCard, PipelinesTable, pipesLine, stateCounts, type Part, type PipesLoad } from "./MonitoringPipelines";
import { quality, QualityCard, QualityTable } from "./MonitoringQuality";
import { MonitoringViews } from "./MonitoringViews";
import { LABEL, StatusBadge } from "./StatusBadge";

const REFRESH_MS = 30_000;
/** How long one snapshot (the stage, pipelines, quality and incidents reads, together) may take before the page calls the API unreachable. */
export const DEADLINE_MS = 10_000;
const timedOut = () =>
  new ApiError(0, `The monitoring API did not answer within ${DEADLINE_MS / 1000} s, so nothing on this page can be shown as healthy.`);
const failure = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, String(e)));

export function ago(iso: string | null, now: number): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const TITLE: Record<HealthState, string> = {
  healthy: "is healthy", warning: "needs attention", critical: "needs attention", unknown: "status unknown", disabled: "monitoring is off",
};

type Load =
  | { status: "loading" }
  | { status: "ok"; stage: string; data: StageHealth | null; pipes: PipesLoad; quality: Part<StageQualityHealth>; alerts: Part<StageAlertIncidents>; at: number }
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

/** The components whose rows carry their own evidence of a last success, and how the services line names it. */
const EVIDENCE = [
  ["log-archive.newest-object", "log archive last durable write"],
  ["quality-sync.publication", "quality sync last publication"],
] as const;

/** The oldest answer in a group: the group is only as recent as its least recent probe. */
const oldest = (rows: Shown[]) =>
  rows.some((r) => !r.observed_at) ? null : rows.map((r) => r.observed_at!).sort((a, b) => Date.parse(a) - Date.parse(b))[0];

type Retry = { onRetry(): void; lastGood?: number };

type Snapshot = Extract<Load, { status: "ok" }>;

/** The Services panel: one line when every service is healthy; the services that are not, listed, otherwise. "Show all"
 * lists every service. A gap (no probe answer, metrics not readable) is never folded away. */
function ServicesPanel({ groups, line, gap, metricsGap, metricsReason, now }: {
  groups: ServiceGroup[]; line: string; gap?: { state: HealthState; reason?: string }; metricsGap?: HealthState; metricsReason?: string; now: number;
}) {
  const [all, setAll] = useState(false);
  const id = useId();
  const problems = groups.filter((g) => g.state !== "healthy");
  const shown = all ? groups : problems;
  const gapRow = groups.length === 0;
  const metricsRow = metricsGap && (all || metricsGap === "unknown");
  const visible = shown.length > 0 || gapRow || !!metricsRow;
  const hidden = groups.length - shown.length + (metricsGap && !metricsRow ? 1 : 0);
  const toggle = all || hidden > 0;
  return (
    <section className="q-card mon-list mon-svc" aria-labelledby="mon-services-h">
      <div className="f-card-head">
        <h2 id="mon-services-h">Services</h2>
        <span className="f-count">{groups.length + (metricsGap ? 1 : 0)}</span>
        <p className="mon-svc-line">{line}</p>
        {toggle && (
          <button type="button" className="f-btn f-outline mon-svc-toggle" aria-expanded={all} aria-controls={id} onClick={() => setAll((x) => !x)}>
            {all ? (problems.length ? "Show only problems" : "Hide healthy services") : `Show all ${groups.length} services`}
          </button>
        )}
      </div>
      <div id={id} className="f-scroll" role="region" aria-label="Service health" tabIndex={0} hidden={!visible}>
        <table className="f-table mon-table mon-services">
          <thead><tr><th scope="col">Service</th><th scope="col">State</th><th scope="col">Detail</th><th scope="col">Last checked</th></tr></thead>
          <tbody>
            {shown.map((g) => (
              <tr key={g.service}>
                <th scope="row">{g.name}</th>
                <td><StatusBadge state={g.state} /></td>
                <td>
                  {g.rows.map((s) => (
                    <span key={s.component} className="mon-part">
                      <span className="mon-what">{s.display_name} · {LABEL[s.shown]}</span>
                      <span className="mon-why">{s.shown !== s.state ? `Stale: no fresh answer since ${ago(s.observed_at, now)}. ${s.reason}` : s.reason}</span>
                    </span>
                  ))}
                </td>
                <td className="f-mono">{ago(oldest(g.rows), now)}</td>
              </tr>
            ))}
            {gapRow && (
              <tr><th scope="row">Service probes</th><td><StatusBadge state={gap?.state ?? "unknown"} /></td>
                <td>{gap?.reason ?? "The API reported no services for this stage."}</td><td className="f-mono">—</td></tr>
            )}
            {metricsRow && (
              <tr><th scope="row">Resource metrics</th><td><StatusBadge state={metricsGap} /></td>
                <td>{metricsReason}</td><td className="f-mono">—</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
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
      <PipelinesCard p={p} />
      <QualityCard q={q} retry={retry.onRetry} />
      <AlertsCard a={a} now={now} />
    </>
  );
  const pipelinePanels = (
    <>
      <ActOn p={p} a={a} now={now} stage={access.stage} retryPipes={pipesRetry} retryAlerts={retry.onRetry} />
      {p.ok && <PipelinesTable p={p} now={now} stage={access.stage} />}
      {q.ok && <QualityTable q={q} now={now} stage={access.stage} />}
    </>
  );
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
            <section className="mon-card" aria-label="Services summary">
              <div className="mon-card-top"><h2 className="label">Services</h2><StatusBadge state="disabled" /></div>
              <p className="mon-value"><strong>—</strong></p>
              <p className="mon-note">Your role may not read the stage health.</p>
            </section>
            {cards}
          </div>
        </div>
        {pipelinePanels}
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
  const ready = groups.filter((g) => g.state === "healthy").length;
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
  const servicesState = servicesGap ?? (groups.length ? worst(groups.map((g) => g.state)) : "unknown");
  const metrics = integration("metrics");
  const metricsGap = absent(metrics);
  const servicesLine = servicesGap ? "service probes give no answer" : `${ready} of ${groups.length} services ready`;
  const pipelinesLine = noDagster ? "no Dagster on this stage" : pipesLine(p);
  const expiredLine = expired ? `${expired} service answer${expired === 1 ? "" : "s"} expired` : "";
  // A null last_success_at is no evidence of a write: it reads unknown, never as a time.
  const evidence = EVIDENCE.flatMap(([component, label]) => {
    const row = services.find((s) => s.component === component);
    return row ? [`${label} ${row.last_success_at ? ago(row.last_success_at, now) : "unknown"}`] : [];
  });
  const svcLine = [
    servicesGap ? `Service probes ${LABEL[servicesGap].toLowerCase()}: ${servicesReason ?? "no answer"}` : `${ready} of ${groups.length} healthy`,
    expiredLine, ...evidence, metricsGap ? `resource metrics ${LABEL[metricsGap].toLowerCase()}` : "",
  ].filter(Boolean).join(" · ");

  return (
    <>
      <section className="mon-banner" data-state={stageState} aria-labelledby="mon-banner-h">
        <div>
          <h2 id="mon-banner-h"><StatusBadge state={stageState} /> {stage} {TITLE[stageState]}</h2>
          <p>
            {pipelinesLine} · {servicesLine}{expiredLine ? ` · ${expiredLine}` : ""}
            {p.ok && p.expired ? ` · ${p.expired} pipeline signal${p.expired === 1 ? "" : "s"} expired` : ""}
          </p>
        </div>
      </section>

      <div className="mon-summary">
        <div className="mon-cards">
          <section className="mon-card" aria-label="Services summary">
            <div className="mon-card-top"><h2 className="label">Services</h2><StatusBadge state={servicesState} /></div>
            {servicesGap
              ? <p className="mon-value"><strong>—</strong></p>
              : <p className="mon-value"><strong>{ready} of {groups.length}</strong> ready</p>}
            <p className="mon-note">{servicesGap ? servicesReason : stateCounts(groups.map((g) => g.state)) || "No services reported."}</p>
          </section>
          {cards}
        </div>
      </div>

      {pipelinePanels}

      <ServicesPanel
        groups={groups} line={svcLine} now={now} metricsGap={metricsGap} metricsReason={metrics?.reason}
        gap={servicesGap || groups.length === 0 ? { state: servicesGap ?? "unknown", reason: servicesReason } : undefined}
      />
    </>
  );
}

function Unavailable({ name, what = "health", error, lastGood, onRetry }: { name: string; what?: string; error: ApiError; lastGood?: number; onRetry?(): void }) {
  const denied = !retryable(error);
  return (
    <section className="mon-banner mon-state" data-state={denied ? "disabled" : "unknown"} aria-labelledby="mon-banner-h">
      <div>
        <h2 id="mon-banner-h">
          <StatusBadge state={denied ? "disabled" : "unknown"} /> {name} {denied ? `${what} is not available` : "status unknown"}
        </h2>
        <p role="alert">{error.message}{!denied && lastGood ? ` Last good snapshot ${clock(lastGood)}.` : ""}</p>
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
    const healthRead = access.operations.includes("get_stage_health") ? getStageHealth(stage, ctl.signal) : Promise.resolve(null);
    healthRead.then(
      async (data) => {
        stageAnswered = true;
        const [pipesLoad, qualityLoad, alertsLoad] = await Promise.all([pipesRead, qualityRead, alertsRead]);
        settle({ status: "ok", stage, data, pipes: pipesLoad, quality: qualityLoad, alerts: alertsLoad, at: Date.now() });
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
            ? <Unavailable name={stage.toUpperCase()} error={load.error} lastGood={lastGood} onRetry={retry} />
            : ready
              ? <Overview key={access.stage} access={access} snap={ready} now={now} retry={{ onRetry: retry, lastGood: lastGoodPipes }} />
              : <p className="mon-loading" role="status">Reading {stage.toUpperCase()} health…</p>}
      </>
    );
  }

  return (
    <>
      <div className="q-head">
        <div>
          <h1>Monitoring</h1>
          <p className="f-sub">Health of the platform, its pipelines and their data, per stage.</p>
        </div>
        {ready && (
          <div className="q-engine" role="status">
            <span className="icon"><img src="/icons/clock.svg" alt="" width="20" height="20" loading="lazy" /></span>
            <span><strong>Checked {ago(ready.data?.evaluated_at ?? new Date(ready.at).toISOString(), now)}</strong><span className="label">Auto-refresh · 30 s</span></span>
          </div>
        )}
      </div>
      <div className="mon-bar">
        <MonitoringViews stage={stage ?? asked ?? undefined} />
        {picker}
      </div>
      {body}
    </>
  );
}
