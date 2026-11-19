import { expect, test, type Page } from "@playwright/test";
import { shoot } from "./shots";

const FAILED = "c94cbcb0-5d1e-4a8e-9f0b-2f6c1a7e3b21";
const attention = (page: Page) => page.getByRole("region", { name: "What needs attention" });
const card = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test("Needs attention opens the failed run with the keyboard; the screen names the step, the scope and links to Dagster", async ({ page }) => {
  await page.goto("/monitoring?stage=prod");
  const link = attention(page).getByRole("row", { name: /Run failed/ }).getByRole("link", { name: "Open run c94cbcb0" });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/monitoring/prod/runs/${FAILED}$`));
  await expect(page.getByRole("heading", { level: 1, name: "sales · orders" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Monitoring/PROD/sales · orders/Run c94cbcb0");
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Monitoring" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("list", { name: "Run" })).toContainText("Critical");
  await expect(page.getByRole("list", { name: "Run" })).toContainText("floe_silver_orders");
  await expect(card(page, "What failed")).toContainText("SchemaMismatchError");
  await expect(card(page, "What failed")).toContainText("First line only");
  await expect(card(page, "Data quality")).toContainText("412 rows rejected");
  await expect(card(page, "Open incidents")).toContainText("latest run failed");
  const dagster = page.getByRole("link", { name: /Open in Dagster/ }).first();
  await expect(dagster).toHaveAttribute("href", `http://dagster-prod.olf.localhost/runs/${FAILED}`);
  await expect(page.getByRole("button", { name: /re-?run/i })).toHaveCount(0);
  // A data-engineer may not read PROD's log archive: said, not hidden.
  await expect(card(page, "Logs")).toContainText("Archived logs are not available");
  await expect(card(page, "Logs")).toContainText("Your role may not read logs on stage PROD.");
});

test("with log access the run's archived lines show, and the level filter asks the API again", async ({ page }) => {
  await page.goto(`/monitoring/prod/runs/${FAILED}?mock=admin`);
  const lines = page.getByRole("region", { name: "Run log lines" });
  await expect(lines.getByRole("row")).toHaveCount(9);
  await card(page, "Logs").getByRole("combobox", { name: "Level" }).selectOption("error");
  await expect(lines.getByRole("row")).toHaveCount(3);
});

test("an incident and a pipelines row link to their run", async ({ page }) => {
  await page.goto("/monitoring?stage=prod");
  await expect(page.getByRole("region", { name: "Open alert incidents" }).getByRole("link", { name: "Open run c94cbcb0" }).first())
    .toHaveAttribute("href", `/monitoring/prod/runs/${FAILED}`);
  await page.getByRole("region", { name: "Pipeline health" }).getByRole("row", { name: /crm_accounts/ }).getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: "crm · accounts" })).toBeVisible();
  await expect(card(page, "What failed")).toContainText("This run succeeded: nothing failed.");
});

test("an expected run that did not start shows when it was due", async ({ page }) => {
  await page.goto("/monitoring?stage=prod");
  await expect(attention(page).getByRole("row", { name: /Expected run did not start/ })).toContainText(/due \d\d:\d\d/);
});

test("a stage whose run routes answer 403 shows the API's words as Disabled, with no retry", async ({ page }) => {
  await page.goto(`/monitoring/prod/runs/${FAILED}?mock=unauthorized`);
  await expect(page.getByRole("heading", { level: 2, name: "Disabled This run's failure is not available" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("may not call get_run_failure on stage 'prod'");
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
});

test("a role with no monitoring access on the stage reads nothing", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/stages/")) reads.push(r.url()); });
  await page.goto(`/monitoring/prod/runs/${FAILED}?mock=no-access`);
  await expect(page.getByRole("heading", { level: 2, name: "Disabled PROD monitoring is not available" })).toBeVisible();
  expect(reads).toEqual([]);
});

test("an unknown run is a 404 in words, and an unreachable API is unknown with Retry, never green", async ({ page }) => {
  await page.goto("/monitoring/prod/runs/nope");
  await expect(page.getByRole("heading", { level: 2, name: "Disabled Run nope was not found" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("no run 'nope' in stage 'prod'");

  await page.route("**/api/v1/stages/prod/runs/**", (route) => route.abort());
  await page.goto(`/monitoring/prod/runs/${FAILED}`);
  await expect(page.getByRole("heading", { level: 2, name: "Unknown This run's failure cannot be read" })).toBeVisible();
  await expect(page.locator('.mon-badge[data-state="healthy"]')).toHaveCount(0);
  await page.unroute("**/api/v1/stages/prod/runs/**");
  await page.getByRole("button", { name: /Retry/ }).click();
  await expect(card(page, "What failed")).toContainText("SchemaMismatchError");
});

test("an unreadable event log is unknown, never 'nothing failed'", async ({ page }) => {
  await page.goto(`/monitoring/prod/runs/${FAILED}?mock=unknown`);
  await expect(card(page, "What failed")).toContainText("the run's event log could not be read");
  await expect(card(page, "What failed")).toContainText("Unknown");
  await expect(card(page, "What failed")).not.toContainText("nothing failed");
  await expect(card(page, "Data quality")).toContainText("the run's quality manifest could not be read");
});

for (const colorScheme of ["dark", "light"] as const) {
  test(`the failed run at 390 px (${colorScheme}) does not scroll sideways`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/monitoring/prod/runs/${FAILED}?mock=admin`);
    await expect(page.getByRole("region", { name: "Run log lines" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(page.getByRole("region", { name: "Run log lines" })).toHaveAttribute("tabindex", "0");
  });
}

test("screenshots: failed run", async ({ page }) => {
  await shoot(page, "monitoring-run", async () => {
    await page.goto(`/monitoring/prod/runs/${FAILED}?mock=admin`);
    await expect(page.getByRole("region", { name: "Run log lines" })).toBeVisible();
  });
  await shoot(page, "monitoring-run-unknown", async () => {
    await page.goto(`/monitoring/prod/runs/${FAILED}?mock=unknown`);
    await expect(card(page, "What failed")).toContainText("could not be read");
  });
});
