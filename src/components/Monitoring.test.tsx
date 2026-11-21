// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getStageHealth, type AlertIncident, type HealthSignal, type HealthWindow, type HealthState, type MonitoringCapabilities, type MonitoringStage, type PipelineHealth,
  type PipelineQuality, type PipelinesHealth, type QualityCounts, type StageAlertIncidents, type StageHealth, type StageQualityHealth,
} from "../lib/health-api";
import { formatTime } from "../lib/time";
import { DEADLINE_MS, Monitoring } from "./Monitoring";
import { StatusBadge } from "./StatusBadge";

const soon = () => new Date(Date.now() + 40_000).toISOString();
const svcLine = () => document.querySelector(".mon-svc-line") as HTMLElement;
const SERVICE_NAMES: Record<string, string> = { trino: "Trino", polaris: "Polaris", dagster: "Dagster", "log-archive": "Log archive", "quality-sync": "Quality sync" };
const svc = (component: string, state: HealthState, over = {}) => {
  const service = component.split(".")[0];
  return {
    component, display_name: `${SERVICE_NAMES[service]} ${component.split(".")[1]}`, service, service_display_name: SERVICE_NAMES[service],
    source: "x", state, reason: `${component} says ${state}`,
    observed_at: new Date().toISOString(), expires_at: soon(), max_age_seconds: 60, last_success_at: null, ...over,
  };
};
const available = ["dagster", "services", "quality"].map((name) => ({ name, status: "available", reason: "read" }));
const health = (over: Partial<StageHealth> = {}): StageHealth => ({
  stage: "prod", state: "healthy", evaluated_at: new Date().toISOString(),
  pipelines: [{ job: "sales_orders", state: "healthy" }],
  services: [svc("trino.readiness", "healthy"), svc("polaris.readiness", "healthy")],
  integrations: [...available, { name: "metrics", status: "not_provided", reason: "no metrics source is connected to the API" }] as StageHealth["integrations"],
  ...over,
});

const sig = (kind: HealthSignal["kind"], state: HealthState, over: Partial<HealthSignal> = {}): HealthSignal => ({
  kind, state, reason: `${kind} says ${state}`, run: null, observed_at: new Date().toISOString(), expires_at: soon(), due: null, ...over,
});
const run = (job: string, status: string, id = `${job}-run-0001`) => {
  const t = Date.now() / 1000 - 600;
  return { run_id: id, job_name: job, status, created_at: t, started_at: t, ended_at: t + 60, tags: {} };
};
const pipeline = (job: string, over: Partial<PipelineHealth> = {}): PipelineHealth => ({
  job, domain: null, product: null, state: "healthy", latest_run: run(job, "SUCCESS"), last_success: run(job, "SUCCESS"), failed_runs: 0, covered_from: null,
  schedule: { name: `${job}_daily`, status: "running", last_expected_at: new Date(Date.now() - 900_000).toISOString() },
  freshness: { last_success_at: new Date(Date.now() - 540_000).toISOString(), age_seconds: 540 },
  signals: [sig("execution", "healthy"), sig("latest_success", "healthy"), sig("expected_run", "healthy"), sig("freshness", "healthy", { expires_at: null })],
  ...over,
});
const windowOf = (over: Partial<HealthWindow> = {}): HealthWindow => ({
  range: "24h", from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString(), covered_from: null, ...over,
});
const pipes = (over: Partial<PipelinesHealth> = {}): PipelinesHealth => ({
  stage: "prod", evaluated_at: new Date().toISOString(), window: windowOf(), failed_runs: 0,
  thresholds: { run_max_age_seconds: 604800, schedule_max_age_seconds: 300, schedule_grace_seconds: 900, run_window: 25 },
  integrations: available as PipelinesHealth["integrations"], pipelines: [pipeline("sales_orders")], ...over,
});
const ALL_OPS = ["get_stage_health", "get_stage_service_health", "list_pipeline_health", "get_stage_quality_health", "list_logs", "list_alert_incidents"];
const SOURCES = ["dagster", "services", "quality", "quality-sync", "logs", "metrics", "alerts"] as const;
/** One stage a role may monitor: every route and every source, unless `over` says otherwise. */
const access = (stage: string, over: Partial<MonitoringStage> = {}): MonitoringStage => ({
  stage, operations: ALL_OPS, capabilities: SOURCES.map((name) => ({ name, status: "available", reason: `${name} is configured` })), ...over,
});
const caps = (...stages: MonitoringStage[]): MonitoringCapabilities => ({ stages: stages.length ? stages : [access("dev"), access("prod")] });
const CAPS_URL = "/api/v1/monitoring-capabilities";
const counts = (over: Partial<QualityCounts> = {}): QualityCounts => ({ passed: 12, warn: 0, error: 0, not_run: 0, unknown: 0, blocking: 0, ...over });
const pq = (job: string, over: Partial<PipelineQuality> = {}): PipelineQuality => ({
  job, domain: "sales", product: job, run_id: `${job}-run-0001`, observed_at: new Date().toISOString(), complete: true,
  state: "healthy", counts: counts(), reason: "quality checks passed", ...over,
});
const qualityOf = (over: Partial<StageQualityHealth> = {}): StageQualityHealth => ({
  stage: "prod", evaluated_at: new Date().toISOString(), integrations: available.slice(0, 1).concat(available[2]) as StageQualityHealth["integrations"],
  totals: counts(), pipelines: [pq("sales_orders")], ...over,
});
const incidentsOf = (over: Partial<StageAlertIncidents> = {}): StageAlertIncidents => ({
  stage: "prod", state: { status: "available", reason: "read from the alert evaluator's state", evaluated_at: new Date().toISOString(), stale: false },
  incidents: [], ...over,
});
type Reply = { status?: number; body?: unknown } | "down";
type Panels = { quality?: (stage: string) => Reply; alerts?: (stage: string) => Reply };
/** The panels' routes: quality counts with every check passed and no open incident, unless `panels` says otherwise. */
function panel(input: string, panels: Panels = {}): Reply | undefined {
  const [, stage = "", path] = /stages\/([^/]+)\/(health\/quality|alerts\/incidents)$/.exec(input) ?? [];
  if (path === "health/quality") return (panels.quality ?? ((st) => ({ body: qualityOf({ stage: st }) })))(stage);
  if (path === "alerts/incidents") return (panels.alerts ?? ((st) => ({ body: incidentsOf({ stage: st }) })))(stage);
  return undefined;
}
const respond = (r: Reply) => {
  if (r === "down") throw new TypeError("Failed to fetch");
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
};
/** Wraps a fetch so the capabilities (every stage in full, as for a platform admin) and the panels' routes answer. */
const withCaps = <F extends (input: string, init?: RequestInit) => Promise<unknown>>(f: F) => (input: string, init?: RequestInit) => {
  const r = input === CAPS_URL ? { body: caps() } : panel(input);
  return r ? Promise.resolve(respond(r)) : f(input, init);
};

/** Answers /health with `reply`, /health/pipelines with `pipesReply` (healthy pipelines unless given), the
 * capabilities with `capsReply` (every stage in full unless given) and the quality and incidents routes with `panels`. */
function api(
  reply: (stage: string) => Reply,
  pipesReply: (stage: string) => Reply = (stage) => ({ body: pipes({ stage }) }),
  capsReply: () => Reply = () => ({ body: caps() }),
  panels: Panels = {},
) {
  const fetch = vi.fn(async (input: string) => {
    const [, stage = "", sub] = /stages\/([^/]+)\/health(\/pipelines)?$/.exec(input) ?? [];
    return respond(input === CAPS_URL ? capsReply() : panel(input, panels) ?? (sub ? pipesReply(stage) : reply(stage)));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const healthCalls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([u]) => u as string).filter((u) => u.endsWith("/health"));
const open = (stages = ["dev", "prod"], entry = "/monitoring?stage=prod") =>
  render(<MemoryRouter initialEntries={[entry]}><Monitoring stages={stages} /></MemoryRouter>);
const banner = () => screen.getByRole("heading", { level: 2, name: /PROD/ });
const attentionRow = (name: string) => within(screen.getByRole("region", { name: "What needs attention" })).getByRole("row", { name: new RegExp(name) });
const pipelineRow = (name: string) => within(screen.getByRole("region", { name: "Pipeline health" })).getByRole("row", { name: new RegExp(name) });
const serviceRow = (name: string) => within(screen.getByRole("region", { name: "Service health" })).getByRole("row", { name: new RegExp(name) });
/** Opens the Services panel's full list (it folds to one line when every service is healthy). */
const showAllServices = () => userEvent.click(screen.getByRole("button", { name: /^Show all \d+ services$/ }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("MON / Status badge", () => {
  it.each([
    ["healthy", "Healthy"], ["warning", "Warning"], ["critical", "Critical"], ["unknown", "Unknown"], ["disabled", "Disabled"],
  ] as const)("%s reads %s, with a decorative dot", (state, word) => {
    const { container } = render(<StatusBadge state={state} />);
    const badge = container.querySelector(".mon-badge")!;
    expect(badge).toHaveTextContent(word);
    expect(badge).toHaveAttribute("data-state", state);
    expect(badge.querySelector(".mon-dot")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("overview", () => {
  it("shows a healthy stage, its services and the absent metrics as Disabled", async () => {
    api(() => ({ body: health() }));
    open();
    expect(await screen.findByRole("heading", { name: "Healthy PROD is healthy" })).toBeInTheDocument();
    expect(screen.getByText("0 pipelines failed · 2 of 2 services ready")).toBeInTheDocument();
    // Every service is healthy: Services is one line, with a toggle, and its table is folded away.
    expect(svcLine()).toHaveTextContent(/^2 of 2 healthy · resource metrics disabled$/);
    expect(screen.queryByRole("region", { name: "Service health" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show all 2 services" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide healthy services" })).toHaveAttribute("aria-expanded", "true");
    expect(serviceRow("Trino")).toHaveTextContent("Healthy");
    expect(serviceRow("Resource metrics")).toHaveTextContent("Disabled");
    expect(serviceRow("Resource metrics")).toHaveTextContent("no metrics source is connected to the API");
    expect(screen.getByRole("status")).toHaveTextContent(/Checked \d+ s ago/);
  });

  it("names failures and keeps the API's critical rollup", async () => {
    const failed = pipeline("sales_orders", {
      state: "critical", latest_run: run("sales_orders", "FAILURE"),
      signals: [sig("execution", "critical"), sig("latest_success", "healthy"), sig("expected_run", "healthy")],
    });
    api(
      () => ({ body: health({ state: "critical", pipelines: [{ job: "sales_orders", state: "critical" }, { job: "crm", state: "healthy" }] }) }),
      () => ({ body: pipes({ pipelines: [failed, pipeline("crm")] }) }),
    );
    open();
    expect(await screen.findByRole("heading", { name: "Critical PROD needs attention" })).toBeInTheDocument();
    const pipelines = screen.getByRole("region", { name: "Pipelines summary" });
    expect(pipelines).toHaveTextContent("1 failed of 2 · 0 missed");
    // Counts only: the card names no pipeline and no time; the table and the list hold the detail.
    expect(pipelines).toHaveTextContent(/1 critical · 1 healthy$/);
    expect(pipelines).not.toHaveTextContent(/sales_orders|crm|Last success/);
    expect(within(pipelines).getByText("Critical")).toBeInTheDocument();
  });

  it("never shows an expired healthy answer as healthy", async () => {
    const stale = svc("trino.readiness", "healthy", { observed_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T00:01:00Z" });
    api(() => ({ body: health({ services: [stale] }) }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(screen.queryByText(/is healthy/)).toBeNull();
    expect(banner().closest("section")).toHaveTextContent("1 service answer expired");
    expect(serviceRow("Trino")).toHaveTextContent("Unknown");
    expect(serviceRow("Trino")).toHaveTextContent(/Stale: no fresh answer/);
    expect(within(screen.getByRole("region", { name: "Services summary" })).getByText("0 of 1")).toBeInTheDocument();
  });

  it("keeps a worse API rollup when a probe has expired", async () => {
    const stale = svc("trino.readiness", "healthy", { observed_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T00:01:00Z" });
    api(() => ({ body: health({ state: "critical", services: [stale] }) }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Critical PROD needs attention" })).toBeInTheDocument();
  });

  it("reads unknown, with the API's reason, when Dagster cannot be read", async () => {
    const integrations = health().integrations.map((i) => (i.name === "dagster" ? { ...i, status: "unavailable" as const, reason: "Dagster could not be read" } : i));
    api(() => ({ body: health({ state: "unknown", pipelines: [], integrations }) }), () => ({ body: pipes({ pipelines: [], integrations }) }));
    open();
    expect(await screen.findByRole("heading", { name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(attentionRow("Pipelines cannot be read")).toHaveTextContent("Unknown");
    expect(attentionRow("Pipelines cannot be read")).toHaveTextContent("Dagster could not be read");
    const pipelines = screen.getByRole("region", { name: "Pipelines summary" });
    expect(within(pipelines).getByText("Unknown")).toBeInTheDocument();
    expect(pipelines).toHaveTextContent("Dagster could not be read");
    expect(pipelines).not.toHaveTextContent(/failed/);
  });

  it("shows an absent service list as a gap, not as zero healthy", async () => {
    const integrations = health().integrations.map((i) => (i.name === "services" ? { ...i, status: "disabled" as const, reason: "no service probes are configured" } : i));
    api(() => ({ body: health({ services: [], integrations }) }));
    open();
    await screen.findByRole("heading", { name: /PROD/ });
    expect(serviceRow("Service probes")).toHaveTextContent("Disabled");
    expect(serviceRow("Service probes")).toHaveTextContent("no service probes are configured");
    expect(screen.getByText(/service probes give no answer/)).toBeInTheDocument();
  });
});

describe("pipelines and needs attention", () => {
  const failedRun = run("sales_orders", "FAILURE", "c94cbcb0-5d1e-4a8e");
  const troubled = () => pipes({
    pipelines: [
      pipeline("sales_orders", {
        state: "critical", latest_run: failedRun, failed_runs: 2,
        signals: [
          sig("execution", "critical", { reason: "latest run failed", run: failedRun.run_id }),
          sig("latest_success", "healthy"),
          sig("quality", "warning", { reason: "quality checks warned", run: failedRun.run_id }),
        ],
      }),
      pipeline("crm_accounts", {
        state: "critical",
        signals: [sig("execution", "healthy"), sig("expected_run", "critical", { reason: "an expected run did not start" })],
      }),
      pipeline("erp_inventory", {
        state: "disabled", schedule: { name: "erp_daily", status: "stopped", last_expected_at: null },
        signals: [sig("expected_run", "disabled", { reason: "schedule is stopped" })],
      }),
    ],
  });

  it("lists each warning and critical signal in the API's words, worst first, with its pipeline and run", async () => {
    api(() => ({ body: health({ state: "critical" }) }), () => ({ body: troubled() }));
    open();
    expect(await screen.findByRole("heading", { name: "Critical PROD needs attention" })).toBeInTheDocument();
    expect(screen.getByText(/^1 pipeline failed · 1 missed run · 1 quality warning · 2 of 2 services ready/)).toBeInTheDocument();
    const rows = within(screen.getByRole("region", { name: "What needs attention" })).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.querySelector(".mon-what")?.textContent)).toEqual(["Run failed", "Expected run did not start", "Quality check warned"]);
    expect(attentionRow("Run failed")).toHaveTextContent("Critical");
    expect(attentionRow("Run failed")).toHaveTextContent("latest run failed");
    expect(attentionRow("Run failed")).toHaveTextContent("sales_orders");
    expect(attentionRow("Run failed")).toHaveTextContent("run c94cbcb0");
    expect(attentionRow("Quality check warned")).toHaveTextContent("Warning");
    expect(pipelineRow("erp_inventory")).toBeInTheDocument(); // a stopped schedule is listed, but needs no attention
    expect(within(screen.getByRole("region", { name: "What needs attention" })).queryByText("erp_inventory")).toBeNull();
    const summary = screen.getByRole("region", { name: "Pipelines summary" });
    expect(summary).toHaveTextContent("1 failed of 3 · 1 missed");
  });

  it("links each signal's run and each pipeline's latest run to its Failed-run screen", async () => {
    api(() => ({ body: health({ state: "critical" }) }), () => ({ body: troubled() }));
    open();
    await screen.findByRole("region", { name: "Pipeline health" });
    const href = `/monitoring/prod/runs/${failedRun.run_id}`;
    expect(within(attentionRow("Run failed")).getByRole("link", { name: "Open run c94cbcb0" })).toHaveAttribute("href", href);
    expect(within(pipelineRow("sales_orders")).getByRole("link", { name: "Open run c94cbcb0" })).toHaveAttribute("href", href);
    expect(within(pipelineRow("sales_orders")).getByRole("link", { name: "Open run c94cbcb0" }).textContent).toBe("c94cbcb0");
  });

  it("shows when a missed expected run was due, from the signal's own `due`", async () => {
    const due = new Date(Date.now() - 1_800_000);
    const missed = pipes({
      pipelines: [pipeline("crm_accounts", {
        state: "critical",
        schedule: { name: "crm_daily", status: "running", last_expected_at: new Date(Date.now() - 600_000).toISOString() },
        signals: [sig("expected_run", "critical", { reason: "an expected run did not start", due: due.toISOString() })],
      })],
    });
    api(() => ({ body: health({ state: "critical" }) }), () => ({ body: missed }));
    open();
    await screen.findByRole("region", { name: "Pipeline health" });
    // The column header names the zone; the cell holds the time on a 24-hour clock, in UTC by default.
    expect(screen.getByRole("columnheader", { name: "When (UTC)" })).toBeInTheDocument();
    expect(attentionRow("Expected run did not start")).toHaveTextContent(`due ${formatTime(due, "UTC", Date.now())}`);
    expect(within(attentionRow("Expected run did not start")).getByText(formatTime(due, "UTC", Date.now())).closest("time")).toHaveAttribute("dateTime", due.toISOString());
  });

  it("falls back to the schedule's last tick, without the word due, when the API sends no `due`", async () => {
    api(() => ({ body: health({ state: "critical" }) }), () => ({ body: troubled() }));
    open();
    await screen.findByRole("region", { name: "Pipeline health" });
    expect(attentionRow("Expected run did not start")).not.toHaveTextContent("due");
  });

  it("shows each pipeline's latest run, last success, schedule and failed runs", async () => {
    api(() => ({ body: health({ state: "critical" }) }), () => ({ body: troubled() }));
    open();
    await screen.findByRole("region", { name: "Pipeline health" });
    expect(pipelineRow("sales_orders")).toHaveTextContent("Critical");
    expect(pipelineRow("sales_orders")).toHaveTextContent(/Failed · .*c94cbcb0/);
    expect(pipelineRow("sales_orders")).toHaveTextContent("2 failed in last 24h");
    expect(pipelineRow("erp_inventory")).toHaveTextContent("Disabled");
    expect(pipelineRow("erp_inventory")).toHaveTextContent(/Stopped\s*erp_daily/);
  });

  it("reads a failed-run count that could not be read as Unknown, never 0", async () => {
    api(() => ({ body: health() }), () => ({ body: pipes({ failed_runs: null, pipelines: [pipeline("sales_orders", { failed_runs: null })] }) }));
    open();
    await screen.findByRole("region", { name: "Pipeline health" });
    const cell = pipelineRow("sales_orders").querySelectorAll("td")[4];
    expect(cell).toHaveTextContent("Unknown");
    expect(cell).toHaveTextContent("the count of failed runs could not be read");
    expect(cell).not.toHaveTextContent("0");
  });

  it("says where the count starts when the API's run read stopped short of the window", async () => {
    const from = new Date(Date.now() - 3_600_000);
    api(() => ({ body: health() }), () => ({
      body: pipes({ window: windowOf({ covered_from: from.toISOString() }), pipelines: [pipeline("sales_orders", { failed_runs: 3, covered_from: from.toISOString() })] }),
    }));
    open();
    await screen.findByRole("region", { name: "Pipeline health" });
    expect(pipelineRow("sales_orders")).toHaveTextContent(`3 failed since ${formatTime(from, "UTC", Date.now())} UTC`);
    expect(pipelineRow("sales_orders")).toHaveTextContent("the run read stopped short of the last 24h");
    expect(pipelineRow("sales_orders")).not.toHaveTextContent("in last 24h");
  });

  it("names the window's range from the API", async () => {
    api(() => ({ body: health() }), () => ({ body: pipes({ window: windowOf({ range: "7d" }), pipelines: [pipeline("sales_orders", { failed_runs: 4 })] }) }));
    open();
    await screen.findByRole("region", { name: "Pipeline health" });
    expect(pipelineRow("sales_orders")).toHaveTextContent("4 failed in last 7d");
  });

  it("keeps the run-window wording for an API from before the window (no `window`, `covered_from` or stage count)", async () => {
    const { window: _w, failed_runs: _f, ...older } = pipes({ pipelines: [pipeline("sales_orders", { failed_runs: 2 })] });
    const pipelines = older.pipelines.map(({ covered_from: _c, ...p }) => p);
    api(() => ({ body: health() }), () => ({ body: { ...older, pipelines } }));
    open();
    await screen.findByRole("region", { name: "Pipeline health" });
    expect(pipelineRow("sales_orders")).toHaveTextContent("2 of last 25 runs");
  });

  it("reads a pipelines answer with `window: null` as no window, in the run-window wording", async () => {
    api(() => ({ body: health() }), () => ({ body: { ...pipes({ pipelines: [pipeline("sales_orders", { failed_runs: 2 })] }), window: null } }));
    open();
    await screen.findByRole("region", { name: "Pipeline health" });
    expect(pipelineRow("sales_orders")).toHaveTextContent("2 of last 25 runs");
  });

  it("accepts a stage health answer with `window: null`", async () => {
    api(() => ({ body: { ...health(), window: null, failed_runs: null } }));
    open();
    expect(await screen.findByRole("heading", { name: "Healthy PROD is healthy" })).toBeInTheDocument();
    expect(await getStageHealth("prod")).toMatchObject({ window: null });
  });

  it("does not take a window that is not a HealthWindow as an answer", async () => {
    api(() => ({ body: health() }), () => ({ body: { ...pipes(), window: { range: "24h" } } }));
    open();
    expect(await screen.findByText(/Pipelines cannot be read/)).toBeInTheDocument();
  });

  it("says nothing needs attention only when every pipeline signal is current and fine", async () => {
    api(() => ({ body: health() }));
    open();
    expect(await screen.findByText(/Nothing needs attention/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Needs attention" })).getByText("0")).toBeInTheDocument();
  });

  it("reads an expired healthy pipeline signal as unknown, in the row, the pipeline and the stage", async () => {
    const old = { observed_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-02T00:00:00Z" };
    api(() => ({ body: health() }), () => ({ body: pipes({ pipelines: [pipeline("sales_orders", { signals: [sig("execution", "healthy", old)] })] }) }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(screen.getByText(/1 pipeline signal expired/)).toBeInTheDocument();
    expect(attentionRow("No current evidence")).toHaveTextContent("execution: answer expired");
    expect(pipelineRow("sales_orders")).toHaveTextContent("Unknown");
    expect(screen.queryByText(/Nothing needs attention/)).toBeNull();
  });

  it("shows a pipeline that has no evidence yet as unknown, with the API's reasons", async () => {
    const fresh = pipeline("new_job", {
      state: "unknown", latest_run: null, last_success: null, freshness: { last_success_at: null, age_seconds: null },
      signals: [sig("execution", "unknown", { reason: "no observation" }), sig("freshness", "unknown", { reason: "no successful run on record" })],
    });
    api(() => ({ body: health({ state: "unknown" }) }), () => ({ body: pipes({ pipelines: [fresh] }) }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(attentionRow("No current evidence")).toHaveTextContent("execution: no observation · freshness: no successful run on record");
    expect(pipelineRow("new_job")).toHaveTextContent("No run in the window");
    expect(pipelineRow("new_job")).toHaveTextContent("None on record");
  });

  it("reads unknown, keeps the stage's own answer, and offers Retry when the pipelines read fails", async () => {
    let fail = true;
    const fetch = api(() => ({ body: health() }), () => (fail ? { status: 502, body: { detail: "bad gateway" } } : { body: pipes() }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(screen.getByText(/pipelines cannot be read · 2 of 2 services ready/)).toBeInTheDocument();
    expect(attentionRow("Pipelines cannot be read")).toHaveTextContent("The monitoring API failed (502)");
    expect(within(screen.getByRole("region", { name: "Pipelines summary" })).getByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Pipeline health" })).toBeNull();
    await showAllServices();
    expect(serviceRow("Trino")).toHaveTextContent("Healthy"); // the stage answer still stands
    fail = false;
    await userEvent.click(within(screen.getByRole("region", { name: "What needs attention" })).getByRole("button", { name: /Retry/ }));
    expect(await screen.findByRole("heading", { name: "Healthy PROD is healthy" })).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([u]) => (u as string).endsWith("/pipelines"))).toHaveLength(2);
  });

  it("drops the old pipelines and names the last good snapshot when a refresh of them fails", async () => {
    vi.useFakeTimers();
    let fail = false;
    api(() => ({ body: health() }), () => (fail ? "down" : { body: pipes() }));
    open();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("region", { name: "Pipeline health" })).toBeInTheDocument();
    fail = true;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(attentionRow("Pipelines cannot be read")).toHaveTextContent("isn’t answering");
    expect(attentionRow("Pipelines cannot be read")).toHaveTextContent("Last good snapshot");
    expect(screen.queryByRole("region", { name: "Pipeline health" })).toBeNull();
  });

  it("shows a refused pipelines read in the API's words, with no retry", async () => {
    api(() => ({ body: health() }), () => ({ status: 403, body: { detail: "role analyst may not call list_pipeline_health" } }));
    open();
    expect(await screen.findByRole("region", { name: "What needs attention" })).toHaveTextContent("role analyst may not call list_pipeline_health");
    expect(attentionRow("Pipeline health is not available")).toHaveTextContent("Disabled");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(banner()).toHaveTextContent("Unknown");
  });

  it("does not take a 200 without a PipelinesHealth as an answer", async () => {
    api(() => ({ body: health() }), () => ({ body: { stage: "prod" } }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(attentionRow("Pipelines cannot be read")).toHaveTextContent("Unknown");
  });

  it.each([
    ["no thresholds", (b: PipelinesHealth) => { delete (b as Partial<PipelinesHealth>).thresholds; }],
    ["a pipeline without signals", (b: PipelinesHealth) => { delete (b.pipelines[0] as Partial<PipelineHealth>).signals; }],
    ["a pipeline without a schedule", (b: PipelinesHealth) => { delete (b.pipelines[0] as Partial<PipelineHealth>).schedule; }],
    ["a pipeline without freshness", (b: PipelinesHealth) => { delete (b.pipelines[0] as Partial<PipelineHealth>).freshness; }],
    ["a signal without a state", (b: PipelinesHealth) => { delete (b.pipelines[0].signals[0] as Partial<HealthSignal>).state; }],
    ["a latest run without an id", (b: PipelinesHealth) => { b.pipelines[0].latest_run = { status: "FAILURE" } as PipelineHealth["latest_run"]; }],
  ])("reads a pipelines answer with %s as a failed read, and keeps the stage's own answer", async (_, spoil) => {
    const body = pipes();
    spoil(body);
    api(() => ({ body: health() }), () => ({ body }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(attentionRow("Pipelines cannot be read")).toHaveTextContent("Unknown");
    expect(within(screen.getByRole("region", { name: "What needs attention" })).getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    await showAllServices();
    expect(serviceRow("Trino")).toHaveTextContent("Healthy");
  });

  it("lets a critical pipeline colour the stage when /health still says healthy", async () => {
    const failed = pipeline("sales_orders", { state: "critical", signals: [sig("execution", "critical", { reason: "latest run failed" })] });
    api(() => ({ body: health({ state: "healthy" }) }), () => ({ body: pipes({ pipelines: [failed] }) }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Critical PROD needs attention" })).toBeInTheDocument();
    expect(screen.queryByText(/is healthy/)).toBeNull();
  });

  it("keeps a worse /health answer over milder pipeline verdicts", async () => {
    const warned = pipeline("sales_orders", { state: "warning", signals: [sig("quality", "warning")] });
    api(() => ({ body: health({ state: "critical" }) }), () => ({ body: pipes({ pipelines: [warned] }) }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Critical PROD needs attention" })).toBeInTheDocument();
  });

  it("treats a stage without Dagster as monitoring off, not as a gap", async () => {
    const integrations = health().integrations.map((i) => (i.name === "dagster" ? { ...i, status: "disabled" as const, reason: "no Dagster is configured for this stage" } : i));
    api(() => ({ body: health({ pipelines: [], integrations }) }), () => ({ status: 404, body: { detail: "no Dagster is configured for stage 'prod'" } }));
    open();
    expect(await screen.findByRole("heading", { name: "Healthy PROD is healthy" })).toBeInTheDocument();
    expect(screen.getByText(/no Dagster on this stage/)).toBeInTheDocument();
    expect(attentionRow("Pipeline health is not available")).toHaveTextContent("no Dagster is configured for stage 'prod'");
  });
});

describe("unavailable and absent", () => {
  it("shows unknown, never green, when the API is down, and retries", async () => {
    let down = true;
    const fetch = api(() => (down ? "down" : { body: health() }), () => (down ? "down" : { body: pipes() }));
    open();
    expect(await screen.findByRole("heading", { name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("nothing on this page can be shown as healthy");
    expect(screen.queryByText("Healthy")).toBeNull();
    down = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByRole("heading", { name: "Healthy PROD is healthy" })).toBeInTheDocument();
    expect(healthCalls(fetch)).toHaveLength(2);
  });

  it("says a 5xx is not health either", async () => {
    api(() => ({ status: 502, body: { detail: "bad gateway" } }));
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("The monitoring API failed (502)");
    expect(banner()).toHaveTextContent("Unknown");
  });

  it("shows a refused stage as not available, with the API's words and no retry", async () => {
    api(() => ({ status: 403, body: { detail: "role analyst may not call get_stage_health" } }));
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("role analyst may not call get_stage_health");
    expect(banner()).toHaveTextContent("Disabled");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("says so when there is no stage, and calls nothing", () => {
    const fetch = api(() => ({ body: health() }));
    open([]);
    expect(screen.getByText("This deployment has no stage to monitor yet.")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops an answer whose body was still arriving when the stage changed", async () => {
    // dev's headers arrive, then its body only ends when the request is aborted, as fetch does on a switch.
    vi.stubGlobal("fetch", vi.fn(withCaps(async (input: string, init: RequestInit = {}) => {
      // prod answers a little later, so a stale dev result would render on its own first.
      if (input.endsWith("/prod/health")) return new Promise((done) => setTimeout(() => done(new Response(JSON.stringify(health()))), 100));
      if (input.endsWith("/prod/health/pipelines")) return new Response(JSON.stringify(pipes()));
      return {
        ok: true, status: 200,
        json: () => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      } as unknown as Response;
    })));
    open(["dev", "prod"], "/monitoring?stage=dev");
    await screen.findByText("Reading DEV health…");
    await userEvent.click(screen.getByRole("radio", { name: "PROD" }));
    expect(await screen.findByRole("heading", { name: "Healthy PROD is healthy" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rethrows a cancelled body read instead of answering undefined", async () => {
    const ctl = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      // Like a real body stream: an already-aborted read rejects at once, a later abort rejects it then.
      json: () => new Promise((_, reject) => {
        const fail = () => reject(new DOMException("aborted", "AbortError"));
        if (ctl.signal.aborted) fail(); else ctl.signal.addEventListener("abort", fail);
      }),
    })));
    const read = getStageHealth("dev", ctl.signal);
    ctl.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
  });

  it("offers a list instead of the switch for more than three stages", async () => {
    const four = ["dev", "test", "uat", "prod"];
    api((stage) => ({ body: health({ stage }) }), undefined, () => ({ body: caps(...four.map((st) => access(st))) }));
    open(four, "/monitoring?stage=uat");
    expect(await screen.findByRole("heading", { name: "Healthy UAT is healthy" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Stage" })).toHaveValue("uat");
    expect(screen.queryByRole("group", { name: "Stage" })).toBeNull();
  });

  it("offers DEV | UAT | PROD as three segments", async () => {
    const three = ["dev", "uat", "prod"];
    api((stage) => ({ body: health({ stage }) }), undefined, () => ({ body: caps(...three.map((st) => access(st))) }));
    open(three, "/monitoring?stage=uat");
    expect(await screen.findByRole("heading", { name: "Healthy UAT is healthy" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Stage" })).getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual(["DEV", "UAT", "PROD"]);
    expect(screen.getByRole("radio", { name: "UAT" })).toBeChecked();
  });

  it("does not take a 200 without a StageHealth as an answer", async () => {
    api(() => ({ body: {} }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeInTheDocument();
  });

  it("switches stage from a segmented DEV | PROD switch, with the keyboard, and asks the API for it", async () => {
    const fetch = api((stage) => ({ body: health({ stage }) }));
    open(["dev", "prod"], "/monitoring");
    expect(await screen.findByRole("heading", { name: "Healthy DEV is healthy" })).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Stage" });
    expect(within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual(["DEV", "PROD"]);
    expect(screen.queryByRole("combobox", { name: "Stage" })).toBeNull();
    expect(screen.getByRole("radio", { name: "DEV" })).toBeChecked();
    screen.getByRole("radio", { name: "DEV" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "PROD" })).toBeChecked();
    expect(await screen.findByRole("heading", { name: "Healthy PROD is healthy" })).toBeInTheDocument();
    expect(healthCalls(fetch)).toEqual(["/api/v1/stages/dev/health", "/api/v1/stages/prod/health"]);
    expect(fetch).toHaveBeenCalledWith("/api/v1/stages/prod/health/pipelines", expect.anything());
  });
});

describe("a health read that never answers", () => {
  /** A fetch that never answers on its own and, like the real one, rejects once aborted. */
  const stall = (_: string, init: RequestInit = {}) => new Promise<Response>((_, reject) => {
    const fail = () => reject(new DOMException("aborted", "AbortError"));
    if (init.signal?.aborted) fail(); else init.signal?.addEventListener("abort", fail);
  });
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  it("on a first visit reads Unknown with Retry at the deadline, then refreshes only after that", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(withCaps(stall));
    vi.stubGlobal("fetch", fetch);
    open();
    await advance(0); // the capabilities answer; the snapshot and its deadline start then
    await advance(DEADLINE_MS - 1);
    expect(screen.getByText("Reading PROD health…")).toBeInTheDocument();
    await advance(1);
    expect(screen.getByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(`did not answer within ${DEADLINE_MS / 1000} s`);
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    await advance(30_000 - 1);
    expect(healthCalls(fetch)).toHaveLength(1); // no refresh while the stalled read was pending, nor before 30 s after it
    await advance(1);
    expect(healthCalls(fetch)).toHaveLength(2);
  });

  it("shows the stage's answer and reads only the pipelines as unreachable when they alone stall", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(withCaps((input: string, init?: RequestInit) =>
      input.endsWith("/pipelines") ? stall(input, init) : Promise.resolve(new Response(JSON.stringify(health()))))));
    open();
    await advance(0); // the capabilities answer; the snapshot and its deadline start then
    await advance(DEADLINE_MS - 1);
    expect(screen.getByText("Reading PROD health…")).toBeInTheDocument();
    await advance(1);
    expect(screen.getByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(attentionRow("Pipelines cannot be read")).toHaveTextContent(`did not answer within ${DEADLINE_MS / 1000} s`);
    expect(screen.getByText(/^2 of 2 healthy/)).toBeInTheDocument(); // the services' own answer stands
  });

  it("after a good snapshot, drops it for Unknown when a refresh stalls", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(withCaps((input: string, init?: RequestInit) => {
      if (input.endsWith("/pipelines")) return Promise.resolve(new Response(JSON.stringify(pipes())));
      return calls++ === 0 ? Promise.resolve(new Response(JSON.stringify(health()))) : stall(input, init);
    })));
    open();
    await advance(0);
    expect(screen.getByRole("heading", { level: 2, name: "Healthy PROD is healthy" })).toBeInTheDocument();
    await advance(30_000); // the refresh starts and stalls; its effect (and deadline) run when act ends
    expect(calls).toBe(2);
    await advance(DEADLINE_MS);
    expect(screen.getByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Last good snapshot");
    expect(screen.queryByText("Healthy")).toBeNull();
    expect(screen.queryByRole("region", { name: "Service health" })).toBeNull();
  });
});

describe("monitoring capabilities", () => {
  const urls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([u]) => u as string);

  it("shows a clear no-access state for a role with no stage, and reads no health", async () => {
    const fetch = api(() => ({ body: health() }), undefined, () => ({ body: { stages: [] } }));
    open();
    expect(await screen.findByText(/Your role may not monitor any stage/)).toBeInTheDocument();
    expect(screen.getByText("No monitoring access")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Stage" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Stage" })).toBeNull();
    expect(urls(fetch)).toEqual([CAPS_URL]);
  });

  it("offers only the stages the capabilities list", async () => {
    api((stage) => ({ body: health({ stage }) }), undefined, () => ({ body: caps(access("dev")) }));
    open(["dev", "prod"], "/monitoring");
    expect(await screen.findByRole("heading", { name: "Healthy DEV is healthy" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Stage" })).getAllByRole("radio").map((o) => o.getAttribute("aria-label"))).toEqual(["DEV"]);
  });

  it("refuses a deployed stage the role may not monitor without calling any of its routes", async () => {
    const fetch = api(() => ({ body: health() }), undefined, () => ({ body: caps(access("dev")) }));
    open(["dev", "prod"], "/monitoring?stage=prod");
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role has no monitoring access on stage PROD.");
    expect(banner()).toHaveTextContent("Disabled");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(urls(fetch).filter((u) => u.includes("/prod/"))).toEqual([]);
  });

  it("does not read pipelines for a role without list_pipeline_health, and says why", async () => {
    const fetch = api(() => ({ body: health() }), undefined, () => ({ body: caps(access("prod", { operations: ["get_stage_health"] })) }));
    open();
    expect(await screen.findByRole("heading", { name: "Healthy PROD is healthy" })).toBeInTheDocument(); // /health's rollup stands
    expect(attentionRow("Pipeline health is not available")).toHaveTextContent("Your role may not read pipeline health on stage PROD.");
    expect(attentionRow("Pipeline health is not available")).toHaveTextContent("Disabled");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(urls(fetch).some((u) => u.endsWith("/pipelines"))).toBe(false);
  });

  it("does not read the stage health for a role without get_stage_health, and keeps the panels it may read", async () => {
    const fetch = api(() => ({ body: health() }), undefined, () => ({ body: caps(access("prod", { operations: ["list_pipeline_health"] })) }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Disabled PROD health is not available" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Pipeline health" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Service health" })).toBeNull();
    expect(healthCalls(fetch)).toEqual([]);
  });

  it("does not read pipelines on a stage whose Dagster the capabilities call disabled", async () => {
    const off = { name: "dagster" as const, status: "disabled" as const, reason: "no Dagster is configured for this stage" };
    const integrations = health().integrations.map((i) => (i.name === "dagster" ? off : i));
    const capabilities = access("prod").capabilities.map((c) => (c.name === "dagster" ? off : c));
    const fetch = api(() => ({ body: health({ pipelines: [], integrations }) }), undefined, () => ({ body: caps(access("prod", { capabilities })) }));
    open();
    expect(await screen.findByRole("heading", { name: "Healthy PROD is healthy" })).toBeInTheDocument();
    expect(screen.getByText(/no Dagster on this stage/)).toBeInTheDocument();
    expect(attentionRow("Pipeline health is not available")).toHaveTextContent("no Dagster is configured for this stage");
    expect(urls(fetch).some((u) => u.endsWith("/pipelines"))).toBe(false);
  });

  it("shows service probes the capabilities call not configured as Disabled, whatever /health lists", async () => {
    const capabilities = access("prod").capabilities.map((c) => (c.name === "services" ? { ...c, status: "disabled" as const, reason: "no service probes are configured" } : c));
    api(() => ({ body: health() }), undefined, () => ({ body: caps(access("prod", { capabilities })) }));
    open();
    await screen.findByRole("heading", { name: /PROD/ });
    expect(serviceRow("Service probes")).toHaveTextContent("Disabled");
    expect(serviceRow("Service probes")).toHaveTextContent("no service probes are configured");
    expect(within(screen.getByRole("region", { name: "Service health" })).queryByText("Trino")).toBeNull();
  });

  it.each([
    ["a 503", { status: 503, body: {} }, "The monitoring API failed (503)"],
    ["a malformed answer", { body: { stages: [{ stage: "prod", operations: "all" }] } }, "The monitoring API failed (500)"],
    ["a capability with no status", { body: { stages: [{ stage: "prod", operations: [], capabilities: [{ name: "dagster", reason: "x" }] }] } }, "The monitoring API failed (500)"],
  ] as const)("reads unknown, never green, on %s, and Retry reads the capabilities again", async (_, reply, words) => {
    let bad = true;
    const fetch = api(() => ({ body: health() }), undefined, () => (bad ? reply : { body: caps() }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown Monitoring status unknown" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(words);
    expect(healthCalls(fetch)).toEqual([]);
    bad = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByRole("heading", { name: "Healthy PROD is healthy" })).toBeInTheDocument();
  });
});

describe("services by service", () => {
  it("groups probe rows by service, reads each group's worst row, and names them as the API does", async () => {
    api(() => ({
      body: health({
        services: [
          svc("dagster.read-api", "unknown", { display_name: "Dagster API", reason: "the API did not answer" }),
          svc("dagster.workloads", "healthy", { display_name: "Dagster workloads", reason: "pods ready" }),
          svc("trino.readiness", "healthy"),
        ],
      }),
    }));
    open();
    await screen.findByRole("heading", { name: /PROD/ });
    const names = () => within(screen.getByRole("region", { name: "Service health" })).getAllByRole("row").slice(1).map((r) => r.querySelector("th")?.textContent);
    // A service that is not healthy opens the panel on its own, listing only what is not healthy; the toggle lists all.
    expect(names()).toEqual(["Dagster"]);
    await userEvent.click(screen.getByRole("button", { name: "Show all 2 services" }));
    expect(names()).toEqual(["Dagster", "Trino", "Resource metrics"]);
    await userEvent.click(screen.getByRole("button", { name: "Show only problems" }));
    expect(names()).toEqual(["Dagster"]);
    expect(within(serviceRow("Dagster")).getAllByText("Unknown")[0]).toHaveClass("mon-badge");
    expect(serviceRow("Dagster")).toHaveTextContent("Dagster API · Unknown");
    expect(serviceRow("Dagster")).toHaveTextContent("Dagster workloads · Healthy");
    expect(screen.queryByText(/dagster\.read-api/)).toBeNull(); // the machine key is never shown
    expect(screen.getByText(/1 of 2 services ready/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Services summary" })).getByText("Unknown")).toBeInTheDocument();
  });

  it("shows the log archive's last durable write and the last quality publication from last_success_at", async () => {
    const at = new Date(Date.now() - 180_000).toISOString();
    api(() => ({ body: health({ services: [svc("log-archive.newest-object", "healthy", { last_success_at: at }), svc("quality-sync.publication", "healthy", { last_success_at: at })] }) }));
    open();
    await screen.findByRole("heading", { name: /PROD/ });
    // Each "ago" keeps its absolute time on hover and for a screen reader.
    expect(svcLine()).toHaveTextContent(
      /^2 of 2 healthy · log archive last durable write 3 min ago \(at [^)]+ UTC\) · quality sync last publication 3 min ago \(at [^)]+ UTC\) · resource metrics disabled$/,
    );
    expect(svcLine().querySelector("time")).toHaveAttribute("dateTime", at);
  });

  it("reads a null last_success_at as unknown, never as a time", async () => {
    api(() => ({ body: health({ services: [svc("log-archive.newest-object", "unknown", { last_success_at: null }), svc("trino.readiness", "healthy")] }) }));
    open();
    await screen.findByRole("heading", { name: /PROD/ });
    expect(svcLine()).toHaveTextContent(/^1 of 2 healthy · log archive last durable write unknown/);
    expect(screen.queryByText(/last durable write \d/)).toBeNull();
  });

  it.each([
    ["no service key", (s: Record<string, unknown>) => { delete s.service; }],
    ["no display name", (s: Record<string, unknown>) => { delete s.display_name; }],
    ["a numeric last success", (s: Record<string, unknown>) => { s.last_success_at = 12; }],
    ["an unknown state", (s: Record<string, unknown>) => { s.state = "green"; }],
  ])("does not take a service row with %s as an answer", async (_, spoil) => {
    const body = health();
    spoil(body.services[0] as unknown as Record<string, unknown>);
    api(() => ({ body }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(screen.queryByText("Healthy")).toBeNull();
  });
});

describe("data quality", () => {
  const card = () => screen.getByRole("region", { name: "Data quality summary" });
  const qualityRow = (name: string) => within(screen.getByRole("region", { name: "Quality by pipeline" })).getByRole("row", { name: new RegExp(name) });
  const urls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([u]) => u as string);

  it("shows each pipeline's counts and their totals, and a null count as unknown, never as zeros", async () => {
    const body = qualityOf({
      totals: counts({ passed: 10, warn: 1, error: 2, blocking: 1 }),
      pipelines: [
        pq("sales_orders", { state: "critical", counts: counts({ passed: 10, warn: 1, error: 2, blocking: 1 }), reason: "a blocking quality check failed" }),
        pq("crm_accounts", { state: "unknown", counts: null, complete: null, run_id: null, reason: "no finished run of the pipeline has quality evidence yet" }),
        pq("web_events", { counts: counts({ passed: 0 }), reason: "the manifest has no result" }),
      ],
    });
    api(() => ({ body: health() }), undefined, undefined, { quality: () => ({ body }) });
    open();
    expect(await within(await screen.findByRole("region", { name: "Data quality summary" })).findByText("Critical")).toBeInTheDocument();
    expect(card()).toHaveTextContent("2 error 1 warn · 10 passed");
    expect(card()).toHaveTextContent("1 blocking · counts from 2 of 3 pipelines");
    expect(qualityRow("sales_orders")).toHaveTextContent("2 error (1 blocking) · 1 warn · 10 passed");
    expect(qualityRow("crm_accounts")).toHaveTextContent("Counts unknown");
    expect(qualityRow("crm_accounts")).not.toHaveTextContent(/\d/);
    expect(qualityRow("crm_accounts")).toHaveTextContent("Unknown");
    expect(qualityRow("web_events")).toHaveTextContent("0 error · 0 warn · 0 passed"); // zero is a count, unlike null
  });

  it("shows no totals as unknown, not as zero checks", async () => {
    const body = qualityOf({ totals: null, pipelines: [pq("sales_orders", { state: "unknown", counts: null, reason: "the manifest could not be read" })] });
    api(() => ({ body: health() }), undefined, undefined, { quality: () => ({ body }) });
    open();
    await screen.findByRole("region", { name: "Quality by pipeline" });
    expect(card()).toHaveTextContent("—");
    expect(card()).toHaveTextContent("No pipeline has quality counts yet");
    expect(card()).not.toHaveTextContent(/\d/);
    expect(within(card()).getByText("Unknown")).toBeInTheDocument();
  });

  it("marks an incomplete manifest as incomplete and keeps its counts", async () => {
    const body = qualityOf({ pipelines: [pq("sales_orders", { state: "unknown", complete: false, counts: counts({ passed: 3 }), reason: "dbt results are not in yet" })] });
    api(() => ({ body: health() }), undefined, undefined, { quality: () => ({ body }) });
    open();
    expect(await screen.findByText("Incomplete")).toBeInTheDocument();
    expect(qualityRow("sales_orders")).toHaveTextContent("3 passed");
    expect(qualityRow("sales_orders")).toHaveTextContent("not every result is in yet · dbt results are not in yet");
    expect(qualityRow("sales_orders")).toHaveTextContent("Unknown");
  });

  it.each([
    ["Dagster could not be read", "dagster", "unavailable", "Unknown"],
    ["no quality manifest reader is configured for this stage", "quality", "not_provided", "Disabled"],
  ] as const)("reads the answer's own integration '%s' as a gap", async (reason, name, status, word) => {
    const integrations = [{ name: "dagster", status: "available", reason: "read" }, { name: "quality", status: "available", reason: "read" }]
      .map((i) => (i.name === name ? { ...i, status, reason } : i)) as StageQualityHealth["integrations"];
    api(() => ({ body: health() }), undefined, undefined, { quality: () => ({ body: qualityOf({ integrations, totals: null, pipelines: [] }) }) });
    open();
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(within(card()).getByText(word)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Quality by pipeline" })).toBeNull();
  });

  it("does not read quality for a role without get_stage_quality_health, nor on a stage with no quality source", async () => {
    const fetch = api(() => ({ body: health() }), undefined, () => ({ body: caps(access("prod", { operations: ["get_stage_health", "list_pipeline_health"] })) }));
    open();
    expect(await screen.findByText("Your role may not read quality counts on stage PROD.")).toBeInTheDocument();
    expect(within(card()).getByText("Disabled")).toBeInTheDocument();
    expect(urls(fetch).some((u) => u.endsWith("/health/quality"))).toBe(false);
  });

  it("does not read quality when the capabilities say the source is not provided", async () => {
    const capabilities = access("prod").capabilities.map((c) => (c.name === "quality" ? { ...c, status: "not_provided" as const, reason: "no quality manifest reader is configured for this stage" } : c));
    const fetch = api(() => ({ body: health() }), undefined, () => ({ body: caps(access("prod", { capabilities })) }));
    open();
    expect(await screen.findByText("no quality manifest reader is configured for this stage")).toBeInTheDocument();
    expect(urls(fetch).some((u) => u.endsWith("/health/quality"))).toBe(false);
  });

  it("shows a 403 in the API's words as Disabled, with no retry", async () => {
    api(() => ({ body: health() }), undefined, undefined, { quality: () => ({ status: 403, body: { detail: "role analyst may not call get_stage_quality_health" } }) });
    open();
    expect(await screen.findByText("role analyst may not call get_stage_quality_health")).toBeInTheDocument();
    expect(within(card()).getByText("Disabled")).toBeInTheDocument();
    expect(within(card()).queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it.each([
    ["negative counts", (b: StageQualityHealth) => { b.pipelines[0].counts!.passed = -1; }],
    ["counts without blocking", (b: StageQualityHealth) => { delete (b.pipelines[0].counts as Partial<QualityCounts>).blocking; }],
    ["a text complete", (b: StageQualityHealth) => { (b.pipelines[0] as unknown as Record<string, unknown>).complete = "yes"; }],
    ["no totals field", (b: StageQualityHealth) => { delete (b as Partial<StageQualityHealth>).totals; }],
  ])("reads a quality answer with %s as unknown, with Retry", async (_, spoil) => {
    const body = qualityOf();
    spoil(body);
    api(() => ({ body: health() }), undefined, undefined, { quality: () => ({ body }) });
    open();
    expect(await within(await screen.findByRole("region", { name: "Data quality summary" })).findByText("Unknown")).toBeInTheDocument();
    expect(card()).toHaveTextContent("The monitoring API failed (500)");
    expect(within(card()).getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Quality by pipeline" })).toBeNull();
  });
});

describe("alert incidents", () => {
  const card = () => screen.getByRole("region", { name: "Alerts summary" });
  const table = () => screen.getByRole("region", { name: "What needs attention" });
  const urls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([u]) => u as string);
  const incident = (id: string, delivery: AlertIncident["delivery"], over: Partial<AlertIncident> = {}): AlertIncident => ({
    id, condition: "failed_run", severity: "critical", job: null, domain: "sales", product: "orders", table: null, component: null,
    opened_at: new Date(Date.now() - 3_600_000).toISOString(), last_seen_at: new Date(Date.now() - 120_000).toISOString(),
    summary: `incident ${id}`, run_ids: [], delivery, ...over,
  });
  const show = (body: StageAlertIncidents | Reply) =>
    api(() => ({ body: health() }), undefined, undefined, { alerts: () => ("state" in (body as object) ? { body } : body as Reply) });

  it("links an incident's runs to their Failed-run screen and names its job", async () => {
    show(incidentsOf({ incidents: [incident("a", { status: "delivered", event: "opened", attempts: 1, receivers: 1, delivered: 1 }, {
      run_ids: ["c94cbcb0-5d1e-4a8e"], job: "sales_orders", product: null, domain: null,
    })] }));
    open();
    const row = await within(await screen.findByRole("region", { name: "What needs attention" })).findByRole("row", { name: /incident a/ });
    expect(within(row).getByRole("link", { name: "Open run c94cbcb0" })).toHaveAttribute("href", "/monitoring/prod/runs/c94cbcb0-5d1e-4a8e");
    expect(within(row).getByRole("link", { name: "Runs of sales_orders" })).toHaveAttribute("href", "/monitoring/prod/runs?job=sales_orders");
  });

  it.each([
    ["pending", { status: "pending", event: "opened", attempts: 1, receivers: 2, delivered: 0 }, "Pending", "opened notification · 0 of 2 receivers · 1 attempt"],
    ["delivered", { status: "delivered", event: "escalated", attempts: 2, receivers: 2, delivered: 2 }, "Delivered", "escalated notification · 2 of 2 receivers · 2 attempts"],
    ["undeliverable", { status: "undeliverable", event: "opened", attempts: 10, receivers: 1, delivered: 0 }, "Undeliverable", "opened notification · 0 of 1 receiver · 10 attempts"],
    ["unrouted", { status: "unrouted", event: "opened", attempts: 0, receivers: 0, delivered: 0 }, "Unrouted", "opened notification · no receiver is routed for it"],
    ["unknown", { status: "unknown", event: null, attempts: null, receivers: null, delivered: null }, "Unknown", "notification · the evaluator kept no outcome"],
  ] as const)("shows a %s delivery in words", async (_, delivery, word, line) => {
    show(incidentsOf({ incidents: [incident("i-1", delivery)] }));
    open();
    const row = await within(await screen.findByRole("region", { name: "What needs attention" })).findByRole("row", { name: /incident i-1/ });
    expect(row.querySelector(".mon-delivery")).toHaveTextContent(new RegExp(`^${word}$`));
    expect(row).toHaveTextContent(line);
    expect(row).toHaveTextContent("Critical");
    expect(row).toHaveTextContent("sales · orders");
    expect(within(card()).getByText("Critical")).toBeInTheDocument();
    expect(card()).toHaveTextContent("1 open incident");
  });

  it("says no open incidents only for a current evaluation, and offers no acknowledgement", async () => {
    show(incidentsOf());
    open();
    expect(await within(await screen.findByRole("region", { name: "What needs attention" })).findByText("Nothing needs attention: no pipeline signal is warning or critical and no alert incident is open.")).toBeInTheDocument();
    expect(within(card()).getByText("Healthy")).toBeInTheDocument();
    expect(card()).toHaveTextContent(/0 open incidents.*Evaluated \d+ s ago/);
    expect(screen.queryByRole("button", { name: /acknowledge/i })).toBeNull();
  });

  it("shows a stale evaluation as stale: its incidents stay, flagged", async () => {
    const state = { status: "available" as const, reason: "the alert evaluator has not run since 2026-11-19T09:00:00+00:00", evaluated_at: "2026-11-19T09:00:00Z", stale: true };
    show(incidentsOf({ state, incidents: [incident("i-1", { status: "delivered", event: "opened", attempts: 1, receivers: 1, delivered: 1 }, { severity: "warning" })] }));
    open();
    expect(await screen.findByRole("note")).toHaveTextContent("Stale: the alert evaluator has not run since 2026-11-19T09:00:00+00:00. Its incidents and notifications may be out of date.");
    expect(within(table()).getByRole("row", { name: /incident i-1/ })).toBeInTheDocument();
    expect(within(card()).getByText("Warning")).toBeInTheDocument(); // as the rollup ranks it: a warning outranks unknown
    expect(card()).toHaveTextContent("Stale: the alert evaluator has not run since");
    expect(card()).not.toHaveTextContent("Evaluated");
  });

  it("does not take a stale empty list for no incidents", async () => {
    show(incidentsOf({ state: { status: "available", reason: "the alert evaluator has not run since 09:00", evaluated_at: null, stale: true } }));
    open();
    expect(await screen.findByText(/none can be ruled out/)).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs attention: no pipeline signal is warning or critical and no alert incident is open.")).toBeNull();
    expect(within(card()).getByText("Unknown")).toBeInTheDocument();
  });

  it.each([
    ["unavailable", "the alert evaluator has not written a state yet", "Unknown", "Incidents cannot be read"],
    ["not_provided", "no alert evaluator, or no key to read its state, is configured", "Disabled", "Alert incidents are not available"],
  ] as const)("shows an %s state with incidents null as such, never as none", async (status, reason, word, title) => {
    show(incidentsOf({ state: { status, reason, evaluated_at: null, stale: null }, incidents: null }));
    open();
    const row = await within(await screen.findByRole("region", { name: "What needs attention" })).findByRole("row", { name: new RegExp(title) });
    expect(row).toHaveTextContent(reason);
    expect(row).toHaveTextContent(word);
    expect(card()).toHaveTextContent("—");
    expect(screen.queryByText("Nothing needs attention: no pipeline signal is warning or critical and no alert incident is open.")).toBeNull();
  });

  it("reads incidents null as unknown even when the state says available", async () => {
    show(incidentsOf({ incidents: null }));
    open();
    expect(await within(await screen.findByRole("region", { name: "What needs attention" })).findByRole("row", { name: /Incidents cannot be read/ })).toHaveTextContent("Unknown");
  });

  it("does not read incidents for a role without list_alert_incidents", async () => {
    const fetch = api(() => ({ body: health() }), undefined, () => ({ body: caps(access("prod", { operations: ["get_stage_health"] })) }));
    open();
    expect(await within(await screen.findByRole("region", { name: "Alerts summary" })).findByText("Your role may not read alert incidents on stage PROD.")).toBeInTheDocument();
    expect(within(card()).getByText("Disabled")).toBeInTheDocument();
    expect(within(table()).getByRole("row", { name: /Alert incidents are not available/ })).toHaveTextContent("Your role may not read alert incidents");
    expect(urls(fetch).some((u) => u.endsWith("/alerts/incidents"))).toBe(false);
  });

  it("shows a 403 in the API's words with no retry, and a 503 as unknown with Retry", async () => {
    let reply: Reply = { status: 403, body: { detail: "role analyst may not call list_alert_incidents" } };
    api(() => ({ body: health() }), undefined, undefined, { alerts: () => reply });
    open();
    const refused = await within(await screen.findByRole("region", { name: "What needs attention" })).findByRole("row", { name: /Alert incidents are not available/ });
    expect(refused).toHaveTextContent("role analyst may not call list_alert_incidents");
    expect(within(table()).queryByRole("button", { name: /Retry/ })).toBeNull();
    cleanup();
    reply = { status: 503, body: {} };
    open();
    const gap = await within(await screen.findByRole("region", { name: "What needs attention" })).findByRole("row", { name: /Incidents cannot be read/ });
    expect(gap).toHaveTextContent("The monitoring API failed (503)");
    reply = { body: incidentsOf() };
    await userEvent.click(within(gap).getByRole("button", { name: /Retry/ }));
    expect(await within(table()).findByText("Nothing needs attention: no pipeline signal is warning or critical and no alert incident is open.")).toBeInTheDocument();
  });

  it.each([
    ["a delivery status the API does not define", (b: StageAlertIncidents) => { (b.incidents![0].delivery as { status: string }).status = "sent"; }],
    ["a severity of info", (b: StageAlertIncidents) => { (b.incidents![0] as { severity: string }).severity = "info"; }],
    ["no state", (b: StageAlertIncidents) => { delete (b as Partial<StageAlertIncidents>).state; }],
    ["a text stale flag", (b: StageAlertIncidents) => { (b.state as { stale: unknown }).stale = "no"; }],
    ["a runbook that is not text", (b: StageAlertIncidents) => { (b.incidents![0] as { runbook: unknown }).runbook = 42; }],
  ])("reads an incidents answer with %s as unknown", async (_, spoil) => {
    const body = incidentsOf({ incidents: [incident("i-1", { status: "delivered", event: "opened", attempts: 1, receivers: 1, delivered: 1 })] });
    spoil(body);
    show(body);
    open();
    expect(await within(await screen.findByRole("region", { name: "What needs attention" })).findByRole("row", { name: /Incidents cannot be read/ })).toHaveTextContent("Unknown");
    expect(within(card()).getByText("Unknown")).toBeInTheDocument();
  });
});

describe("one list to act on", () => {
  const RUN = "c94cbcb0-5d1e-4a8e";
  const OBSERVED = new Date().toISOString();
  const failing = () => pipes({
    pipelines: [
      pipeline("sales_orders", {
        state: "critical", latest_run: run("sales_orders", "FAILURE", RUN), failed_runs: 2,
        // One observed_at for all three: rows of a severity sort newest first, and per-call clocks can differ by 1 ms.
        signals: [
          sig("execution", "critical", { reason: "latest run failed", run: RUN, observed_at: OBSERVED }),
          sig("freshness", "critical", { reason: "data is stale", observed_at: OBSERVED }),
          sig("quality", "critical", { reason: "a blocking quality check failed", run: RUN, observed_at: OBSERVED }),
        ],
      }),
      pipeline("web_events", { failed_runs: 0 }),
    ],
  });
  const delivered = { status: "delivered", event: "opened", attempts: 1, receivers: 2, delivered: 2 } as const;
  // One instant for every incident: per-call clocks differ by a millisecond on a slow runner, and the list sorts newest first.
  const seen = Date.now();
  const inc = (id: string, condition: string, over: Partial<AlertIncident> = {}): AlertIncident => ({
    id, condition, severity: "critical", job: "sales_orders", domain: "sales", product: "orders", table: null, component: null,
    opened_at: new Date(seen - 600_000).toISOString(), last_seen_at: new Date(seen).toISOString(), summary: `summary of ${id}`,
    run_ids: [RUN], delivery: delivered, ...over,
  });
  const list = () => screen.getByRole("region", { name: "What needs attention" });
  const names = () => within(list()).getAllByRole("row").slice(1).map((r) => r.querySelector(".mon-what")?.textContent);

  it("joins an incident to the signal it is about, so neither is shown twice, and keeps an incident about nothing listed", async () => {
    const incidents = [
      inc("failed", "run_failed"),
      inc("quality", "quality", { delivery: { status: "undeliverable", event: "opened", attempts: 10, receivers: 1, delivered: 0 } }),
      inc("spool", "service_degraded", { job: null, domain: null, product: null, component: "log-archive.spool-age", severity: "warning", summary: "the spool is not draining", run_ids: [] }),
    ];
    api(() => ({ body: health({ state: "critical" }) }), () => ({ body: failing() }), undefined, { alerts: () => ({ body: incidentsOf({ incidents }) }) });
    open();
    await screen.findByRole("region", { name: "Pipeline health" });
    // 3 signals + 1 incident about no signal: 4 rows, not 3 + 3.
    expect(names()).toEqual(["Run failed", "Data is late", "Quality check failed", "the spool is not draining"]);
    expect(new Set(names()).size).toBe(names().length);
    expect(screen.queryByRole("region", { name: "Open alert incidents" })).toBeNull();
    expect(screen.queryByText("summary of failed")).toBeNull(); // the joined incident adds its notification, not a second row
    expect(within(list()).getAllByRole("link", { name: "Open run c94cbcb0" })).toHaveLength(2); // once per row that names it
    const failed = attentionRow("Run failed");
    expect(failed.querySelector(".mon-delivery")).toHaveTextContent(/^Delivered$/);
    expect(failed).toHaveTextContent("opened notification · 2 of 2 receivers · 1 attempt");
    expect(attentionRow("Quality check failed").querySelector(".mon-delivery")).toHaveTextContent(/^Undeliverable$/);
    // A signal no incident is about says no notification went out, in words.
    expect(attentionRow("Data is late").querySelector(".mon-delivery")).toHaveTextContent(/^None$/);
    expect(attentionRow("Data is late")).toHaveTextContent("no incident is open for it, so none was sent");
    const spool = attentionRow("the spool is not draining");
    expect(spool).toHaveTextContent("log-archive.spool-age");
    expect(spool).toHaveTextContent("Warning");
    expect(spool).toHaveTextContent(/last seen \d+ s ago/);
    expect(within(screen.getByRole("region", { name: "Needs attention" })).getByText("4")).toBeInTheDocument();
  });

  describe("each incident's runbook section (#1344)", () => {
    const BOOK = "https://docs.example/runbooks/alerting";
    const load = (incidents: AlertIncident[]) => {
      api(() => ({ body: health({ state: "critical" }) }), () => ({ body: failing() }), undefined, { alerts: () => ({ body: incidentsOf({ incidents }) }) });
      open();
      return screen.findByRole("region", { name: "Pipeline health" });
    };
    const spool = (over: Partial<AlertIncident> = {}) =>
      inc("spool", "service_degraded", { job: null, domain: null, product: null, component: "log-archive.spool-age", severity: "warning", summary: "the spool is not draining", run_ids: [], ...over });

    it("links it on a row an incident joined and on a standalone one, in a new tab, saying which runbook", async () => {
      await load([inc("failed", "run_failed", { runbook: `${BOOK}#run_failed` }), spool({ runbook: `${BOOK}#service_degraded` })]);
      const joined = within(attentionRow("Run failed")).getByRole("link", { name: "Runbook for run_failed (opens in a new tab)" });
      expect(joined).toHaveAttribute("href", `${BOOK}#run_failed`);
      expect(joined).toHaveAttribute("target", "_blank");
      expect(joined).toHaveAttribute("rel", "noopener noreferrer");
      expect(joined).toHaveTextContent(/^Runbook ↗$/);
      const alone = within(attentionRow("the spool is not draining")).getByRole("link", { name: "Runbook for service_degraded (opens in a new tab)" });
      expect(alone).toHaveAttribute("href", `${BOOK}#service_degraded`);
      expect(alone).toHaveAttribute("rel", "noopener noreferrer");
      // A signal no incident is about has no notification, so no runbook.
      expect(within(attentionRow("Data is late")).queryByRole("link", { name: /Runbook/ })).toBeNull();
    });

    it.each([
      ["null (no runbook page)", null],
      ["absent (an API before #1344)", undefined],
      ["not a web address", "javascript:alert(1)"],
      ["a relative path", "/runbooks/alerting#run_failed"],
    ])("shows no link and no placeholder when it is %s", async (_, runbook) => {
      const over = runbook === undefined ? {} : { runbook };
      await load([inc("failed", "run_failed", over), spool(over)]);
      expect(within(list()).queryByRole("link", { name: /Runbook/ })).toBeNull();
      expect(list()).not.toHaveTextContent(/Runbook/);
      expect(attentionRow("Run failed").querySelector(".mon-delivery")).toHaveTextContent(/^Delivered$/);
      expect(attentionRow("the spool is not draining")).toHaveTextContent("opened notification · 2 of 2 receivers · 1 attempt");
    });
  });

  it("says a notification is unknown, not none, when the incidents are stale or cannot be read", async () => {
    const state = { status: "available" as const, reason: "the alert evaluator has not run since 09:00", evaluated_at: null, stale: true };
    api(() => ({ body: health({ state: "critical" }) }), () => ({ body: failing() }), undefined, { alerts: () => ({ body: incidentsOf({ state, incidents: [] }) }) });
    open();
    await screen.findByRole("region", { name: "Pipeline health" });
    expect(attentionRow("Data is late").querySelector(".mon-delivery")).toHaveTextContent(/^Unknown$/);
    expect(attentionRow("Data is late")).toHaveTextContent("the alert evaluation is stale");
    cleanup();
    api(() => ({ body: health({ state: "critical" }) }), () => ({ body: failing() }), undefined, { alerts: () => ({ status: 503, body: {} }) });
    open();
    await screen.findByRole("region", { name: "Pipeline health" });
    expect(attentionRow("Data is late").querySelector(".mon-delivery")).toHaveTextContent(/^Unknown$/);
    expect(attentionRow("Incidents cannot be read")).toHaveTextContent("The monitoring API failed (503)");
  });

  it("links pipeline names to their runs and a failed count to those failed runs in the window shown", async () => {
    api(() => ({ body: health({ state: "critical" }) }), () => ({ body: failing() }));
    open();
    await screen.findByRole("region", { name: "Pipeline health" });
    expect(within(pipelineRow("sales_orders")).getByRole("link", { name: "Runs of sales_orders" })).toHaveAttribute("href", "/monitoring/prod/runs?job=sales_orders");
    expect(within(attentionRow("Run failed")).getByRole("link", { name: "Runs of sales_orders" })).toHaveAttribute("href", "/monitoring/prod/runs?job=sales_orders");
    const failed = within(pipelineRow("sales_orders")).getByRole("link", { name: /^2 failed in last 24h/ });
    expect(failed).toHaveAttribute("href", "/monitoring/prod/runs?job=sales_orders&status=failed&window=24h");
    expect(within(pipelineRow("sales_orders")).getByRole("link", { name: "Open run c94cbcb0" })).toHaveAttribute("href", `/monitoring/prod/runs/${RUN}`);
    // Zero failed runs is a count, but there is nothing to open.
    expect(pipelineRow("web_events")).toHaveTextContent("0 failed in last 24h");
    expect(within(pipelineRow("web_events")).queryByRole("link", { name: /failed/ })).toBeNull();
  });

  it("keeps four summary cards, counts only, when the role may not read the stage health", async () => {
    api(() => ({ body: health() }), undefined, () => ({ body: caps(access("prod", { operations: ["list_pipeline_health", "list_alert_incidents"] })) }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Disabled PROD health is not available" })).toBeInTheDocument();
    const cards = ["Services summary", "Pipelines summary", "Data quality summary", "Alerts summary"].map((name) => screen.getByRole("region", { name }));
    expect(cards).toHaveLength(4);
    expect(cards[0]).toHaveTextContent("Your role may not read the stage health.");
  });

  it("keeps the services card to counts", async () => {
    api(() => ({ body: health({ services: [svc("trino.readiness", "warning"), svc("polaris.readiness", "healthy")] }) }));
    open();
    const card = await screen.findByRole("region", { name: "Services summary" });
    expect(card).toHaveTextContent("1 of 2 ready");
    expect(card).toHaveTextContent("1 warning · 1 healthy");
    expect(card).not.toHaveTextContent(/Trino|Polaris/);
  });
});

describe("status badges in rows", () => {
  it("give every row's accessible name its state in words", async () => {
    api(() => ({ body: health({ state: "warning", services: [svc("trino.readiness", "warning")] }) }));
    open();
    const region = await screen.findByRole("region", { name: "Service health" });
    expect(within(region).getByRole("row", { name: /^Trino Warning/ })).toBeInTheDocument();
    await showAllServices();
    expect(within(region).getByRole("row", { name: /^Resource metrics Disabled/ })).toBeInTheDocument();
    for (const dot of document.querySelectorAll(".mon-dot")) expect(dot).toHaveAttribute("aria-hidden", "true");
  });
});
