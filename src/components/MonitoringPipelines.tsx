// Monitoring · pipelines: the Pipelines summary card, the "Needs attention" table and the pipelines table, all from
// GET /api/v1/stages/{stage}/health/pipelines. Every row is a signal the API returned, in the API's words: nothing
// is inferred, and a pipeline answer that is missing, refused or expired is never shown as healthy.

import {
  ApiError, effective, worst,
  type HealthSignal, type HealthState, type Integration, type PipelineHealth, type PipelinesHealth,
} from "../lib/health-api";
import { StatusBadge } from "./StatusBadge";

/** The pipelines read of one snapshot: its answer, or why there is none. */
export type PipesLoad = { status: "ok"; data: PipelinesHealth } | { status: "error"; error: ApiError };

type Signal = HealthSignal & { shown: HealthState };
export type Pipeline = Omit<PipelineHealth, "signals"> & { signals: Signal[]; shown: HealthState };
/** What the page knows about pipelines: their list, or a gap with its reason and the state that gap reads as. */
export type Pipes =
  | { ok: true; pipelines: Pipeline[]; runWindow: number; failed: number; missed: number; quality: { warning: number; critical: number }; expired: number }
  | { ok: false; state: HealthState; reason: string; error?: ApiError };

const denied = (e: ApiError) => e.status === 401 || e.status === 403 || e.status === 404;
/** An integration that gives no evidence: disabled on purpose, or unknown because it could not be read. */
export const absent = (i?: Integration): HealthState | undefined =>
  !i || i.status === "available" ? undefined : i.status === "unavailable" ? "unknown" : "disabled";

const of = (p: Pipeline, kind: HealthSignal["kind"]) => p.signals.find((s) => s.kind === kind);

/** Reads the pipelines answer at `now`: an expired healthy signal reads unknown, and so does the pipeline it is in. */
export function pipes(load: PipesLoad, now: number): Pipes {
  if (load.status === "error") return { ok: false, state: denied(load.error) ? "disabled" : "unknown", reason: load.error.message, error: load.error };
  const dagster = load.data.integrations.find((i) => i.name === "dagster");
  const gap = absent(dagster);
  if (gap) return { ok: false, state: gap, reason: dagster?.reason ?? "Dagster could not be read" };
  let expired = 0;
  const pipelines = load.data.pipelines.map((p) => {
    const signals = p.signals.map((s) => ({ ...s, shown: effective(s, now) }));
    const stale = signals.filter((s) => s.shown !== s.state).length;
    expired += stale;
    return { ...p, signals, shown: stale ? worst([p.state, "unknown"]) : p.state };
  });
  const count = (kind: HealthSignal["kind"], state: HealthState) => pipelines.filter((p) => of(p, kind)?.shown === state).length;
  return {
    ok: true, pipelines, expired, runWindow: load.data.thresholds.run_window,
    failed: count("execution", "critical"), missed: count("expected_run", "critical"),
    quality: { warning: count("quality", "warning"), critical: count("quality", "critical") },
  };
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** The banner's pipeline words: what failed and was missed, from the pipelines answer. */
export function pipesLine(p: Pipes): string {
  if (!p.ok) return "pipelines cannot be read";
  const parts = [`${plural(p.failed, "pipeline")} failed`];
  if (p.missed) parts.push(plural(p.missed, "missed run"));
  if (p.quality.critical) parts.push(plural(p.quality.critical, "quality failure"));
  if (p.quality.warning) parts.push(plural(p.quality.warning, "quality warning"));
  return parts.join(" · ");
}

/** "14:05" today, "16 Nov 14:05" another day. */
export function when(t: number | string | null | undefined, now: number): string {
  if (t === null || t === undefined) return "—";
  const d = new Date(typeof t === "number" ? t * 1000 : Date.parse(t));
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}
const short = (run: string) => run.slice(0, 8);

export function PipelinesCard({ p, now }: { p: Pipes; now: number }) {
  const state = p.ok ? (p.pipelines.length ? worst(p.pipelines.map((x) => x.shown)) : "unknown") : p.state;
  const last = p.ok
    ? p.pipelines.map((x) =>
        x.latest_run?.status === "FAILURE" ? `${x.job} failed ${when(x.latest_run.ended_at ?? x.latest_run.created_at, now)}`
          : x.last_success ? `${x.job} ${when(x.last_success.ended_at ?? x.last_success.created_at, now)}` : `${x.job} no success on record`)
    : [];
  return (
    <section className="mon-card" aria-label="Pipelines summary">
      <div className="mon-card-top"><h2 className="label">Pipelines</h2><StatusBadge state={state} /></div>
      {p.ok
        ? <p className="mon-value"><strong>{p.failed} failed</strong> of {p.pipelines.length} · {p.missed} missed</p>
        : <p className="mon-value"><strong>—</strong></p>}
      <p className="mon-note">
        {!p.ok ? p.reason : p.pipelines.length ? `Last success · ${last.slice(0, 4).join(" · ")}${last.length > 4 ? ` · +${last.length - 4} more` : ""}` : "No pipelines on this stage yet."}
      </p>
    </section>
  );
}

const TITLES: Partial<Record<HealthSignal["kind"], Partial<Record<HealthState, string>>>> = {
  execution: { critical: "Run failed", warning: "Run canceled" },
  expected_run: { critical: "Expected run did not start", warning: "Schedule is stopped" },
  freshness: { critical: "Data is late", warning: "Data is ageing" },
  quality: { critical: "Quality check failed", warning: "Quality check warned" },
};
type Row = { key: string; state: HealthState; title: string; detail: string; job?: string; at?: string; run?: string | null; sort: number };
const RANK: Record<HealthState, number> = { critical: 0, warning: 1, unknown: 2, healthy: 3, disabled: 4 };

/** One row per warning or critical signal, and one per pipeline that has no current evidence. Worst first. */
export function attention(p: Pipes, stage: string): Row[] {
  if (!p.ok) return [{ key: "gap", state: p.state, title: p.state === "disabled" ? "Pipeline health is not available" : "Pipelines cannot be read", detail: p.reason, sort: 0 }];
  if (!p.pipelines.length) return [{ key: "none", state: "unknown", title: "No pipelines", detail: `Dagster reports no pipeline on ${stage.toUpperCase()}, so none can be shown as healthy.`, sort: 0 }];
  const rows: Row[] = [];
  for (const x of p.pipelines) {
    const bad = x.signals.filter((s) => s.shown === "critical" || s.shown === "warning");
    for (const s of bad) {
      const at = s.kind === "expected_run" ? x.schedule.last_expected_at ?? s.observed_at : s.observed_at;
      rows.push({
        key: `${x.job}/${s.kind}`, state: s.shown, title: TITLES[s.kind]?.[s.shown] ?? s.kind, detail: s.reason,
        job: x.job, at: at ?? undefined, run: s.run, sort: RANK[s.shown],
      });
    }
    if (!bad.length && x.shown === "unknown") {
      const unknown = x.signals.filter((s) => s.shown === "unknown");
      rows.push({
        key: `${x.job}/unknown`, state: "unknown", title: "No current evidence", job: x.job, sort: RANK.unknown,
        detail: unknown.map((s) => `${s.kind.replace("_", " ")}: ${s.shown !== s.state ? "answer expired" : s.reason}`).join(" · ") || "the API gave no signal",
      });
    }
  }
  return rows.sort((a, b) => a.sort - b.sort || (b.at ? Date.parse(b.at) : 0) - (a.at ? Date.parse(a.at) : 0));
}

export function NeedsAttention({ p, now, stage, retry }: { p: Pipes; now: number; stage: string; retry?: { onRetry(): void; lastGood?: number } }) {
  const rows = attention(p, stage);
  return (
    <section className="q-card mon-list" aria-labelledby="mon-attention-h">
      <div className="f-card-head">
        <h2 id="mon-attention-h">Needs attention</h2>
        <span className="f-count">{rows.length}</span>
      </div>
      <div className="f-scroll" role="region" aria-label="What needs attention" tabIndex={0}>
        <table className="f-table mon-table mon-attention">
          <thead><tr><th scope="col">State</th><th scope="col">What happened</th><th scope="col">Pipeline</th><th scope="col">When</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td><StatusBadge state={r.state} /></td>
                <th scope="row">
                  <span className="mon-what">{r.title}</span>
                  <span className="mon-why f-mono">{r.detail}</span>
                  {r.key === "gap" && retry && (
                    <span className="mon-why">
                      {retry.lastGood ? `Last good snapshot ${when(retry.lastGood / 1000, now)}. ` : ""}
                      <button type="button" className="f-btn f-outline" onClick={retry.onRetry}><span aria-hidden="true">↻</span> Retry</button>
                    </span>
                  )}
                </th>
                <td className="f-mono mon-job">{r.job ?? "—"}</td>
                <td className="f-mono">{r.at ? when(r.at, now) : "—"}{r.run ? ` · run ${short(r.run)}` : ""}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><th scope="row" colSpan={4} className="mon-clear">Nothing needs attention: no pipeline signal is warning or critical.</th></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const SCHEDULE: Record<PipelineHealth["schedule"]["status"], string> = { running: "running", stopped: "stopped", absent: "No schedule" };
const RUN_WORD: Record<string, string> = { SUCCESS: "Succeeded", FAILURE: "Failed", CANCELED: "Canceled", CANCELING: "Canceling", STARTED: "Running", QUEUED: "Queued", STARTING: "Starting", NOT_STARTED: "Not started" };

export function PipelinesTable({ p, now }: { p: Extract<Pipes, { ok: true }>; now: number }) {
  if (!p.pipelines.length) return null;
  return (
    <section className="q-card mon-list" aria-labelledby="mon-pipelines-h">
      <div className="f-card-head">
        <h2 id="mon-pipelines-h">Pipelines</h2>
        <span className="f-count">{p.pipelines.length}</span>
      </div>
      <div className="f-scroll" role="region" aria-label="Pipeline health" tabIndex={0}>
        <table className="f-table mon-table mon-pipes">
          <thead>
            <tr><th scope="col">Pipeline</th><th scope="col">State</th><th scope="col">Latest run</th><th scope="col">Last success</th><th scope="col">Schedule</th><th scope="col">Failed runs</th></tr>
          </thead>
          <tbody>
            {p.pipelines.map((x) => {
              const run = x.latest_run;
              return (
                <tr key={x.job}>
                  <th scope="row"><span className="f-mono">{x.job}</span></th>
                  <td><StatusBadge state={x.shown} /></td>
                  <td>{run ? <>{RUN_WORD[run.status] ?? run.status} · {when(run.ended_at ?? run.started_at ?? run.created_at, now)} <span className="f-mono">· {short(run.run_id)}</span></> : "No run in the window"}</td>
                  <td>{x.freshness.last_success_at ? when(x.freshness.last_success_at, now) : "None on record"}</td>
                  <td>{x.schedule.status === "absent" ? SCHEDULE.absent : <><span className="f-mono">{x.schedule.name}</span> · {SCHEDULE[x.schedule.status]}</>}</td>
                  <td className="f-mono">{x.failed_runs} of last {p.runWindow}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
