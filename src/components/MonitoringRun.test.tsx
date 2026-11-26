// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPipelinesHealth, getRunQuality, listRunLogs, type AlertIncident, type LogLine, type MonitoringStage, type PipelineHealth, type PipelinesHealth,
  type QualityCheck, type RunFailure, type RunLogs, type RunQuality, type StageAlertIncidents,
} from "../lib/health-api";
import { formatClock, formatDate, formatTime, setZoneChoice } from "../lib/time";
import { duration, MonitoringRun, runState } from "./MonitoringRun";

const RUN = "c94cbcb0-5d1e-4a8e-9f0b-2f6c1a7e3b21";
const DAGSTER = "http://dagster-prod.olf.localhost";
const soon = () => new Date(Date.now() + 60_000).toISOString();
const started = Math.round(Date.now() / 1000) - 600;
const runBody = { run_id: RUN, job_name: "sales_orders", status: "FAILURE", created_at: started - 5, started_at: started, ended_at: started + 114, tags: {} };
const failureOf = (over: Partial<RunFailure> = {}): RunFailure => ({
  run_id: RUN, job: "sales_orders", domain: "sales", product: "orders", status: "FAILURE",
  steps: [{ step: "floe_silver_orders", error_class: "SchemaMismatchError", message: "orders.amount: expected decimal(18,2), found string", message_truncated: true }],
  run_message: null, steps_truncated: false, rows: { rejected: 412, accepted: 19000, complete: true },
  sources: [{ name: "dagster", status: "available", reason: "read from the run's event log" }, { name: "quality", status: "available", reason: "read from the run's quality manifest" }],
  ...over,
});
const pipelineOf = (over: Partial<PipelineHealth> = {}): PipelineHealth => ({
  job: "sales_orders", domain: "sales", product: "orders", state: "critical", latest_run: runBody, last_success: null, failed_runs: 1, covered_from: null,
  schedule: { name: "sales_daily", status: "running", last_expected_at: null }, freshness: { last_success_at: null, age_seconds: null },
  signals: [{ kind: "execution", state: "critical", reason: "latest run failed", run: RUN, observed_at: new Date().toISOString(), expires_at: soon(), due: null }],
  ...over,
});
const pipesOf = (p: PipelineHealth[] = [pipelineOf()]): PipelinesHealth => ({
  stage: "prod", evaluated_at: new Date().toISOString(), failed_runs: 1,
  window: { range: "24h", from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString(), covered_from: null },
  thresholds: { run_max_age_seconds: 1, schedule_max_age_seconds: 1, schedule_grace_seconds: 1, run_window: 25 },
  integrations: [{ name: "dagster", status: "available", reason: "read" }], pipelines: p,
});
const check = (over: Partial<QualityCheck> = {}): QualityCheck => ({
  engine: "floe", check_id: "not_null.order_id", table: "sales_silver.orders", column: "order_id", engine_severity: "reject", outcome: "passed",
  pipeline_outcome: "continued", observed_at: new Date().toISOString(), rows: 19402, accepted_rows: null, rejected_rows: null, violations: 0, failures: null,
  report_id: "r-floe", ...over,
});
const HREF = `/api/v1/stages/prod/runs/${RUN}/quality/reports/r-floe`;
const qualityOf = (over: Partial<RunQuality> = {}): RunQuality => ({
  run_id: RUN, job: "sales_orders", status: "FAILURE", complete: true,
  counts: { passed: 1, warn: 1, error: 1, not_run: 0, unknown: 0, blocking: 1 },
  checks: [
    check(),
    check({ check_id: "schema.amount_type", column: "amount", engine_severity: "abort", outcome: "error", pipeline_outcome: "blocked", rejected_rows: 19402, accepted_rows: 0, violations: null }),
    check({ engine: "dbt", check_id: "accepted_values_stg_orders_status", table: "sales_staging.stg_orders", column: "status", engine_severity: "warn", outcome: "warn", violations: null, failures: 3, rows: null, report_id: "r-dbt" }),
  ],
  reports: [{ id: "r-dbt", engine: "dbt", table: null, href: `/api/v1/stages/prod/runs/${RUN}/quality/reports/r-dbt` }, { id: "r-floe", engine: "floe", table: "sales_silver.orders", href: HREF }],
  runbook: null,
  sources: [{ name: "quality", status: "available", reason: "read from the run's quality manifest" }],
  ...over,
});
const noManifest = (status: "not_provided" | "unavailable", reason: string): RunQuality =>
  qualityOf({ complete: null, counts: null, checks: null, reports: [], sources: [{ name: "quality", status, reason }] });
const incident = (over: Partial<AlertIncident> = {}): AlertIncident => ({
  id: "i1", condition: "run_failed", severity: "critical", job: "sales_orders", domain: "sales", product: "orders", table: null, component: null,
  opened_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), summary: "latest run failed", run_ids: [RUN],
  delivery: { status: "delivered", event: "opened", attempts: 1, receivers: 2, delivered: 2 }, ...over,
});
const incidentsOf = (incidents: AlertIncident[] | null = [incident(), incident({ id: "other", summary: "another job's incident", job: "crm", run_ids: [] })]): StageAlertIncidents => ({
  stage: "prod", state: { status: "available", reason: "read", evaluated_at: new Date().toISOString(), stale: false }, incidents,
});
const OPS = ["get_stage_health", "list_pipeline_health", "get_run", "get_run_failure", "get_stage_quality_health", "get_run_quality", "list_logs", "list_alert_incidents"];
const access = (over: Partial<MonitoringStage> = {}): MonitoringStage => ({
  stage: "prod", operations: OPS, log_retention_days: 30,
  capabilities: ["dagster", "services", "quality", "logs", "alerts"].map((name) => ({ name: name as "dagster", status: "available", reason: `${name} is configured` })),
  ...over,
});
const T0 = Date.UTC(2026, 10, 16, 21, 58);
const lineOf = (i: number, over: Partial<LogLine> = {}): LogLine => ({
  archived_at: new Date().toISOString(), namespace: "olf-prod", pod: "run-pod", container: "floe", line: `line ${i}`, error: null,
  timestamp: new Date(T0 + i * 1000).toISOString(), level: "info", ...over,
});
const logsOf = (n = 3, over: Partial<RunLogs> = {}): RunLogs => ({
  lines: Array.from({ length: n }, (_, i) => lineOf(i)), truncated: false,
  since: new Date(T0).toISOString(), until: new Date(T0 + 10 * 60_000).toISOString(), next: null, ...over,
});

type Reply = { status?: number; body?: unknown } | "down";
type Routes = Partial<Record<"caps" | "failure" | "run" | "pipes" | "quality" | "alerts" | "logs" | "dayLogs" | "other", (url: URL) => Reply>>;
/** Every route answers as for a platform admin on PROD's failed run, unless `routes` says otherwise. */
function api(routes: Routes = {}) {
  const defaults: Required<Routes> = {
    caps: () => ({ body: { stages: [access()] } }),
    failure: () => ({ body: failureOf() }),
    run: () => ({ body: runBody }),
    pipes: () => ({ body: pipesOf() }),
    quality: () => ({ body: qualityOf() }),
    alerts: () => ({ body: incidentsOf() }),
    // Like the API, a `severity` floor keeps only lines at or above it (the default lines are all INFO).
    logs: (u) => {
      const floor = u.searchParams.get("severity");
      const rank = ["debug", "info", "warning", "error", "critical"];
      const page = logsOf();
      return { body: floor ? { ...page, lines: page.lines.filter((l) => rank.indexOf(l.level ?? "") >= rank.indexOf(floor)) } : page };
    },
    // The stage's day read (list_logs), the only log route of an API from before #1326.
    dayLogs: () => ({ body: { lines: [lineOf(0), lineOf(1)].map(({ timestamp: _t, level: _l, ...l }) => l), truncated: false } }),
    other: () => ({ status: 404 }),
  };
  const all = { ...defaults, ...routes };
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input, "http://portal.test");
    const p = url.pathname;
    const key: keyof Routes = p === "/api/v1/monitoring-capabilities" ? "caps" : p.endsWith("/failure") ? "failure" : /\/runs\/[^/]+$/.test(p) ? "run"
      : p.endsWith("/health/pipelines") ? "pipes" : /\/runs\/[^/]+\/quality$/.test(p) ? "quality" : p.endsWith("/alerts/incidents") ? "alerts"
      : /\/runs\/[^/]+\/logs$/.test(p) ? "logs" : p === "/api/v1/stages/prod/logs" ? "dayLogs" : "other";
    const r = all[key](url);
    if (r === "down") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const urls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([u]) => new URL(u as string, "http://portal.test"));
const open = (dagster: string | null = DAGSTER, runId = RUN) =>
  render(<MemoryRouter initialEntries={[`/monitoring/prod/runs/${runId}`]}><MonitoringRun stage="prod" runId={runId} dagster={dagster ?? undefined} /></MemoryRouter>);
const card = (name: string) => screen.getByRole("region", { name });

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const logReads = (fetch: ReturnType<typeof vi.fn>) => urls(fetch).filter((u) => u.pathname === `/api/v1/stages/prod/runs/${RUN}/logs`);
const qualityReads = (fetch: ReturnType<typeof vi.fn>) => urls(fetch).filter((u) => u.pathname.endsWith("/quality"));

describe("failed run", () => {
  it("names the scope, the failing step, its redacted first line and the rows, and links to the run in Dagster", async () => {
    api();
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "sales · orders" })).toBeInTheDocument();
    expect(await screen.findByText("SchemaMismatchError")).toBeInTheDocument();
    const chips = screen.getByRole("list", { name: "Run" });
    expect(chips).toHaveTextContent("Critical");
    expect(chips).toHaveTextContent("Stage PROD");
    expect(chips).toHaveTextContent("floe_silver_orders");
    expect(document.querySelector(".f-sub")).toHaveTextContent(/^Pipeline sales_orders · started .* · failed after 1 min 54 s$/);
    expect(card("What failed")).toHaveTextContent("Step floe_silver_orders failed");
    expect(card("What failed")).toHaveTextContent("First line only");
    expect(card("Data quality")).toHaveTextContent("412 rows rejected · 19,000 accepted");
    expect(card("Data quality")).toHaveTextContent("1 error · 1 warn · 1 passed · 1 blocking");
    for (const link of screen.getAllByRole("link", { name: /Open in Dagster/ })) {
      expect(link).toHaveAttribute("href", `${DAGSTER}/runs/${RUN}`);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("keeps the Monitoring head and tabs, Runs current, with a way back to the stage's runs", async () => {
    api();
    open();
    expect(await screen.findByRole("heading", { level: 1, name: "Monitoring" })).toBeInTheDocument();
    const views = screen.getByRole("navigation", { name: "Monitoring views" });
    expect(within(views).getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/monitoring?stage=prod");
    expect(within(views).getByRole("link", { name: "Metrics" })).toHaveAttribute("href", "/monitoring/metrics?stage=prod");
    expect(within(views).getByRole("link", { name: "Logs" })).toHaveAttribute("href", "/monitoring/prod/logs");
    const runs = within(views).getByRole("link", { name: "Runs" });
    expect(runs).toHaveAttribute("href", "/monitoring/prod/runs");
    expect(runs).toHaveAttribute("aria-current", "page");
    const back = screen.getByRole("link", { name: "Back to Runs" });
    expect(back).toHaveAttribute("href", "/monitoring/prod/runs");
    expect(back).toHaveTextContent("← Runs");
  });

  it("shows each receiver of an incident's notification, from an API that names them", async () => {
    const delivery = {
      status: "pending" as const, event: "escalated" as const, attempts: 14, receivers: 2, delivered: 1,
      targets: [
        { receiver: "discussions", status: "delivered" as const, attempts: 1, url: "https://github.com/orgs/OpenLakeForge/discussions/1441" },
        { receiver: "on-call", status: "retrying" as const, attempts: 13, url: null },
      ],
    };
    api({ alerts: () => ({ body: incidentsOf([incident({ delivery })]) }) });
    open();
    const incidents = await screen.findByRole("region", { name: "Open incidents" });
    await within(incidents).findByText("latest run failed");
    expect(incidents).toHaveTextContent("Delivered 1 of 2");
    expect(incidents).toHaveTextContent("on-call — Retrying · 13 attempts");
    expect(within(incidents).getByRole("link", { name: /View discussion/ })).toHaveAttribute("href", delivery.targets[0].url);
  });

  it("offers no Re-run: run control stays in Dagster in v0.7, and no runbook while the API names none", async () => {
    api();
    open();
    await screen.findByText("SchemaMismatchError");
    expect(screen.queryByRole("button", { name: /re-?run|retry|launch/i })).toBeNull();
    expect(card("What failed")).toHaveTextContent("re-run sales_orders from Dagster");
    expect(screen.queryByRole("link", { name: /Runbook/ })).toBeNull();
  });

  it("opens on the failure summary, then the logs, with no Next step card", async () => {
    api();
    open();
    await screen.findByRole("region", { name: "Run log lines" });
    const cards = screen.getAllByRole("region").filter((r) => r.classList.contains("run-card")).map((r) => r.querySelector("h2")!.textContent);
    expect(cards).toEqual(["What failed", "Logs", "Quality checks", "Data quality", "Open incidents"]);
    expect(screen.queryByRole("region", { name: "Next step" })).toBeNull();
  });

  it("summarizes the failure: step, error, when it ended, and links to the logs, reports, Dagster and the job's runs", async () => {
    api();
    open();
    const what = await screen.findByRole("region", { name: "What failed" });
    await within(what).findByRole("list", { name: "Quality reports" });
    expect(what).toHaveTextContent("Step floe_silver_orders failed");
    expect(what).toHaveTextContent("SchemaMismatchError");
    expect(within(what).getByText("When", { selector: "dt" }).closest("div")).toHaveTextContent(/^WhenEnded .*, after 1 min 54 s$/);
    expect(within(what).getByRole("link", { name: /^Logs/ })).toHaveAttribute("href", "#run-logs-h");
    expect(within(what).getByRole("link", { name: /Open in Dagster/ })).toHaveAttribute("href", `${DAGSTER}/runs/${RUN}`);
    expect(within(what).getByRole("link", { name: "All runs of sales_orders" })).toHaveAttribute("href", "/monitoring/prod/runs?job=sales_orders");
    expect(within(what).getByRole("link", { name: /Floe report/ })).toHaveAttribute("href", HREF);
    // The page's head does not repeat the summary's Dagster link.
    expect(screen.getAllByRole("link", { name: /Open in Dagster/ })).toHaveLength(1);
  });

  it("says when the run ended is not known when the run read fails", async () => {
    api({ run: () => ({ status: 503 }) });
    open();
    const what = await screen.findByRole("region", { name: "What failed" });
    expect(within(what).getByText("When", { selector: "dt" }).closest("div")).toHaveTextContent("Not known: The monitoring API failed (503)");
  });

  it("lists only the open incidents of this run or its pipeline, with their delivery", async () => {
    api();
    open();
    const incidents = await screen.findByRole("region", { name: "Open incidents" });
    await within(incidents).findByText("latest run failed");
    expect(incidents).not.toHaveTextContent("another job's incident");
    expect(incidents).toHaveTextContent("Delivered opened notification · 2 of 2 receivers · 1 attempt");
  });

  it("links each open incident's runbook section (#1344) in a new tab, saying which runbook", async () => {
    const book = "https://docs.example/runbooks/alerting#run_failed";
    api({ alerts: () => ({ body: incidentsOf([incident({ runbook: book })]) }) });
    open();
    const incidents = await screen.findByRole("region", { name: "Open incidents" });

    const link = await within(incidents).findByRole("link", { name: /^Runbook ?for run_failed \(opens in a new tab\)$/ });
    expect(link).toHaveAttribute("href", book);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // The incident's own runbook, not the run's: the quality answer names none here.
    expect(within(screen.getByRole("region", { name: "What failed" })).queryByRole("link", { name: /Runbook/ })).toBeNull();
  });

  it.each([
    ["null (no runbook page)", null],
    ["absent (an API before #1344)", undefined],
    ["not a web address", "javascript:alert(1)"],
  ])("shows an incident with a runbook that is %s without a link or a placeholder", async (_, runbook) => {
    api({ alerts: () => ({ body: incidentsOf([incident(runbook === undefined ? {} : { runbook })]) }) });
    open();
    const incidents = await screen.findByRole("region", { name: "Open incidents" });
    await within(incidents).findByText("latest run failed");
    expect(within(incidents).queryByRole("link", { name: /Runbook/ })).toBeNull();
    expect(incidents).not.toHaveTextContent("Runbook");
    expect(incidents).toHaveTextContent("Delivered opened notification · 2 of 2 receivers · 1 attempt");
  });
});

describe("quality checks (get_run_quality)", () => {
  it("lists the checks that did not pass, failures first, with engine, table, column, WARN apart from ERROR, and the recorded counts", async () => {
    const fetch = api();
    open();
    const table = await screen.findByRole("region", { name: "Quality check results" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.querySelector(".run-outcome")!.textContent)).toEqual(["ERROR", "WARN"]);
    expect(rows[0]).toHaveTextContent("schema.amount_type");
    expect(rows[0]).toHaveTextContent("sales_silver.orders · amount");
    expect(rows[0]).toHaveTextContent("Floe · severity abort");
    expect(rows[0]).toHaveTextContent("Blocked the run");
    expect(rows[0]).toHaveTextContent("19,402 rejected · 0 accepted · of 19,402 rows");
    expect(rows[1]).toHaveTextContent("dbt · severity warn");
    expect(rows[1]).toHaveTextContent("3 failures");
    expect(rows[1]).not.toHaveTextContent("rows");
    expect(within(card("Quality checks")).getByText("2 of 3 did not pass")).toBeInTheDocument();
    expect(qualityReads(fetch).map((u) => u.pathname)).toEqual([`/api/v1/stages/prod/runs/${RUN}/quality`]);
  });

  it("collapses the passing checks behind their count, and shows them on demand", async () => {
    api();
    open();
    await screen.findByRole("region", { name: "Quality check results" });
    const passes = card("Quality checks").querySelector("details")!;
    expect(passes).not.toHaveAttribute("open");
    const toggle = within(card("Quality checks")).getByText("1 passed").closest("summary")!;
    expect(toggle).toHaveTextContent("1 passed · show them");
    await userEvent.click(toggle);
    expect(passes).toHaveAttribute("open");
    const rows = within(screen.getByRole("region", { name: "Passed quality checks" })).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("PASS");
    expect(rows[0]).toHaveTextContent("not_null.order_id");
  });

  it("says no check failed when every check passed, with the passes still behind their count", async () => {
    api({ quality: () => ({ body: qualityOf({ checks: [check(), check({ check_id: "unique.order_id" })], counts: { passed: 2, warn: 0, error: 0, not_run: 0, unknown: 0, blocking: 0 } }) }) });
    open();
    expect(await within(await screen.findByRole("region", { name: "Quality checks" })).findByText(/No check in the run's quality manifest failed/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Quality check results" })).toBeNull();
    expect(within(card("Quality checks")).getByText("2 passed")).toBeInTheDocument();
  });

  it("shows a check not run or unknown as not passed, never among the passes", async () => {
    api({ quality: () => ({ body: qualityOf({ checks: [check(), check({ check_id: "x.not_run", outcome: "not_run" }), check({ check_id: "x.unknown", outcome: "unknown" })] }) }) });
    open();
    const rows = within(await screen.findByRole("region", { name: "Quality check results" })).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.querySelector(".run-outcome")!.textContent)).toEqual(["UNKNOWN", "NOT RUN"]);
  });

  it("says no counts were recorded rather than showing zeros", async () => {
    api({ quality: () => ({ body: qualityOf({ checks: [check({ outcome: "error", rows: null, violations: null })] }) }) });
    open();
    const table = await screen.findByRole("region", { name: "Quality check results" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("No counts recorded");
  });

  it("says the run wrote no manifest, in the API's words, and never shows passes", async () => {
    api({ quality: () => ({ body: noManifest("not_provided", "the run wrote no quality manifest") }), failure: () => ({ body: failureOf({ rows: null }) }) });
    open();
    await screen.findByText("SchemaMismatchError");
    for (const name of ["Quality checks", "Data quality"]) {
      expect(card(name)).toHaveTextContent("No quality manifest");
      expect(card(name)).toHaveTextContent("the run wrote no quality manifest");
      expect(card(name)).not.toHaveTextContent(/PASS|passed/);
    }
    expect(card("Quality checks").querySelector('.mon-badge[data-state="disabled"]')).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Quality check results" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Quality reports" })).toBeNull();
  });

  it("reads an unreadable manifest as unknown, not as no checks", async () => {
    api({ quality: () => ({ body: noManifest("unavailable", "the run's quality manifest could not be read") }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(card("Quality checks")).toHaveTextContent("The quality manifest cannot be read");
    expect(card("Quality checks").querySelector('.mon-badge[data-state="unknown"]')).not.toBeNull();
    expect(card("Quality checks")).not.toHaveTextContent("lists no check");
  });

  it("flags an incomplete manifest, and its counts as partial", async () => {
    api({ quality: () => ({ body: qualityOf({ complete: false }) }) });
    open();
    await screen.findByRole("region", { name: "Quality check results" });
    expect(card("Quality checks")).toHaveTextContent("Manifest incomplete");
    expect(card("Quality checks")).toHaveTextContent("checks may be missing from this list");
    expect(card("Data quality")).toHaveTextContent("manifest incomplete, so these counts may be partial");
  });

  it("says a manifest with no check lists none, not that everything passed", async () => {
    api({ quality: () => ({ body: qualityOf({ checks: [], counts: { passed: 0, warn: 0, error: 0, not_run: 0, unknown: 0, blocking: 0 } }) }) });
    open();
    expect(await within(await screen.findByRole("region", { name: "Quality checks" })).findByText("The run's quality manifest lists no check.")).toBeInTheDocument();
  });

  it("shows a refused read (403) as Disabled in the API's words, with no Retry", async () => {
    api({ quality: () => ({ status: 403, body: { detail: "role analyst may not call get_run_quality on stage 'prod'" } }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(card("Quality checks")).toHaveTextContent("Quality checks are not available");
    expect(card("Quality checks")).toHaveTextContent("role analyst may not call get_run_quality on stage 'prod'");
    expect(within(card("Quality checks")).queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("offers Retry when the read fails, and reads again", async () => {
    let down = true;
    api({ quality: () => (down ? { status: 503 } : { body: qualityOf() }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(card("Quality checks")).toHaveTextContent("Quality checks cannot be read");
    down = false;
    await userEvent.click(within(card("Quality checks")).getByRole("button", { name: /Retry/ }));
    expect(await screen.findByRole("region", { name: "Quality check results" })).toBeInTheDocument();
  });

  it("does not take a report link to another origin as an answer", async () => {
    api({ quality: () => ({ body: qualityOf({ reports: [{ id: "x", engine: "floe", table: null, href: "https://evil.example/report" }] }) }) });
    await expect(getRunQuality("prod", RUN)).rejects.toMatchObject({ status: 200 });
  });
});

describe("quality reports", () => {
  it("links each report the API offers as a same-origin download", async () => {
    api();
    open();
    const reports = await screen.findByRole("list", { name: "Quality reports" });
    const floe = within(reports).getByRole("link", { name: /Floe report/ });
    expect(floe).toHaveAttribute("href", HREF);
    expect(floe).toHaveAttribute("download");
    expect(floe).not.toHaveAttribute("target");
    expect(floe).toHaveAccessibleName(/^Floe report\s+for sales_silver\.orders \(downloads a JSON file\)$/);
    expect(within(reports).getByRole("link", { name: /dbt results/ })).toHaveAttribute("href", `/api/v1/stages/prod/runs/${RUN}/quality/reports/r-dbt`);
  });

  it("hides a report the API gives no link for, and says why", async () => {
    const q = qualityOf();
    api({ quality: () => ({ body: { ...q, reports: q.reports.map((r) => ({ ...r, href: null })) } }) });
    open();
    const reports = await screen.findByRole("list", { name: "Quality reports" });
    expect(within(reports).queryByRole("link")).toBeNull();
    expect(reports).toHaveTextContent("dbt results");
    expect(reports).toHaveTextContent("Floe report");
    expect(card("What failed")).toHaveTextContent("These reports are not downloadable here. The API gives no link to your role on this stage");
  });

  it("names only the reports that cannot be downloaded when some can", async () => {
    const q = qualityOf();
    api({ quality: () => ({ body: { ...q, reports: [{ ...q.reports[0], href: null }, q.reports[1]] } }) });
    open();
    const reports = await screen.findByRole("list", { name: "Quality reports" });
    expect(within(reports).getAllByRole("link")).toHaveLength(1);
    expect(card("What failed")).toHaveTextContent("dbt results: not downloadable here");
  });

  it("says the run retained no report", async () => {
    api({ quality: () => ({ body: qualityOf({ reports: [] }) }) });
    open();
    expect(await screen.findByText("The run retained no Floe or dbt report.")).toBeInTheDocument();
  });

  it("shows a runbook in the failure summary only when the API names one as a web address", async () => {
    api({ quality: () => ({ body: qualityOf({ runbook: "https://docs.example/runbooks/alerting#failed_run" }) }) });
    open();
    const book = await within(await screen.findByRole("region", { name: "What failed" })).findByRole("link", { name: /Runbook/ });
    expect(book).toHaveAttribute("href", "https://docs.example/runbooks/alerting#failed_run");
    expect(book).toHaveAttribute("target", "_blank");
    expect(book).toHaveAttribute("rel", "noopener noreferrer");
    cleanup();
    api({ quality: () => ({ body: qualityOf({ runbook: "javascript:alert(1)" }) }) });
    open();
    await screen.findByRole("list", { name: "Quality reports" });
    expect(screen.queryByRole("link", { name: /Runbook/ })).toBeNull();
  });
});

describe("run logs (list_run_logs)", () => {
  it("reads the run's window with each line's time and level, and asks again when the filters change", async () => {
    const fetch = api();
    open();
    const lines = await screen.findByRole("region", { name: "Run log lines" });
    const rows = within(lines).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent("21:58:00.000");
    expect(rows[1]).toHaveTextContent("INFO");
    expect(within(rows[1]).getByText("21:58:00.000").closest("time")).toHaveAttribute("dateTime", new Date(T0).toISOString());
    // The logs open at warning and above; with no such line in the window, they fall back to all levels and say so.
    const [first, fallback] = logReads(fetch);
    expect(first.searchParams.get("limit")).toBe("200");
    expect(first.searchParams.get("severity")).toBe("warning");
    expect(first.searchParams.get("match_run")).toBeNull();
    expect(first.searchParams.get("date")).toBeNull();
    expect(fallback.searchParams.get("severity")).toBeNull();
    expect(logReads(fetch)).toHaveLength(2);
    expect(card("Logs")).toHaveTextContent("No line at warning or above in the run's window, so all levels are shown.");
    expect(within(card("Logs")).getByRole("combobox", { name: "Level" })).toHaveValue("");
    await userEvent.selectOptions(within(card("Logs")).getByRole("combobox", { name: "Level" }), "error");
    await vi.waitFor(() => expect(logReads(fetch).at(-1)!.searchParams.get("severity")).toBe("error"));
    await userEvent.click(within(card("Logs")).getByRole("checkbox", { name: "Only this run's lines" }));
    await vi.waitFor(() => expect(logReads(fetch).at(-1)!.searchParams.get("match_run")).toBe("true"));
    expect(logReads(fetch).at(-1)!.searchParams.get("severity")).toBe("error");
  });

  it("opens at warning and above when the window has such lines, with an obvious way back to all levels", async () => {
    const fetch = api({ logs: (u) => ({ body: u.searchParams.get("severity") === "warning"
      ? logsOf(0, { lines: [lineOf(1, { level: "warning", line: "a warning" })] })
      : logsOf(3) }) });
    open();
    const lines = await screen.findByRole("region", { name: "Run log lines" });
    expect(within(lines).getAllByRole("row")).toHaveLength(2);
    expect(within(card("Logs")).getByRole("combobox", { name: "Level" })).toHaveValue("warning");
    expect(card("Logs")).toHaveTextContent("Showing warnings and above only.");
    expect(card("Logs")).toHaveTextContent("1 lines");
    await userEvent.click(within(card("Logs")).getByRole("button", { name: "Show all levels" }));
    await vi.waitFor(() => expect(within(screen.getByRole("region", { name: "Run log lines" })).getAllByRole("row")).toHaveLength(4));
    expect(logReads(fetch).at(-1)!.searchParams.get("severity")).toBeNull();
    expect(within(card("Logs")).getByRole("combobox", { name: "Level" })).toHaveValue("");
    expect(within(card("Logs")).queryByRole("button", { name: "Show all levels" })).toBeNull();
  });

  it("keeps a floor the reader picked even when it matches no line, and offers all levels", async () => {
    const fetch = api({ logs: (u) => ({ body: u.searchParams.get("severity") ? logsOf(0) : logsOf(3, { lines: [lineOf(0, { level: "warning" })] }) }) });
    open();
    await screen.findByRole("region", { name: "Run log lines" });
    await userEvent.selectOptions(within(card("Logs")).getByRole("combobox", { name: "Level" }), "critical");
    expect(await within(card("Logs")).findByText(/The archive holds no critical only line/)).toBeInTheDocument();
    expect(within(card("Logs")).getByRole("combobox", { name: "Level" })).toHaveValue("critical");
    expect(logReads(fetch).at(-1)!.searchParams.get("severity")).toBe("critical");
    await userEvent.click(within(card("Logs")).getByRole("button", { name: "Show all levels" }));
    await vi.waitFor(() => expect(within(card("Logs")).getByRole("combobox", { name: "Level" })).toHaveValue(""));
  });

  it("jumps to the first error line", async () => {
    api({ logs: () => ({ body: logsOf(0, { lines: [lineOf(0, { level: "warning" }), lineOf(1, { level: "error", line: "the first error" }), lineOf(2, { level: "critical" })] }) }) });
    open();
    await screen.findByRole("region", { name: "Run log lines" });
    await userEvent.click(within(card("Logs")).getByRole("button", { name: "Jump to first error" }));
    expect(document.activeElement).toHaveTextContent("the first error");
    expect(document.activeElement?.tagName).toBe("TR");
  });

  it("offers no jump when the lines shown hold no error", async () => {
    api({ logs: () => ({ body: logsOf(0, { lines: [lineOf(0, { level: "warning" })] }) }) });
    open();
    await screen.findByRole("region", { name: "Run log lines" });
    expect(within(card("Logs")).queryByRole("button", { name: "Jump to first error" })).toBeNull();
  });

  it("explains what 'Only this run's lines' hides", async () => {
    api();
    open();
    await screen.findByRole("region", { name: "Run log lines" });
    const box = within(card("Logs")).getByRole("checkbox", { name: "Only this run's lines" });
    expect(box).toHaveAccessibleDescription(/hides other workloads' lines from that window/);
    expect(screen.getByText(/hides other workloads' lines from that window/)).toBeVisible();
  });

  it("shows nothing for a null time or level, never a guessed one", async () => {
    api({ logs: () => ({ body: logsOf(0, { lines: [lineOf(0, { timestamp: null, level: null, line: "[v1] exit code 1" })] }) }) });
    open();
    const row = within(await screen.findByRole("region", { name: "Run log lines" })).getAllByRole("row")[1];
    const cells = within(row).getAllByRole("cell");
    expect(cells[0]).toBeEmptyDOMElement();
    expect(cells[1]).toBeEmptyDOMElement();
    expect(cells[3]).toHaveTextContent("[v1] exit code 1");
  });

  it("marks each UTC day of a window that crosses midnight", async () => {
    const at = (ms: number) => new Date(Date.UTC(2026, 10, 16, 23, 58) + ms).toISOString();
    api({ logs: () => ({ body: logsOf(0, {
      since: at(0), until: at(10 * 60_000),
      lines: [lineOf(0, { timestamp: at(0) }), lineOf(1, { timestamp: at(150_000) }), lineOf(2, { timestamp: at(200_000), level: "warning" })],
    }) }) });
    open();
    const lines = await screen.findByRole("region", { name: "Run log lines" });
    const now = Date.now();
    expect(within(lines).getAllByRole("rowheader").map((h) => h.textContent)).toEqual([formatDate(at(0), "UTC", now), formatDate(at(10 * 60_000), "UTC", now)]);
    expect(within(lines).getByRole("columnheader", { name: "Time (UTC)" })).toBeInTheDocument();
    expect(within(lines).getByText("WARNING")).toHaveAttribute("data-level", "warning");
    expect(card("Logs")).toHaveTextContent(`${formatTime(at(0), "UTC", now)} → ${formatTime(at(10 * 60_000), "UTC", now)} UTC · crosses midnight`);
  });

  it("reads days and midnight in the zone the reader picked: the same window does not cross midnight in New York", async () => {
    setZoneChoice("local");
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: "America/New_York" } as Intl.ResolvedDateTimeFormatOptions);
    try {
      const at = (ms: number) => new Date(Date.UTC(2026, 10, 16, 23, 58) + ms).toISOString();
      api({ logs: () => ({ body: logsOf(0, {
        since: at(0), until: at(10 * 60_000),
        lines: [lineOf(0, { timestamp: at(0) }), lineOf(1, { timestamp: at(150_000), level: "warning" })],
      }) }) });
      open();
      const lines = await screen.findByRole("region", { name: "Run log lines" });
      expect(within(lines).queryAllByRole("rowheader")).toHaveLength(0);
      expect(within(lines).getByRole("columnheader", { name: "Time (America/New_York)" })).toBeInTheDocument();
      expect(within(lines).getAllByRole("row")[1]).toHaveTextContent("18:58:00.000");
      expect(card("Logs")).not.toHaveTextContent("crosses midnight");
      expect(card("Logs")).toHaveTextContent(/18:58 → .*19:08 America\/New_York/);
    } finally {
      setZoneChoice("utc");
      vi.restoreAllMocks();
    }
  });

  it("reads on with Load more, passing `next` back as `after` with the same filters, and appends", async () => {
    const fetch = api({
      logs: (u) => (u.searchParams.get("after") === "c1"
        ? { body: logsOf(0, { lines: [lineOf(9, { line: "the last line" })], truncated: false, next: null }) }
        : { body: logsOf(2, { truncated: true, next: "c1" }) }),
    });
    open();
    await screen.findByRole("region", { name: "Run log lines" });
    expect(card("Logs")).toHaveTextContent("2+ lines");
    expect(card("Logs")).toHaveTextContent("2 lines shown: the window has more.");
    await userEvent.click(within(card("Logs")).getByRole("button", { name: "Load more" }));
    expect(await within(card("Logs")).findByText("the last line")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Run log lines" })).getAllByRole("row")).toHaveLength(4);
    expect(logReads(fetch).at(-1)!.searchParams.get("after")).toBe("c1");
    expect(card("Logs")).toHaveTextContent("3 lines");
    expect(within(card("Logs")).queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("says honestly when an answer is truncated with no way to read on", async () => {
    api({ logs: () => ({ body: logsOf(2, { truncated: true, next: null }) }) });
    open();
    await screen.findByRole("region", { name: "Run log lines" });
    expect(card("Logs")).toHaveTextContent("the API gave no way to read on");
    expect(within(card("Logs")).queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps the lines and offers Retry when Load more fails", async () => {
    let down = true;
    api({ logs: (u) => (u.searchParams.get("after") ? (down ? { status: 503 } : { body: logsOf(1, { next: null }) }) : { body: logsOf(2, { truncated: true, next: "c1" }) }) });
    open();
    await screen.findByRole("region", { name: "Run log lines" });
    await userEvent.click(within(card("Logs")).getByRole("button", { name: "Load more" }));
    expect(await within(card("Logs")).findByText("More lines cannot be read")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Run log lines" })).getAllByRole("row")).toHaveLength(3);
    down = false;
    await userEvent.click(within(card("Logs")).getByRole("button", { name: /Retry/ }));
    await vi.waitFor(() => expect(within(screen.getByRole("region", { name: "Run log lines" })).getAllByRole("row")).toHaveLength(4));
  });

  it("says the window holds no line rather than showing an empty table", async () => {
    api({ logs: () => ({ body: logsOf(0) }) });
    open();
    expect(await within(await screen.findByRole("region", { name: "Logs" })).findByText(/The archive holds no line in the run's window/)).toBeInTheDocument();
  });

  it("shows how long the archive keeps lines, and nothing when the API says none", async () => {
    api();
    open();
    await screen.findByRole("region", { name: "Run log lines" });
    expect(card("Logs")).toHaveTextContent("Kept 30 days");
    cleanup();
    api({ caps: () => ({ body: { stages: [access({ log_retention_days: null })] } }) });
    open();
    await screen.findByRole("region", { name: "Run log lines" });
    expect(card("Logs")).not.toHaveTextContent(/Kept/);
  });

  it("makes no logs read when the role may not read the archive, says why, and still says how long it keeps lines", async () => {
    const fetch = api({ caps: () => ({ body: { stages: [access({ operations: OPS.filter((o) => o !== "list_logs") })] } }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(card("Logs")).toHaveTextContent("Disabled");
    expect(card("Logs")).toHaveTextContent("Your role may not read logs on stage PROD.");
    expect(card("Logs")).toHaveTextContent("Kept 30 days");
    expect(within(card("Logs")).queryByRole("combobox")).toBeNull();
    expect(logReads(fetch)).toEqual([]);
  });

  it("shows a log archive that is configured but unreadable as unknown, in the API's words", async () => {
    const caps = access();
    caps.capabilities = caps.capabilities.map((c) => (c.name === "logs" ? { ...c, status: "unavailable", reason: "the platform API holds no object-store key for the log archive" } : c));
    const fetch = api({ caps: () => ({ body: { stages: [caps] } }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(card("Logs")).toHaveTextContent("Unknown");
    expect(card("Logs")).toHaveTextContent("the platform API holds no object-store key for the log archive");
    expect(logReads(fetch)).toEqual([]);
  });

  it("offers Retry on a failed logs read", async () => {
    let down = true;
    api({ logs: () => (down ? { status: 503 } : { body: logsOf(2) }) });
    open();
    const retry = await within(await screen.findByRole("region", { name: "Logs" })).findByRole("button", { name: /Retry/ });
    expect(card("Logs")).toHaveTextContent("Unknown");
    down = false;
    await userEvent.click(retry);
    expect(within(await screen.findByRole("region", { name: "Run log lines" })).getAllByRole("row")).toHaveLength(3);
  });

  it("reads lines from an API without time or level as null", async () => {
    const { timestamp: _t, level: _l, ...older } = lineOf(0);
    const { next: _n, ...page } = logsOf(0, { lines: [older as LogLine] });
    api({ logs: () => ({ body: page }) });
    const read = await listRunLogs("prod", RUN);
    expect(read.lines[0].timestamp).toBeNull();
    expect(read.lines[0].level).toBeNull();
    expect(read.next).toBeNull();
  });
});

describe("capabilities gate each read", () => {
  it("makes no quality read when the role lacks get_run_quality, and says why", async () => {
    const fetch = api({ caps: () => ({ body: { stages: [access({ operations: OPS.filter((o) => o !== "get_run_quality") })] } }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(card("Quality checks")).toHaveTextContent("Your role may not read this run's quality checks on stage PROD.");
    expect(card("Data quality")).toHaveTextContent("Quality counts are not available");
    expect(qualityReads(fetch)).toEqual([]);
  });

  it("makes no quality read on a stage with no quality reader", async () => {
    const caps = access();
    caps.capabilities = caps.capabilities.map((c) => (c.name === "quality" ? { ...c, status: "not_provided", reason: "no quality manifest reader is configured for this stage" } : c));
    const fetch = api({ caps: () => ({ body: { stages: [caps] } }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(card("Quality checks")).toHaveTextContent("no quality manifest reader is configured for this stage");
    expect(qualityReads(fetch)).toEqual([]);
  });

  it("makes no run read when the role lacks get_run_failure and get_run, and says why", async () => {
    const fetch = api({ caps: () => ({ body: { stages: [access({ operations: OPS.filter((o) => o !== "get_run_failure" && o !== "get_run") })] } }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Disabled This run's failure is not available" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your role may not read this run's failure on stage PROD.");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(urls(fetch).filter((u) => u.pathname.endsWith("/failure") || u.pathname.endsWith(`/runs/${RUN}`))).toEqual([]);
  });

  it("asks an API from before the run operations were listed, and shows no quality checks it cannot serve", async () => {
    const { log_retention_days: _, ...older } = access({ operations: ["get_stage_health", "list_pipeline_health", "list_logs", "list_alert_incidents"] });
    const fetch = api({ caps: () => ({ body: { stages: [older] } }), logs: () => ({ status: 404, body: { detail: "Not Found" } }) });
    open();
    expect(await screen.findByText("SchemaMismatchError")).toBeInTheDocument();
    expect(card("Quality checks")).toHaveTextContent("This Platform API does not serve a run's quality checks yet.");
    expect(qualityReads(fetch)).toEqual([]);
    expect(card("Logs")).not.toHaveTextContent(/Kept/);
  });

  it("reads an older API's lines from list_logs for the run's UTC day, never from the run log route it lacks", async () => {
    const { log_retention_days: _, ...older } = access({ operations: ["get_stage_health", "list_pipeline_health", "list_logs", "list_alert_incidents"] });
    const fetch = api({ caps: () => ({ body: { stages: [older] } }), logs: () => ({ status: 404, body: { detail: "Not Found" } }) });
    open();
    const lines = await screen.findByRole("region", { name: "Run log lines" });
    expect(within(lines).getAllByRole("row")).toHaveLength(3);
    expect(within(lines).getByText("line 1")).toBeInTheDocument();
    expect(logReads(fetch)).toEqual([]);
    const day = new Date(started * 1000).toISOString().slice(0, 10);
    const read = urls(fetch).find((u) => u.pathname === "/api/v1/stages/prod/logs")!;
    expect(read.searchParams.get("severity")).toBe("warning");
    expect(read.searchParams.get("run_id")).toBe(RUN);
    expect(read.searchParams.get("date")).toBe(day);
    expect(card("Logs")).toHaveTextContent(`Archived ${day} (UTC) · run c94cbcb0`);
    expect(within(card("Logs")).queryByRole("checkbox")).toBeNull();
    expect(within(card("Logs")).getAllByRole("option").map((o) => o.textContent)).toEqual(["All levels", "Warning and above", "Error and above"]);
    await userEvent.selectOptions(within(card("Logs")).getByRole("combobox", { name: "Level" }), "error");
    await vi.waitFor(() => expect(urls(fetch).filter((u) => u.pathname === "/api/v1/stages/prod/logs").at(-1)!.searchParams.get("severity")).toBe("error"));
    expect(logReads(fetch)).toEqual([]);
  });

  it("does not guess an older API's log day when the run read fails", async () => {
    const { log_retention_days: _, ...older } = access({ operations: ["get_stage_health", "list_pipeline_health", "list_logs", "list_alert_incidents"] });
    const fetch = api({ caps: () => ({ body: { stages: [older] } }), run: () => ({ status: 503 }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(card("Logs")).toHaveTextContent("its day in the log archive is not known");
    expect(urls(fetch).filter((u) => u.pathname.endsWith("/logs"))).toEqual([]);
  });
});

describe("what failed, honestly", () => {
  it("reads an unreadable event log as unknown, never as nothing failed", async () => {
    api({ failure: () => ({ body: failureOf({ steps: null, sources: [{ name: "dagster", status: "unavailable", reason: "the run's event log could not be read" }, { name: "quality", status: "unavailable", reason: "the run's quality manifest could not be read" }], rows: null }) }) });
    open();
    const what = await screen.findByRole("region", { name: "What failed" });
    expect(what).toHaveTextContent("Unknown");
    expect(what).toHaveTextContent("The failed steps cannot be read");
    expect(what).toHaveTextContent("the run's event log could not be read");
    expect(what).not.toHaveTextContent("nothing failed");
    expect(card("Data quality")).toHaveTextContent("Row counts cannot be read");
    expect(card("Data quality")).not.toHaveTextContent("0 rows");
  });

  it("shows the run's own message when no step failed, such as a pod killed for memory", async () => {
    api({ failure: () => ({ body: failureOf({ steps: [], run_message: "Run pod was OOMKilled" }) }) });
    open();
    expect(await screen.findByText("The run failed outside any step")).toBeInTheDocument();
    expect(card("What failed")).toHaveTextContent("Run pod was OOMKilled");
  });

  it("says more steps failed than shown", async () => {
    api({ failure: () => ({ body: failureOf({ steps_truncated: true }) }) });
    open();
    expect(await screen.findByText(/More steps failed than are shown here/)).toBeInTheDocument();
  });

  it("names a run that succeeded as such, with a healthy badge from the API's own status", async () => {
    api({ failure: () => ({ body: failureOf({ status: "SUCCESS", steps: [] }) }), run: () => ({ body: { ...runBody, status: "SUCCESS" } }) });
    open();
    expect(await screen.findByText("This run succeeded: nothing failed.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Run" })).toHaveTextContent("Healthy");
  });

  it("says no manifest gave rows when the pipeline has no product, never zero", async () => {
    api({ failure: () => ({ body: failureOf({ rows: null, sources: [failureOf().sources[0], { name: "quality", status: "not_provided", reason: "only a product pipeline's run writes a quality manifest" }] }) }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(card("Data quality")).toHaveTextContent("Row counts are not available");
    expect(card("Data quality")).toHaveTextContent("only a product pipeline's run writes a quality manifest");
  });
});

describe("domain and product", () => {
  it("takes them from the failure answer before the pipelines answer", async () => {
    api({ failure: () => ({ body: failureOf({ domain: "commerce", product: "checkout" }) }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "commerce · checkout" })).toBeInTheDocument();
  });

  it("falls back to the pipelines answer only where the failure answer has none", async () => {
    api({ failure: () => ({ body: failureOf({ domain: null, product: null }) }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "sales · orders" })).toBeInTheDocument();
  });

  it("falls back to the job and says why the domain and product are not known", async () => {
    api({ failure: () => ({ body: failureOf({ domain: null, product: null }) }), pipes: () => ({ body: pipesOf([pipelineOf({ domain: null, product: null })]) }), alerts: () => ({ body: incidentsOf([]) }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "sales_orders" })).toBeInTheDocument();
    expect(screen.getByText(/Not known: the job declares no data product/)).toBeInTheDocument();
  });

  it("takes the scope from an incident of the job when the failure names none and the pipelines read is refused", async () => {
    api({ failure: () => ({ body: failureOf({ domain: null, product: null }) }), pipes: () => ({ status: 403, body: { detail: "role may not call list_pipeline_health" } }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "sales · orders" })).toBeInTheDocument();
  });

  it("accepts a failure answer from before `domain` and `product`, as null", async () => {
    const { domain: _d, product: _p, ...older } = failureOf();
    api({ failure: () => ({ body: older }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "sales · orders" })).toBeInTheDocument();
  });
});

describe("missing fields", () => {
  it("says the times are not known when the run read fails, and still reads the run's log window", async () => {
    const fetch = api({ run: () => ({ status: 503 }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(screen.getAllByText(/Not known: The monitoring API failed \(503\)/).length).toBeGreaterThan(0);
    expect(await screen.findByRole("region", { name: "Run log lines" })).toBeInTheDocument();
    // The warning-and-above read, then its fallback to all levels: both of the run's window, neither of a day.
    expect(logReads(fetch)).toHaveLength(2);
  });

  it("says when no Dagster address is published for the stage, instead of a dead link", async () => {
    api();
    open(null);
    await screen.findByText("SchemaMismatchError");
    expect(screen.queryByRole("link", { name: /Open in Dagster/ })).toBeNull();
    expect(screen.getAllByText(/No Dagster address is published for this stage/).length).toBeGreaterThan(0);
  });

  it("shows the pipeline's state now as unknown when its healthy signal has expired", async () => {
    const old = { observed_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-02T00:00:00Z" };
    api({ pipes: () => ({ body: pipesOf([pipelineOf({ state: "healthy", signals: [{ ...pipelineOf().signals[0], state: "healthy", ...old }] })]) }) });
    open();
    await screen.findByText("SchemaMismatchError");
    const now = screen.getByText("Pipeline now").closest("div")!;
    expect(now).toHaveTextContent("Unknown");
    expect(now).not.toHaveTextContent("Healthy");
  });
});

describe("review fixes", () => {
  const fact = (term: string) => screen.getByText(term, { selector: "dt" }).closest("div")!;

  it("shows a queued run as not started, never its creation as a start, and no duration", async () => {
    api({ run: () => ({ body: { ...runBody, status: "QUEUED", started_at: null, ended_at: null } }), failure: () => ({ body: failureOf({ status: "QUEUED", steps: [] }) }) });
    open();
    await screen.findByText(/Dagster recorded no failed step/);
    expect(fact("Started")).toHaveTextContent("Not started");
    expect(document.querySelector(".f-sub")).not.toHaveTextContent("started ");
    expect(document.querySelector(".f-sub")).toHaveTextContent("is queued");
    expect(document.querySelector(".f-sub")).not.toHaveTextContent("after");
  });

  it("says the start is unknown for an ended run with no start, and computes no duration from creation", async () => {
    api({ run: () => ({ body: { ...runBody, started_at: null } }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(fact("Started")).toHaveTextContent("Start unknown: Dagster recorded no start time for this run");
    expect(document.querySelector(".f-sub")).toHaveTextContent(/^Pipeline sales_orders · failed$/);
  });

  it("turns Pipeline now Unknown once its healthy signal expires while the page is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expires = new Date(Date.now() + 3_000).toISOString();
    api({ pipes: () => ({ body: pipesOf([pipelineOf({ state: "healthy", signals: [{ ...pipelineOf().signals[0], state: "healthy", expires_at: expires }] })]) }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(fact("Pipeline now")).toHaveTextContent("Healthy");
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(fact("Pipeline now")).toHaveTextContent("Unknown");
    expect(fact("Pipeline now")).not.toHaveTextContent("Healthy");
  });
});

describe("refused, missing and unreachable", () => {
  it("shows a 403 on an unauthorized stage in the API's words, as Disabled, with no retry", async () => {
    api({ failure: () => ({ status: 403, body: { detail: "role analyst may not call get_run_failure on stage 'prod'" } }), run: () => ({ status: 403 }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Disabled This run's failure is not available" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("role analyst may not call get_run_failure on stage 'prod'");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(document.querySelector('.mon-badge[data-state="healthy"]')).toBeNull();
  });

  it("calls nothing on a stage the capabilities do not offer", async () => {
    const fetch = api({ caps: () => ({ body: { stages: [access({ stage: "dev" })] } }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Disabled PROD monitoring is not available" })).toBeInTheDocument();
    expect(urls(fetch).filter((u) => u.pathname.startsWith("/api/v1/stages/"))).toEqual([]);
  });

  it("names a run the stage does not know (404)", async () => {
    api({ failure: () => ({ status: 404, body: { detail: "no run 'nope' in stage 'prod'" } }), run: () => ({ status: 404 }) });
    open(DAGSTER, "nope");
    expect(await screen.findByRole("heading", { level: 2, name: "Disabled Run nope was not found" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("no run 'nope' in stage 'prod'");
  });

  it("reads an unreachable API as unknown, never green, and Retry reads again", async () => {
    let down = true;
    api({ failure: () => (down ? "down" : { body: failureOf() }), run: () => (down ? "down" : { body: runBody }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown This run's failure cannot be read" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("nothing on this page can be shown as healthy");
    expect(screen.getByRole("list", { name: "Run" })).toHaveTextContent("Unknown");
    expect(document.querySelector('.mon-badge[data-state="healthy"]')).toBeNull();
    down = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("SchemaMismatchError")).toBeInTheDocument();
  });

  it("does not take a 200 without a RunFailure as an answer", async () => {
    api({ failure: () => ({ body: { run_id: RUN, steps: "nope" } }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown This run's failure cannot be read" })).toBeInTheDocument();
  });

  it("reads unknown when the capabilities cannot be read, with Retry", async () => {
    api({ caps: () => ({ status: 500 }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown Monitoring access cannot be read" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });

  it("keeps the failure when a side read fails, and says which", async () => {
    api({ alerts: () => ({ status: 503 }), quality: () => "down" });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(card("Open incidents")).toHaveTextContent("Alert incidents cannot be read");
    expect(card("Quality checks")).toHaveTextContent("Quality checks cannot be read");
    expect(card("Data quality")).toHaveTextContent("Quality counts cannot be read");
  });

  it("reaches every link and control with the keyboard", async () => {
    api({ logs: () => ({ body: logsOf(2, { truncated: true, next: "c1" }) }) });
    open();
    await screen.findByRole("region", { name: "Run log lines" });
    const reached = new Set<Element>();
    for (let i = 0; i < 30; i++) { await userEvent.tab(); if (document.activeElement) reached.add(document.activeElement); }
    expect(reached).toContain(screen.getAllByRole("link", { name: /Open in Dagster/ })[0]);
    expect(reached).toContain(screen.getByRole("region", { name: "Quality check results" }));
    expect(reached).toContain(within(card("Logs")).getByRole("combobox", { name: "Level" }));
    expect(reached).toContain(within(card("Logs")).getByRole("checkbox", { name: "Only this run's lines" }));
    expect(reached).toContain(card("Quality checks").querySelector("summary"));
    expect(reached).toContain(within(card("What failed")).getByRole("link", { name: /^Logs/ }));
    expect(reached).toContain(screen.getByRole("region", { name: "Run log lines" }));
    expect(reached).toContain(within(card("Logs")).getByRole("button", { name: "Load more" }));
    expect(reached).toContain(screen.getByRole("link", { name: /Floe report/ }));
  });
});

describe("helpers and the client", () => {
  it.each([["FAILURE", "critical"], ["CANCELED", "warning"], ["SUCCESS", "healthy"], ["STARTED", "unknown"], ["WHATEVER", "unknown"]] as const)(
    "reads Dagster's %s as %s", (status, state) => expect(runState(status)).toBe(state));

  it("formats durations and a line's time, and keeps a time it cannot parse as sent", () => {
    expect(duration(114)).toBe("1 min 54 s");
    expect(duration(7500)).toBe("2 h 5 min");
    expect(duration(30)).toBe("30 s");
    expect(formatClock("2026-11-16T23:59:58.120+00:00", "UTC", "millisecond")).toBe("23:59:58.120");
    expect(formatClock("2026-11-17T01:00:00+01:00", "UTC", "millisecond")).toBe("00:00:00.000");
    expect(formatClock("not a time", "UTC", "millisecond")).toBe("not a time");
  });

  it("accepts a pipelines answer from before `due`, `domain` and `product`, as null", async () => {
    const { domain: _d, product: _p, ...older } = pipelineOf();
    const signals = older.signals.map(({ due: _, ...s }) => s);
    api({ pipes: () => ({ body: { ...pipesOf(), pipelines: [{ ...older, signals }] } }) });
    const p = await getPipelinesHealth("prod");
    expect(p.pipelines[0].domain).toBeNull();
    expect(p.pipelines[0].product).toBeNull();
    expect(p.pipelines[0].signals[0].due).toBeNull();
  });
});
