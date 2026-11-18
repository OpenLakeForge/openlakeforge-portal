// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStageHealth, type HealthSignal, type HealthState, type PipelineHealth, type PipelinesHealth, type StageHealth } from "../lib/health-api";
import { DEADLINE_MS, Monitoring } from "./Monitoring";
import { StatusBadge } from "./StatusBadge";

const soon = () => new Date(Date.now() + 40_000).toISOString();
const svc = (component: string, state: HealthState, over = {}) => ({
  component, source: "x", state, reason: `${component} says ${state}`,
  observed_at: new Date().toISOString(), expires_at: soon(), max_age_seconds: 60, ...over,
});
const available = ["dagster", "services", "quality"].map((name) => ({ name, status: "available", reason: "read" }));
const health = (over: Partial<StageHealth> = {}): StageHealth => ({
  stage: "prod", state: "healthy", evaluated_at: new Date().toISOString(),
  pipelines: [{ job: "sales_orders", state: "healthy" }],
  services: [svc("trino.readiness", "healthy"), svc("polaris.readiness", "healthy")],
  integrations: [...available, { name: "metrics", status: "not_provided", reason: "no metrics source is connected to the API" }] as StageHealth["integrations"],
  ...over,
});

const sig = (kind: HealthSignal["kind"], state: HealthState, over: Partial<HealthSignal> = {}): HealthSignal => ({
  kind, state, reason: `${kind} says ${state}`, run: null, observed_at: new Date().toISOString(), expires_at: soon(), ...over,
});
const run = (job: string, status: string, id = `${job}-run-0001`) => {
  const t = Date.now() / 1000 - 600;
  return { run_id: id, job_name: job, status, created_at: t, started_at: t, ended_at: t + 60, tags: {} };
};
const pipeline = (job: string, over: Partial<PipelineHealth> = {}): PipelineHealth => ({
  job, state: "healthy", latest_run: run(job, "SUCCESS"), last_success: run(job, "SUCCESS"), failed_runs: 0,
  schedule: { name: `${job}_daily`, status: "running", last_expected_at: new Date(Date.now() - 900_000).toISOString() },
  freshness: { last_success_at: new Date(Date.now() - 540_000).toISOString(), age_seconds: 540 },
  signals: [sig("execution", "healthy"), sig("latest_success", "healthy"), sig("expected_run", "healthy"), sig("freshness", "healthy", { expires_at: null })],
  ...over,
});
const pipes = (over: Partial<PipelinesHealth> = {}): PipelinesHealth => ({
  stage: "prod", evaluated_at: new Date().toISOString(),
  thresholds: { run_max_age_seconds: 604800, schedule_max_age_seconds: 300, schedule_grace_seconds: 900, run_window: 25 },
  integrations: available as PipelinesHealth["integrations"], pipelines: [pipeline("sales_orders")], ...over,
});
type Reply = { status?: number; body?: unknown } | "down";

/** Answers /health with `reply` and /health/pipelines with `pipesReply` (healthy pipelines unless given). */
function api(reply: (stage: string) => Reply, pipesReply: (stage: string) => Reply = (stage) => ({ body: pipes({ stage }) })) {
  const fetch = vi.fn(async (input: string) => {
    const [, stage = "", sub] = /stages\/([^/]+)\/health(\/pipelines)?$/.exec(input) ?? [];
    const r = sub ? pipesReply(stage) : reply(stage);
    if (r === "down") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
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
    expect(pipelines).toHaveTextContent(/Last success · sales_orders failed \d\d?:\d\d( [AP]M)? · crm \d\d?:\d\d( [AP]M)?$/);
    expect(within(pipelines).getByText("Critical")).toBeInTheDocument();
  });

  it("never shows an expired healthy answer as healthy", async () => {
    const stale = svc("trino.readiness", "healthy", { observed_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T00:01:00Z" });
    api(() => ({ body: health({ services: [stale] }) }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(screen.queryByText(/is healthy/)).toBeNull();
    expect(screen.getByText(/1 service answer expired/)).toBeInTheDocument();
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

  it("shows each pipeline's latest run, last success, schedule and failed runs", async () => {
    api(() => ({ body: health({ state: "critical" }) }), () => ({ body: troubled() }));
    open();
    await screen.findByRole("region", { name: "Pipeline health" });
    expect(pipelineRow("sales_orders")).toHaveTextContent("Critical");
    expect(pipelineRow("sales_orders")).toHaveTextContent(/Failed · .* · c94cbcb0/);
    expect(pipelineRow("sales_orders")).toHaveTextContent("2 of last 25");
    expect(pipelineRow("erp_inventory")).toHaveTextContent("Disabled");
    expect(pipelineRow("erp_inventory")).toHaveTextContent("erp_daily · stopped");
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
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      // prod answers a little later, so a stale dev result would render on its own first.
      if (input.endsWith("/prod/health")) return new Promise((done) => setTimeout(() => done(new Response(JSON.stringify(health()))), 100));
      if (input.endsWith("/prod/health/pipelines")) return new Response(JSON.stringify(pipes()));
      return {
        ok: true, status: 200,
        json: () => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      } as unknown as Response;
    }));
    open(["dev", "prod"], "/monitoring?stage=dev");
    await screen.findByText("Reading DEV health…");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Stage" }), "prod");
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

  it("does not take a 200 without a StageHealth as an answer", async () => {
    api(() => ({ body: {} }));
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeInTheDocument();
  });

  it("switches stage from the selector and asks the API for it", async () => {
    const fetch = api((stage) => ({ body: health({ stage }) }));
    open(["dev", "prod"], "/monitoring");
    expect(await screen.findByRole("heading", { name: "Healthy DEV is healthy" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Stage" }), "prod");
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
    const fetch = vi.fn(stall);
    vi.stubGlobal("fetch", fetch);
    open();
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
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) =>
      input.endsWith("/pipelines") ? stall(input, init) : Promise.resolve(new Response(JSON.stringify(health())))));
    open();
    await advance(DEADLINE_MS - 1);
    expect(screen.getByText("Reading PROD health…")).toBeInTheDocument();
    await advance(1);
    expect(screen.getByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(attentionRow("Pipelines cannot be read")).toHaveTextContent(`did not answer within ${DEADLINE_MS / 1000} s`);
    expect(serviceRow("Trino")).toHaveTextContent("Healthy");
  });

  it("after a good snapshot, drops it for Unknown when a refresh stalls", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      if (input.endsWith("/pipelines")) return Promise.resolve(new Response(JSON.stringify(pipes())));
      return calls++ === 0 ? Promise.resolve(new Response(JSON.stringify(health()))) : stall(input, init);
    }));
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
