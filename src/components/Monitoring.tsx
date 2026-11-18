import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { ApiError, effective, getStageHealth, worst, type HealthState, type Integration, type StageHealth } from "../lib/health-api";
import { StatusBadge } from "./StatusBadge";

const REFRESH_MS = 30_000;

/** The probe components the API reports (platform-api service_probes.py), in words. Others show their raw name. */
const SERVICE_NAMES: Record<string, string> = {
  "dagster.read-api": "Dagster API",
  "dagster.workloads": "Dagster workloads",
  "trino.readiness": "Trino",
  "trino.workloads": "Trino workloads",
  "polaris.readiness": "Polaris catalog",
  "object-store.list": "Object storage",
  "log-archive.newest-object": "Log archive",
  "log-archive.spool-age": "Log spool age",
  "log-archive.spool-size": "Log spool size",
};

export function ago(iso: string | null, now: number): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** An integration that gives no evidence: disabled on purpose, or unknown because it could not be read. */
const absent = (i?: Integration): HealthState | undefined =>
  !i || i.status === "available" ? undefined : i.status === "unavailable" ? "unknown" : "disabled";

const TITLE: Record<HealthState, string> = {
  healthy: "is healthy", warning: "needs attention", critical: "needs attention", unknown: "status unknown", disabled: "monitoring is off",
};

type Load = { status: "loading" } | { status: "ok"; data: StageHealth; at: number } | { status: "error"; error: ApiError };

function Overview({ health, now }: { health: StageHealth; now: number }) {
  const stage = health.stage.toUpperCase();
  const integration = (n: Integration["name"]) => health.integrations.find((i) => i.name === n);
  const services = health.services.map((s) => ({ ...s, shown: effective(s, now) }));
  const ready = services.filter((s) => s.shown === "healthy").length;
  // An expired probe is no evidence: the stage reads at least unknown, and a worse API rollup always stands.
  const expired = services.filter((s) => s.shown !== s.state).length;
  const stageState = expired ? worst([health.state, "unknown"]) : health.state;
  const servicesGap = absent(integration("services"));
  const servicesState = servicesGap ?? (services.length ? worst(services.map((s) => s.shown)) : "unknown");
  const pipelinesGap = absent(integration("dagster"));
  const failing = health.pipelines.filter((p) => p.state === "critical").length;
  const pipelinesState = pipelinesGap ?? (health.pipelines.length ? worst(health.pipelines.map((p) => p.state)) : "unknown");
  const metrics = integration("metrics");
  const metricsGap = absent(metrics);
  const servicesLine = servicesGap ? "service probes give no answer" : `${ready} of ${services.length} services ready`;
  const pipelinesLine = pipelinesGap ? "pipelines cannot be read" : `${failing} pipeline${failing === 1 ? "" : "s"} failing`;

  return (
    <>
      <section className="mon-banner" data-state={stageState} aria-labelledby="mon-banner-h">
        <div>
          <h2 id="mon-banner-h"><StatusBadge state={stageState} /> {stage} {TITLE[stageState]}</h2>
          <p>{pipelinesLine} · {servicesLine}{expired ? ` · ${expired} service answer${expired === 1 ? "" : "s"} expired` : ""}</p>
        </div>
      </section>

      <div className="mon-summary">
        <section className="mon-card" aria-label="Services summary">
          <div className="mon-card-top"><h2 className="label">Services</h2><StatusBadge state={servicesState} /></div>
          {servicesGap
            ? <p className="mon-value"><strong>—</strong></p>
            : <p className="mon-value"><strong>{ready} of {services.length}</strong> ready</p>}
          <p className="mon-note">{servicesGap ? integration("services")?.reason : services.map((s) => SERVICE_NAMES[s.component] ?? s.component).join(", ")}</p>
        </section>
        <section className="mon-card" aria-label="Pipelines summary">
          <div className="mon-card-top"><h2 className="label">Pipelines</h2><StatusBadge state={pipelinesState} /></div>
          {pipelinesGap
            ? <p className="mon-value"><strong>—</strong></p>
            : <p className="mon-value"><strong>{failing} failed</strong> of {health.pipelines.length}</p>}
          <p className="mon-note">{pipelinesGap ? integration("dagster")?.reason : health.pipelines.length ? health.pipelines.map((p) => p.job).join(", ") : "No pipelines have run on this stage yet."}</p>
        </section>
      </div>

      <section className="q-card mon-list" aria-labelledby="mon-services-h">
        <div className="f-card-head">
          <h2 id="mon-services-h">Services</h2>
          <span className="f-count">{services.length + (metricsGap ? 1 : 0)}</span>
        </div>
        <div className="f-scroll" role="region" aria-label="Service health" tabIndex={0}>
          <table className="f-table mon-table">
            <thead><tr><th scope="col">Service</th><th scope="col">State</th><th scope="col">Detail</th><th scope="col">Last checked</th></tr></thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.component}>
                  <th scope="row">{SERVICE_NAMES[s.component] ?? <span className="f-mono">{s.component}</span>}</th>
                  <td><StatusBadge state={s.shown} /></td>
                  <td>{s.shown !== s.state ? `Stale: no fresh answer since ${ago(s.observed_at, now)}. ${s.reason}` : s.reason}</td>
                  <td className="f-mono">{ago(s.observed_at, now)}</td>
                </tr>
              ))}
              {services.length === 0 && (
                <tr><th scope="row">Service probes</th><td><StatusBadge state={servicesGap ?? "unknown"} /></td>
                  <td>{integration("services")?.reason ?? "The API reported no services for this stage."}</td><td className="f-mono">—</td></tr>
              )}
              {metricsGap && (
                <tr><th scope="row">Resource metrics</th><td><StatusBadge state={metricsGap} /></td>
                  <td>{metrics?.reason}</td><td className="f-mono">—</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Unavailable({ stage, error, lastGood, onRetry }: { stage: string; error: ApiError; lastGood?: number; onRetry(): void }) {
  const denied = error.status === 401 || error.status === 403 || error.status === 404;
  return (
    <section className="mon-banner mon-state" data-state={denied ? "disabled" : "unknown"} aria-labelledby="mon-banner-h">
      <div>
        <h2 id="mon-banner-h">
          <StatusBadge state={denied ? "disabled" : "unknown"} /> {stage.toUpperCase()} {denied ? "health is not available" : "status unknown"}
        </h2>
        <p role="alert">{error.message}{!denied && lastGood ? ` Last good snapshot ${clock(lastGood)}.` : ""}</p>
        {!denied && <button type="button" className="f-btn f-outline" onClick={onRetry}><span aria-hidden="true">↻</span> Retry</button>}
      </div>
    </section>
  );
}

/** Monitoring · Overview (Figma "Screens — v0.4 · Monitoring"): platform health per stage, from the Platform API only. */
export function Monitoring({ stages }: { stages: string[] }) {
  const [params, setParams] = useSearchParams();
  const asked = params.get("stage");
  const stage = asked && stages.includes(asked) ? asked : stages[0];
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [lastGood, setLastGood] = useState<number>();
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!stage) return;
    const ctl = new AbortController();
    setLoad((l) => (l.status === "ok" && l.data.stage === stage ? l : { status: "loading" }));
    getStageHealth(stage, ctl.signal).then(
      (data) => {
        if (ctl.signal.aborted) return; // the stage changed or the page left: this answer is not for it
        const at = Date.now(); setLoad({ status: "ok", data, at }); setLastGood(at); setNow(at); },
      (e) => { if (!ctl.signal.aborted) setLoad({ status: "error", error: e instanceof ApiError ? e : new ApiError(0, String(e)) }); },
    );
    const refresh = setTimeout(retry, REFRESH_MS);
    return () => { ctl.abort(); clearTimeout(refresh); };
  }, [stage, attempt, retry]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(tick);
  }, []);

  const pick = (s: string) => { setLastGood(undefined); setParams({ stage: s }); };

  return (
    <>
      <div className="q-head">
        <div>
          <h1>Monitoring</h1>
          <p className="f-sub">Health of the platform, its pipelines and their data, per stage.</p>
        </div>
        {load.status === "ok" && (
          <div className="q-engine" role="status">
            <span className="icon"><img src="/icons/clock.svg" alt="" width="20" height="20" loading="lazy" /></span>
            <span><strong>Checked {ago(load.data.evaluated_at, now)}</strong><span className="label">Auto-refresh · 30 s</span></span>
          </div>
        )}
      </div>

      {stages.length === 0 ? (
        <p className="empty"><span className="label">No stages</span>This deployment has no stage to monitor yet.</p>
      ) : (
        <>
          <div className="q-context">
            <label>
              <span className="q-label">Stage</span>
              <select className="q-select" value={stage} onChange={(e) => pick(e.target.value)}>
                {stages.map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}
              </select>
            </label>
          </div>
          {load.status === "loading" && <p className="mon-loading" role="status">Reading {stage.toUpperCase()} health…</p>}
          {load.status === "error" && <Unavailable stage={stage} error={load.error} lastGood={lastGood} onRetry={retry} />}
          {load.status === "ok" && <Overview health={load.data} now={now} />}
        </>
      )}
    </>
  );
}
