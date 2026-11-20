import { expect, test, type Page } from "@playwright/test";
import { shoot } from "./shots";

const FAILED = "c94cbcb0-5d1e-4a8e-9f0b-2f6c1a7e3b21";
const LEDGER = "e5d27b8c-0f41-4a9e-b6c3-1d8a2f7e9b05"; // finance_ledger: crossed midnight, incomplete manifest
const CRM = "4be0c1a9-2d7f-4c63-a1e8-5f3b9d0e7c42"; // crm_accounts: wrote no quality manifest
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
  // A data-engineer may not read PROD's log archive: said, not hidden, with how long the archive keeps lines.
  await expect(card(page, "Logs")).toContainText("Archived logs are not available");
  await expect(card(page, "Logs")).toContainText("Your role may not read logs on stage PROD.");
  await expect(card(page, "Logs")).toContainText("Kept 30 days");
  // The run's checks are the data-engineer's to read; its reports are not theirs to download on PROD.
  const checks = page.getByRole("region", { name: "Quality check results" });
  await expect(checks.getByRole("row")).toHaveCount(18);
  await expect(checks.getByRole("row").nth(1)).toContainText("ERROR");
  await expect(checks.getByRole("row", { name: /cast\.ordered_at/ })).toContainText("WARN");
  await expect(checks.getByRole("row", { name: /schema\.amount_type/ })).toContainText("Blocked the run");
  await expect(card(page, "Data quality")).toContainText("2 error · 1 warn · 14 passed · 1 blocking");
  await expect(page.getByRole("list", { name: "Quality reports" }).getByRole("link")).toHaveCount(0);
  await expect(card(page, "Data quality")).toContainText("These reports are not downloadable here");
});

test("with download rights the run's reports are same-origin downloads", async ({ page }) => {
  await page.goto(`/monitoring/prod/runs/${FAILED}?mock=admin`);
  const floe = page.getByRole("list", { name: "Quality reports" }).getByRole("link", { name: /Floe report/ });
  await expect(floe).toHaveAttribute("href", new RegExp(`^/api/v1/stages/prod/runs/${FAILED}/quality/reports/[0-9a-f]{16}$`));
  const [download] = await Promise.all([page.waitForEvent("download"), floe.click()]);
  expect(download.suggestedFilename()).toBe("run_report.json");
});

test("a run that wrote no quality manifest says so, and shows no check", async ({ page }) => {
  await page.goto(`/monitoring/prod/runs/${CRM}`);
  await expect(card(page, "Quality checks")).toContainText("No quality manifest");
  await expect(card(page, "Quality checks")).toContainText("the run wrote no quality manifest");
  await expect(page.getByRole("region", { name: "Quality check results" })).toHaveCount(0);
  await expect(card(page, "Data quality")).not.toContainText("passed");
});

test("a run quality read refused with 403 is Disabled in the API's words", async ({ page }) => {
  await page.route("**/api/v1/stages/prod/runs/*/quality", (route) =>
    route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ detail: "role analyst may not call get_run_quality on stage 'prod'" }) }));
  await page.goto(`/monitoring/prod/runs/${FAILED}`);
  await expect(card(page, "Quality checks")).toContainText("Quality checks are not available");
  await expect(card(page, "Quality checks")).toContainText("may not call get_run_quality");
  await expect(card(page, "Quality checks").getByRole("button", { name: /Retry/ })).toHaveCount(0);
});

test("a run that crossed midnight shows both UTC days, an incomplete manifest, and reads on with Load more", async ({ page }) => {
  await page.goto(`/monitoring/prod/runs/${LEDGER}?mock=admin`);
  await expect(card(page, "Quality checks")).toContainText("Manifest incomplete");
  await expect(card(page, "Data quality")).toContainText("0 error · 2 warn · 8 passed");
  const logs = card(page, "Logs");
  await expect(logs).toContainText("crosses midnight");
  await expect(logs).toContainText("200+ lines");
  await logs.getByRole("button", { name: "Load more" }).click();
  await expect(logs).toContainText("308 lines");
  await expect(logs.getByRole("button", { name: "Load more" })).toHaveCount(0);
  const days = page.getByRole("region", { name: "Run log lines" }).getByRole("rowheader");
  await expect(days).toHaveCount(2);
  await logs.getByRole("checkbox", { name: "Match this run only" }).check();
  await expect(logs).not.toContainText("trino-worker");
});

test("a stage with no log archive (log_retention_days null) shows no retention", async ({ page }) => {
  await page.goto(`/monitoring/prod/runs/${FAILED}?mock=not-provided`);
  await expect(card(page, "Logs")).toContainText("Archived logs are not available");
  await expect(card(page, "Logs")).not.toContainText("Kept");
});

test("with log access the run's window shows each line's time and level, and the filters ask the API again", async ({ page }) => {
  await page.goto(`/monitoring/prod/runs/${FAILED}?mock=admin`);
  const lines = page.getByRole("region", { name: "Run log lines" });
  await expect(lines.getByRole("row")).toHaveCount(12);
  await expect(lines.getByRole("row", { name: /floe_schema_mismatch/ })).toContainText(/\d\d:\d\d:\d\d\.\d{3}\s*ERROR/);
  // A v1 record has no time and no level: both cells stay empty.
  const v1 = lines.getByRole("row", { name: /\[v1\] exit code 1/ });
  await expect(v1.getByRole("cell").nth(0)).toBeEmpty();
  await expect(v1.getByRole("cell").nth(1)).toBeEmpty();
  await card(page, "Logs").getByRole("checkbox", { name: "Match this run only" }).check();
  await expect(lines.getByRole("row")).toHaveCount(10);
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
  await shoot(page, "monitoring-run-midnight", async () => {
    await page.goto(`/monitoring/prod/runs/${LEDGER}?mock=admin`);
    await expect(page.getByRole("region", { name: "Run log lines" })).toBeVisible();
  });
  await shoot(page, "monitoring-run-no-manifest", async () => {
    await page.goto(`/monitoring/prod/runs/${CRM}`);
    await expect(card(page, "Quality checks")).toContainText("No quality manifest");
  });
  await shoot(page, "monitoring-run-unknown", async () => {
    await page.goto(`/monitoring/prod/runs/${FAILED}?mock=unknown`);
    await expect(card(page, "What failed")).toContainText("could not be read");
  });
});
