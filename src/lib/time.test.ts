import { describe, expect, it } from "vitest";
import { ago, browserZone, dayKey, formatClock, formatDate, formatFull, formatTime, seconds, toMs, zoneLabel } from "./time";

// Every assertion names its zone, so these hold whatever zone the process runs in (npm test runs under TZ=UTC and
// TZ=America/New_York alike).
const NOW = Date.UTC(2026, 10, 20, 12, 0); // Nov 20, 2026 12:00 UTC
const NY = "America/New_York";

describe("formatTime: one 24-hour format, with the date when not today and the year when not this year", () => {
  it("writes today's time as the clock alone, another day with its date, another year with its year", () => {
    expect(formatTime("2026-11-20T09:05:00Z", "UTC", NOW)).toBe("09:05");
    expect(formatTime("2026-11-19T17:28:00Z", "UTC", NOW)).toBe("Nov 19 17:28");
    expect(formatTime("2025-11-19T17:28:00Z", "UTC", NOW)).toBe("Nov 19, 2025 17:28");
    expect(formatTime("2027-01-02T03:04:00Z", "UTC", NOW)).toBe("Jan 2, 2027 03:04");
  });

  it("never writes a 12-hour clock, and midnight is 00, never 24", () => {
    expect(formatTime("2026-11-20T16:49:00Z", "UTC", NOW)).toBe("16:49");
    expect(formatTime("2026-11-20T00:05:00Z", "UTC", NOW)).toBe("00:05");
    expect(formatTime("2026-11-20T00:05:00Z", "UTC", NOW)).not.toMatch(/AM|PM/);
  });

  it("decides today in the zone it writes in: the same instant is today in UTC and yesterday in New York", () => {
    const t = "2026-11-20T03:00:00Z";
    expect(formatTime(t, "UTC", NOW)).toBe("03:00");
    expect(formatTime(t, NY, NOW)).toBe("Nov 19 22:00");
    expect(formatTime(t, "Asia/Tokyo", NOW)).toBe("12:00");
  });

  it("decides this year in the zone too: New Year's Eve in UTC is already next year in Tokyo", () => {
    const eve = Date.UTC(2026, 11, 31, 20, 0);
    expect(formatTime(eve, "UTC", eve)).toBe("20:00");
    expect(formatTime(eve, "Asia/Tokyo", Date.UTC(2026, 11, 31, 12, 0))).toBe("Jan 1, 2027 05:00");
  });

  it("follows daylight saving time across both transitions", () => {
    // New York springs forward at 02:00 EST on Mar 8, 2026 (07:00 UTC): 01:59 is followed by 03:00.
    const spring = Date.UTC(2026, 2, 8, 12);
    expect(formatTime("2026-03-08T06:59:00Z", NY, spring)).toBe("01:59");
    expect(formatTime("2026-03-08T07:00:00Z", NY, spring)).toBe("03:00");
    // It falls back at 02:00 EDT on Nov 1, 2026 (06:00 UTC): 01:30 happens twice, an hour apart in UTC.
    const fall = Date.UTC(2026, 10, 1, 12);
    expect(formatTime("2026-11-01T05:30:00Z", NY, fall)).toBe("01:30");
    expect(formatTime("2026-11-01T06:30:00Z", NY, fall)).toBe("01:30");
    // UTC has no daylight saving time: the same instants an hour apart read an hour apart.
    expect(formatTime("2026-11-01T05:30:00Z", "UTC", fall)).toBe("05:30");
    expect(formatTime("2026-11-01T06:30:00Z", "UTC", fall)).toBe("06:30");
    // The zone's label is its IANA name, which does not change with DST, unlike EST/EDT.
    expect(formatFull("2026-11-01T05:30:00Z", NY)).toBe("Nov 1, 2026 01:30:00 America/New_York");
    expect(formatFull("2026-11-01T06:30:00Z", NY)).toBe("Nov 1, 2026 01:30:00 America/New_York");
  });

  it("reads epoch milliseconds, Dagster's epoch seconds and Dates as the same instant", () => {
    const iso = "2026-11-19T17:28:05.120Z";
    const ms = Date.parse(iso);
    expect(formatTime(ms, "UTC", NOW)).toBe("Nov 19 17:28");
    expect(formatTime(seconds(ms / 1000), "UTC", NOW)).toBe("Nov 19 17:28");
    expect(formatTime(new Date(ms), "UTC", NOW)).toBe("Nov 19 17:28");
    expect(toMs("2026-11-19T18:28:05.120+01:00")).toBe(ms);
  });

  it("writes seconds and milliseconds when asked", () => {
    expect(formatTime("2026-11-20T09:05:07.204Z", "UTC", NOW, "second")).toBe("09:05:07");
    expect(formatTime("2026-11-19T09:05:07.204Z", "UTC", NOW, "millisecond")).toBe("Nov 19 09:05:07.204");
  });

  it("writes — for no time, and a time that does not parse as sent", () => {
    expect(formatTime(null, "UTC", NOW)).toBe("—");
    expect(formatTime(undefined, "UTC", NOW)).toBe("—");
    expect(formatTime("not a time", "UTC", NOW)).toBe("not a time");
  });

  it("reads a zone the runtime does not know as UTC, never as the process's own", () => {
    expect(formatTime("2026-11-20T09:05:00Z", "Mars/Olympus_Mons", NOW)).toBe("09:05");
  });
});

describe("the other forms", () => {
  it("formatClock: the clock alone, for rows grouped under their day", () => {
    expect(formatClock("2026-11-16T23:59:58.120+00:00", "UTC", "millisecond")).toBe("23:59:58.120");
    expect(formatClock("2026-11-17T01:00:00+01:00", "UTC", "millisecond")).toBe("00:00:00.000");
    expect(formatClock("2026-11-16T23:59:58.120Z", NY, "millisecond")).toBe("18:59:58.120");
    expect(formatClock("2026-11-16T23:59:58Z", "UTC")).toBe("23:59");
    expect(formatClock("garbage", "UTC")).toBe("garbage");
  });

  it("formatDate and dayKey: the day in the zone", () => {
    expect(formatDate("2026-11-17T00:08:00Z", "UTC", NOW)).toBe("Nov 17");
    expect(formatDate("2026-11-17T00:08:00Z", NY, NOW)).toBe("Nov 16");
    expect(formatDate("2025-11-17T00:08:00Z", "UTC", NOW)).toBe("Nov 17, 2025");
    expect(dayKey("2026-11-17T00:08:00Z", "UTC")).toBe("2026-11-17");
    expect(dayKey("2026-11-17T00:08:00Z", NY)).toBe("2026-11-16");
    expect(dayKey("nope", "UTC")).toBeUndefined();
  });

  it("formatFull: date, year, seconds and the zone, for a tooltip", () => {
    expect(formatFull("2026-11-19T17:28:05Z", "UTC")).toBe("Nov 19, 2026 17:28:05 UTC");
    expect(formatFull("2026-11-19T17:28:05Z", "Europe/Paris")).toBe("Nov 19, 2026 18:28:05 Europe/Paris");
  });

  it("ago: relative times stay relative", () => {
    expect(ago(NOW - 5_000, NOW)).toBe("5 s ago");
    expect(ago(new Date(NOW - 720_000).toISOString(), NOW)).toBe("12 min ago");
    expect(ago(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(ago(NOW + 5_000, NOW)).toBe("0 s ago");
    expect(ago(null, NOW)).toBe("—");
  });

  it("zoneLabel: UTC, or the IANA name", () => {
    expect(zoneLabel("UTC")).toBe("UTC");
    expect(zoneLabel("Etc/UTC")).toBe("UTC");
    expect(zoneLabel(NY)).toBe(NY);
  });

  it("browserZone: the runtime's own zone", () => {
    const tz = process.env.TZ;
    if (tz && tz !== "UTC") expect(browserZone()).toBe(tz);
    else expect(browserZone()).toMatch(/UTC|\//);
  });
});
