// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPipelinesHealth, type AlertIncident, type MonitoringStage, type PipelineHealth, type PipelinesHealth, type RunFailure,
  type StageAlertIncidents, type StageQualityHealth,
} from "../lib/health-api";
import { duration, MonitoringRun, runDay, runState } from "./MonitoringRun";

const RUN = "c94cbcb0-5d1e-4a8e-9f0b-2f6c1a7e3b21";
const DAGSTER = "http://dagster-prod.olf.localhost";
const soon = () => new Date(Date.now() + 60_000).toISOString();
const started = Math.round(Date.now() / 1000) - 600;
const runBody = { run_id: RUN, job_name: "sales_orders", status: "FAILURE", created_at: started - 5, started_at: started, ended_at: started + 114, tags: {} };
const failureOf = (over: Partial<RunFailure> = {}): RunFailure => ({
  run_id: RUN, job: "sales_orders", status: "FAILURE",
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
const qualityOf = (run_id: string | null = RUN): StageQualityHealth => ({
  stage: "prod", evaluated_at: new Date().toISOString(),
  integrations: [{ name: "dagster", status: "available", reason: "read" }, { name: "quality", status: "available", reason: "read" }],
  totals: null,
  pipelines: [{ job: "sales_orders", domain: "sales", product: "orders", run_id, observed_at: new Date().toISOString(), complete: true, state: "critical",
    counts: { passed: 14, warn: 1, error: 2, not_run: 0, unknown: 0, blocking: 1 }, reason: "a blocking quality check failed" }],
});
const incident = (over: Partial<AlertIncident> = {}): AlertIncident => ({
  id: "i1", condition: "failed_run", severity: "critical", job: "sales_orders", domain: "sales", product: "orders", table: null, component: null,
  opened_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), summary: "latest run failed", run_ids: [RUN],
  delivery: { status: "delivered", event: "opened", attempts: 1, receivers: 2, delivered: 2 }, ...over,
});
const incidentsOf = (incidents: AlertIncident[] | null = [incident(), incident({ id: "other", summary: "another job's incident", job: "crm", run_ids: [] })]): StageAlertIncidents => ({
  stage: "prod", state: { status: "available", reason: "read", evaluated_at: new Date().toISOString(), stale: false }, incidents,
});
const OPS = ["get_stage_health", "list_pipeline_health", "get_stage_quality_health", "list_logs", "list_alert_incidents"];
const access = (over: Partial<MonitoringStage> = {}): MonitoringStage => ({
  stage: "prod", operations: OPS,
  capabilities: ["dagster", "services", "quality", "logs", "alerts"].map((name) => ({ name: name as "dagster", status: "available", reason: `${name} is configured` })),
  ...over,
});
const logsOf = (n = 3) => ({
  lines: Array.from({ length: n }, (_, i) => ({ archived_at: new Date().toISOString(), namespace: "olf-prod", pod: "run-pod", container: "floe", line: `line ${i}`, error: null })),
  truncated: false,
});

type Reply = { status?: number; body?: unknown } | "down";
type Routes = Partial<Record<"caps" | "failure" | "run" | "pipes" | "quality" | "alerts" | "logs", (url: URL) => Reply>>;
/** Every route answers as for a platform admin on PROD's failed run, unless `routes` says otherwise. */
function api(routes: Routes = {}) {
  const defaults: Required<Routes> = {
    caps: () => ({ body: { stages: [access()] } }),
    failure: () => ({ body: failureOf() }),
    run: () => ({ body: runBody }),
    pipes: () => ({ body: pipesOf() }),
    quality: () => ({ body: qualityOf() }),
    alerts: () => ({ body: incidentsOf() }),
    logs: () => ({ body: logsOf() }),
  };
  const all = { ...defaults, ...routes };
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input, "http://portal.test");
    const p = url.pathname;
    const key: keyof Routes = p === "/api/v1/monitoring-capabilities" ? "caps" : p.endsWith("/failure") ? "failure" : /\/runs\/[^/]+$/.test(p) ? "run"
      : p.endsWith("/health/pipelines") ? "pipes" : p.endsWith("/health/quality") ? "quality" : p.endsWith("/alerts/incidents") ? "alerts" : "logs";
    const r = all[key](url);
    if (r === "down") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const urls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([u]) => new URL(u as string, "http://portal.test"));
const open = (dagster: string | null = DAGSTER, runId = RUN) =>
  render(<MemoryRouter><MonitoringRun stage="prod" runId={runId} dagster={dagster ?? undefined} /></MemoryRouter>);
const card = (name: string) => screen.getByRole("region", { name });

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("failed run", () => {
  it("names the scope, the failing step, its redacted first line and the rows, and links to the run in Dagster", async () => {
    api();
    open();
    expect(await screen.findByRole("heading", { level: 1, name: "sales · orders" })).toBeInTheDocument();
    expect(await screen.findByText("SchemaMismatchError")).toBeInTheDocument();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs).toHaveTextContent("Monitoring/PROD/sales · orders/Run c94cbcb0");
    expect(within(crumbs).getByRole("link", { name: "PROD" })).toHaveAttribute("href", "/monitoring?stage=prod");
    expect(within(crumbs).getByText("Run c94cbcb0")).toHaveAttribute("aria-current", "page");
    const chips = screen.getByRole("list", { name: "Run" });
    expect(chips).toHaveTextContent("Critical");
    expect(chips).toHaveTextContent("Stage PROD");
    expect(chips).toHaveTextContent("floe_silver_orders");
    expect(document.querySelector(".f-sub")).toHaveTextContent(/^Pipeline sales_orders · started .* · failed after 1 min 54 s$/);
    expect(card("What failed")).toHaveTextContent("Step floe_silver_orders failed");
    expect(card("What failed")).toHaveTextContent("First line only");
    expect(card("Data quality")).toHaveTextContent("412 rows rejected · 19,000 accepted");
    expect(card("Data quality")).toHaveTextContent("2 error · 1 warn · 14 passed · 1 blocking");
    for (const link of screen.getAllByRole("link", { name: /Open in Dagster/ })) {
      expect(link).toHaveAttribute("href", `${DAGSTER}/runs/${RUN}`);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("offers no Re-run: run control stays in Dagster in v0.7", async () => {
    api();
    open();
    await screen.findByText("SchemaMismatchError");
    expect(screen.queryByRole("button", { name: /re-?run|retry|launch/i })).toBeNull();
    expect(card("Next step")).toHaveTextContent("re-run sales_orders from Dagster");
  });

  it("lists only the open incidents of this run or its pipeline, with their delivery", async () => {
    api();
    open();
    const incidents = await screen.findByRole("region", { name: "Open incidents" });
    await within(incidents).findByText("latest run failed");
    expect(incidents).not.toHaveTextContent("another job's incident");
    expect(incidents).toHaveTextContent("Delivered opened notification · 2 of 2 receivers · 1 attempt");
  });

  it("reads the run's archived lines for its UTC day, and asks again when the level changes", async () => {
    const fetch = api();
    open();
    const lines = await screen.findByRole("region", { name: "Run log lines" });
    expect(within(lines).getAllByRole("row")).toHaveLength(4);
    const read = urls(fetch).find((u) => u.pathname === "/api/v1/stages/prod/logs")!;
    expect(read.searchParams.get("run_id")).toBe(RUN);
    expect(read.searchParams.get("date")).toBe(new Date(started * 1000).toISOString().slice(0, 10));
    expect(read.searchParams.get("limit")).toBe("200");
    expect(read.searchParams.get("severity")).toBeNull();
    await userEvent.selectOptions(within(card("Logs")).getByRole("combobox", { name: "Level" }), "error");
    await vi.waitFor(() => expect(urls(fetch).filter((u) => u.pathname.endsWith("/logs")).at(-1)!.searchParams.get("severity")).toBe("error"));
  });

  it("says the archive holds no line rather than showing an empty table", async () => {
    api({ logs: () => ({ body: logsOf(0) }) });
    open();
    expect(await within(await screen.findByRole("region", { name: "Logs" })).findByText(/The archive holds no line of this run/)).toBeInTheDocument();
  });

  it("makes no logs read when the role may not read the archive, and says why", async () => {
    const fetch = api({ caps: () => ({ body: { stages: [access({ operations: OPS.filter((o) => o !== "list_logs") })] } }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(card("Logs")).toHaveTextContent("Disabled");
    expect(card("Logs")).toHaveTextContent("Your role may not read logs on stage PROD.");
    expect(urls(fetch).filter((u) => u.pathname.endsWith("/logs"))).toEqual([]);
  });

  it("shows a log archive that is configured but unreadable as unknown, in the API's words", async () => {
    const caps = access();
    caps.capabilities = caps.capabilities.map((c) => (c.name === "logs" ? { ...c, status: "unavailable", reason: "the platform API holds no object-store key for the log archive" } : c));
    api({ caps: () => ({ body: { stages: [caps] } }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(card("Logs")).toHaveTextContent("Unknown");
    expect(card("Logs")).toHaveTextContent("the platform API holds no object-store key for the log archive");
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

  it("does not show another run's quality counts as this run's", async () => {
    api({ quality: () => ({ body: qualityOf("7a1f02de-0000") }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(card("Data quality")).toHaveTextContent("The stage's quality counts are for run 7a1f02de of this pipeline, not this one.");
    expect(within(card("Data quality")).getByRole("link", { name: "7a1f02de" })).toHaveAttribute("href", "/monitoring/prod/runs/7a1f02de-0000");
    expect(card("Data quality")).not.toHaveTextContent("14 passed");
  });
});

describe("missing fields", () => {
  it("falls back to the job and says why the domain and product are not known", async () => {
    api({ pipes: () => ({ body: pipesOf([pipelineOf({ domain: null, product: null })]) }), alerts: () => ({ body: incidentsOf([]) }) });
    open();
    expect(await screen.findByRole("heading", { level: 1, name: "sales_orders" })).toBeInTheDocument();
    expect(screen.getByText(/Not known: the job declares no data product/)).toBeInTheDocument();
  });

  it("takes the scope from an incident of the job when the pipelines read is refused", async () => {
    api({ pipes: () => ({ status: 403, body: { detail: "role may not call list_pipeline_health" } }) });
    open();
    expect(await screen.findByRole("heading", { level: 1, name: "sales · orders" })).toBeInTheDocument();
  });

  it("says the times are not known when the run read fails, and does not guess the log day", async () => {
    const fetch = api({ run: () => ({ status: 503 }) });
    open();
    await screen.findByText("SchemaMismatchError");
    expect(screen.getByText(/Not known: The monitoring API failed \(503\)/)).toBeInTheDocument();
    expect(card("Logs")).toHaveTextContent("its day in the log archive is not known");
    expect(urls(fetch).filter((u) => u.pathname.endsWith("/logs"))).toEqual([]);
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
    expect(card("Data quality")).toHaveTextContent("Quality counts cannot be read");
  });

  it("reaches every link and control with the keyboard", async () => {
    api();
    open();
    await screen.findByRole("region", { name: "Run log lines" });
    const reached = new Set<Element>();
    for (let i = 0; i < 20; i++) { await userEvent.tab(); if (document.activeElement) reached.add(document.activeElement); }
    expect(reached).toContain(screen.getAllByRole("link", { name: /Open in Dagster/ })[0]);
    expect(reached).toContain(within(card("Logs")).getByRole("combobox", { name: "Level" }));
    expect(reached).toContain(screen.getByRole("region", { name: "Run log lines" }));
  });
});

describe("helpers and the client", () => {
  it.each([["FAILURE", "critical"], ["CANCELED", "warning"], ["SUCCESS", "healthy"], ["STARTED", "unknown"], ["WHATEVER", "unknown"]] as const)(
    "reads Dagster's %s as %s", (status, state) => expect(runState(status)).toBe(state));

  it("formats durations and the run's UTC day", () => {
    expect(duration(114)).toBe("1 min 54 s");
    expect(duration(7500)).toBe("2 h 5 min");
    expect(duration(30)).toBe("30 s");
    expect(runDay({ ...runBody, started_at: Date.UTC(2026, 10, 16, 23, 59) / 1000 })).toBe("2026-11-16");
    expect(runDay({ ...runBody, started_at: null, created_at: Date.UTC(2026, 10, 17, 0, 1) / 1000 })).toBe("2026-11-17");
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
