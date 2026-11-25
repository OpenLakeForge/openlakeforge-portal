// Monitoring · the four summary gauges: services, pipeline runs, data quality and alerts. A ring's segments are the
// counts listed beside it, so colour is never the only carrier. A source that gives no answer reads "—" with its
// state and the API's reason: never an empty green ring.

import { Link } from "react-router";
import type { HealthState } from "../lib/health-api";
import { StatusBadge } from "./StatusBadge";

export type Tone = "ok" | "warn" | "bad" | "run" | "none";
/** One count of a gauge. `optional` is listed only when it is not zero. */
export type Slice = { label: string; value: number; tone: Tone; optional?: boolean };

const R = 40;
const C = 2 * Math.PI * R;

function Ring({ slices, center, unit, fill }: { slices: Slice[]; center: string; unit?: string; fill?: Tone }) {
  const shown = slices.filter((s) => s.value > 0);
  const total = shown.reduce((n, s) => n + s.value, 0);
  const gap = shown.length > 1 ? 2 : 0;
  let at = 0;
  return (
    <svg className="mon-ring" viewBox="0 0 96 96" aria-hidden="true" focusable="false">
      <g transform="rotate(-90 48 48)" fill="none" strokeWidth="10">
        {total === 0 && <circle cx="48" cy="48" r={R} data-tone={fill ?? "none"} strokeDasharray={fill ? undefined : "6 6.57"} />}
        {shown.map((s) => {
          const length = (s.value / total) * C;
          const from = at;
          at += length;
          return <circle key={s.label} cx="48" cy="48" r={R} data-tone={s.tone} strokeDasharray={`${Math.max(1, length - gap)} ${C}`} strokeDashoffset={-from} />;
        })}
      </g>
      <text className="mon-ring-center" x="48" y={unit ? 48 : 55}>{center}</text>
      {unit && <text className="mon-ring-unit" x="48" y="63">{unit}</text>}
    </svg>
  );
}

export function Gauge({ label, title, to, center, unit, slices, fill, state, note, children }: {
  label: string; title: string; to?: string; center: string; unit?: string; slices: Slice[]; state?: HealthState;
  /** The whole ring in one tone when every count is zero and that is the answer. Without it, zero is a dashed ring. */
  fill?: Tone; note?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <section className="mon-card mon-gauge" aria-label={label}>
      <div className="mon-card-top">
        <h2>{to ? <Link to={to}>{title} <span aria-hidden="true">›</span></Link> : title}</h2>
        {state && <StatusBadge state={state} />}
      </div>
      <div className="mon-gauge-body">
        <Ring slices={slices} center={center} unit={unit} fill={fill} />
        {center !== "—" && <span className="sr-only">{center} {unit}</span>}
        <ul className="mon-legend">
          {slices.filter((s) => !s.optional || s.value > 0).map((s) => (
            <li key={s.label}><span className="mon-key" data-tone={s.tone} aria-hidden="true" /><span>{s.label}</span> <strong>{s.value}</strong></li>
          ))}
        </ul>
      </div>
      {note && <p className="mon-note">{note}</p>}
      {children}
    </section>
  );
}
