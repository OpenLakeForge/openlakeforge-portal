// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserZone, dayKey, formatClock, setZoneChoice, zoneLabel } from "../lib/time";
import { listLogs, listRunLogs, type LogLine, type MonitoringCapabilities, type MonitoringStage } from "../lib/health-api";
import { CLOCK_MS, logsHref, logStages, MonitoringLogs, readLogsParams, search, searchedBy, sendable, span } from "./MonitoringLogs";

const RUN = "c94cbcb0-5d1e-4a8e-9f0b-2f6c1a7e3b21";
const SOURCES = ["dagster", "services", "quality", "logs", "metrics", "alerts"] as const;
const access = (stage: string, over: Partial<MonitoringStage> = {}): MonitoringStage => ({
  stage, operations: ["get_stage_health", "get_run", "get_run_failure", "list_logs"], log_retention_days: 14,
  capabilities: SOURCES.map((name) => ({ name, status: "available", reason: `${name} is configured` })), ...over,
});
const caps = (...stages: MonitoringStage[]): MonitoringCapabilities => ({
  stages: stages.length ? stages : [access("dev"), access("prod", { operations: ["get_stage_health", "get_run", "get_run_failure"] })],
});

const line = (text: string, over: Partial<LogLine> = {}): LogLine => ({
  archived_at: "2026-11-19T15:00:00Z", namespace: "olf-dev", pod: "trino-coordinator-0", container: "trino", line: text, error: null,
  component: "trino", product: null, run_id: null, timestamp: "2026-11-19T14:03:00.339Z", level: "info", ...over,
});
const LINES = () => [
  line("Scheduler tick: 2 schedules evaluated", { pod: "dagster-daemon-5f7c9", container: "dagster-daemon", component: "dagster-daemon", timestamp: "2026-11-19T14:00:00Z" }),
  line("Query 0001_03 finished · dev_reporting"),
  line("Memory pool general reserved above 80% for 30 s", { level: "warning", timestamp: "2026-11-19T14:17:00Z" }),
  line("Starting web_events", { pod: "dagster-run-8ad7e2f8", container: "floe", run_id: "8ad7e2f8-0000-4000-a000-000000000000", timestamp: "2026-11-19T14:05:03Z" }),
  line(null as unknown as string, { line: null, error: "the record is not valid JSON", timestamp: null, level: null }),
];

type Reply = { status?: number; body?: unknown } | "down";
const respond = (r: Reply) => {
  if (r === "down") throw new TypeError("Failed to fetch");
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
};
function api({ capsBody = caps(), logs = (_u: URL) => ({ body: { lines: LINES(), truncated: false } }) as Reply,
  runLogs = (_u: URL) => ({ body: { lines: LINES(), truncated: false, since: "2026-11-19T14:00:00Z", until: "2026-11-19T14:02:00Z", next: null } }) as Reply,
  run = () => ({ body: { run_id: RUN, job_name: "sales_orders", status: "FAILURE", created_at: Date.parse("2026-11-18T23:59:00Z") / 1000, started_at: Date.parse("2026-11-19T00:00:10Z") / 1000, ended_at: null, tags: {} } }) as Reply,
}: { capsBody?: MonitoringCapabilities; logs?: (u: URL) => Reply; runLogs?: (u: URL) => Reply; run?: () => Reply } = {}) {
  const fetch = vi.fn(async (input: string) => {
    if (input === "/api/v1/monitoring-capabilities") return respond({ body: capsBody });
    const url = new URL(input, "http://portal");
    if (/^\/api\/v1\/stages\/[^/]+\/logs$/.test(url.pathname)) return respond(logs(url));
    if (/^\/api\/v1\/stages\/[^/]+\/runs\/[^/]+\/logs$/.test(url.pathname)) return respond(runLogs(url));
    if (/^\/api\/v1\/stages\/[^/]+\/runs\/[^/]+$/.test(url.pathname)) return respond(run());
    return respond({ status: 404, body: { detail: "Not Found" } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const reads = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([u]) => u as string).filter((u) => u.includes("/logs") || /\/runs\//.test(u));

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}
function Page({ stages }: { stages: string[] }) {
  const { stage } = useParams();
  return <MonitoringLogs key={stage} stage={stage!} stages={stages} />;
}
const open = (entry: string, stages = ["dev", "prod"]) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/monitoring/:stage/logs" element={<><Page stages={stages} /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
/** The innermost element whose whole text matches: text split by links and spans still matches. */
const text = (re: RegExp) => (_: string, el: Element | null) => !!el && re.test(el.textContent ?? "") && ![...el.children].some((c) => re.test(c.textContent ?? ""));
const where = () => screen.getByTestId("where").textContent;
const rows = async (stage = "DEV") => within(await screen.findByRole("region", { name: `${stage} log lines` })).getAllByRole("row").slice(1);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); setZoneChoice("utc"); });

describe("logs helpers", () => {
  it("builds the address, two-digit hour, empty filters left out", () => {
    expect(logsHref("dev")).toBe("/monitoring/dev/logs");
    expect(logsHref("dev", { date: "2026-11-19", hour: 4, pod: "trino-0", level: "warning", q: "" })).toBe("/monitoring/dev/logs?date=2026-11-19&hour=04&pod=trino-0&level=warning");
    expect(logsHref("prod", { run: RUN })).toBe(`/monitoring/prod/logs?run=${RUN}`);
    expect(logsHref("prod", { run: RUN, matchRun: true })).toBe(`/monitoring/prod/logs?run=${RUN}&match_run=true`);
    expect(logsHref("prod", { matchRun: true })).toBe("/monitoring/prod/logs");
  });

  it("reads the address back: today's current hour by default, a date alone is the whole day, nonsense is named", () => {
    const now = Date.parse("2026-11-20T18:42:00Z");
    expect(readLogsParams(new URLSearchParams(""), now)).toMatchObject({ date: "2026-11-20", hour: 18, ignored: [] });
    expect(readLogsParams(new URLSearchParams("date=2026-11-19"), now)).toMatchObject({ date: "2026-11-19", hour: undefined });
    expect(readLogsParams(new URLSearchParams(`run=${RUN}`), now)).toMatchObject({ run: RUN, date: undefined, hour: undefined });
    const bad = readLogsParams(new URLSearchParams("date=2026-02-30&hour=25&level=loud&q=boom"), now);
    expect(bad).toMatchObject({ date: "2026-11-20", hour: undefined, level: undefined, q: "boom" });
    expect(bad.ignored).toEqual(["date=2026-02-30", "hour=25", "level=loud"]);
  });

  it("spans a day or one hour of it, and searches the lines read, ignoring case", () => {
    expect(span("2026-11-19", 23)).toEqual({ since: "2026-11-19T23:00:00.000Z", until: "2026-11-20T00:00:00.000Z" });
    expect(span("2026-11-19")).toEqual({ since: "2026-11-19T00:00:00.000Z", until: "2026-11-20T00:00:00.000Z" });
    expect(search(LINES(), "MEMORY").map((l) => l.line)).toEqual(["Memory pool general reserved above 80% for 30 s"]);
    expect(search(LINES(), "json")).toHaveLength(1);
    expect(search(LINES(), "  ")).toHaveLength(5);
    expect(sendable(" boom ")).toBe("boom");
    expect(sendable("a\tb")).toBeUndefined();
    expect(sendable("x".repeat(201))).toBeUndefined();
    expect(searchedBy(search(LINES(), "memory"), "MEMORY")).toBe(true);
    expect(searchedBy(LINES(), "memory")).toBe(false);
    expect(searchedBy([], "memory")).toBe(true);
  });

  it("offers the stages whose archive the role may read", () => {
    expect(logStages(caps())).toEqual(["dev"]);
  });

  it("asks list_logs and the run window with every filter", async () => {
    const fetch = api();
    await listLogs("dev", { date: "2026-11-19", hour: 0, pod: "p", container: "c", component: "k", product: "orders", runId: "r", severity: "warning" });
    await listRunLogs("prod", RUN, { severity: "error", pod: "p", since: "2026-11-19T00:00:00.000Z", after: "x", limit: 200 });
    expect(reads(fetch)).toEqual([
      "/api/v1/stages/dev/logs?date=2026-11-19&hour=0&pod=p&container=c&component=k&product=orders&run_id=r&severity=warning&limit=500",
      `/api/v1/stages/prod/runs/${RUN}/logs?limit=200&severity=error&after=x&pod=p&since=2026-11-19T00%3A00%3A00.000Z`,
    ]);
  });
});

describe("MonitoringLogs", () => {
  it("browses a day and hour: one read with the filters, lines with time, level, pod and container, and a Logs tab", async () => {
    const fetch = api();
    open("/monitoring/dev/logs?date=2026-11-19&hour=14&pod=trino-coordinator-0");
    const r = await rows();
    expect(r).toHaveLength(5);
    expect(r[1]).toHaveTextContent(/14:03:00\.339\s*INFO\s*trino\s*trino-coordinator-0\s*Query 0001_03/);
    expect(within(r[3]).getByRole("link", { name: "Run 8ad7e2f8's window" })).toHaveAttribute("href", "/monitoring/dev/logs?run=8ad7e2f8-0000-4000-a000-000000000000");
    expect(within(r[0]).getByRole("link", { name: "Filter to dagster-daemon-5f7c9" })).toHaveAttribute("href", "/monitoring/dev/logs?date=2026-11-19&hour=14&pod=dagster-daemon-5f7c9");
    expect(r[4]).toHaveTextContent("Unreadable record: the record is not valid JSON");
    expect(reads(fetch)).toEqual(["/api/v1/stages/dev/logs?date=2026-11-19&hour=14&pod=trino-coordinator-0&limit=500"]);
    expect(screen.getByLabelText("Pod")).toHaveValue("trino-coordinator-0");
    expect(screen.getByRole("link", { name: "Logs" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText(/DEV · 2026-11-19, 14:00–15:00 \(UTC\)/)).toBeInTheDocument();
  });

  it("steps an hour back, and a level asks the API with `severity`", async () => {
    const user = userEvent.setup();
    const fetch = api();
    open("/monitoring/dev/logs?date=2026-11-19&hour=00");
    await rows();
    await user.click(screen.getByRole("button", { name: /Previous hour/ }));
    expect(where()).toBe("/monitoring/dev/logs?date=2026-11-18&hour=23");
    await user.selectOptions(screen.getByRole("combobox", { name: "Level" }), "Warning and above");
    expect(where()).toBe("/monitoring/dev/logs?date=2026-11-18&hour=23&level=warning");
    await waitFor(() => expect(reads(fetch).at(-1)).toBe("/api/v1/stages/dev/logs?date=2026-11-18&hour=23&severity=warning&limit=500"));
  });

  it("search asks the API with `q` once typing pauses, and says the archive was searched", async () => {
    const fetch = api({ logs: (u) => {
      const q = u.searchParams.get("q");
      return { body: { lines: q ? LINES().filter((l) => (l.line ?? "").toLowerCase().includes(q.toLowerCase())) : LINES(), truncated: false } };
    } });
    open("/monitoring/dev/logs?date=2026-11-19&hour=14");
    await rows();
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveAccessibleDescription("Search asks the archive for lines containing the text, ignoring case.");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Memory" } });
    expect(where()).toBe("/monitoring/dev/logs?date=2026-11-19&hour=14&q=Memory");
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveAccessibleDescription("The archive was searched for lines containing “Memory”, ignoring case, over the whole time asked."));
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0].querySelector("mark")).toHaveTextContent("Memory");
    expect(reads(fetch)).toEqual([
      "/api/v1/stages/dev/logs?date=2026-11-19&hour=14&limit=500",
      "/api/v1/stages/dev/logs?date=2026-11-19&hour=14&q=Memory&limit=500",
    ]);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nowhere" } });
    expect(await screen.findByText(text(/The archive holds no line containing “nowhere” for 2026-11-19, 14:00–15:00 \(UTC\)/))).toBeInTheDocument();
  });

  it("an API that ignores `q` is detected: the lines loaded are filtered here, the page says so, and `q` is not sent again", async () => {
    const fetch = api({ logs: () => ({ body: { lines: LINES(), truncated: true } }) });
    open("/monitoring/dev/logs?date=2026-11-19&hour=14&q=memory");
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveAccessibleDescription("This Platform API does not search, so search filters the 5 lines loaded, not the whole archive: lines past them are not searched."));
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(screen.getByText("1 of 5+ lines")).toBeInTheDocument();
    expect(screen.getByText(/The first 5 lines only: the archive holds more, and this route has no way to read on/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nowhere" } });
    expect(await screen.findByText(/None of the 5 lines loaded contains “nowhere”\. The archive may hold it elsewhere/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    // One read with `q`, its answer adopted as the unsearched read: no second read, now or for the next search.
    expect(reads(fetch)).toEqual(["/api/v1/stages/dev/logs?date=2026-11-19&hour=14&q=memory&limit=500"]);
  });

  it("a search the API would refuse (too long, control characters) is not sent, and filters the lines loaded", async () => {
    const fetch = api();
    open(`/monitoring/dev/logs?date=2026-11-19&hour=14&q=${"x".repeat(201)}`);
    await rows().catch(() => undefined);
    expect(await screen.findByText(/at most 200 characters with no control characters, so this search filters the 5 lines loaded/)).toBeInTheDocument();
    expect(reads(fetch)).toEqual(["/api/v1/stages/dev/logs?date=2026-11-19&hour=14&limit=500"]);
  });

  it("keeps the selected window when the clock crosses an hour and midnight, while the bounds move on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-11-19T23:59:40Z"));
    const fetch = api();
    open("/monitoring/dev/logs");
    await rows();
    expect(screen.getByRole("button", { name: /Next hour/ })).toBeDisabled();
    expect(screen.getByLabelText("Day (UTC)")).toHaveAttribute("max", "2026-11-19");
    expect(screen.getByRole("option", { name: "00:00–01:00" })).not.toBeDisabled();
    await vi.advanceTimersByTimeAsync(CLOCK_MS);
    await waitFor(() => expect(screen.getByRole("button", { name: /Next hour/ })).toBeEnabled());
    expect(screen.getByLabelText("Day (UTC)")).toHaveAttribute("max", "2026-11-20");
    // Still the hour the page opened on: the address has no date, and its lines are not read again.
    expect(screen.getByText(/DEV · 2026-11-19, 23:00–00:00 \(UTC\)/)).toBeInTheDocument();
    expect(reads(fetch)).toEqual(["/api/v1/stages/dev/logs?date=2026-11-19&hour=23&limit=500"]);
  });

  it("offers only this run's lines in run mode, as `match_run`, kept in the address", async () => {
    const user = userEvent.setup();
    const fetch = api({ capsBody: caps(access("prod")) });
    open(`/monitoring/prod/logs?run=${RUN}`);
    await rows("PROD");
    const only = screen.getByRole("checkbox", { name: "Only this run's lines" });
    expect(only).toHaveAccessibleDescription(/hides other workloads' lines/);
    await user.click(only);
    expect(where()).toBe(`/monitoring/prod/logs?run=${RUN}&match_run=true`);
    await waitFor(() => expect(reads(fetch).at(-1)).toBe(`/api/v1/stages/prod/runs/${RUN}/logs?limit=200&match_run=true`));
  });

  it("run mode reads the run's window and pages with Load more, passing `next` back as `after`", async () => {
    const user = userEvent.setup();
    const f2 = api({
      capsBody: caps(access("prod")),
      runLogs: (u) => u.searchParams.get("after")
        ? { body: { lines: [line("Run failed", { timestamp: "2026-11-19T14:01:59Z" })], truncated: false, since: "2026-11-19T14:00:00Z", until: "2026-11-19T14:02:00Z", next: null } }
        : { body: { lines: LINES().slice(0, 2), truncated: true, since: "2026-11-19T14:00:00Z", until: "2026-11-19T14:02:00Z", next: "p:2" } },
    });
    open(`/monitoring/prod/logs?run=${RUN}&level=error`);
    expect(await rows("PROD")).toHaveLength(2);
    expect(screen.getByText(text(/run c94cbcb0's window, Nov 19(, 2026)? 14:00 UTC → Nov 19(, 2026)? 14:02 UTC/))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Run screen" })).toHaveAttribute("href", `/monitoring/prod/runs/${RUN}`);
    expect(screen.queryByLabelText("Product")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(async () => expect(await rows("PROD")).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(reads(f2)).toEqual([
      `/api/v1/stages/prod/runs/${RUN}/logs?limit=200&severity=error`,
      `/api/v1/stages/prod/runs/${RUN}/logs?limit=200&severity=error&after=p%3A2`,
    ]);
  });

  it("a truncated run window with no `next` says the rest cannot be read here", async () => {
    api({ capsBody: caps(access("prod")), runLogs: () => ({ body: { lines: LINES(), truncated: true, since: "2026-11-19T14:00:00Z", until: "2026-11-19T15:00:00Z", next: null } }) });
    open(`/monitoring/prod/logs?run=${RUN}&date=2026-11-19&hour=14`);
    expect(await screen.findByText(/the window has more, but the API gave no way to read on/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("narrows the run window to the day and hour asked", async () => {
    const fetch = api({ capsBody: caps(access("prod")) });
    open(`/monitoring/prod/logs?run=${RUN}&date=2026-11-19&hour=14&pod=p`);
    await rows("PROD");
    expect(reads(fetch)).toEqual([
      `/api/v1/stages/prod/runs/${RUN}/logs?limit=200&pod=p&since=2026-11-19T14%3A00%3A00.000Z&until=2026-11-19T15%3A00%3A00.000Z`,
    ]);
  });

  it("an older API (no log_retention_days) reads a run from the stage route by its UTC day, at the floors it takes", async () => {
    const fetch = api({ capsBody: caps(access("prod", { log_retention_days: undefined })) });
    open(`/monitoring/prod/logs?run=${RUN}&level=info`);
    await rows("PROD");
    expect(reads(fetch)).toEqual([`/api/v1/stages/prod/runs/${RUN}`, `/api/v1/stages/prod/logs?date=2026-11-19&run_id=${RUN}&limit=500`]);
    expect(screen.getByText(text(/This Platform API has no run window: these are run c94cbcb0's lines of 2026-11-19 \(UTC\)/))).toBeInTheDocument();
    expect(screen.getByText(/filters at warning or error only, so “Info and above” is not applied/)).toBeInTheDocument();
    expect(within(screen.getByRole("combobox", { name: "Level" })).getAllByRole("option").map((o) => o.textContent)).toEqual(["All levels", "Warning and above", "Error and above"]);
  });

  it("a role without the archive's row sees the stages it may read, and nothing is asked", async () => {
    const fetch = api();
    open("/monitoring/prod/logs");
    expect(await screen.findByRole("heading", { name: "Disabled PROD logs are not available" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your role may not read logs on stage PROD.");
    expect(within(screen.getByRole("combobox", { name: "Stage" })).getAllByRole("option").map((o) => o.textContent)).toEqual(["DEV", "PROD · no access"]);
    expect(reads(fetch)).toEqual([]);
  });

  it("a 403 from the archive is shown in the API's words, with no Retry", async () => {
    api({ logs: () => ({ status: 403, body: { detail: "role data-engineer may not call list_logs on stage 'dev'" } }) });
    open("/monitoring/dev/logs?date=2026-11-19&hour=14");
    expect(await screen.findByRole("alert")).toHaveTextContent("role data-engineer may not call list_logs on stage 'dev'");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("a stage with no log archive says so and asks nothing; an empty hour says the archive holds no line", async () => {
    const fetch = api({ capsBody: caps(access("dev", { log_retention_days: null, capabilities: [{ name: "logs", status: "not_provided", reason: "no log archive is configured for this stage" }] })) });
    open("/monitoring/dev/logs");
    expect(await screen.findByText(/DEV keeps no archived logs: no log archive is configured for this stage\./)).toBeInTheDocument();
    expect(reads(fetch)).toEqual([]);
    cleanup();
    api({ logs: () => ({ body: { lines: [], truncated: false } }) });
    open("/monitoring/dev/logs?date=2026-11-19&hour=03&level=error");
    expect(await screen.findByText(text(/The archive holds no error and above line for 2026-11-19, 03:00–04:00 \(UTC\)/))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Show every line of this time" })).toHaveAttribute("href", "/monitoring/dev/logs?date=2026-11-19&hour=03");
  });

  it("an unreachable archive is unknown with Retry", async () => {
    const user = userEvent.setup();
    let down = true;
    api({ logs: () => (down ? "down" : { body: { lines: LINES(), truncated: false } }) });
    open("/monitoring/dev/logs?date=2026-11-19&hour=14");
    expect(await screen.findByRole("heading", { name: "Unknown DEV logs cannot be read" })).toBeInTheDocument();
    down = false;
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await rows()).toHaveLength(5);
  });

  it("shows line times in the chosen zone, with day rows on that zone's days; the archive's pickers stay in UTC", async () => {
    api({ logs: () => ({ body: { lines: [
      line("late", { timestamp: "2026-11-19T23:30:00.125Z" }), line("early", { timestamp: "2026-11-20T00:30:00.250Z" }),
    ], truncated: false } }) });
    act(() => setZoneChoice("local"));
    open("/monitoring/dev/logs?date=2026-11-19");
    const zone = browserZone();
    await rows();
    const lines = () => document.querySelectorAll("tr[data-line]");
    expect(screen.getByRole("columnheader", { name: `Time (${zoneLabel(zone)})` })).toBeInTheDocument();
    expect(lines()[0]).toHaveTextContent(formatClock("2026-11-19T23:30:00.125Z", zone, "millisecond"));
    const days = [...new Set(["2026-11-19T23:30:00.125Z", "2026-11-20T00:30:00.250Z"].map((t) => dayKey(t, zone)))];
    expect(document.querySelectorAll("tr.run-day")).toHaveLength(days.length > 1 ? 2 : 0);
    expect(screen.getByLabelText("Day (UTC)")).toHaveValue("2026-11-19");
    expect(screen.getByLabelText("Hour (UTC)")).toBeInTheDocument();
    act(() => setZoneChoice("utc"));
    expect(screen.getByRole("columnheader", { name: "Time (UTC)" })).toBeInTheDocument();
    expect(document.querySelectorAll("tr.run-day")).toHaveLength(2);
    expect(lines()[0]).toHaveTextContent("23:30:00.125");
  });

  it("moves between lines with the arrow keys", async () => {
    api();
    open("/monitoring/dev/logs?date=2026-11-19&hour=14");
    const region = await screen.findByRole("region", { name: "DEV log lines" });
    region.focus();
    fireEvent.keyDown(region, { key: "ArrowDown" });
    const r = await rows();
    expect(r[0]).toHaveFocus();
    fireEvent.keyDown(region, { key: "ArrowDown" });
    expect(r[1]).toHaveFocus();
    fireEvent.keyDown(region, { key: "End" });
    expect(r[4]).toHaveFocus();
    fireEvent.keyDown(region, { key: "Home" });
    expect(r[0]).toHaveFocus();
  });
});
