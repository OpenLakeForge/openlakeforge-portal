// Monitoring · data quality: the Data quality gauge and each pipeline's check words, from
// GET /api/v1/stages/{stage}/health/quality. Counts are the API's; `counts: null` is unknown and never shown as zeros.

import { ApiError, worst, type HealthState, type PipelineQuality, type QualityCounts, type StageQualityHealth } from "../lib/health-api";
import { Gauge } from "./MonitoringGauges";
import { absent, type Part } from "./MonitoringPipelines";

/** What the page knows about quality: the answer and its state, or a gap with its reason. */
export type Quality = { ok: true; data: StageQualityHealth; state: HealthState; counted: number } | { ok: false; state: HealthState; reason: string; error?: ApiError };

const denied = (e: ApiError) => e.status === 401 || e.status === 403 || e.status === 404;

export function quality(load: Part<StageQualityHealth>): Quality {
  if (load.status === "error") return { ok: false, state: denied(load.error) ? "disabled" : "unknown", reason: load.error.message, error: load.error };
  if (load.status === "off") return { ok: false, state: load.state, reason: load.reason };
  // A Dagster that could not be read, or a stage with no manifest reader, gives no counts at all.
  for (const name of ["dagster", "quality"]) {
    const i = load.data.integrations.find((x) => x.name === name);
    const gap = absent(i);
    if (gap) return { ok: false, state: gap, reason: i?.reason ?? `${name} could not be read` };
  }
  const p = load.data.pipelines;
  return { ok: true, data: load.data, state: p.length ? worst(p.map((x) => x.state)) : "unknown", counted: p.filter((x) => x.counts).length };
}

/** Failed checks with whether they block: `blocking` counts the failed checks that stopped the pipeline, so the rest
 * failed without stopping it. "4 failed (non-blocking)", "2 failed (1 blocking)", "1 failed (blocking)". */
export function failedWords(c: Pick<QualityCounts, "error" | "blocking">): string {
  if (!c.error) return "0 failed";
  const tag = !c.blocking ? "non-blocking" : c.blocking >= c.error ? "blocking" : `${c.blocking} blocking`;
  return `${c.error} failed (${tag})`;
}

const checks = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
/** A quality row of the list to act on, from its counts: what failed or warned, the worst first. Undefined when the
 * counts show nothing failed or warned (they are of another run than the signal), so the signal's own words stand. */
export function qualityTitle(c: QualityCounts): string | undefined {
  const soft = c.error - c.blocking;
  if (c.blocking) return `${checks(c.blocking, "blocking check")} failed`;
  if (soft > 0) return `${checks(soft, "non-blocking check")} failed`;
  if (c.warn) return `${checks(c.warn, "check")} warned`;
  return undefined;
}

/** "0 failed · 2 warned · 14 passed", with blocking failures, not-run and unknown checks when there are any. */
export function countsLine(c: QualityCounts): string {
  const parts = [failedWords(c), `${c.warn} warned`, `${c.passed} passed`];
  if (c.not_run) parts.push(`${c.not_run} not run`);
  if (c.unknown) parts.push(`${c.unknown} unknown`);
  return parts.join(" · ");
}

/** Where the card's totals come from: "counts from all 3 pipelines" ("from 1 pipeline"), or "of N" when some have none, and
 * "· K incomplete" when K of the counted ones are partial (`complete === false`), so a partial sum never looks whole.
 * A row with no counts is not in the sum (only in "of N"), so it is never called incomplete here. */
export function countsFrom(counted: number, pipelines: number, incomplete: number): string {
  const noun = pipelines === 1 ? "pipeline" : "pipelines";
  const from = counted < pipelines ? `counts from ${counted} of ${pipelines} ${noun}` : pipelines === 1 ? "counts from 1 pipeline" : `counts from all ${pipelines} ${noun}`;
  return incomplete ? `${from} · ${incomplete} incomplete` : from;
}

/** A row's reason as shown. An incomplete row with its own reason (a run that failed or was canceled before its
 * checks finished) shows that reason alone; only one with none (a run still writing results) says results are pending. */
export function qualityWhy(row: Pick<PipelineQuality, "complete" | "reason">): string {
  if (row.complete !== false || row.reason.trim()) return row.reason;
  return "not every result is in yet";
}

export function QualityCard({ q, retry }: { q: Quality; retry?(): void }) {
  const totals = q.ok ? q.data.totals : null;
  const pipelines = q.ok ? q.data.pipelines.length : 0;
  let note: string;
  if (!q.ok) note = q.reason;
  else if (!pipelines) note = "No pipeline has quality evidence on this stage yet.";
  else if (!totals) note = "No pipeline has quality counts yet, so none can be shown.";
  else {
    // Totals add up the known counts only: say when some pipelines have none or are incomplete, so a partial sum never
    // looks whole. A sum from every pipeline needs no words.
    const incomplete = q.data.pipelines.filter((x) => x.counts && x.complete === false).length;
    const partial = q.counted < pipelines || incomplete ? countsFrom(q.counted, pipelines, incomplete) : "";
    note = [totals.blocking && `${totals.blocking} blocking`, partial].filter(Boolean).join(" · ");
  }
  const total = totals ? totals.passed + totals.warn + totals.error + totals.not_run + totals.unknown : 0;
  return (
    <Gauge
      label="Data quality summary" title="Data quality" state={q.state === "healthy" ? undefined : q.state} note={note}
      center={totals && total ? `${Math.floor((totals.passed / total) * 100)}%` : "—"} unit={totals && total ? "passed" : undefined}
      slices={totals ? [
        { label: "Passed", value: totals.passed, tone: "ok" }, { label: "Warn", value: totals.warn, tone: "warn" },
        { label: "Failed", value: totals.error, tone: "bad" }, { label: "Not run", value: totals.not_run, tone: "none", optional: true },
        { label: "Unknown", value: totals.unknown, tone: "none", optional: true },
      ] : []}
    >
      {!q.ok && q.error && !denied(q.error) && retry && (
        <button type="button" className="f-btn f-outline mon-retry" onClick={retry}><span aria-hidden="true">↻</span> Retry</button>
      )}
    </Gauge>
  );
}

/** A pipeline's checks in a few words for its row: what failed or warned first, then what passed. */
export function checksShort(c: QualityCounts): string {
  const parts = [c.error && failedWords(c), c.warn && `${c.warn} warned`, `${c.passed} passed`, c.not_run && `${c.not_run} not run`, c.unknown && `${c.unknown} unknown`];
  return parts.filter(Boolean).join(" · ");
}
