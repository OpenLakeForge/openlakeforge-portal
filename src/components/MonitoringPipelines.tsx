// Monitoring · pipelines: the Pipelines summary card, the "Needs attention" rows and the pipelines table, all from
// GET /api/v1/stages/{stage}/health/pipelines. Every row is a signal the API returned, in the API's words: nothing
// is inferred, and a pipeline answer that is missing, refused or expired is never shown as healthy.

import {
  ApiError, effective, worst,
  type HealthSignal, type HealthState, type HealthWindow, type Integration, type PipelineHealth, type PipelinesHealth,
} from "../lib/health-api";
import { Link } from "react-router";
import { formatTime, seconds, useTimeZone, type TimeZoneState } from "../lib/time";
import { StatusBadge } from "./StatusBadge";
import { Time, Zoned } from "./Time";

/** One read of a snapshot: its answer, why it failed, or why it was not made (`off`: no source, or not the role's). */
export type Part<T> = { status: "ok"; data: T } | { status: "error"; error: ApiError } | { status: "off"; state: HealthState; reason: string };
export type PipesLoad = Part<PipelinesHealth>;

type Signal = HealthSignal & { shown: HealthState };
export type Pipeline = Omit<PipelineHealth, "signals"> & { signals: Signal[]; shown: HealthState };
/** What the page knows about pipelines: their list, or a gap with its reason and the state that gap reads as. */
export type Pipes =
  | { ok: true; pipelines: Pipeline[]; runWindow: number; window: HealthWindow | null; failed: number; missed: number; quality: { warning: number; critical: number }; expired: number }
  | { ok: false; state: HealthState; reason: string; error?: ApiError; off?: boolean };

const denied = (e: ApiError) => e.status === 401 || e.status === 403 || e.status === 404;
/** An integration that gives no evidence: disabled on purpose, or unknown because it could not be read. */
export const absent = (i?: Pick<Integration, "status">): HealthState | undefined =>
  !i || i.status === "available" ? undefined : i.status === "unavailable" ? "unknown" : "disabled";

const of = (p: Pipeline, kind: HealthSignal["kind"]) => p.signals.find((s) => s.kind === kind);

/** Reads the pipelines answer at `now`: an expired healthy signal reads unknown, and so does the pipeline it is in. */
export function pipes(load: PipesLoad, now: number): Pipes {
  if (load.status === "error") return { ok: false, state: denied(load.error) ? "disabled" : "unknown", reason: load.error.message, error: load.error };
  if (load.status === "off") return { ok: false, state: load.state, reason: load.reason, off: true };
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
    ok: true, pipelines, expired, runWindow: load.data.thresholds.run_window, window: load.data.window ?? null,
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

const short = (run: string) => run.slice(0, 8);
/** The Failed-run screen of one run. */
export const runHref = (stage: string, run: string) => `/monitoring/${encodeURIComponent(stage)}/runs/${encodeURIComponent(run)}`;
/** The Runs page of one pipeline; with `failedIn`, only its failed runs in that window (e.g. "24h"). */
export function runsHref(stage: string, job: string, failedIn?: string): string {
  const q = new URLSearchParams({ job });
  if (failedIn) { q.set("status", "failed"); q.set("window", failedIn); }
  return `/monitoring/${encodeURIComponent(stage)}/runs?${q}`;
}
/** A machine name that may wrap after each `_` or `.`, never inside a word. */
export function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[_.])/);
  return <>{parts.map((x, n) => <span key={n}>{n ? <wbr /> : null}{x}</span>)}</>;
}
/** A pipeline name as a link to its runs. */
export function JobLink({ stage, job }: { stage: string; job: string }) {
  return <Link className="run-link f-mono mon-job-link" to={runsHref(stage, job)} aria-label={`Runs of ${job}`}><Breakable text={job} /></Link>;
}
/** A run id as a link to its Failed-run screen; the accessible name says which run it opens. */
export function RunLink({ stage, run, label = `run ${short(run)}` }: { stage: string; run: string; label?: string }) {
  return <Link className="run-link f-mono" to={runHref(stage, run)} aria-label={`Open run ${short(run)}`}>{label}</Link>;
}

/** "2 critical · 1 warning · 1 healthy": how many items read each state, worst first. Counts only, never names. */
export function stateCounts(states: HealthState[]): string {
  const order: HealthState[] = ["critical", "warning", "unknown", "disabled", "healthy"];
  return order.flatMap((st) => { const n = states.filter((x) => x === st).length; return n ? [`${n} ${st}`] : []; }).join(" · ");
}

export function PipelinesCard({ p }: { p: Pipes }) {
  const state = p.ok ? (p.pipelines.length ? worst(p.pipelines.map((x) => x.shown)) : "unknown") : p.state;
  return (
    <section className="mon-card" aria-label="Pipelines summary">
      <div className="mon-card-top"><h2 className="label">Pipelines</h2><StatusBadge state={state} /></div>
      {p.ok
        ? <p className="mon-value"><strong>{p.failed} failed</strong> of {p.pipelines.length} · {p.missed} missed</p>
        : <p className="mon-value"><strong>—</strong></p>}
      <p className="mon-note">
        {!p.ok ? p.reason : p.pipelines.length ? stateCounts(p.pipelines.map((x) => x.shown)) : "No pipelines on this stage yet."}
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
export type Row = { key: string; state: HealthState; title: string; detail: string; kind?: HealthSignal["kind"]; job?: string; at?: string; due?: string | null; run?: string | null; sort: number };
export const RANK: Record<HealthState, number> = { critical: 0, warning: 1, unknown: 2, healthy: 3, disabled: 4 };

/** One row per warning or critical signal, and one per pipeline that has no current evidence. Worst first. */
export function attention(p: Pipes, stage: string): Row[] {
  if (!p.ok) return [{ key: "gap", state: p.state, title: p.state === "disabled" ? "Pipeline health is not available" : "Pipelines cannot be read", detail: p.reason, sort: 0 }];
  if (!p.pipelines.length) return [{ key: "none", state: "unknown", title: "No pipelines", detail: `Dagster reports no pipeline on ${stage.toUpperCase()}, so none can be shown as healthy.`, sort: 0 }];
  const rows: Row[] = [];
  for (const x of p.pipelines) {
    const bad = x.signals.filter((s) => s.shown === "critical" || s.shown === "warning");
    for (const s of bad) {
      // An expected_run signal names the occurrence it judged (`due`); the schedule's last tick is only a fallback.
      const due = s.kind === "expected_run" ? s.due : null;
      const at = s.kind === "expected_run" ? due ?? x.schedule.last_expected_at ?? s.observed_at : s.observed_at;
      rows.push({
        key: `${x.job}/${s.kind}`, kind: s.kind, state: s.shown, title: TITLES[s.kind]?.[s.shown] ?? s.kind, detail: s.reason,
        job: x.job, at: at ?? undefined, due, run: s.run, sort: RANK[s.shown],
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

/** A pipeline's failed-run count in the API's window, as words. Null is unknown, never 0. A count whose read stopped
 * short of the window's start says where it starts (the pipeline's `covered_from`). An older API without `window` counts the last `run_window` runs. */
export function failedRuns(x: Pick<PipelineHealth, "failed_runs" | "covered_from">, p: Pick<Extract<Pipes, { ok: true }>, "window" | "runWindow">, now: number,
  tz: Pick<TimeZoneState, "zone" | "label">): { text: string; why?: string; failedIn?: string } {
  if (x.failed_runs === null) return { text: "Unknown", why: "the count of failed runs could not be read" };
  if (!p.window) return { text: `${x.failed_runs} of last ${p.runWindow} runs` };
  // The pipeline's own `covered_from`: the window's is about the stage's sum, and a job with none counts the whole window.
  const from = x.covered_from;
  const failedIn = x.failed_runs > 0 ? p.window.range : undefined;
  if (from) return { text: `${x.failed_runs} failed since ${formatTime(from, tz.zone, now)} ${tz.label}`, why: `the run read stopped short of the last ${p.window.range}`, failedIn };
  return { text: `${x.failed_runs} failed in last ${p.window.range}`, failedIn };
}

const SCHEDULE: Record<PipelineHealth["schedule"]["status"], string> = { running: "Running", stopped: "Stopped", absent: "No schedule" };
const RUN_WORD: Record<string, string> = { SUCCESS: "Succeeded", FAILURE: "Failed", CANCELED: "Canceled", CANCELING: "Canceling", STARTED: "Running", QUEUED: "Queued", STARTING: "Starting", NOT_STARTED: "Not started" };

export function PipelinesTable({ p, now, stage }: { p: Extract<Pipes, { ok: true }>; now: number; stage: string }) {
  const tz = useTimeZone();
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
            <tr><th scope="col">Pipeline</th><th scope="col">State</th><th scope="col"><Zoned>Latest run</Zoned></th><th scope="col"><Zoned>Last success</Zoned></th><th scope="col">Schedule</th><th scope="col">Failed runs</th></tr>
          </thead>
          <tbody>
            {p.pipelines.map((x) => {
              const run = x.latest_run;
              return (
                <tr key={x.job}>
                  <th scope="row"><JobLink stage={stage} job={x.job} /></th>
                  <td><StatusBadge state={x.shown} /></td>
                  <td>{run ? <>{RUN_WORD[run.status] ?? run.status} · <Time at={seconds(run.ended_at ?? run.started_at ?? run.created_at)} now={now} bare /><span className="mon-why"><RunLink stage={stage} run={run.run_id} label={short(run.run_id)} /></span></> : "No run in the window"}</td>
                  <td>{x.freshness.last_success_at ? <Time at={x.freshness.last_success_at} now={now} bare /> : "None on record"}</td>
                  <td>{x.schedule.status === "absent" ? SCHEDULE.absent : <>{SCHEDULE[x.schedule.status]}<span className="mon-why f-mono">{x.schedule.name && <Breakable text={x.schedule.name} />}</span></>}</td>
                  <td className="f-mono mon-failed">{(() => {
                    const f = failedRuns(x, p, now, tz);
                    const text = f.failedIn
                      ? <Link className="run-link" to={runsHref(stage, x.job, f.failedIn)} aria-label={`${f.text}: open the failed runs of ${x.job}`}>{f.text}</Link>
                      : f.text;
                    return <>{text}{f.why && <span className="mon-why">{f.why}</span>}</>;
                  })()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
