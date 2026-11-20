// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMetricSeriesData, type MetricCatalog, type MetricLine, type MetricSeriesData, type MetricSeriesInfo, type MonitoringCapabilities, type MonitoringStage,
} from "../lib/health-api";
import { formatValue, linePath, MAX_LINES, shape, summary, ticks } from "./MetricChart";
import { MonitoringMetrics } from "./MonitoringMetrics";

const ALL_OPS = ["get_stage_health", "list_pipeline_health", "list_stage_metrics", "get_stage_metric"];
const SOURCES = ["dagster", "services", "quality", "logs", "metrics", "alerts"] as const;
const access = (stage: string, over: Partial<MonitoringStage> = {}): MonitoringStage => ({
  stage, operations: ALL_OPS, capabilities: SOURCES.map((name) => ({ name, status: "available", reason: `${name} is configured` })), ...over,
});
const caps = (...stages: MonitoringStage[]): MonitoringCapabilities => ({ stages: stages.length ? stages : [access("dev"), access("prod")] });
const OFF = { status: "disabled" as const, reason: "the deployment profile turns metrics off" };
const slimAccess = (stage: string) => access(stage, {
  capabilities: SOURCES.map((name) => (name === "metrics" ? { name, ...OFF } : { name, status: "available" as const, reason: "ok" })),
});

const PROM = ["cpu_usage_cores", "memory_working_set_bytes", "container_restarts", "trino_running_queries", "trino_failed_queries", "object_store_bucket_bytes"];
const UNITS: Record<string, string> = {
  cpu_usage_cores: "cores", memory_working_set_bytes: "bytes", container_restarts: "restarts", trino_running_queries: "queries",
  trino_failed_queries: "queries", object_store_bucket_bytes: "bytes", pipeline_runs: "runs", pipeline_run_duration_seconds: "seconds",
  node_cpu_usage_cores: "cores", node_memory_working_set_bytes: "bytes",
};
const info = (name: string, over: Partial<MetricSeriesInfo> = {}): MetricSeriesInfo => ({
  name, unit: UNITS[name], source: name.startsWith("pipeline") ? "dagster" : "prometheus", labels: ["stage"],
  ranges: name.startsWith("pipeline") ? ["1h", "6h", "24h", "7d"] : ["1h", "6h", "24h"], state: "available", reason: "a target behind the series is up", ...over,
});
const catalog = (over: (i: MetricSeriesInfo) => Partial<MetricSeriesInfo> = () => ({})): MetricCatalog => ({
  stage: "prod", observed_at: new Date().toISOString(),
  series: [...PROM, "pipeline_runs", "pipeline_run_duration_seconds"].map((n) => { const i = info(n); return { ...i, ...over(i) }; }),
});
const times = (n = 4) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 10, 20, 9, i)).toISOString());
const lineOf = (labels: Record<string, string>, values: (number | null)[]): MetricLine => ({ labels, points: times(values.length).map((t, i) => [t, values[i]]) });
const series = (name: string, over: Partial<MetricSeriesData> = {}): MetricSeriesData => ({
  series: name, stage: name.startsWith("node") ? null : "prod", source: name.startsWith("pipeline") ? "dagster" : "prometheus", state: "available",
  reason: "read from the metrics backend", range: "24h", step_seconds: 300, unit: UNITS[name], observed_at: new Date().toISOString(),
  complete: true, covered_from: null, lines: [lineOf({ stage: "prod" }, [1, 2, null, 3])], ...over,
});

type Reply = { status?: number; body?: unknown } | "down";
const respond = (r: Reply) => {
  if (r === "down") throw new TypeError("Failed to fetch");
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
};
/** Answers the capabilities, the catalog and each series; `seriesReply` gets the series name and the range. */
function api({ capsBody = caps(), catalogReply = () => ({ body: catalog() }), seriesReply = (name: string) => ({ body: series(name) }) }: {
  capsBody?: MonitoringCapabilities; catalogReply?: () => Reply; seriesReply?: (name: string, range: string) => Reply;
} = {}) {
  const fetch = vi.fn(async (input: string) => {
    if (input === "/api/v1/monitoring-capabilities") return respond({ body: capsBody });
    const url = new URL(input, "http://portal");
    const m = /^\/api\/v1\/(?:stages\/[^/]+|platform)\/metrics(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return respond({ status: 404, body: { detail: "Not Found" } });
    return respond(m[1] ? seriesReply(m[1], url.searchParams.get("range") ?? "") : catalogReply());
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const urls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([u]) => u as string);
const open = (entry = "/monitoring/metrics?stage=prod") =>
  render(<MemoryRouter initialEntries={[entry]}><MonitoringMetrics stages={["dev", "prod"]} /></MemoryRouter>);
const card = (title: string) => screen.findByRole("region", { name: title });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("chart helpers", () => {
  it("folds lines past the limit into one 'other' line, keeping the largest by name", () => {
    const lines = ["a", "b", "c", "d", "e", "f", "g"].map((c, i) => lineOf({ component: c }, [i, i + 1]));
    const s = shape(lines, { by: "component", single: "CPU" });
    expect(s.lines).toHaveLength(MAX_LINES);
    expect(s.lines.map((l) => l.name)).toEqual(["d", "e", "f", "g", "3 other components"]);
    expect(s.lines.at(-1)!.values).toEqual([0 + 1 + 2, 1 + 2 + 3]);
  });

  it("merges lines by label, keeps gaps as null, and orders statuses so colours follow the name", () => {
    const s = shape([
      lineOf({ job: "a", status: "failed" }, [1, null]), lineOf({ job: "b", status: "failed" }, [2, null]),
      lineOf({ job: "a", status: "succeeded" }, [3, null]), lineOf({ job: "a", status: "canceled" }, [0, null]),
    ], { by: "status", single: "Runs", order: ["succeeded", "failed", "canceled"], hideZero: ["canceled"] });
    expect(s.lines.map((l) => [l.name, l.values])).toEqual([["succeeded", [3, null]], ["failed", [3, null]]]);
  });

  it("breaks a line at a gap and draws a lone sample as a dot, never as a zero", () => {
    const p = linePath([1, 2, null, 4, null], 4);
    expect(p.line).toBe("M0.000 75.000L25.000 50.000");
    expect(p.dots).toBe("M75.000 0.000h0.001");
    expect(linePath([null, null], 4)).toEqual({ line: "", dots: "" });
  });

  it("labels axes in round steps of the unit, and counts in whole numbers", () => {
    expect(ticks(1.45, "cores")).toEqual([0, 0.5, 1, 1.5]);
    expect(ticks(2, "runs")).toEqual([0, 1, 2]);
    expect(ticks(3 * 1024 ** 3, "bytes")).toEqual([0, 1, 2, 3].map((g) => g * 1024 ** 3));
    expect(formatValue(1.5 * 1024 ** 3, "bytes")).toBe("1.5 GiB");
    expect(formatValue(1, "queries")).toBe("1 query");
    expect(formatValue(125, "seconds")).toBe("2 min 5 s");
  });

  it("summarises each line in words: its latest sample and its peak", () => {
    const s = shape([lineOf({ component: "trino" }, [0.5, 1.25, null]), lineOf({ component: "polaris" }, [null, null, null])], { by: "component", single: "CPU" });
    const words = summary(s, "cores", "24h");
    expect(words[0]).toBe("polaris: no sample in the last 24h");
    expect(words[1]).toMatch(/^trino: 1\.25 cores last sample \d\d:\d\d.*, peak 1\.25 cores$/);
  });

  it("rejects a malformed series answer", () => {
    expect(isMetricSeriesData(series("cpu_usage_cores"))).toBe(true);
    expect(isMetricSeriesData({ ...series("cpu_usage_cores"), state: "ok" })).toBe(false);
    expect(isMetricSeriesData({ ...series("cpu_usage_cores"), lines: [{ labels: {}, points: [["t", "1"]] }] })).toBe(false);
  });
});

describe("Monitoring · Metrics", () => {
  it("charts every curated series the catalog lists, with a text summary and a table of values", async () => {
    const fetch = api({ seriesReply: (name) => ({ body: name === "cpu_usage_cores"
      ? series(name, { lines: [lineOf({ component: "trino" }, [0.4, 0.8, null, 1.2]), lineOf({ component: "polaris" }, [0.1, 0.1, 0.1, 0.1])] })
      : series(name) }) });
    open();
    const cpu = await card("CPU");
    expect(await within(cpu).findByText(/^trino: 1\.2 cores now, peak 1\.2 cores$/)).toBeTruthy();
    expect(within(cpu).getByText(/^polaris: 0\.1 cores now/)).toBeTruthy();
    for (const title of ["Memory", "Storage", "Trino load", "Trino query errors", "Pipeline runs", "Run duration", "Node CPU", "Node memory"]) {
      expect(await within(await card(title)).findByRole("group", { name: new RegExp(`^${title}, last 24h`) })).toBeTruthy();
    }
    // Only the curated series are read, all through the Platform API, over the default range.
    const read = urls(fetch).filter((u) => u.includes("/metrics/"));
    expect(read.every((u) => u.startsWith("/api/v1/") && u.endsWith("?range=24h"))).toBe(true);
    expect(read.some((u) => u.includes("container_restarts"))).toBe(false);
    expect(read).toContain("/api/v1/platform/metrics/node_cpu_usage_cores?range=24h");

    await userEvent.click(within(cpu).getByRole("button", { name: "Show the values as a table" }));
    const table = within(cpu).getByRole("region", { name: "CPU values" });
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    expect(within(table).getAllByText("no sample")).toHaveLength(1); // the gap, never 0
    expect(document.querySelector('.mon-badge[data-state="healthy"]')).toBeNull();
  });

  it("reads each step from the keyboard", async () => {
    api();
    open();
    const plot = await within(await card("Trino load")).findByRole("group", { name: /Trino load, last 24h/ });
    plot.focus();
    await userEvent.keyboard("{End}");
    expect(within(await card("Trino load")).getByText(/: 3 queries$/)).toBeTruthy();
    await userEvent.keyboard("{ArrowLeft}");
    expect(within(await card("Trino load")).getByText(/: no sample$/)).toBeTruthy();
    await userEvent.keyboard("{Home}");
    expect(within(await card("Trino load")).getByText(/: 1 query$/)).toBeTruthy();
  });

  it("with metrics off (Slim) says resource history is not collected, reads no Prometheus series and keeps the pipeline charts", async () => {
    const fetch = api({
      capsBody: caps(slimAccess("prod")),
      catalogReply: () => ({ body: catalog((i) => (i.source === "prometheus" ? { state: "disabled", reason: OFF.reason } : {})) }),
    });
    open();
    const notice = await screen.findByRole("heading", { level: 2, name: /Resource history is not collected/ });
    expect(notice.closest("section")!.textContent).toContain("The deployment profile turns metrics off");
    expect(notice.closest("section")!.textContent).toContain("CPU, Memory, Storage, Trino load, Trino query errors, Node CPU, Node memory");
    expect(await within(await card("Pipeline runs")).findByRole("group", { name: /Pipeline runs/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "CPU" })).toBeNull();
    const read = urls(fetch).filter((u) => u.includes("/metrics/"));
    expect(read.map((u) => u.split("/metrics/")[1])).toEqual(["pipeline_runs?range=24h", "pipeline_run_duration_seconds?range=24h"]);
    expect(document.querySelector('.mon-badge[data-state="healthy"]')).toBeNull();
  });

  it("an unavailable backend reads Unknown with the API's reason, never zeros, and Retry asks again", async () => {
    let down = true;
    const fetch = api({ seriesReply: (name) => ({ body: down && name === "cpu_usage_cores"
      ? series(name, { state: "unavailable", reason: "the metrics backend did not answer", lines: [] }) : series(name) }) });
    open();
    const cpu = await card("CPU");
    expect(await within(cpu).findByText("CPU cannot be read")).toBeTruthy();
    expect(within(cpu).getByText(/the metrics backend did not answer/)).toBeTruthy();
    expect(within(cpu).getAllByText("Unknown")).toHaveLength(1);
    down = false;
    await userEvent.click(within(cpu).getByRole("button", { name: /Retry/ }));
    expect(await within(cpu).findByRole("group", { name: /CPU, last 24h/ })).toBeTruthy();
    expect(urls(fetch).filter((u) => u.includes("/cpu_usage_cores"))).toHaveLength(2);
  });

  it("an unreachable series read is Unknown with Retry; a refused one is Disabled in the API's words", async () => {
    api({ seriesReply: (name) => (name === "memory_working_set_bytes" ? "down"
      : name === "node_cpu_usage_cores" ? { status: 403, body: { detail: "role analyst may not call get_platform_metric" } } : { body: series(name) }) });
    open();
    expect(await within(await card("Memory")).findByText("Memory cannot be read")).toBeTruthy();
    expect(within(await card("Memory")).getByRole("button", { name: /Retry/ })).toBeTruthy();
    const node = await card("Node CPU");
    expect(await within(node).findByText("role analyst may not call get_platform_metric")).toBeTruthy();
    expect(within(node).getByText("Disabled")).toBeTruthy();
    expect(within(node).queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("a series with no sample in the range reads 'No samples', not a flat line", async () => {
    api({ seriesReply: (name) => ({ body: name === "pipeline_runs" ? series(name, { lines: [] })
      : name === "trino_running_queries" ? series(name, { lines: [lineOf({ stage: "prod" }, [null, null])] }) : series(name) }) });
    open();
    expect(await within(await card("Pipeline runs")).findByText("No pipeline is defined or ran on this stage in this range.")).toBeTruthy();
    expect(await within(await card("Trino load")).findByText("Nothing was recorded in the last 24 hours.")).toBeTruthy();
    expect(within(await card("Trino load")).queryByRole("group")).toBeNull();
  });

  it("a stage whose catalog answers 403 shows the API's words as Disabled, with no retry and no series read", async () => {
    const fetch = api({ catalogReply: () => ({ status: 403, body: { detail: "role analyst may not call list_stage_metrics on stage 'prod'" } }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Disabled PROD metrics are not available" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("may not call list_stage_metrics on stage 'prod'");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(urls(fetch).filter((u) => u.includes("/metrics/"))).toEqual([]);
  });

  it("a role without list_stage_metrics, or a stage it may not monitor, reads nothing", async () => {
    const fetch = api({ capsBody: caps(access("dev"), access("prod", { operations: ["get_stage_health"] })) });
    open();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Your role may not read metrics on stage PROD.");
    expect(urls(fetch).filter((u) => u.includes("/metrics"))).toEqual([]);
    cleanup();

    const again = api({ capsBody: caps(access("dev")) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Disabled PROD metrics are not available" })).toBeTruthy();
    expect(urls(again).filter((u) => u.includes("/metrics"))).toEqual([]);
  });

  it("a role without get_stage_metric sees the catalog's charts as not available, and no stage series is read", async () => {
    const fetch = api({ capsBody: caps(access("prod", { operations: ["list_stage_metrics"] })) });
    open();
    expect(await within(await card("CPU")).findByText("Your role may not read metric series on stage PROD.")).toBeTruthy();
    expect(urls(fetch).filter((u) => u.includes("/stages/prod/metrics/"))).toEqual([]);
  });

  it("switching the range reads every chart again over it; a range past the retention is not asked for", async () => {
    const fetch = api({ seriesReply: (name, range) => ({ body: series(name, { range: range as MetricSeriesData["range"] }) }) });
    open();
    await within(await card("CPU")).findByRole("group", { name: /CPU, last 24h/ });
    await userEvent.click(screen.getByRole("radio", { name: "Last 6 hours" }));
    expect(await within(await card("CPU")).findByRole("group", { name: /CPU, last 6h/ })).toBeTruthy();
    expect(urls(fetch)).toContain("/api/v1/stages/prod/metrics/cpu_usage_cores?range=6h");
    expect(screen.getByRole("radio", { name: "Last 6 hours" })).toHaveProperty("checked", true);

    await userEvent.click(screen.getByRole("radio", { name: "Last 7 days" }));
    expect(await within(await card("CPU")).findByText("Not kept for the last 7d")).toBeTruthy();
    expect(within(await card("CPU")).getByText("This deployment keeps this series for 1h, 6h, 24h only.")).toBeTruthy();
    expect(within(await card("Node CPU")).getByText("Not kept for the last 7d")).toBeTruthy();
    expect(await within(await card("Pipeline runs")).findByRole("group", { name: /Pipeline runs, last 7d/ })).toBeTruthy();
    expect(urls(fetch).filter((u) => u.endsWith("range=7d")).map((u) => u.split("/metrics/")[1]))
      .toEqual(["pipeline_runs?range=7d", "pipeline_run_duration_seconds?range=7d"]);
  });

  it("a capped Dagster read says from when it covers the range", async () => {
    api({ seriesReply: (name) => ({ body: name === "pipeline_runs"
      ? series(name, { complete: false, covered_from: new Date(Date.UTC(2026, 10, 20, 9, 1)).toISOString(), lines: [lineOf({ job: "a", status: "succeeded" }, [null, 1, 0, 2])] })
      : series(name) }) });
    open();
    expect(await within(await card("Pipeline runs")).findByText(/the read reached its run cap, so earlier steps are gaps, not zeros/)).toBeTruthy();
  });

  it("a malformed catalog reads Unknown with Retry", async () => {
    api({ catalogReply: () => ({ body: { stage: "prod", series: "nope" } }) });
    open();
    expect(await screen.findByRole("heading", { level: 2, name: "Unknown PROD metrics cannot be read" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
  });

  it("offers Overview and Metrics as views of the same stage", async () => {
    api();
    open();
    const views = await screen.findByRole("navigation", { name: "Monitoring views" });
    expect(within(views).getByRole("link", { name: "Overview" }).getAttribute("href")).toBe("/monitoring?stage=prod");
    expect(within(views).getByRole("link", { name: "Metrics" }).getAttribute("aria-current")).toBe("page");
  });
});
