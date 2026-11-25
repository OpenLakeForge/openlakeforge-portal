// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRuns, listRuns, runsGate, RUNS_LIMIT, type MonitoringCapabilities, type MonitoringStage, type PipelinesHealth, type Run } from "../lib/health-api";
import { formatTime, seconds, setZoneChoice } from "../lib/time";
import { coverage, matchesStatus, MonitoringRuns, runsHref } from "./MonitoringRuns";

const OPS = ["get_stage_health", "list_pipeline_health", "get_run", "get_run_failure"];
const SOURCES = ["dagster", "services", "quality", "logs", "metrics", "alerts"] as const;
const access = (stage: string, over: Partial<MonitoringStage> = {}): MonitoringStage => ({
  stage, operations: OPS, log_retention_days: 14,
  capabilities: SOURCES.map((name) => ({ name, status: "available", reason: `${name} is configured` })), ...over,
});
const caps = (...stages: MonitoringStage[]): MonitoringCapabilities => ({ stages: stages.length ? stages : [access("dev"), access("prod")] });

const NOW = () => Math.round(Date.now() / 1000);
let n = 0;
const run = (job: string, status: string, agoSeconds: number, over: Partial<Run> = {}): Run => {
  const created = NOW() - agoSeconds;
  n += 1;
  return {
    run_id: `${String(n).padStart(8, "0")}-0000-4000-a000-000000000000`, job_name: job, status, created_at: created,
    started_at: created + 5, ended_at: status === "STARTED" ? null : created + 125, tags: {}, ...over,
  };
};
const RUNS = () => [
  run("sales_orders", "STARTED", 4 * 60),
  run("crm_accounts", "QUEUED", 60, { started_at: null, ended_at: null }),
  run("sales_orders", "FAILURE", 40 * 60),
  run("web_events", "SUCCESS", 2 * 3600),
  run("web_events", "CANCELED", 5 * 3600),
  run("sales_orders", "SUCCESS", 23 * 3600),
  run("sales_orders", "FAILURE", 3 * 86400),
];
const pipeline = (job: string, domain: string | null, product: string | null) => ({
  job, domain, product, state: "healthy" as const, latest_run: null, last_success: null, failed_runs: 0, covered_from: null,
  schedule: { name: null, status: "absent" as const, last_expected_at: null }, freshness: { last_success_at: null, age_seconds: null }, signals: [],
});
const PIPES = (): PipelinesHealth => ({
  stage: "prod", evaluated_at: new Date().toISOString(), window: null, failed_runs: null,
  thresholds: { run_max_age_seconds: 1, schedule_max_age_seconds: 1, schedule_grace_seconds: 1, run_window: 25 },
  integrations: [{ name: "dagster", status: "available", reason: "read from Dagster" }],
  pipelines: [pipeline("sales_orders", "sales", "orders"), pipeline("crm_accounts", "crm", "accounts"), pipeline("web_events", null, null)],
});

type Reply = { status?: number; body?: unknown } | "down";
const respond = (r: Reply) => {
  if (r === "down") throw new TypeError("Failed to fetch");
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
};
function api({ capsBody = caps(), runsReply = (_job: string) => ({ body: { runs: RUNS() } }) as Reply, pipesReply = () => ({ body: PIPES() }) as Reply }: {
  capsBody?: MonitoringCapabilities; runsReply?: (job: string) => Reply; pipesReply?: () => Reply;
} = {}) {
  const fetch = vi.fn(async (input: string) => {
    if (input === "/api/v1/monitoring-capabilities") return respond({ body: capsBody });
    const url = new URL(input, "http://portal");
    if (/^\/api\/v1\/stages\/[^/]+\/runs$/.test(url.pathname)) {
      const job = url.searchParams.get("job") ?? "";
      const reply = runsReply(job);
      if (reply !== "down" && reply.status === undefined && isRuns(reply.body)) {
        return respond({ body: { runs: reply.body.runs.filter((r) => !job || r.job_name === job) } });
      }
      return respond(reply);
    }
    if (url.pathname.endsWith("/health/pipelines")) return respond(pipesReply());
    return respond({ status: 404, body: { detail: "Not Found" } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const urls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([u]) => u as string);
const runReads = (fetch: ReturnType<typeof vi.fn>) => urls(fetch).filter((u) => /\/runs\?/.test(u));

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}
function Page({ stages }: { stages: string[] }) {
  const { stage } = useParams();
  return <MonitoringRuns key={stage} stage={stage!} stages={stages} />;
}
const open = (entry = "/monitoring/prod/runs", stages = ["dev", "prod"]) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/monitoring/:stage/runs" element={<><Page stages={stages} /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
const table = () => screen.findByRole("region", { name: "PROD runs" });
const rows = async () => within(await table()).getAllByRole("row").slice(1);
const where = () => screen.getByTestId("where").textContent;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("runs helpers", () => {
  it("maps each status filter to Dagster's statuses; a canceled run is under All only", () => {
    expect(matchesStatus("FAILURE", "failed")).toBe(true);
    expect(matchesStatus("SUCCESS", "succeeded")).toBe(true);
    for (const s of ["QUEUED", "NOT_STARTED", "STARTING", "STARTED", "CANCELING"]) expect(matchesStatus(s, "in_progress")).toBe(true);
    for (const f of ["failed", "succeeded", "in_progress"] as const) expect(matchesStatus("CANCELED", f)).toBe(false);
    expect(matchesStatus("CANCELED", "")).toBe(true);
  });

  it("builds the page's address, leaving out the default window and empty filters", () => {
    expect(runsHref("prod")).toBe("/monitoring/prod/runs");
    expect(runsHref("prod", { job: "sales_orders", status: "failed", window: "24h" })).toBe("/monitoring/prod/runs?job=sales_orders&status=failed");
    expect(runsHref("prod", { window: "7d", product: "orders" })).toBe("/monitoring/prod/runs?product=orders&window=7d");
  });

  it("says a read that reached its limit before the window's start covers only back to its oldest run", () => {
    const r = (created: number) => ({ ...run("a", "SUCCESS", 0), created_at: created });
    expect(coverage([r(50), r(40)], 3, 10)).toEqual({ complete: true, oldest: 40, coveredFrom: null });
    expect(coverage([r(50), r(40), r(30)], 3, 10)).toEqual({ complete: false, oldest: 30, coveredFrom: 30 });
    expect(coverage([r(50), r(40), r(5)], 3, 10)).toEqual({ complete: false, oldest: 5, coveredFrom: null });
  });

  it("reads runs with the job and the API's largest limit, and refuses a malformed answer", async () => {
    const fetch = api();
    await listRuns("prod", { job: "sales orders" });
    expect(urls(fetch)).toEqual([`/api/v1/stages/prod/runs?limit=${RUNS_LIMIT}&job=sales+orders`]);
    expect(isRuns({ runs: [{ run_id: "x", job_name: "j", status: "SUCCESS", created_at: 1, started_at: null, ended_at: null, tags: {} }] })).toBe(true);
    expect(isRuns({ runs: [{ run_id: "x", status: "SUCCESS" }] })).toBe(false);
    api({ runsReply: () => ({ body: { runs: "none" } }) });
    await expect(listRuns("prod")).rejects.toMatchObject({ status: 200 });
  });

  it("gates on get_run (the list's twin row), on Dagster, and asks an older API anyway", () => {
    expect(runsGate(access("prod"))).toEqual({ open: true });
    expect(runsGate(access("prod", { operations: ["get_stage_health"] }))).toMatchObject({ open: false, state: "disabled", reason: "Your role may not read runs on stage PROD." });
    expect(runsGate(access("prod", { operations: [], log_retention_days: undefined }))).toEqual({ open: true });
    const noDagster = access("prod", { capabilities: [{ name: "dagster", status: "disabled", reason: "no Dagster is configured for this stage" }] });
    expect(runsGate(noDagster)).toMatchObject({ open: false, state: "disabled", reason: "no Dagster is configured for this stage" });
  });
});

describe("MonitoringRuns", () => {
  it("reads the capabilities first, then lists the stage's runs of the last 24 hours with every column", async () => {
    const fetch = api();
    open();
    expect(screen.getByRole("status")).toHaveTextContent("Reading your monitoring access…");
    const r = await rows();
    // The 3-day-old failure is outside the default window.
    expect(r).toHaveLength(6);
    expect(within(r[0]).getByRole("rowheader")).toHaveTextContent("sales_orders");
    expect(r[0]).toHaveTextContent("sales · orders");
    expect(r[0]).toHaveTextContent("Running");
    expect(r[0]).toHaveTextContent(/so far/);
    expect(r[1]).toHaveTextContent("crm · accounts");
    expect(r[1]).toHaveTextContent("Queued");
    expect(r[1]).toHaveTextContent("Not started");
    expect(r[2]).toHaveTextContent("Failed");
    expect(r[2]).toHaveTextContent("2 min");
    expect(r[3]).toHaveTextContent("No data product");
    const link = within(r[2]).getByRole("link", { name: /^Open run / });
    expect(link).toHaveAttribute("href", expect.stringMatching(/^\/monitoring\/prod\/runs\/\d{8}-0000-4000-a000-0{12}$/));
    expect(runReads(fetch)).toEqual([`/api/v1/stages/prod/runs?limit=${RUNS_LIMIT}`]);
    // A read that covers the whole window needs no note.
    expect(screen.queryByText(/Read all 7 runs Dagster holds/)).toBeNull();
    expect(screen.queryByText(/The API filters runs by pipeline only/)).toBeNull();
    expect(screen.getByRole("navigation", { name: "Monitoring views" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Runs" })).toHaveAttribute("aria-current", "page");
  });

  it("opens a deep link with its filters: the job is asked of the API, status and window filter the answer", async () => {
    const fetch = api();
    open("/monitoring/prod/runs?job=sales_orders&status=failed&window=7d");
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.textContent!.includes("Failed"))).toBe(true);
    expect(runReads(fetch)).toEqual([`/api/v1/stages/prod/runs?limit=${RUNS_LIMIT}&job=sales_orders`]);
    expect(screen.getByRole("combobox", { name: "Pipeline" })).toHaveValue("sales_orders");
    expect(screen.getByRole("radio", { name: "Failed runs" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Last 7 days" })).toBeChecked();
    expect(screen.getByText((_, el) => !!el?.matches(".mc-head .sr-only") && el.textContent === "Failed runs of sales_orders created in the last 7 days")).toBeInTheDocument();
  });

  it("filters status and window in place, without a new read, and keeps them in the address", async () => {
    const user = userEvent.setup();
    const fetch = api();
    open();
    await rows();
    await user.click(screen.getByRole("radio", { name: "In progress runs" }));
    expect(where()).toBe("/monitoring/prod/runs?status=in_progress");
    expect(await rows()).toHaveLength(2);
    await user.click(screen.getByRole("radio", { name: "Last 1 hour" }));
    expect(where()).toBe("/monitoring/prod/runs?status=in_progress&window=1h");
    expect(await rows()).toHaveLength(2);
    await user.click(screen.getByRole("radio", { name: "Succeeded runs" }));
    expect(await screen.findByText("No matching runs")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Show all runs of the last 1 hour" })).toHaveAttribute("href", "/monitoring/prod/runs?window=1h");
    expect(runReads(fetch)).toHaveLength(1);
  });

  it("asks again when the pipeline changes, and filters by product from the pipelines answer", async () => {
    const user = userEvent.setup();
    const fetch = api();
    open();
    await rows();
    await user.selectOptions(screen.getByRole("combobox", { name: "Pipeline" }), "web_events");
    expect(where()).toBe("/monitoring/prod/runs?job=web_events");
    await waitFor(() => expect(runReads(fetch)).toHaveLength(2));
    expect(await rows()).toHaveLength(2);
    await user.selectOptions(screen.getByRole("combobox", { name: "Pipeline" }), "");
    await user.selectOptions(await screen.findByRole("combobox", { name: "Product" }), "orders");
    expect(where()).toBe("/monitoring/prod/runs?product=orders");
    const r = await rows();
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.textContent!.includes("sales_orders"))).toBe(true);
  });

  it("says when the read stopped at the API's limit before the window's start", async () => {
    const many = Array.from({ length: RUNS_LIMIT }, (_, i) => run("web_events", "SUCCESS", 600 + i * 3600));
    api({ runsReply: () => ({ body: { runs: many } }) });
    open("/monitoring/prod/runs?window=7d");
    expect(await rows()).toHaveLength(RUNS_LIMIT);
    expect(screen.getByText(/Read the newest 100 runs, the most the API answers at once/)).toHaveTextContent(/only\./);
    expect(screen.getByText(/were not read, so they are not listed; pick a pipeline to reach further back/)).toBeInTheDocument();
    cleanup();
    api({ runsReply: () => ({ body: { runs: many } }) });
    open("/monitoring/prod/runs");
    await rows();
    expect(screen.getByText(/before this window starts/)).toBeInTheDocument();
    expect(screen.queryByText(/were not read/)).toBeNull();
  });

  it("an empty stage reads 'No runs', never a table", async () => {
    api({ runsReply: () => ({ body: { runs: [] } }) });
    open();
    expect(await screen.findByText("No runs")).toBeInTheDocument();
    expect(screen.getByText(/Dagster has no run on PROD/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("an unreachable runs read is Unknown with Retry, which reads again", async () => {
    const user = userEvent.setup();
    let down = true;
    const fetch = api({ runsReply: () => (down ? "down" : { body: { runs: RUNS() } }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown PROD runs cannot be read" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The monitoring API isn’t answering");
    down = false;
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await rows()).toHaveLength(6);
    expect(runReads(fetch)).toHaveLength(2);
  });

  it("a refused read (403) is Disabled in the API's words, with no Retry", async () => {
    api({ runsReply: () => ({ status: 403, body: { detail: "role analyst may not call list_runs on stage 'prod'" } }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Disabled PROD runs are not available" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("may not call list_runs on stage 'prod'");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("a role without get_run reads no run at all", async () => {
    const fetch = api({ capsBody: caps(access("prod", { operations: ["get_stage_health"] })) });
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role may not read runs on stage PROD.");
    expect(runReads(fetch)).toEqual([]);
  });

  it("a stage whose Dagster is not configured is not asked", async () => {
    const fetch = api({ capsBody: caps(access("prod", { capabilities: [{ name: "dagster", status: "unavailable", reason: "Dagster could not be configured" }] })) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown PROD runs cannot be read" })).toBeInTheDocument();
    expect(runReads(fetch)).toEqual([]);
  });

  it("no monitoring access, and a stage the role may not monitor, read nothing", async () => {
    let fetch = api({ capsBody: { stages: [] } });
    open();
    expect(await screen.findByText("No monitoring access")).toBeInTheDocument();
    expect(runReads(fetch)).toEqual([]);
    cleanup();
    fetch = api({ capsBody: caps(access("dev")) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Disabled PROD runs are not available" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "PROD · no access" })).toBeInTheDocument();
    expect(runReads(fetch)).toEqual([]);
  });

  it("an unreadable pipelines answer leaves domain and product unknown, and says why", async () => {
    api({ pipesReply: () => ({ status: 502, body: { detail: "Dagster for stage 'prod' is unreachable" } }) });
    open();
    const r = await rows();
    expect(r[0]).toHaveTextContent("Not known");
    expect(screen.getByText(/Domain and product cannot be shown: The monitoring API failed \(502\)/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Product" })).toBeNull();
  });

  it("a 200 pipelines answer whose Dagster is unavailable leaves scope unknown: the product filter is not applied, and says why", async () => {
    api({
      pipesReply: () => ({
        body: { ...PIPES(), pipelines: [], integrations: [{ name: "dagster", status: "unavailable", reason: "Dagster could not be read" }] },
      }),
    });
    open("/monitoring/prod/runs?product=orders");
    const r = await rows();
    // Every run of the window is listed, unfiltered by product; none is called "No data product".
    expect(r).toHaveLength(6);
    expect(r.every((x) => x.textContent!.includes("Not known"))).toBe(true);
    expect(screen.queryByText("No data product")).toBeNull();
    expect(screen.queryByText("No matching runs")).toBeNull();
    expect(screen.getByText(/Domain and product cannot be shown: Dagster could not be read/)).toBeInTheDocument();
    expect(screen.getByText(/runs of every product are listed/)).toHaveTextContent("The product filter orders is not applied");
    expect(screen.getByRole("combobox", { name: "Product" })).toBeDisabled();
    expect(screen.getByText((_, el) => !!el?.matches(".mc-head .sr-only") && el.textContent === "Runs created in the last 24 hours")).toBeInTheDocument();
  });

  it("switching stage goes to that stage's page, keeping status and window but not the pipeline", async () => {
    const user = userEvent.setup();
    api();
    open("/monitoring/prod/runs?job=sales_orders&status=failed&window=6h");
    await rows();
    await user.selectOptions(screen.getByRole("combobox", { name: "Stage" }), "dev");
    expect(where()).toBe("/monitoring/dev/runs?status=failed&window=6h");
  });

  it("writes each start in the page's one zone: the column names it, the cell holds the time on a 24-hour clock", async () => {
    const runs = RUNS();
    api({ runsReply: () => ({ body: { runs } }) });
    open();
    const r = await rows();
    expect(screen.getByRole("columnheader", { name: "Started (UTC)" })).toBeInTheDocument();
    const failed = runs[2];
    const time = within(r[2]).getByText(formatTime(seconds(failed.started_at!), "UTC", Date.now()));
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("dateTime", new Date(failed.started_at! * 1000).toISOString());
    expect(time.getAttribute("title")).toMatch(/ UTC$/);
    expect(r[2]).not.toHaveTextContent(/AM|PM/);
    // The switch is on this page too, and the choice changes the column and every cell at once.
    await userEvent.click(screen.getByRole("radio", { name: /^Local \(/ }));
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByRole("columnheader", { name: `Started (${zone === "Etc/UTC" ? "UTC" : zone})` })).toBeInTheDocument();
    expect(r[2]).toHaveTextContent(formatTime(seconds(failed.started_at!), zone, Date.now()));
    setZoneChoice("utc");
  });

  it("an unknown status or window in the address falls back to All and 24 hours", async () => {
    api();
    open("/monitoring/prod/runs?status=broken&window=1y");
    expect(await rows()).toHaveLength(6);
    expect(screen.getByRole("radio", { name: "All statuses" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Last 24 hours" })).toBeChecked();
  });

  it("no deployed stage reads 'No stages'", () => {
    api();
    open("/monitoring/prod/runs", []);
    expect(screen.getByText("No stages")).toBeInTheDocument();
  });
});
