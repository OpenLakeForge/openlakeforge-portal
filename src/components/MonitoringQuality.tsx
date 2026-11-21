// Monitoring · data quality: the Data quality card and the per-pipeline table, from
// GET /api/v1/stages/{stage}/health/quality. Counts are the API's; `counts: null` is unknown and never shown as zeros.

import { ApiError, worst, type HealthState, type PipelineQuality, type QualityCounts, type StageQualityHealth } from "../lib/health-api";
import { absent, RunLink, type Part } from "./MonitoringPipelines";
import { StatusBadge } from "./StatusBadge";
import { Time, Zoned } from "./Time";

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

/** "0 error · 2 warn · 14 passed", with blocking errors, not-run and unknown checks when there are any. */
export function countsLine(c: QualityCounts): string {
  const parts = [`${c.error} error${c.blocking ? ` (${c.blocking} blocking)` : ""}`, `${c.warn} warn`, `${c.passed} passed`];
  if (c.not_run) parts.push(`${c.not_run} not run`);
  if (c.unknown) parts.push(`${c.unknown} unknown`);
  return parts.join(" · ");
}

/** Where the card's totals come from: "counts from all 3 pipelines", or "of N" when some have none, and
 * "· K incomplete" when K of them are partial (`complete === false`), so a partial sum never looks whole. */
export function countsFrom(counted: number, pipelines: number, incomplete: number): string {
  const from = counted < pipelines ? `counts from ${counted} of ${pipelines} pipelines` : `counts from all ${pipelines} pipelines`;
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
    // Totals add up the known counts only: say when some pipelines have none, so a partial sum never looks whole.
    const extra = [totals.blocking && `${totals.blocking} blocking`, totals.not_run && `${totals.not_run} not run`, totals.unknown && `${totals.unknown} unknown`];
    extra.push(countsFrom(q.counted, pipelines, q.data.pipelines.filter((x) => x.complete === false).length));
    note = extra.filter(Boolean).join(" · ");
  }
  return (
    <section className="mon-card" aria-label="Data quality summary">
      <div className="mon-card-top"><h2 className="label">Data quality</h2><StatusBadge state={q.state} /></div>
      {totals
        ? <p className="mon-value"><strong>{totals.error} error</strong> {totals.warn} warn · {totals.passed} passed</p>
        : <p className="mon-value"><strong>—</strong></p>}
      <p className="mon-note">{note}</p>
      {!q.ok && q.error && !denied(q.error) && retry && (
        <button type="button" className="f-btn f-outline mon-retry" onClick={retry}><span aria-hidden="true">↻</span> Retry</button>
      )}
    </section>
  );
}

export function QualityTable({ q, now, stage }: { q: Extract<Quality, { ok: true }>; now: number; stage: string }) {
  const rows = q.data.pipelines;
  if (!rows.length) return null;
  return (
    <section className="q-card mon-list" aria-labelledby="mon-quality-h">
      <div className="f-card-head">
        <h2 id="mon-quality-h">Data quality</h2>
        <span className="f-count">{rows.length}</span>
      </div>
      <div className="f-scroll" role="region" aria-label="Quality by pipeline" tabIndex={0}>
        <table className="f-table mon-table mon-quality">
          <thead><tr><th scope="col">Product</th><th scope="col">State</th><th scope="col">Checks</th><th scope="col"><Zoned>Run</Zoned></th></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.job}>
                <th scope="row"><span className="f-mono">{x.domain ? `${x.domain} · ` : ""}{x.product ?? x.job}</span></th>
                <td><StatusBadge state={x.state} /></td>
                <td>
                  <span className="mon-what">
                    {x.counts ? countsLine(x.counts) : "Counts unknown"}
                    {x.complete === false && <span className="mon-tag">Incomplete</span>}
                  </span>
                  <span className="mon-why f-mono">{qualityWhy(x)}</span>
                </td>
                <td className="f-mono">{x.run_id ? <><Time at={x.observed_at} now={now} bare /> · <RunLink stage={stage} run={x.run_id} /></> : "No run"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
