// One way to read a time on the Monitoring pages (portal#40): every absolute time in one time zone, the one the reader
// picked (UTC by default: the archive, the API and the logs are UTC), on a 24-hour clock, with the date when it is not
// today in that zone and the year when it is not this year. Relative times ("5 s ago") stay relative.
//
//   "17:28"            today
//   "Nov 19 17:28"     another day this year
//   "Nov 19, 2025 17:28" another year
//
// The zone is named once per place a time is read: a table column holding times names it in its header
// ("Started (UTC)"), a chart in its axis caption ("Time (UTC)"), and any other absolute time carries it after the time
// ("started 17:28 UTC"). The choice is the browser's own (localStorage), and the server always renders UTC: the
// pages switch after hydration, through useSyncExternalStore's server snapshot, so the markup never mismatches.

import { useSyncExternalStore } from "react";

/** A point in time: an ISO 8601 string as the API sends it, epoch milliseconds, or a Date. Dagster's epoch seconds
 *  are converted by the caller (`seconds(t)`). */
export type Instant = string | number | Date;
export type ZoneChoice = "utc" | "local";
export const UTC = "UTC";

/** Epoch milliseconds of `t`; NaN when it does not parse. */
export function toMs(t: Instant): number {
  if (t instanceof Date) return t.getTime();
  return typeof t === "number" ? t : Date.parse(t);
}
/** Dagster's epoch seconds as milliseconds. */
export const seconds = (s: number) => s * 1000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

type Parts = { y: number; mo: number; d: number; h: number; mi: number; s: number; ms: number };
const formats = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
      });
    } catch (e) {
      // A zone this runtime does not know reads as UTC, never as the server's or the browser's own zone.
      if (zone === UTC) throw e;
      f = formatter(UTC);
    }
    formats.set(zone, f);
  }
  return f;
}
/** The wall-clock fields of `ms` in `zone`. */
function partsOf(ms: number, zone: string): Parts {
  const out: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = Number(p.value);
  // Some ICU versions write midnight as 24 even with h23.
  return { y: out.year, mo: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second, ms: ((ms % 1000) + 1000) % 1000 };
}

/** The label the zone is named by: "UTC", or the IANA name ("Europe/Paris"), never an abbreviation that changes with DST. */
export const zoneLabel = (zone: string) => (zone === UTC || zone === "Etc/UTC" ? UTC : zone);

export type Precision = "minute" | "second" | "millisecond";
const clockOf = (p: Parts, precision: Precision) =>
  `${pad(p.h)}:${pad(p.mi)}${precision === "minute" ? "" : `:${pad(p.s)}${precision === "millisecond" ? `.${pad(p.ms, 3)}` : ""}`}`;
const dateOf = (p: Parts, n: Parts | null) => `${MONTHS[p.mo - 1]} ${p.d}${!n || p.y !== n.y ? `, ${p.y}` : ""}`;

/** "17:28" when `t` is on `now`'s day in `zone`, "Nov 19 17:28" another day, "Nov 19, 2025 17:28" another year.
 *  "—" for no time; a time that does not parse is shown as sent. */
export function formatTime(t: Instant | null | undefined, zone: string, now: number, precision: Precision = "minute"): string {
  if (t === null || t === undefined) return "—";
  const ms = toMs(t);
  if (Number.isNaN(ms)) return String(t);
  const p = partsOf(ms, zone);
  const n = partsOf(now, zone);
  const clock = clockOf(p, precision);
  return p.y === n.y && p.mo === n.mo && p.d === n.d ? clock : `${dateOf(p, n)} ${clock}`;
}

/** The clock alone, for rows grouped under their day: "23:41:07.204". */
export function formatClock(t: Instant, zone: string, precision: Precision = "minute"): string {
  const ms = toMs(t);
  return Number.isNaN(ms) ? String(t) : clockOf(partsOf(ms, zone), precision);
}

/** The date alone, as `formatTime` writes it: "Nov 19", with the year when it is not `now`'s. */
export function formatDate(t: Instant, zone: string, now: number): string {
  const ms = toMs(t);
  return Number.isNaN(ms) ? String(t) : dateOf(partsOf(ms, zone), partsOf(now, zone));
}

/** The day `t` falls on in `zone`, as "2026-11-19": to group rows by day and to see a window cross midnight. */
export function dayKey(t: Instant, zone: string): string | undefined {
  const ms = toMs(t);
  if (Number.isNaN(ms)) return undefined;
  const p = partsOf(ms, zone);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

/** The full time, for a tooltip and for assistive technology: "Nov 19, 2026 17:28:05 UTC". */
export function formatFull(t: Instant, zone: string): string {
  const ms = toMs(t);
  if (Number.isNaN(ms)) return String(t);
  const p = partsOf(ms, zone);
  return `${dateOf(p, null)} ${clockOf(p, "second")} ${zoneLabel(zone)}`;
}

/** "5 s ago", "12 min ago", "3 h ago"; "—" for no time. Relative times need no zone. */
export function ago(t: Instant | null | undefined, now: number): string {
  if (t === null || t === undefined) return "—";
  const ms = toMs(t);
  if (Number.isNaN(ms)) return String(t);
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

/** ISO 8601 in UTC, for `<time dateTime>`; undefined when `t` does not parse. */
export function isoOf(t: Instant): string | undefined {
  const ms = toMs(t);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

// ── The reader's choice ─────────────────────────────────────────────────────────────────────────────

export const ZONE_KEY = "olf.monitoring.timeZone";

/** The browser's IANA zone; UTC when the runtime cannot tell. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || UTC;
  } catch {
    return UTC;
  }
}

/** The choice when storage refused to keep it (a private window, blocked site data): it lasts as long as the page. */
let memory: ZoneChoice | null = null;
const listeners = new Set<() => void>();

function readChoice(): ZoneChoice {
  if (memory) return memory;
  try {
    return window.localStorage.getItem(ZONE_KEY) === "local" ? "local" : "utc";
  } catch {
    return "utc";
  }
}

/** Keeps the reader's choice in this browser and tells every time on the page. */
export function setZoneChoice(choice: ZoneChoice): void {
  try {
    window.localStorage.setItem(ZONE_KEY, choice);
    memory = null;
  } catch {
    memory = choice;
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab that changes the choice changes it here too.
  const onStorage = (e: StorageEvent) => { if (e.key === ZONE_KEY || e.key === null) listener(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

/** What a page reads: the choice, the zone it means, and that zone's label. `local` is the browser's zone, or null on
 *  the server, which cannot know it. */
export type TimeZoneState = { choice: ZoneChoice; zone: string; label: string; local: string | null };

const SERVER: TimeZoneState = { choice: "utc", zone: UTC, label: UTC, local: null };
let snap: TimeZoneState | undefined;
function getSnapshot(): TimeZoneState {
  const choice = readChoice();
  const local = browserZone();
  if (!snap || snap.choice !== choice || snap.local !== local) {
    const zone = choice === "local" ? local : UTC;
    snap = { choice, zone, label: zoneLabel(zone), local };
  }
  return snap;
}
const getServerSnapshot = () => SERVER;

/** The reader's time zone: UTC on the server and during hydration, then the choice this browser kept. */
export function useTimeZone(): TimeZoneState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
