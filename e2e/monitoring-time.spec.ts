import { expect, test, type Locator, type Page } from "@playwright/test";

// portal#40: one labelled time zone across the Monitoring pages. The browser runs in New York so UTC and Local differ.
const NY = "America/New_York";
test.use({ timezoneId: NY });

const FAILED = "c94cbcb0-5d1e-4a8e-9f0b-2f6c1a7e3b21";
const card = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const zone = (page: Page) => page.getByRole("group", { name: "Time zone" });

/** What a <time> element says: its instant and its text. */
async function timeOf(t: Locator) {
  return { iso: (await t.getAttribute("datetime"))!, text: (await t.textContent())!.trim() };
}
/** "17:28" for `iso` in `tz`, as the page writes a time of today (the dates are checked by the unit tests). */
function clock(iso: string, tz: string, ms = false) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const [h, m, s] = f.format(new Date(iso)).split(":");
  return ms ? `${h}:${m}:${s}.${iso.slice(20, 23)}` : `${h}:${m}`;
}

test("opens in UTC, labelled, on a 24-hour clock; overview, run header and logs agree on the same instants", async ({ page }) => {
  await page.goto("/monitoring?stage=prod&mock=admin");
  await expect(zone(page).getByRole("radio", { name: "UTC" })).toBeChecked();
  await expect(zone(page).getByRole("radio", { name: `Local (${NY})` })).not.toBeChecked();
  const pipes = page.getByRole("region", { name: "Pipeline health" });
  await expect(pipes.getByRole("columnheader", { name: "Latest run (UTC)" })).toBeVisible();
  const latest = await timeOf(pipes.getByRole("row").filter({ has: page.getByRole("link", { name: "Runs of sales_orders" }) }).getByRole("cell").nth(1).locator("time"));
  expect(latest.text).toMatch(/^(\w{3} \d{1,2} )?\d\d:\d\d$/);
  expect(latest.text.endsWith(clock(latest.iso, "UTC"))).toBe(true);
  await expect(page.locator("main")).not.toContainText(/\d\d:\d\d [AP]M/);

  await page.goto(`/monitoring/prod/runs/${FAILED}?mock=admin`);
  const facts = page.locator(".run-facts");
  // The run's end, read on the overview, is the same instant here (the mock dates its runs from each request's clock,
  // so allow its seconds to move) and is written the same way, with its zone.
  const ended = await timeOf(facts.locator("div", { hasText: "Ended" }).locator("time"));
  expect(Math.abs(Date.parse(ended.iso) - Date.parse(latest.iso))).toBeLessThan(5_000);
  expect(ended.text).toBe(`${latest.text.replace(/\d\d:\d\d$/, clock(ended.iso, "UTC"))} UTC`);
  const started = await timeOf(facts.locator("div", { hasText: "Started" }).locator("time"));
  await expect(page.locator(".run-head .f-sub")).toContainText(`started ${started.text}`);
  // The logs: the column names the zone, each line is that instant's clock, and the window starts at the run's start.
  const lines = page.getByRole("region", { name: "Run log lines" });
  await expect(lines.getByRole("columnheader", { name: "Time (UTC)" })).toBeVisible();
  const line = await timeOf(lines.getByRole("row", { name: /floe_schema_mismatch/ }).locator("time"));
  expect(line.text).toBe(clock(line.iso, "UTC", true));
  const since = await timeOf(card(page, "Logs").locator(".run-foot time").first());
  expect(Math.abs(Date.parse(since.iso) - Date.parse(started.iso))).toBeLessThan(5_000);
  expect(since.text).toBe(clock(since.iso, "UTC"));
  expect(started.text).toBe(`${clock(started.iso, "UTC")} UTC`);
  // A relative time keeps its absolute time on hover.
  const opened = card(page, "Open incidents").locator("time").first();
  await expect(opened).toHaveAttribute("title", / UTC$/);
});

test("Local switches every time on the page to the browser's zone, and the choice holds across pages and reloads", async ({ page }) => {
  await page.goto(`/monitoring/prod/runs/${FAILED}?mock=admin`);
  const facts = page.locator(".run-facts");
  const startedUtc = await timeOf(facts.locator("div", { hasText: "Started" }).locator("time"));
  await zone(page).getByRole("radio", { name: `Local (${NY})` }).check();
  await expect(zone(page).getByRole("radio", { name: `Local (${NY})` })).toBeChecked();
  const started = await timeOf(facts.locator("div", { hasText: "Started" }).locator("time"));
  expect(started.iso).toBe(startedUtc.iso);
  expect(started.text).toMatch(new RegExp(`${clock(started.iso, NY)} America/New_York$`));
  await expect(page.locator(".run-head .f-sub")).toContainText(`started ${started.text}`);
  const lines = page.getByRole("region", { name: "Run log lines" });
  await expect(lines.getByRole("columnheader", { name: `Time (${NY})` })).toBeVisible();
  const line = await timeOf(lines.getByRole("row", { name: /floe_schema_mismatch/ }).locator("time"));
  expect(line.text).toBe(clock(line.iso, NY, true));
  await expect(card(page, "Logs")).toContainText(`America/New_York`);
  await expect(page.locator("main")).not.toContainText(/\(UTC\)| UTC\b/);

  // The choice is the browser's: the overview, the Runs page, Metrics and a reload all keep it, and nothing is in the address.
  await page.getByRole("navigation", { name: "Monitoring views" }).getByRole("link", { name: "Overview" }).click();
  await expect(page).toHaveURL(/\/monitoring\?stage=prod$/);
  await expect(zone(page).getByRole("radio", { name: `Local (${NY})` })).toBeChecked();
  await expect(page.getByRole("region", { name: "Pipeline health" }).getByRole("columnheader", { name: `Latest run (${NY})` })).toBeVisible();
  await page.getByRole("navigation", { name: "Monitoring views" }).getByRole("link", { name: "Runs" }).click();
  await expect(page.getByRole("columnheader", { name: `Started (${NY})` })).toBeVisible();
  await page.getByRole("navigation", { name: "Monitoring views" }).getByRole("link", { name: "Metrics" }).click();
  await expect(page.getByText(`Time (${NY})`).first()).toBeVisible();
  await page.reload();
  await expect(zone(page).getByRole("radio", { name: `Local (${NY})` })).toBeChecked();
  await expect(page.getByText(`Time (${NY})`).first()).toBeVisible();
  await zone(page).getByRole("radio", { name: "UTC" }).check();
  await expect(page.getByText("Time (UTC)").first()).toBeVisible();
});

test("with storage blocked the pages open in UTC and the switch still works for the page", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError"); } });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/monitoring/prod/runs?mock=admin");
  await expect(zone(page).getByRole("radio", { name: "UTC" })).toBeChecked();
  await expect(page.getByRole("columnheader", { name: "Started (UTC)" })).toBeVisible();
  await zone(page).getByRole("radio", { name: `Local (${NY})` }).check();
  await expect(page.getByRole("columnheader", { name: `Started (${NY})` })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the server renders UTC and the page switches after hydration, with no hydration error", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(m.text()); });
  await page.addInitScript(() => { try { window.localStorage.setItem("olf.monitoring.timeZone", "local"); } catch { /* none */ } });
  const html = await (await page.request.get("/monitoring?stage=prod")).text();
  const inputs = html.match(/<input[^>]*name="mon-zone"[^>]*>/g) ?? [];
  expect(inputs.filter((i) => i.includes('checked=""')).map((i) => i.match(/value="(\w+)"/)?.[1])).toEqual(["utc"]);
  expect(html).toContain('aria-label="Local"'); // the server cannot know the browser's zone
  await page.goto("/monitoring?stage=prod");
  await expect(zone(page).getByRole("radio", { name: `Local (${NY})` })).toBeChecked();
  await expect(page.getByRole("region", { name: "Pipeline health" }).getByRole("columnheader", { name: `Latest run (${NY})` })).toBeVisible();
  expect(logs.filter((l) => /hydrat|did not match/i.test(l))).toEqual([]);
});
