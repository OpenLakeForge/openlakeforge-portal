import { expect, test, type Page } from "@playwright/test";
import { shoot } from "./shots";

const FAILED = "c94cbcb0-5d1e-4a8e-9f0b-2f6c1a7e3b21"; // sales_orders' failed run on PROD
const LEDGER = "e5d27b8c-0f41-4a9e-b6c3-1d8a2f7e9b05"; // finance_ledger: 308 lines across midnight
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const lines = (page: Page, stage = "DEV") => page.getByRole("region", { name: `${stage} log lines` });
const rows = (page: Page, stage = "DEV") => lines(page, stage).locator("tr[data-line]");
const card = (page: Page) => page.getByRole("region", { name: "Lines", exact: true });
/** The archive reads the page makes, as path and query. */
function reads(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/") && u.pathname.includes("/logs") || (u.pathname.startsWith("/api/") && /\/runs\/[^/]+$/.test(u.pathname))) seen.push(u.pathname + u.search); });
  return seen;
}

test("Logs is a tab next to Runs, reached with the keyboard, and opens on the current UTC hour of the stage", async ({ page }) => {
  const asked = reads(page);
  await page.goto("/monitoring/dev/runs");
  const tab = page.getByRole("navigation", { name: "Monitoring views" }).getByRole("link", { name: "Logs" });
  await tab.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/monitoring\/dev\/logs$/);
  await expect(tab).toHaveAttribute("aria-current", "page");
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, "0");
  await expect(page.getByRole("combobox", { name: "Hour (UTC)" })).toHaveValue(String(now.getUTCHours()));
  await expect(card(page)).toContainText(`DEV · ${now.toISOString().slice(0, 10)}, ${hh}:00`);
  expect(asked).toEqual([`/api/v1/stages/dev/logs?date=${now.toISOString().slice(0, 10)}&hour=${now.getUTCHours()}&limit=500`]);
});

test("browse: a deep link to a day, hour and product lists its lines; a pod narrows; the hour steps back", async ({ page }) => {
  const asked = reads(page);
  const day = yesterday();
  await page.goto(`/monitoring/dev/logs?date=${day}&hour=02&product=orders`);
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText(/02:00:1\d\.000\s*INFO\s*dagster-run-\w{8}\s*floe/);
  await expect(rows(page).first()).toContainText("Starting sales_orders");
  await expect(page.getByLabel("Product", { exact: true })).toHaveValue("orders");
  expect(asked).toEqual([`/api/v1/stages/dev/logs?date=${day}&hour=2&product=orders&limit=500`]);
  // A pod narrows to that pod's lines of the same hour; the product filter is dropped with it.
  await rows(page).first().getByRole("link", { name: /^Filter to / }).click();
  await expect(page).toHaveURL(new RegExp(`date=${day}&hour=02&pod=dagster-run-`));
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(new RegExp(`/monitoring/dev/logs\\?date=${day}&hour=02$`));
  await expect(rows(page).filter({ hasText: "Scheduler tick" })).toHaveCount(12);
  await page.getByRole("button", { name: /Previous hour/ }).click();
  await expect(page).toHaveURL(new RegExp(`date=${day}&hour=01$`));
  await expect(card(page)).toContainText(`${day}, 01:00–02:00 (UTC)`);
  // Filters typed in apply on Enter.
  await page.getByLabel("Container", { exact: true }).fill("trino");
  await page.getByLabel("Container", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/container=trino/);
  await expect(rows(page)).not.toHaveCount(0);
  for (const row of await rows(page).all()) await expect(row).toContainText("trino");
});

test("the whole day is read at most 500 lines at once, and a truncated read says it cannot read on", async ({ page }) => {
  await page.goto(`/monitoring/dev/logs?date=${yesterday()}`);
  await expect(card(page)).toContainText("500+ lines");
  await expect(card(page)).toContainText("The first 500 lines only: the archive holds more, and this route has no way to read on. Pick an hour");
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
});

test("the level filter asks the API with severity and is labelled as on the failed-run page", async ({ page }) => {
  const asked = reads(page);
  const day = yesterday();
  await page.goto(`/monitoring/dev/logs?date=${day}&hour=14`);
  await expect(rows(page)).not.toHaveCount(0);
  const level = page.getByRole("combobox", { name: "Level" });
  await expect(level.getByRole("option")).toHaveText(["All levels", "Info and above", "Warning and above", "Error and above", "Critical only"]);
  await level.selectOption("warning");
  await expect(page).toHaveURL(new RegExp(`date=${day}&hour=14&level=warning$`));
  // Hour 14 holds Trino's memory warning, and some days the catalog's error; nothing below warning.
  await expect(rows(page).filter({ hasText: "Memory pool general reserved above 80%" })).toHaveCount(1);
  for (const row of await rows(page).all()) await expect(row).toContainText(/WARNING|ERROR|CRITICAL/);
  expect(asked.at(-1)).toBe(`/api/v1/stages/dev/logs?date=${day}&hour=14&severity=warning&limit=500`);
});

test("search asks the archive with q, says so, and keeps q in the address", async ({ page }) => {
  const asked = reads(page);
  const day = yesterday();
  await page.goto(`/monitoring/dev/logs?date=${day}&hour=14&q=scheduler`);
  const box = page.getByRole("searchbox", { name: "Search" });
  await expect(box).toHaveValue("scheduler");
  await expect(box).toHaveAccessibleDescription("The archive was searched for lines containing “scheduler”, ignoring case, over the whole time asked.");
  await expect(rows(page)).toHaveCount(12);
  await expect(rows(page).first().locator("mark")).toHaveText("Scheduler");
  await box.fill("memory pool");
  await expect(page).toHaveURL(new RegExp(`q=memory\\+pool$`));
  await expect(rows(page)).toHaveCount(1);
  await box.fill("not in any line");
  await expect(card(page)).toContainText(`The archive holds no line containing “not in any line” for ${day}, 14:00–15:00 (UTC).`);
  expect(asked).toEqual([
    `/api/v1/stages/dev/logs?date=${day}&hour=14&q=scheduler&limit=500`,
    `/api/v1/stages/dev/logs?date=${day}&hour=14&q=memory+pool&limit=500`,
    `/api/v1/stages/dev/logs?date=${day}&hour=14&q=not+in+any+line&limit=500`,
  ]);
});

test("an API that ignores q: search filters the lines loaded in the browser and says so", async ({ page }) => {
  // An API from before openlakeforge#1349 drops `q` and answers every line of the hour.
  await page.route("**/api/v1/stages/dev/logs?*", async (route) => {
    const u = new URL(route.request().url());
    u.searchParams.delete("q");
    await route.fulfill({ response: await route.fetch({ url: u.toString() }) });
  });
  const asked = reads(page);
  const day = yesterday();
  await page.goto(`/monitoring/dev/logs?date=${day}&hour=14&q=scheduler`);
  const box = page.getByRole("searchbox", { name: "Search" });
  await expect(box).toHaveAccessibleDescription(/^This Platform API does not search, so search filters the \d+ lines loaded, not the whole archive\.$/);
  await expect(rows(page)).toHaveCount(12);
  await box.fill("not in any line");
  await expect(card(page)).toContainText("contains “not in any line”. The archive may hold it elsewhere: search filters the lines loaded only.");
  await page.waitForTimeout(500);
  expect(asked).toEqual([`/api/v1/stages/dev/logs?date=${day}&hour=14&q=scheduler&limit=500`]);
});

test("run mode: the failed-run page links here; the run's window pages with Load more across midnight", async ({ page }) => {
  const asked = reads(page);
  await page.goto(`/monitoring/prod/runs/${LEDGER}?mock=admin`);
  await expect(page.getByRole("link", { name: /Open in Logs/ })).toHaveAttribute("href", `/monitoring/prod/logs?run=${LEDGER}`);
  // The mock's role is read from the page's address: carried by hand here, as a link drops it.
  asked.length = 0;
  await page.goto(`/monitoring/prod/logs?run=${LEDGER}&mock=admin`);
  await expect(card(page)).toContainText("200+ lines");
  await expect(card(page)).toContainText(/run e5d27b8c's window, [A-Z][a-z]{2} \d{1,2}(, \d{4})? 23:41 UTC → [A-Z][a-z]{2} \d{1,2}(, \d{4})? 00:32 UTC/);
  await expect(lines(page, "PROD").locator("tr.run-day")).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Run screen" })).toHaveAttribute("href", `/monitoring/prod/runs/${LEDGER}`);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(card(page)).toContainText("308 lines");
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(asked.filter((u) => u.includes("/logs"))).toEqual([
    `/api/v1/stages/prod/runs/${LEDGER}/logs?limit=200`,
    `/api/v1/stages/prod/runs/${LEDGER}/logs?limit=200&after=cDoyMDA`,
  ]);
  // A run's pod narrows the window to the run's own lines.
  await page.goto(`/monitoring/prod/logs?run=${LEDGER}&pod=trino-worker-0&mock=admin`);
  await expect(page.getByLabel("Pod", { exact: true })).toHaveValue("trino-worker-0");
  await expect(rows(page, "PROD")).toHaveCount(6);
  // Only the run's own lines: the API's match_run.
  await page.goto(`/monitoring/prod/logs?run=${LEDGER}&match_run=true&mock=admin`);
  await expect(page.getByRole("checkbox", { name: "Only this run's lines" })).toBeChecked();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(card(page)).toContainText("301 lines");
  await expect(rows(page, "PROD").filter({ hasText: "trino" })).toHaveCount(0);
  await page.goto(`/monitoring/prod/logs?run=${LEDGER}&pod=trino-worker-0&mock=admin`);
  await page.getByRole("button", { name: "Browse the stage instead" }).click();
  await expect(page).toHaveURL(/\/monitoring\/prod\/logs\?date=\d{4}-\d\d-\d\d&pod=trino-worker-0$/);
});

test("run mode narrowed to one UTC day shows only that side of the run's midnight", async ({ page }) => {
  const head = { referer: "http://localhost/?mock=admin" };
  const whole = await (await page.request.get(`/api/v1/stages/prod/runs/${LEDGER}/logs?limit=1`, { headers: head })).json();
  const after = (whole.until as string).slice(0, 10);
  const asked = reads(page);
  await page.goto(`/monitoring/prod/logs?run=${LEDGER}&date=${after}&mock=admin`);
  await expect(card(page)).toContainText(/run e5d27b8c's window, [A-Z][a-z]{2} \d{1,2}(, \d{4})? 00:00 UTC → /);
  await expect(lines(page, "PROD").locator("tr.run-day")).toHaveCount(0);
  const times = await rows(page, "PROD").locator("time").evaluateAll((ts) => ts.map((t) => t.getAttribute("datetime")!));
  expect(times.length).toBeGreaterThan(0);
  expect(times.every((t) => t.startsWith(after))).toBe(true);
  expect(asked).toEqual([`/api/v1/stages/prod/runs/${LEDGER}/logs?limit=200&since=${after}T00%3A00%3A00.000Z&until=${encodeURIComponent(new Date(Date.parse(`${after}T00:00:00Z`) + 86_400_000).toISOString())}`]);
});

test("a data-engineer may not read PROD's archive: the stages offered are DEV's, and the API's 403 is shown in its words", async ({ page }) => {
  const asked = reads(page);
  await page.goto("/monitoring/prod/logs");
  await expect(page.getByRole("heading", { level: 2, name: "Disabled PROD logs are not available" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Your role may not read logs on stage PROD.");
  await expect(page.getByRole("combobox", { name: "Stage" }).getByRole("option")).toHaveText(["DEV", "PROD · no access"]);
  expect(asked).toEqual([]);
  // The failed-run page offers no Logs link where the archive is not the role's.
  await page.goto(`/monitoring/prod/runs/${FAILED}`);
  await expect(page.getByRole("region", { name: "Logs", exact: true })).toContainText("Archived logs are not available");
  await expect(page.getByRole("link", { name: /Open in Logs/ })).toHaveCount(0);
  // Offered, then refused: the API's own words, and no Retry.
  await page.goto("/monitoring/dev/logs?mock=unauthorized");
  await expect(page.getByRole("alert")).toHaveText("role data-engineer may not call list_logs on stage 'dev'");
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
});

test("a stage with no log archive says so and reads nothing", async ({ page }) => {
  const asked = reads(page);
  await page.goto("/monitoring/dev/logs?mock=not-provided");
  await expect(page.getByText("DEV keeps no archived logs: no log archive is configured for this stage.")).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  expect(asked).toEqual([]);
});

test("an API without the run window (no log_retention_days) reads the run's UTC day from the stage route", async ({ page }) => {
  await page.route("**/api/v1/monitoring-capabilities", async (route) => {
    const body = await (await route.fetch()).json();
    for (const s of body.stages) delete s.log_retention_days;
    await route.fulfill({ json: body });
  });
  const asked = reads(page);
  await page.goto(`/monitoring/prod/logs?run=${FAILED}&mock=admin`);
  await expect(card(page)).toContainText("This Platform API has no run window: these are run c94cbcb0's lines of");
  await expect(rows(page, "PROD")).toHaveCount(8);
  await expect(page.getByRole("combobox", { name: "Level" }).getByRole("option")).toHaveText(["All levels", "Warning and above", "Error and above"]);
  expect(asked.some((u) => u.includes(`/runs/${FAILED}/logs`))).toBe(false);
  expect(asked).toEqual([`/api/v1/stages/prod/runs/${FAILED}`, expect.stringMatching(new RegExp(`^/api/v1/stages/prod/logs\\?date=\\d{4}-\\d\\d-\\d\\d&run_id=${FAILED}&limit=500$`))]);
  await page.goto(`/monitoring/prod/logs?run=${FAILED}&level=error&mock=admin`);
  await expect(rows(page, "PROD")).toHaveCount(2);
});

test.describe("in New York", () => {
  test.use({ timezoneId: "America/New_York" });
  test("in the Local zone, line times and their day rows follow it; the archive's pickers stay in UTC", async ({ page }) => {
    await page.addInitScript(() => { try { window.localStorage.setItem("olf.monitoring.timeZone", "local"); } catch { /* none */ } });
    await page.goto(`/monitoring/prod/logs?run=${LEDGER}&mock=admin`);
    await expect(page.getByRole("radio", { name: /^Local/ })).toBeChecked();
    await expect(page.getByLabel("Day (UTC)", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Hour (UTC)" })).toBeVisible();
    const header = lines(page, "PROD").getByRole("columnheader").first();
    await expect(header).toHaveText("Time (America/New_York)");
    // 23:41 to 00:32 UTC is one evening in New York: no day rows, and the clock reads 18:41.
    await expect(rows(page, "PROD").first()).toContainText("18:41:07.000");
    await expect(lines(page, "PROD").locator("tr.run-day")).toHaveCount(0);
    await page.getByRole("radio", { name: "UTC", exact: true }).check();
    await expect(header).toHaveText("Time (UTC)");
    await expect(rows(page, "PROD").first()).toContainText("23:41:07.000");
    await expect(lines(page, "PROD").locator("tr.run-day")).toHaveCount(2);
  });
});

test("the lines are reached with Tab and walked with the arrow keys", async ({ page }) => {
  await page.goto(`/monitoring/dev/logs?date=${yesterday()}&hour=14`);
  const region = lines(page);
  await region.focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows(page).nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rows(page).nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(rows(page).last()).toBeFocused();
});

for (const colorScheme of ["dark", "light"] as const) {
  test(`Logs at 390 px (${colorScheme}) does not scroll sideways; the lines scroll in their own region`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/monitoring/prod/logs?run=${FAILED}&mock=admin`);
    await expect(lines(page, "PROD")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(lines(page, "PROD")).toHaveAttribute("tabindex", "0");
  });
}

test("screenshots: logs", async ({ page }) => {
  await shoot(page, "monitoring-logs", async () => {
    await page.goto(`/monitoring/dev/logs?date=${yesterday()}&hour=14`);
    await expect(rows(page)).not.toHaveCount(0);
  });
  await shoot(page, "monitoring-logs-run", async () => {
    await page.goto(`/monitoring/prod/logs?run=${FAILED}&mock=admin`);
    await expect(rows(page, "PROD")).toHaveCount(11);
  });
  await shoot(page, "monitoring-logs-search", async () => {
    await page.goto(`/monitoring/dev/logs?date=${yesterday()}&hour=14&q=query`);
    await expect(rows(page)).not.toHaveCount(0);
  });
});
