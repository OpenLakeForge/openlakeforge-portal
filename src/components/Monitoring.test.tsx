// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStageHealth, type HealthState, type StageHealth } from "../lib/health-api";
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

function api(reply: (stage: string) => { status?: number; body?: unknown } | "down") {
  const fetch = vi.fn(async (input: string) => {
    const stage = /stages\/([^/]+)\/health$/.exec(input)?.[1] ?? "";
    const r = reply(stage);
    if (r === "down") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const open = (stages = ["dev", "prod"], entry = "/monitoring?stage=prod") =>
  render(<MemoryRouter initialEntries={[entry]}><Monitoring stages={stages} /></MemoryRouter>);
const banner = () => screen.getByRole("heading", { level: 2, name: /PROD/ });
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
    expect(screen.getByText("0 pipelines failing · 2 of 2 services ready")).toBeInTheDocument();
    expect(serviceRow("Trino")).toHaveTextContent("Healthy");
    expect(serviceRow("Resource metrics")).toHaveTextContent("Disabled");
    expect(serviceRow("Resource metrics")).toHaveTextContent("no metrics source is connected to the API");
    expect(screen.getByRole("status")).toHaveTextContent(/Checked \d+ s ago/);
  });

  it("names failures and keeps the API's critical rollup", async () => {
    api(() => ({ body: health({ state: "critical", pipelines: [{ job: "sales_orders", state: "critical" }, { job: "crm", state: "healthy" }] }) }));
    open();
    expect(await screen.findByRole("heading", { name: "Critical PROD needs attention" })).toBeInTheDocument();
    const pipelines = screen.getByRole("region", { name: "Pipelines summary" });
    expect(pipelines).toHaveTextContent("1 failed of 2");
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
    api(() => ({ body: health({ state: "unknown", pipelines: [], integrations }) }));
    open();
    expect(await screen.findByRole("heading", { name: "Unknown PROD status unknown" })).toBeInTheDocument();
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

describe("unavailable and absent", () => {
  it("shows unknown, never green, when the API is down, and retries", async () => {
    let down = true;
    const fetch = api(() => (down ? "down" : { body: health() }));
    open();
    expect(await screen.findByRole("heading", { name: "Unknown PROD status unknown" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("nothing on this page can be shown as healthy");
    expect(screen.queryByText("Healthy")).toBeNull();
    down = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByRole("heading", { name: "Healthy PROD is healthy" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
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
    expect(fetch.mock.calls.map(([u]) => u)).toEqual(["/api/v1/stages/dev/health", "/api/v1/stages/prod/health"]);
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
    expect(fetch).toHaveBeenCalledTimes(1); // no refresh while the stalled read was pending, nor before 30 s after it
    await advance(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("after a good snapshot, drops it for Unknown when a refresh stalls", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) =>
      calls++ === 0 ? Promise.resolve(new Response(JSON.stringify(health()))) : stall(input, init)));
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
