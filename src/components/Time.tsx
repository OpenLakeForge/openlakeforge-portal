// The Monitoring pages' times, in the reader's one time zone (src/lib/time.ts has the rule). Every time is a
// <time dateTime> with its full form in `title`; a relative time also says its absolute time to assistive technology,
// so it is never hover-only.

import { formatClock, formatFull, formatTime, isoOf, setZoneChoice, ago, useTimeZone, zoneLabel, type Instant, type Precision } from "../lib/time";

/** An absolute time: "17:28 UTC", "Nov 19 17:28 UTC". `bare` leaves the zone out where a column header or a chart
 *  caption already names it; `clock` leaves the date out where the rows are grouped under their day. */
export function Time({ at, now, bare = false, clock = false, precision }: {
  at: Instant | null | undefined; now: number; bare?: boolean; clock?: boolean; precision?: Precision;
}) {
  const tz = useTimeZone();
  if (at === null || at === undefined) return <>—</>;
  const iso = isoOf(at);
  if (!iso) return <>{String(at)}</>;
  return <time dateTime={iso} title={formatFull(at, tz.zone)}>{clock ? formatClock(at, tz.zone, precision) : formatTime(at, tz.zone, now, precision)}{bare ? "" : ` ${tz.label}`}</time>;
}

/** A relative time, "5 s ago", with the absolute time on hover and, for a screen reader, in words. */
export function Ago({ at, now }: { at: Instant | null | undefined; now: number }) {
  const tz = useTimeZone();
  if (at === null || at === undefined) return <>—</>;
  const iso = isoOf(at);
  if (!iso) return <>{String(at)}</>;
  return (
    <time dateTime={iso} title={formatFull(at, tz.zone)}>
      {ago(at, now)}<span className="sr-only"> (at {formatTime(at, tz.zone, now)} {tz.label})</span>
    </time>
  );
}

/** "Time (UTC)": a column header or a chart caption that names the zone once for every time under it. */
export function Zoned({ children }: { children: React.ReactNode }) {
  const tz = useTimeZone();
  return <>{children} ({tz.label})</>;
}

/** The one switch of the Monitoring pages: UTC, or the browser's own zone, kept in this browser. */
export function ZoneSwitch() {
  const tz = useTimeZone();
  const local = tz.local ? `Local (${zoneLabel(tz.local)})` : "Local";
  // The switch shows "Local"; the zone's name is its accessible name and its tooltip, so the head stays one line.
  const options = [{ value: "utc", label: "UTC", words: "UTC" }, { value: "local", label: local, words: "Local" }] as const;
  return (
    <fieldset className="mc-range mon-stage mon-zone">
      <legend className="q-label">Time zone</legend>
      <div className="mc-segments">
        {options.map((o) => (
          <label key={o.value} title={o.label}>
            <input type="radio" name="mon-zone" value={o.value} checked={tz.choice === o.value} onChange={() => setZoneChoice(o.value)} aria-label={o.label} />
            <span aria-hidden="true">{o.words}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
