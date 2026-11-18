import { expect, test, type Page } from "@playwright/test";
import { shoot } from "./shots";

const nav = (page: Page) => page.getByRole("navigation", { name: "Primary" });
const services = (page: Page) => page.getByRole("region", { name: "Service health" });
const row = (page: Page, name: string) => services(page).getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });

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

  const stage = page.getByRole("combobox", { name: "Stage" });
  await tabTo(page, stage);
  await stage.selectOption("prod");
  await expect(page).toHaveURL(/stage=prod$/);
  await expect(page.getByRole("heading", { level: 2, name: "Critical PROD needs attention" })).toBeVisible();
  await expect(page.getByText("1 pipeline failing · 4 of 5 services ready")).toBeVisible();
  await expect(row(page, "Log spool age")).toContainText("Warning");
  await expect(row(page, "Resource metrics")).toContainText("Disabled");
  await expect(page.getByRole("status").filter({ hasText: "Checked" })).toContainText("Auto-refresh · 30 s");
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

test("at 390 px the page does not scroll sideways; the service table scrolls in its own region", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/monitoring?stage=prod");
  await expect(row(page, "Trino")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(nav(page).getByRole("link", { name: "Monitoring" })).toBeVisible();
  await expect(services(page)).toHaveAttribute("tabindex", "0"); // keyboard users can scroll it
});

test("screenshots: monitoring", async ({ page }) => {
  await shoot(page, "monitoring", async () => {
    await page.goto("/monitoring?stage=prod");
    await expect(row(page, "Trino")).toBeVisible();
  });
});
