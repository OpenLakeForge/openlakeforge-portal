// Monitoring · pipelines: the "Needs attention" rows and the pipelines table, with each pipeline's quality checks, from
// GET /api/v1/stages/{stage}/health/pipelines and .../health/quality. Every row is a signal the API returned, in the API's words: nothing
// is inferred, and a pipeline answer that is missing, refused or expired is never shown as healthy.

import {
  ApiError, effective, worst,
  type HealthSignal, type HealthState, type HealthWindow, type Integration, type PipelineHealth, type PipelinesHealth,
} from "../lib/health-api";
import { useState } from "react";
import { Link } from "react-router";
import { duration, formatTime, seconds, useTimeZone, type TimeZoneState } from "../lib/time";
import { checksShort, countsLine, qualityWhy, type Quality } from "./MonitoringQuality";
import { StatusBadge } from "./StatusBadge";
import { Time, Zoned } from "./Time";

/** One read of a snapshot: its answer, why it failed, or why it was not made (`off`: no source, or not the role's). */
export type Part<T> = { status: "ok"; data: T } | { status: "error"; error: ApiError } | { status: "off"; state: HealthState; reason: string };
export type PipesLoad = Part<PipelinesHealth>;

type Signal = HealthSignal & { shown: HealthState };
export type Pipeline = Omit<PipelineHealth, "signals"> & { signals: Signal[]; shown: HealthState };
/** What the page knows about pipelines: their list, or a gap with its reason and the state that gap reads as. */
export type Pipes =
  | { ok: true; pipelines: Pipeline[]; runWindow: number; window: HealthWindow | null; expired: number }
  | { ok: false; state: HealthState; reason: string; error?: ApiError; off?: boolean };

const denied = (e: ApiError) => e.status === 401 || e.status === 403 || e.status === 404;
/** An integration that gives no evidence: disabled on purpose, or unknown because it could not be read. */
export const absent = (i?: Pick<Integration, "status">): HealthState | undefined =>
  !i || i.status === "available" ? undefined : i.status === "unavailable" ? "unknown" : "disabled";

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
  return {
    ok: true, pipelines, expired, runWindow: load.data.thresholds.run_window, window: load.data.window ?? null,
  };
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
        key: `${x.job}/unknown`, state: "unknown", title: x.latest_run || x.last_success ? "No current evidence" : "No runs yet", job: x.job, sort: RANK.unknown,
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

/** One row per pipeline: its state, latest run, how long it took and its checks. The rest (last success, schedule,
 * failed runs, the product and the quality reason) opens under the row. A pipeline only the quality answer names is
 * listed too, so a role without the pipelines read still sees the checks. */
export function PipelinesTable({ p, q, now, stage }: { p: Pipes; q: Quality; now: number; stage: string }) {
  const tz = useTimeZone();
  const [open, setOpen] = useState<string[]>([]);
  const pipelines = p.ok ? p.pipelines : [];
  const checks = q.ok ? q.data.pipelines : [];
  const jobs = [...new Set([...pipelines.map((x) => x.job), ...checks.map((x) => x.job)])];
  if (!jobs.length) return null;
  const toggle = (job: string) => setOpen((o) => (o.includes(job) ? o.filter((x) => x !== job) : [...o, job]));
  return (
    <section className="q-card mon-list" aria-labelledby="mon-pipelines-h">
      <div className="f-card-head">
        <h2 id="mon-pipelines-h">Pipelines</h2>
        <span className="f-count">{jobs.length}</span>
      </div>
      <div className="f-scroll" role="region" aria-label="Pipeline health" tabIndex={0}>
        <table className="f-table mon-table mon-pipes">
          <thead>
            <tr><th scope="col">Pipeline</th><th scope="col">State</th><th scope="col"><Zoned>Latest run</Zoned></th><th scope="col">Took</th><th scope="col">Checks</th><th scope="col"><span className="sr-only">Details</span></th></tr>
          </thead>
          {jobs.map((job) => {
              const x = pipelines.find((y) => y.job === job);
              const c = checks.find((y) => y.job === job);
              const run = x?.latest_run;
              const shown = open.includes(job);
              const f = x && p.ok ? failedRuns(x, p, now, tz) : undefined;
              return (
                <tbody key={job}>
                  <tr>
                    <th scope="row"><JobLink stage={stage} job={job} /></th>
                    <td><StatusBadge state={x?.shown ?? c!.state} /></td>
                    <td>{run ? <>{RUN_WORD[run.status] ?? run.status} · <Time at={seconds(run.ended_at ?? run.started_at ?? run.created_at)} now={now} bare /></> : x ? "No run in the window" : "—"}</td>
                    <td className="f-mono">{run && run.started_at !== null && run.ended_at !== null ? duration(run.ended_at - run.started_at) : "—"}</td>
                    <td className="mon-checks">
                      {c ? <>
                        {c.counts ? checksShort(c.counts) : "Counts unknown"}
                        {c.complete === false && <span className="mon-tag">Incomplete</span>}
                        {c.state !== "healthy" && <> <StatusBadge state={c.state} /></>}
                      </> : "—"}
                    </td>
                    <td><button type="button" className="f-link" aria-expanded={shown} aria-label={`Details of ${job}`} onClick={() => toggle(job)}>{shown ? "Hide" : "Details"}</button></td>
                  </tr>
                  {shown && (
                    <tr className="mon-detail">
                      <td colSpan={6}>
                        <dl>
                          {x && <>
                            <div><dt>Last success</dt><dd>{x.freshness.last_success_at ? <Time at={x.freshness.last_success_at} now={now} /> : "None on record"}</dd></div>
                            <div><dt>Schedule</dt><dd>{x.schedule.status === "absent" ? SCHEDULE.absent : <>{SCHEDULE[x.schedule.status]}{x.schedule.name && <> · <span className="f-mono"><Breakable text={x.schedule.name} /></span></>}</>}</dd></div>
                            <div><dt>Failed runs</dt><dd>
                              {f?.failedIn ? <Link className="run-link" to={runsHref(stage, job, f.failedIn)} aria-label={`${f.text}: open the failed runs of ${job}`}>{f.text}</Link> : f?.text}
                              {f?.why && <span className="mon-why">{f.why}</span>}
                            </dd></div>
                          </>}
                          {run && <div><dt>Latest run</dt><dd><RunLink stage={stage} run={run.run_id} label={short(run.run_id)} /></dd></div>}
                          {c && <>
                            <div><dt>Product</dt><dd className="f-mono">{c.domain ? `${c.domain} · ` : ""}{c.product ?? c.job}</dd></div>
                            <div><dt>Quality</dt><dd>
                              {c.counts ? countsLine(c.counts) : "Counts unknown"}
                              <span className="mon-why mon-quality-why">{qualityWhy(c)}</span>
                              {c.run_id ? <span className="mon-why"><Time at={c.observed_at} now={now} /> · <RunLink stage={stage} run={c.run_id} /></span> : <span className="mon-why">No run</span>}
                            </dd></div>
                          </>}
                        </dl>
                      </td>
                    </tr>
                  )}
                </tbody>
              );
            })}
        </table>
      </div>
    </section>
  );
}
