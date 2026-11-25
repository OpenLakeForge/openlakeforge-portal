import { expect, test, type Page } from "@playwright/test";
import { shoot } from "./shots";

const FAILED = "c94cbcb0-5d1e-4a8e-9f0b-2f6c1a7e3b21"; // sales_orders' failed run, 40 min ago
const views = (page: Page) => page.getByRole("navigation", { name: "Monitoring views" });
const runs = (page: Page) => page.getByRole("region", { name: "PROD runs" });
const rows = (page: Page) => runs(page).getByRole("row");

test("Runs is reached from the overview with the keyboard, keeps the stage, and lists the last 24 hours", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/stages/")) reads.push(new URL(r.url()).pathname + new URL(r.url()).search); });
  await page.goto("/monitoring?stage=prod");
  await expect(page.getByRole("heading", { level: 2, name: "Critical PROD needs attention" })).toBeVisible();
  const tab = views(page).getByRole("link", { name: "Runs" });
  await tab.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/monitoring\/prod\/runs$/);
  await expect(tab).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Monitoring" })).toHaveAttribute("aria-current", "page");
  await expect(rows(page).first()).toContainText(["Pipeline", "Domain · product", "Status", "Started (UTC)", "Duration", "Run"].join(""));
  // Newest first: the queued crm_accounts run, then the sales_orders re-run in progress.
  await expect(rows(page).nth(1)).toContainText("crm · accounts");
  await expect(rows(page).nth(1)).toContainText("Not started");
  await expect(rows(page).nth(2)).toContainText("sales_orders");
  await expect(rows(page).nth(2)).toContainText("sales · orders");
  await expect(rows(page).nth(2)).toContainText(/Running.*so far/);
  await expect(page.getByText(/Read the newest 100 runs, the most the API answers at once/)).toContainText("before this window starts");
  // One read of the runs by the overview's gauge and one by this page, with the API's largest limit; status and window are the browser's.
  expect(reads.filter((u) => u.startsWith("/api/v1/stages/prod/runs"))).toEqual(["/api/v1/stages/prod/runs?limit=100", "/api/v1/stages/prod/runs?limit=100"]);
  // Overview keeps the stage on the way back.
  await expect(views(page).getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/monitoring?stage=prod");
});

test("a deep link with its filters opens pre-filtered, and each row opens its run", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/stages/") && r.url().includes("/runs?")) reads.push(new URL(r.url()).search); });
  await page.goto("/monitoring/prod/runs?job=sales_orders&status=failed&window=7d");
  await expect(page.getByRole("combobox", { name: "Pipeline" })).toHaveValue("sales_orders");
  await expect(page.getByRole("radio", { name: "Failed runs" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Last 7 days" })).toBeChecked();
  await expect(rows(page)).toHaveCount(3); // the header and two failures
  await expect(page.getByText(/Read all \d+ runs Dagster holds/)).toHaveCount(0); // a whole window needs no note
  expect(reads).toEqual(["?limit=100&job=sales_orders"]);
  const link = rows(page).nth(1).getByRole("link", { name: "Open run c94cbcb0" });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/monitoring/prod/runs/${FAILED}$`));
  await expect(page.getByRole("heading", { level: 1, name: "sales · orders" })).toBeVisible();
  // An older failure from the list opens too: the run screen reads the same runs.
  await page.goBack();
  await rows(page).nth(2).getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: "sales · orders" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Run" })).toContainText("Critical");
});

test("filters change the address; a wide window says how far the read reached", async ({ page }) => {
  await page.goto("/monitoring/prod/runs");
  await expect(rows(page).nth(1)).toBeVisible();
  await page.getByRole("radio", { name: "Failed runs" }).click();
  await expect(page).toHaveURL(/\/monitoring\/prod\/runs\?status=failed$/);
  await expect(rows(page).filter({ hasText: "Succeeded" })).toHaveCount(0);
  await page.getByRole("radio", { name: "Last 7 days" }).click();
  await expect(page).toHaveURL(/status=failed&window=7d$/);
  await expect(page.getByText(/were not read, so they are not listed; pick a pipeline to reach further back/)).toBeVisible();
  await page.getByRole("combobox", { name: "Product" }).selectOption("orders");
  await expect(page).toHaveURL(/product=orders/);
  await expect(rows(page).filter({ hasText: "web_events" })).toHaveCount(0);
  await page.getByRole("radio", { name: "In progress runs" }).click();
  await page.getByRole("radio", { name: "Last 1 hour" }).click();
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole("radio", { name: "Succeeded runs" }).click();
  await expect(page.getByText("No matching runs")).toBeVisible();
  await page.getByRole("link", { name: "Show all runs of the last 1 hour" }).click();
  await expect(page).toHaveURL(/\/monitoring\/prod\/runs\?window=1h$/);
});

test("DEV's Dagster cannot be read: Unknown with Retry, never an empty list", async ({ page }) => {
  await page.goto("/monitoring/prod/runs?status=failed");
  await page.getByRole("combobox", { name: "Stage" }).selectOption("dev");
  await expect(page).toHaveURL(/\/monitoring\/dev\/runs\?status=failed$/);
  await expect(page.getByRole("heading", { level: 2, name: "Unknown DEV runs cannot be read" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Retry/ })).toBeVisible();
  await expect(page.locator('.mon-badge[data-state="healthy"]')).toHaveCount(0);
});

test("a refused read (403) is Disabled in the API's words; a role without access reads no run", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/stages/") && r.url().includes("/runs?")) reads.push(r.url()); });
  await page.goto("/monitoring/prod/runs?mock=unauthorized");
  await expect(page.getByRole("heading", { level: 2, name: "Disabled PROD runs are not available" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("may not call list_runs on stage 'prod'");
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  reads.length = 0;
  await page.goto("/monitoring/prod/runs?mock=limited");
  await expect(page.getByRole("alert")).toContainText("Your role may not read runs on stage PROD.");
  await page.goto("/monitoring/prod/runs?mock=no-access");
  await expect(page.getByText("No monitoring access")).toBeVisible();
  expect(reads).toEqual([]);
});

test("a pipelines answer whose Dagster is unavailable leaves products unknown: runs stay listed, the product filter is not applied", async ({ page }) => {
  // A 200 with Dagster unavailable and no pipelines, as the API answers when its pipelines pass cannot read Dagster.
  await page.route("**/api/v1/stages/prod/health/pipelines", async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, pipelines: [], integrations: [{ name: "dagster", status: "unavailable", reason: "Dagster could not be read" }] } });
  });
  await page.goto("/monitoring/prod/runs?product=orders");
  await expect(page.getByText(/The product filter orders is not applied/)).toBeVisible();
  await expect(page.getByText(/Domain and product cannot be shown: Dagster could not be read/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Product" })).toBeDisabled();
  await expect(rows(page).filter({ hasText: "web_events" }).first()).toBeVisible();
  await expect(page.getByText("No matching runs")).toHaveCount(0);
  await expect(runs(page).getByText("No data product")).toHaveCount(0);
});

test("a stage with no run reads 'No runs'", async ({ page }) => {
  await page.goto("/monitoring/prod/runs?mock=empty");
  await expect(page.getByText("No runs", { exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
});

for (const colorScheme of ["dark", "light"] as const) {
  test(`at 390 px (${colorScheme}) the runs page does not scroll sideways`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/monitoring/prod/runs");
    await expect(rows(page).nth(1)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
}

test("screenshots: monitoring runs", async ({ page }) => {
  await shoot(page, "monitoring-runs", async () => {
    await page.goto("/monitoring/prod/runs");
    await expect(rows(page).nth(1)).toBeVisible();
  });
  await shoot(page, "monitoring-runs-filtered", async () => {
    await page.goto("/monitoring/prod/runs?status=failed&window=7d");
    await expect(rows(page).nth(1)).toBeVisible();
  });
});
