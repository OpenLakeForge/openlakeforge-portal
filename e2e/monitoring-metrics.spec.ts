import { expect, test, type Page } from "@playwright/test";
import { shoot } from "./shots";

const card = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const plot = (page: Page, name: string) => card(page, name).getByRole("group", { name: new RegExp(`^${name}, last`) });
const views = (page: Page) => page.getByRole("navigation", { name: "Monitoring views" });

test("Metrics is reached from the overview with the keyboard, keeps the stage, and charts the catalog's series", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/") && r.url().includes("/metrics")) reads.push(new URL(r.url()).pathname + new URL(r.url()).search); });
  await page.goto("/monitoring?stage=prod");
  await expect(page.getByRole("heading", { level: 2, name: "Critical PROD needs attention" })).toBeVisible();
  const link = views(page).getByRole("link", { name: "Metrics" });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/monitoring\/metrics\?stage=prod$/);
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Monitoring" })).toHaveAttribute("aria-current", "page");
  for (const name of ["CPU", "Memory", "Storage", "Trino load", "Trino query errors", "Pipeline runs", "Run duration", "Node CPU", "Node memory"]) {
    await expect(plot(page, name)).toBeVisible();
  }
  await expect(card(page, "CPU")).toContainText("3 other components");
  // Every read is the same-origin Platform API, over the default range; nothing goes to Prometheus.
  expect(reads.every((u) => u.startsWith("/api/v1/"))).toBe(true);
  expect(reads).toContain("/api/v1/stages/prod/metrics/cpu_usage_cores?range=24h");
  expect(reads).toContain("/api/v1/platform/metrics/node_memory_working_set_bytes?range=24h");
  await expect(page.locator('.mon-badge[data-state="healthy"]')).toHaveCount(0);
});

test("the keyboard reads a chart step by step, and its values open as a table", async ({ page }) => {
  await page.goto("/monitoring/metrics?stage=prod&range=1h");
  const trino = plot(page, "Trino load");
  await trino.focus();
  await page.keyboard.press("End");
  await expect(card(page, "Trino load")).toContainText(/\d\d:\d\d.*: \d+ quer(y|ies)/);
  await card(page, "Trino load").getByRole("button", { name: "Show the values as a table" }).click();
  await expect(card(page, "Trino load").getByRole("region", { name: "Trino load values" }).getByRole("row")).toHaveCount(61);
});

test("picking a step never moves the plot, however many lines its readout takes", async ({ page }) => {
  // Long series names, as a real deployment's pipelines have, wrap the readout over several lines on a phone.
  await page.route("**/api/v1/stages/prod/metrics/**", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const line of body.lines ?? []) {
      if (line.labels.job) line.labels.job = `${line.labels.job}_customer_health_reliability_pipeline`;
    }
    await route.fulfill({ response: res, json: body });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/monitoring/metrics?stage=prod&range=1h");
  const duration = plot(page, "Run duration");
  await expect(duration).toBeVisible();
  const readout = card(page, "Run duration").locator(".mc-readout");
  const top = () => duration.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  const idle = { top: await top(), height: (await readout.boundingBox())!.height };
  await duration.focus();
  await page.keyboard.press("End");
  await expect(readout).toContainText("customer_health_reliability");
  expect((await readout.boundingBox())!.height).toBeGreaterThan(idle.height); // the case that matters: it did grow
  expect(await top()).toBe(idle.top);
});

test("switching the range asks again over it, and a range past the retention is said, not asked", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/") && r.url().includes("/metrics/")) reads.push(new URL(r.url()).search); });
  await page.goto("/monitoring/metrics?stage=prod");
  await expect(plot(page, "CPU")).toBeVisible();
  // The range is in the address: the radio follows it once the navigation lands.
  await page.getByRole("radio", { name: "Last 6 hours" }).click();
  await expect(page).toHaveURL(/range=6h/);
  await expect(page.getByRole("radio", { name: "Last 6 hours" })).toBeChecked();
  await expect(card(page, "CPU").getByRole("group", { name: /CPU, last 6h/ })).toBeVisible();
  expect(reads).toContain("?range=6h");
  await page.getByRole("radio", { name: "Last 7 days" }).click();
  await expect(card(page, "CPU")).toContainText("Not kept for the last 7d");
  await expect(card(page, "Node CPU")).toContainText("Not kept for the last 7d");
  await expect(plot(page, "Pipeline runs")).toBeVisible();
  await expect(card(page, "Pipeline runs")).toContainText("the read reached its run cap");
});

test("with metrics off (Slim) resource history is absent, not zero, and pipeline charts stay", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/") && r.url().includes("/metrics/")) reads.push(r.url()); });
  await page.goto("/monitoring/metrics?stage=prod&mock=slim");
  await expect(page.getByRole("heading", { level: 2, name: /Resource history is not collected/ })).toBeVisible();
  await expect(page.getByText(/the deployment profile turns metrics off/i)).toBeVisible();
  await expect(plot(page, "Pipeline runs")).toBeVisible();
  await expect(card(page, "CPU")).toHaveCount(0);
  expect(reads.every((u) => u.includes("/metrics/pipeline_"))).toBe(true);
  await expect(page.locator('.mon-badge[data-state="healthy"]')).toHaveCount(0);
});

test("a metrics outage reads Unknown with Retry, never a chart", async ({ page }) => {
  await page.goto("/monitoring/metrics?stage=prod&mock=unavailable");
  await expect(card(page, "CPU")).toContainText("CPU cannot be read");
  await expect(card(page, "CPU")).toContainText("the metrics backend did not answer");
  await expect(card(page, "CPU").getByRole("group")).toHaveCount(0);
  await expect(card(page, "CPU").getByRole("button", { name: /Retry/ })).toBeVisible();
  // DEV's Dagster cannot be read: its pipeline charts are Unknown too.
  await page.getByRole("combobox", { name: "Stage" }).selectOption("dev");
  await expect(card(page, "Pipeline runs")).toContainText("Dagster could not be read");
});

test("no pipeline in the range reads 'No samples'", async ({ page }) => {
  await page.goto("/monitoring/metrics?stage=prod&mock=empty");
  await expect(card(page, "Pipeline runs")).toContainText("No samples");
  await expect(card(page, "Pipeline runs").getByRole("group")).toHaveCount(0);
});

test("a refused stage (403) shows the API's words as Disabled, with no retry", async ({ page }) => {
  await page.goto("/monitoring/metrics?stage=prod&mock=unauthorized");
  await expect(page.getByRole("heading", { level: 2, name: "Disabled PROD metrics are not available" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("may not call list_stage_metrics on stage 'prod'");
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
});

test("a role without the metrics routes reads none of them", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/") && r.url().includes("/metrics")) reads.push(r.url()); });
  await page.goto("/monitoring/metrics?stage=prod&mock=limited");
  await expect(page.getByRole("alert")).toContainText("Your role may not read metrics on stage PROD.");
  await page.goto("/monitoring/metrics?mock=no-access");
  await expect(page.getByText("No monitoring access")).toBeVisible();
  expect(reads).toEqual([]);
});

for (const colorScheme of ["dark", "light"] as const) {
  test(`at 390 px (${colorScheme}) the metrics page does not scroll sideways`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/monitoring/metrics?stage=prod");
    await expect(plot(page, "Node memory")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
}

test("screenshots: monitoring metrics", async ({ page }) => {
  await shoot(page, "monitoring-metrics", async () => {
    await page.goto("/monitoring/metrics?stage=prod");
    await expect(plot(page, "Node memory")).toBeVisible();
  });
  await shoot(page, "monitoring-metrics-slim", async () => {
    await page.goto("/monitoring/metrics?stage=prod&mock=slim");
    await expect(plot(page, "Run duration")).toBeVisible();
  });
  await shoot(page, "monitoring-metrics-unavailable", async () => {
    await page.goto("/monitoring/metrics?stage=dev&mock=unavailable");
    await expect(card(page, "Node memory")).toContainText("cannot be read");
  });
});
