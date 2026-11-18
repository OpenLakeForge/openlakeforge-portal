import { expect, test, type Page } from "@playwright/test";
import { shoot } from "./shots";

const nav = (page: Page) => page.getByRole("navigation", { name: "Primary" });
const services = (page: Page) => page.getByRole("region", { name: "Service health" });
const row = (page: Page, name: string) => services(page).getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
const attention = (page: Page) => page.getByRole("region", { name: "What needs attention" });
const pipelines = (page: Page) => page.getByRole("region", { name: "Pipeline health" });

/** Presses Tab until `target` has focus: the keyboard alone reaches it. */
async function tabTo(page: Page, target: ReturnType<Page["getByRole"]>, max = 15) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error("not reachable with Tab");
}

test("Monitoring is second in the navigation, the landing page stays Services, and the keyboard opens it", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/services$/);
  await expect(nav(page).getByRole("link")).toHaveText(["Services", "Monitoring", "Queries", "Files"]);
  await tabTo(page, nav(page).getByRole("link", { name: "Monitoring" }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/monitoring$/);
  await expect(page.getByRole("heading", { name: "Monitoring", level: 1 })).toBeVisible();
  await expect(nav(page).getByRole("link", { name: "Monitoring" })).toHaveAttribute("aria-current", "page");
});

test("DEV reads unknown when Dagster cannot be read; PROD names what needs attention", async ({ page }) => {
  await page.goto("/monitoring");
  await expect(page.getByRole("heading", { level: 2, name: "Unknown DEV status unknown" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Pipelines summary" })).toContainText("Dagster could not be read");
  await expect(row(page, "Dagster API")).toContainText("Unknown");
  await expect(attention(page).getByRole("row", { name: /Pipelines cannot be read/ })).toContainText("Unknown");
  await expect(pipelines(page)).toHaveCount(0);

  const stage = page.getByRole("combobox", { name: "Stage" });
  await tabTo(page, stage);
  await stage.selectOption("prod");
  await expect(page).toHaveURL(/stage=prod$/);
  await expect(page.getByRole("heading", { level: 2, name: "Critical PROD needs attention" })).toBeVisible();
  await expect(page.getByText("1 pipeline failed · 1 missed run · 1 quality failure · 1 quality warning · 4 of 5 services ready")).toBeVisible();
  await expect(row(page, "Log spool age")).toContainText("Warning");
  await expect(row(page, "Resource metrics")).toContainText("Disabled");
  await expect(page.getByRole("status").filter({ hasText: "Checked" })).toContainText("Auto-refresh · 30 s");
});

test("PROD's needs-attention table names each failing signal, worst first, and the pipelines table lists every job", async ({ page }) => {
  await page.goto("/monitoring?stage=prod");
  const rows = attention(page).getByRole("row");
  await expect(rows).toHaveCount(7); // header + 6: sales_orders run, freshness and quality; crm_accounts missed run and freshness; finance_ledger quality
  await expect(rows.nth(1)).toContainText("Critical");
  await expect(attention(page).getByRole("row", { name: /Run failed/ })).toContainText("run c94cbcb0");
  await expect(attention(page).getByRole("row", { name: /Expected run did not start/ })).toContainText("crm_accounts");
  await expect(attention(page).getByRole("row", { name: /Quality check warned/ })).toContainText("finance_ledger");
  await expect(rows.last()).toContainText("Warning");
  await expect(pipelines(page).getByRole("row")).toHaveCount(5);
  await expect(pipelines(page).getByRole("row", { name: /finance_ledger/ })).toContainText("finance_ledger_daily · stopped");
  await expect(pipelines(page).getByRole("row", { name: /web_events/ })).toContainText("Healthy");
  await expect(page.getByRole("region", { name: "Pipelines summary" })).toContainText("1 failed of 4 · 1 missed");
});

test("a pipelines read that fails reads unknown with Retry, and the stage's own answer stays", async ({ page }) => {
  await page.route("**/api/v1/stages/*/health/pipelines", (route) => route.fulfill({ status: 503, body: "{}" }));
  await page.goto("/monitoring?stage=prod");
  await expect(page.getByRole("heading", { level: 2, name: "Critical PROD needs attention" })).toBeVisible();
  const gap = attention(page).getByRole("row", { name: /Pipelines cannot be read/ });
  await expect(gap).toContainText("The monitoring API failed (503)");
  await expect(pipelines(page)).toHaveCount(0);
  await expect(row(page, "Trino")).toContainText("Healthy");
  await page.unroute("**/api/v1/stages/*/health/pipelines");
  await gap.getByRole("button", { name: /Retry/ }).click();
  await expect(pipelines(page).getByRole("row")).toHaveCount(5);
});

test("an unreachable API is unknown, never green, and Retry works from the keyboard", async ({ page }) => {
  await page.route("**/api/v1/stages/*/health", (route) => route.abort());
  await page.goto("/monitoring?stage=prod");
  await expect(page.getByRole("heading", { level: 2, name: "Unknown PROD status unknown" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("nothing on this page can be shown as healthy");
  await expect(page.locator('.mon-badge[data-state="healthy"]')).toHaveCount(0);

  await page.unroute("**/api/v1/stages/*/health");
  await tabTo(page, page.getByRole("button", { name: /Retry/ }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: "Critical PROD needs attention" })).toBeVisible();
});

for (const colorScheme of ["dark", "light"] as const) {
  test(`at 390 px (${colorScheme}) the page does not scroll sideways; each table scrolls in its own region`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/monitoring?stage=prod");
    await expect(row(page, "Trino")).toBeVisible();
    await expect(pipelines(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(nav(page).getByRole("link", { name: "Monitoring" })).toBeVisible();
    for (const region of [services(page), attention(page), pipelines(page)]) {
      await expect(region).toHaveAttribute("tabindex", "0"); // keyboard users can scroll it
    }
  });
}

test("screenshots: monitoring", async ({ page }) => {
  await shoot(page, "monitoring", async () => {
    await page.goto("/monitoring?stage=prod");
    await expect(row(page, "Trino")).toBeVisible();
    await expect(pipelines(page)).toBeVisible();
  });
  await shoot(page, "monitoring-dev", async () => {
    await page.goto("/monitoring?stage=dev");
    await expect(attention(page)).toContainText("Dagster could not be read");
  });
});
