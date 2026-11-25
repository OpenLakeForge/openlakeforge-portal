// Monitoring · metrics: one series as a line chart, drawn in SVG with no chart library. The plot stretches to its box
// (strokes keep their width), axes and labels are HTML, so it reads the same at 390 px and at 1280 px. Every chart has
// a text alternative: a summary per line (latest and peak), a keyboard readout of each step, and the values as a table.
// A step without a sample is a gap, never a zero.

import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { MetricLine, MetricRange } from "../lib/health-api";
import { formatClock, formatDate, formatTime, UTC, useTimeZone } from "../lib/time";
import { Zoned } from "./Time";

/** A line as the chart draws it: a name and one value per step (null: no sample). */
export type Shown = { key: string; name: string; values: (number | null)[] };
export type Shape = { times: number[]; lines: Shown[] };
/** How a series' lines are named, merged and ordered. */
export type LineRule = {
  /** The label a line is named and merged by (`component`, `job`, `status`…); none: one line named `single`. */
  by?: string;
  single: string;
  /** A fixed order of names (`succeeded`, `failed`…), so a name keeps its colour whatever else is drawn. */
  order?: string[];
  /** How lines merged or folded into one combine per step: `sum` for resources and counts (the default), `max` for a
   *  series that is already a per-step maximum, such as the longest run, where a sum would be a run nobody took. */
  combine?: "sum" | "max";
  /** Names dropped while every value is 0 (a status no run had). */
  hideZero?: string[];
};

/** At most this many lines; past it the smallest fold into one "other" line, never a generated colour. */
export const MAX_LINES = 5;

const sum = (xs: (number | null)[]) => (xs.every((x) => x === null) ? null : xs.reduce<number>((a, x) => a + (x ?? 0), 0));
const max = (xs: (number | null)[]) => (xs.every((x) => x === null) ? null : xs.reduce<number>((a, x) => (x !== null && x > a ? x : a), -Infinity));
const peak = (l: Shown) => l.values.reduce<number>((a, v) => (v !== null && v > a ? v : a), -Infinity);

/** The API's lines as drawn: merged by `rule.by` (combined per step by `rule.combine`), ordered, and folded past MAX_LINES. */
export function shape(lines: MetricLine[], rule: LineRule): Shape {
  const times = (lines[0]?.points ?? []).map(([t]) => Date.parse(t));
  const combine = rule.combine === "max" ? max : sum;
  const merged = new Map<string, (number | null)[][]>();
  for (const l of lines) {
    const name = rule.by ? l.labels[rule.by] ?? "unlabelled" : rule.single;
    merged.set(name, [...(merged.get(name) ?? []), l.points.map(([, v]) => v)]);
  }
  let shown: Shown[] = [...merged].map(([name, rows]) => ({ key: name, name, values: times.map((_, i) => combine(rows.map((r) => r[i] ?? null))) }));
  shown = shown.filter((l) => !(rule.hideZero?.includes(l.name) && l.values.every((v) => v === 0 || v === null)));
  if (shown.length > MAX_LINES) {
    const ranked = [...shown].sort((a, b) => peak(b) - peak(a));
    const kept = ranked.slice(0, MAX_LINES - 1);
    const rest = ranked.slice(MAX_LINES - 1);
    shown = [...kept.sort(byName(rule)), {
      key: "__other", name: `${rest.length} other ${rule.by ?? "line"}s`, values: times.map((_, i) => combine(rest.map((l) => l.values[i]))),
    }];
  } else shown.sort(byName(rule));
  return { times, lines: shown };
}
function byName(rule: LineRule) {
  const rank = (n: string) => { const i = rule.order?.indexOf(n) ?? -1; return i < 0 ? Infinity : i; };
  return (a: Shown, b: Shown) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
}

/** Whether there is anything to draw: at least one step with a sample. */
export const hasSamples = (s: Shape) => s.lines.some((l) => l.values.some((v) => v !== null));

// ── Values and axes ─────────────────────────────────────────────────────────────────────────────────

const BYTES = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
/** The power of 1024 the axis of a byte series is labelled in. */
const byteStep = (max: number) => { let k = 0; while (max >= 1024 && k < BYTES.length - 1) { max /= 1024; k++; } return k; };
const SINGULAR: Record<string, string> = { queries: "query", runs: "run", restarts: "restart" };
const num = (v: number, digits = 2) => v.toLocaleString("en-US", { maximumFractionDigits: digits });

/** "1 min 54 s", "2 h 5 min". */
function seconds(v: number): string {
  const s = Math.max(0, Math.round(v));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ""}`;
}

/** A value in words with its unit: "1.5 GiB", "0.42 cores", "3 runs", "2 min 5 s". */
export function formatValue(v: number, unit: string, scaleMax = v): string {
  if (unit === "bytes") { const k = byteStep(Math.abs(scaleMax)); return `${num(v / 1024 ** k, 1)} ${BYTES[k]}`; }
  if (unit === "seconds") return seconds(v);
  if (unit === "cores") return `${num(v)} ${v === 1 ? "core" : "cores"}`;
  return `${num(v, 1)} ${v === 1 ? SINGULAR[unit] ?? unit : unit}`;
}
/** An axis label: the number in the axis' scale, without the unit word (the chart's subtitle names it). */
function axisLabel(v: number, unit: string, max: number): string {
  if (unit === "bytes") { const k = byteStep(max); return `${num(v / 1024 ** k, 1)} ${BYTES[k]}`; }
  if (unit === "seconds") return seconds(v);
  return num(v, 2);
}

const niceStep = (raw: number) => {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
};
/** Round ticks from 0 to just above `max`, in the axis' own unit (KiB steps for bytes, minutes for seconds). */
export function ticks(max: number, unit: string, count = 4): number[] {
  const base = unit === "bytes" ? 1024 ** byteStep(max) : unit === "seconds" && max >= 120 ? (max >= 7200 ? 3600 : 60) : 1;
  const scaled = max / base;
  // A count (runs, queries, restarts) has no fraction: its axis steps by whole numbers.
  const whole = unit in SINGULAR;
  const step = scaled > 0 ? (whole ? Math.max(1, niceStep(scaled / count)) : niceStep(scaled / count)) : 1;
  const top = Math.max(step, Math.ceil(scaled / step - 1e-9) * step);
  const out: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) out.push(Number((t * base).toPrecision(12)));
  return out;
}

/** A step's time in the reader's zone, as every Monitoring time reads (src/lib/time.ts): "17:00", "Nov 19 17:00". */
export const stepTime = (t: number, zone: string = UTC, now: number = Date.now()) => formatTime(t, zone, now);
/** An axis tick: the clock within a day, the date over a week. The axis caption names the zone. */
const axisTime = (t: number, range: MetricRange, zone: string, now: number) => (range === "7d" ? formatDate(t, zone, now) : formatClock(t, zone));

/** The SVG paths of one line in a 100×100 box: `line` joins neighbouring samples and a gap breaks it; `dots` holds each
 * lone sample (gaps on both sides) as a zero-length round cap, drawn wider so it stays visible. */
export function linePath(values: (number | null)[], max: number): { line: string; dots: string } {
  const n = values.length;
  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => 100 - (max > 0 ? (v / max) * 100 : 0);
  let line = "";
  let dots = "";
  values.forEach((v, i) => {
    if (v === null) return;
    const before = i > 0 && values[i - 1] !== null;
    const after = i < n - 1 && values[i + 1] !== null;
    const at = `${x(i).toFixed(3)} ${y(v).toFixed(3)}`;
    if (!before && !after) dots += `M${at}h0.001`;
    else line += `${before ? "L" : "M"}${at}`;
  });
  return { line, dots };
}

/** The latest sample of a line and when it was taken; undefined when the line has none. */
function latest(l: Shown, times: number[]): { v: number; t: number } | undefined {
  for (let i = l.values.length - 1; i >= 0; i--) if (l.values[i] !== null) return { v: l.values[i]!, t: times[i] };
  return undefined;
}

/** One line per series' line: "now" (the latest sample) and the peak, in words. The text alternative of the plot. */
export function summary(s: Shape, unit: string, range: MetricRange, zone: string = UTC, today: number = Date.now()): string[] {
  const last = s.times.at(-1);
  return s.lines.map((l) => {
    const now = latest(l, s.times);
    if (!now) return `${l.name}: no sample in the last ${range}`;
    const p = peak(l);
    const at = now.t === last ? "now" : `last sample ${stepTime(now.t, zone, today)}`;
    return `${l.name}: ${formatValue(now.v, unit)} ${at}, peak ${formatValue(p, unit)}`;
  });
}

/** The plot, its axes, a keyboard and pointer readout, a legend with each line's summary, and a table of the values. */
export function MetricPlot({ title, unit, range, data, perStep }: { title: string; unit: string; range: MetricRange; data: Shape; perStep?: string }) {
  const id = useId();
  const tz = useTimeZone();
  const today = Date.now();
  const [at, setAt] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const n = data.times.length;
  const max = Math.max(0, ...data.lines.flatMap((l) => l.values.filter((v): v is number => v !== null)));
  const ys = ticks(max, unit);
  const top = ys.at(-1)!;
  const xs = n > 1 ? [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1))) : [0];
  const lines = summary(data, unit, range, tz.zone, today);
  const many = data.lines.length > 1;

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width > 0 && n) setAt(Math.min(n - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step) setAt((i) => Math.min(n - 1, Math.max(0, (i ?? n - 1) + (i === null ? 0 : step))));
    else if (e.key === "Home") setAt(0);
    else if (e.key === "End") setAt(n - 1);
    else if (e.key === "Escape") setAt(null);
    else return;
    e.preventDefault();
  };
  const readout = at === null
    ? "Point at the chart, or focus it and use the arrow keys, to read each step."
    : `${stepTime(data.times[at], tz.zone, today)}: ${data.lines.map((l) => `${many ? `${l.name} ` : ""}${l.values[at] === null ? "no sample" : formatValue(l.values[at]!, unit, max)}`).join(" · ")}`;

  return (
    <figure className="mc-figure">
      <div className="mc-frame">
        <div className="mc-y f-mono" aria-hidden="true">
          {ys.map((t) => <span key={t} style={{ bottom: `${(t / top) * 100}%` }}>{axisLabel(t, unit, top)}</span>)}
        </div>
        <div
          className="mc-plot"
          tabIndex={0}
          role="group"
          aria-label={`${title}, last ${range}. Use the left and right arrow keys to read each step.`}
          aria-describedby={`${id}-sum`}
          onPointerMove={move}
          onPointerLeave={() => setAt(null)}
          onKeyDown={key}
        >
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            {ys.map((t) => <line key={t} className="mc-rule" x1="0" x2="100" y1={100 - (t / top) * 100} y2={100 - (t / top) * 100} vectorEffect="non-scaling-stroke" />)}
            {data.lines.map((l, i) => {
              const { line, dots } = linePath(l.values, top);
              const slot = l.key === "__other" ? "other" : i + 1;
              return (
                <g key={l.key}>
                  {line && <path className="mc-line" data-slot={slot} d={line} vectorEffect="non-scaling-stroke" />}
                  {dots && <path className="mc-line mc-dots" data-slot={slot} d={dots} vectorEffect="non-scaling-stroke" />}
                </g>
              );
            })}
            {at !== null && n > 1 && <line className="mc-cursor" x1={(at / (n - 1)) * 100} x2={(at / (n - 1)) * 100} y1="0" y2="100" vectorEffect="non-scaling-stroke" />}
          </svg>
        </div>
        <div className="mc-x f-mono" aria-hidden="true">
          {xs.map((i, k) => (
            <span key={k} style={{ left: `${n > 1 ? (i / (n - 1)) * 100 : 50}%` }} data-edge={k === 0 ? "start" : k === xs.length - 1 ? "end" : undefined}>
              {axisTime(data.times[i], range, tz.zone, today)}
            </span>
          ))}
        </div>
        <p className="mc-x-caption label">Time ({tz.label})</p>
      </div>
      {/* Under the plot: however many lines a picked step takes, the plot never moves from under the pointer. */}
      <p className={at === null ? "mc-readout mc-idle f-mono" : "mc-readout f-mono"} id={`${id}-readout`} aria-live="polite">{readout}</p>
      <figcaption id={`${id}-sum`}>
        <ul className="mc-legend">
          {data.lines.map((l, i) => (
            <li key={l.key}>
              <span className="mc-swatch" data-slot={l.key === "__other" ? "other" : i + 1} aria-hidden="true" />
              <span>{lines[i]}</span>
            </li>
          ))}
        </ul>
        {perStep && <span className="mon-why">{perStep}</span>}
      </figcaption>
      <button type="button" className="f-btn f-ghost mc-toggle" aria-expanded={table} aria-controls={`${id}-table`} onClick={() => setTable((t) => !t)}>
        {table ? "Hide the values" : "Show the values as a table"}
      </button>
      {table && (
        <div className="f-scroll mc-table" id={`${id}-table`} role="region" aria-label={`${title} values`} tabIndex={0}>
          <table className="f-table mon-table">
            <thead><tr><th scope="col"><Zoned>Time</Zoned></th>{data.lines.map((l) => <th key={l.key} scope="col">{l.name}</th>)}</tr></thead>
            <tbody>
              {data.times.map((t, i) => ({ t, i })).reverse().map(({ t, i }) => (
                <tr key={t}>
                  <th scope="row" className="f-mono">{stepTime(t, tz.zone, today)}</th>
                  {data.lines.map((l) => <td key={l.key} className="f-mono">{l.values[i] === null ? <><span aria-hidden="true">—</span><span className="sr-only">no sample</span></> : formatValue(l.values[i]!, unit, max)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
