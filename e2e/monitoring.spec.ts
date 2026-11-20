import { expect, test, type Page } from "@playwright/test";
import { shoot } from "./shots";

const nav = (page: Page) => page.getByRole("navigation", { name: "Primary" });
const services = (page: Page) => page.getByRole("region", { name: "Service health" });
const row = (page: Page, name: string) => services(page).getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
const attention = (page: Page) => page.getByRole("region", { name: "What needs attention" });
const pipelines = (page: Page) => page.getByRole("region", { name: "Pipeline health" });
const showAll = (page: Page) => page.getByRole("button", { name: /^Show all \d+ services$/ }).click();
const quality = (page: Page) => page.getByRole("region", { name: "Quality by pipeline" });

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
  await expect(row(page, "Dagster")).toContainText("Dagster API · Unknown");
  await expect(page.getByText(/^3 of 5 healthy · log archive last durable write unknown$/)).toBeVisible();
  await expect(attention(page).getByRole("row", { name: /Pipelines cannot be read/ })).toContainText("Unknown");
  await expect(pipelines(page)).toHaveCount(0);

  // Two stages are a segmented switch, not a list: Tab reaches it, an arrow key moves it, and the URL keeps the stage.
  await expect(page.getByRole("combobox", { name: "Stage" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Stage" }).getByRole("radio")).toHaveCount(2);
  await tabTo(page, page.getByRole("radio", { name: "DEV" }));
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/stage=prod$/);
  await expect(page.getByRole("radio", { name: "PROD" })).toBeChecked();
  await expect(page.getByRole("heading", { level: 2, name: "Critical PROD needs attention" })).toBeVisible();
  await expect(page.getByText("1 pipeline failed · 1 missed run · 1 quality failure · 1 quality warning · 5 of 6 services ready")).toBeVisible();
  await expect(row(page, "Log archive")).toContainText("Warning");
  await expect(row(page, "Log archive")).toContainText("Log spool age · Warning");
  // Each "ago" also says its absolute time to a screen reader, in the page's one zone.
  await expect(page.locator(".mon-svc-line")).toHaveText(/^5 of 6 healthy · log archive last durable write 12 min ago \(at [^)]+ UTC\) · quality sync last publication 4 min ago \(at [^)]+ UTC\)$/);
  // Metrics answer on this deployment, so no row stands in for them.
  await expect(row(page, "Resource metrics")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Checked" })).toContainText("Auto-refresh · 30 s");
});

test("with metrics off (Slim) the services table says so, as Disabled", async ({ page }) => {
  await page.goto("/monitoring?stage=prod&mock=slim");
  await expect(page.getByText(/· resource metrics disabled$/)).toBeVisible();
  await showAll(page);
  await expect(row(page, "Resource metrics")).toContainText("Disabled");
  await expect(row(page, "Resource metrics")).toContainText("the deployment profile turns metrics off");
});

test("PROD's needs-attention list names each failing signal and open incident once, worst first, and the pipelines table lists every job", async ({ page }) => {
  await page.goto("/monitoring?stage=prod");
  const rows = attention(page).getByRole("row");
  // header + 8: 6 signals (sales_orders run, freshness and quality; crm_accounts missed run and freshness; finance_ledger
  // quality), 3 of them joined by their incident, and the 2 incidents about no listed signal (the log spool, the ledger's schedule).
  await expect(rows).toHaveCount(9);
  await expect(rows.nth(1)).toContainText("Critical");
  await expect(attention(page).getByRole("row", { name: /Run failed/ })).toContainText("run c94cbcb0");
  await expect(attention(page).getByRole("row", { name: /Expected run did not start/ })).toContainText("crm_accounts");
  await expect(attention(page).getByRole("row", { name: /Quality check warned/ })).toContainText("finance_ledger");
  await expect(rows.last()).toContainText("Warning");
  await expect(pipelines(page).getByRole("row")).toHaveCount(5);
  await expect(pipelines(page).getByRole("row", { name: /finance_ledger/ })).toContainText(/Stopped\s*finance_ledger_daily/);
  await expect(pipelines(page).getByRole("row", { name: /web_events/ })).toContainText("Healthy");
  // Failed runs are counted in the API's 24h window: an unreadable count is Unknown, never 0, and a read that stopped
  // short of the window says where its count starts.
  await expect(pipelines(page).getByRole("row", { name: /sales_orders/ })).toContainText("1 failed in last 24h");
  await expect(pipelines(page).getByRole("row", { name: /crm_accounts/ })).toContainText("the count of failed runs could not be read");
  await expect(pipelines(page).getByRole("row", { name: /web_events/ })).toContainText(/0 failed since .*the run read stopped short of the last 24h/);
  await expect(page.getByRole("region", { name: "Pipelines summary" })).toContainText("1 failed of 4 · 1 missed");
});

test("a pipelines read that fails reads unknown with Retry, and the stage's own answer stays", async ({ page }) => {
  await page.route("**/api/v1/stages/*/health/pipelines", (route) => route.fulfill({ status: 503, body: "{}" }));
  await page.goto("/monitoring?stage=prod");
  await expect(page.getByRole("heading", { level: 2, name: "Critical PROD needs attention" })).toBeVisible();
  const gap = attention(page).getByRole("row", { name: /Pipelines cannot be read/ });
  await expect(gap).toContainText("The monitoring API failed (503)");
  await expect(pipelines(page)).toHaveCount(0);
  await showAll(page);
  await expect(row(page, "Trino")).toContainText("Healthy");
  await page.unroute("**/api/v1/stages/*/health/pipelines");
  await gap.getByRole("button", { name: /Retry/ }).click();
  await expect(pipelines(page).getByRole("row")).toHaveCount(5);
});

test("PROD shows quality counts per product, and every open incident with its delivery in words, once", async ({ page }) => {
  await page.goto("/monitoring?stage=prod");
  await expect(page.getByRole("region", { name: "Data quality summary" })).toContainText("2 error 3 warn · 28 passed");
  await expect(page.getByRole("region", { name: "Data quality summary" })).toContainText("counts from 3 of 4 pipelines");
  await expect(quality(page).getByRole("row", { name: /crm · accounts/ })).toContainText("Counts unknown");
  await expect(quality(page).getByRole("row", { name: /finance · ledger/ })).toContainText("Incomplete");
  await expect(page.getByRole("region", { name: "Open alert incidents" })).toHaveCount(0); // merged into Needs attention
  for (const word of ["Delivered", "Pending", "Undeliverable", "Unrouted", "Unknown"]) {
    await expect(attention(page).locator(".mon-delivery", { hasText: new RegExp(`^${word}$`) })).toHaveCount(1);
  }
  // A signal no incident is about says no notification went out.
  await expect(attention(page).locator(".mon-delivery", { hasText: /^None$/ })).toHaveCount(3);
  // Each item once: no two rows of the list say the same thing about the same scope.
  const items = await attention(page).getByRole("row").evaluateAll((trs) => trs.slice(1).map((tr) => tr.textContent));
  expect(new Set(items).size).toBe(items.length);
  await expect(attention(page).getByRole("row", { name: /latest run failed/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /acknowledge/i })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Alerts summary" })).toContainText("5 open incidents");
});

test("DEV's stale alert evaluator reads stale, and its quality is not configured", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (r) => reads.push(r.url()));
  await page.goto("/monitoring?stage=dev");
  await expect(page.getByRole("note")).toContainText("Stale: the alert evaluator has not run since");
  await expect(page.getByRole("region", { name: "Data quality summary" })).toContainText("no quality manifest reader is configured for this stage");
  expect(reads.filter((u) => u.endsWith("/health/quality"))).toEqual([]);
});

for (const [scenario, row, words, notification] of [
  ["unavailable", /Incidents cannot be read/, "the alert evaluator has not written a state yet", "Unknown"],
  ["empty", /Run failed/, "no incident is open for it, so none was sent", "None"],
  ["not-provided", /Alert incidents are not available/, "no alert evaluator, or no key to read its state, is configured", "Not available"],
] as const) {
  test(`incidents read as ${scenario}, never as a quiet stage`, async ({ page }) => {
    await page.goto(`/monitoring?stage=prod&mock=${scenario}`);
    await expect(attention(page).getByRole("row", { name: row })).toContainText(words);
    await expect(attention(page).getByRole("row", { name: /Run failed/ }).locator(".mon-delivery")).toHaveText(notification);
  });
}

test("a role with no monitoring access sees a clear state and no health is read", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/stages/")) reads.push(r.url()); });
  await page.goto("/monitoring?mock=no-access");
  await expect(page.getByText("No monitoring access")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Stage" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Stage" })).toHaveCount(0);
  expect(reads).toEqual([]);
});

test("a role without list_pipeline_health gets no pipelines read, and the page says why", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (r) => reads.push(r.url()));
  await page.goto("/monitoring?stage=prod&mock=limited");
  await expect(attention(page).getByRole("row", { name: /Pipeline health is not available/ })).toContainText("Your role may not read pipeline health on stage PROD.");
  await showAll(page);
  await expect(row(page, "Trino")).toContainText("Healthy");
  expect(reads.filter((u) => u.endsWith("/health/pipelines"))).toEqual([]);
});

test("a stage the API refuses with 403 shows its words as Disabled, with no retry", async ({ page }) => {
  await page.goto("/monitoring?stage=prod&mock=unauthorized");
  await expect(page.getByRole("heading", { level: 2, name: "Disabled PROD health is not available" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("may not call get_stage_health on stage 'prod'");
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
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
    await expect(pipelines(page)).toBeVisible();
    await showAll(page);
    await expect(row(page, "Trino")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(nav(page).getByRole("link", { name: "Monitoring" })).toBeVisible();
    for (const region of [services(page), attention(page), pipelines(page), quality(page)]) {
      await expect(region).toHaveAttribute("tabindex", "0"); // keyboard users can scroll it
    }
  });
}

test("Services fold to one line when every service is healthy, and the toggle lists them from the keyboard", async ({ page }) => {
  await page.goto("/monitoring?stage=prod&mock=healthy");
  await expect(page.locator(".mon-svc-line")).toHaveText(/^6 of 6 healthy · log archive last durable write 12 min ago \(at [^)]+ UTC\) · quality sync last publication 4 min ago \(at [^)]+ UTC\)$/);
  await expect(services(page)).toHaveCount(0);
  const toggle = page.getByRole("button", { name: "Show all 6 services" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(services(page).getByRole("row")).toHaveCount(7);
  await expect(page.getByRole("button", { name: "Hide healthy services" })).toHaveAttribute("aria-expanded", "true");
});

test("a degraded service opens Services on its own, listing what is not healthy", async ({ page }) => {
  await page.goto("/monitoring?stage=prod");
  await expect(services(page).getByRole("row")).toHaveCount(2); // header + Log archive
  await expect(row(page, "Log archive")).toContainText("Log spool age · Warning");
  await showAll(page);
  await expect(services(page).getByRole("row")).toHaveCount(7);
});

test("pipeline names link to their runs, and a failed count to those failed runs in the window shown", async ({ page }) => {
  await page.goto("/monitoring?stage=prod");
  const sales = pipelines(page).getByRole("row", { name: /sales_orders/ });
  await expect(sales.getByRole("link", { name: "Runs of sales_orders", exact: true })).toHaveAttribute("href", "/monitoring/prod/runs?job=sales_orders");
  await expect(sales.getByRole("link", { name: /^1 failed in last 24h/ })).toHaveAttribute("href", "/monitoring/prod/runs?job=sales_orders&status=failed&window=24h");
  await expect(attention(page).getByRole("row", { name: /Run failed/ }).getByRole("link", { name: "Runs of sales_orders", exact: true }))
    .toHaveAttribute("href", "/monitoring/prod/runs?job=sales_orders");
  await expect(sales.getByRole("link", { name: "Open run c94cbcb0" })).toHaveAttribute("href", /\/monitoring\/prod\/runs\/c94cbcb0-/);
});

for (const width of [1440, 1100, 900, 390]) {
  test(`at ${width} px the summary cards sit four across or two by two, never three and one`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/monitoring?stage=prod");
    await expect(pipelines(page)).toBeVisible();
    const tops = await page.locator(".mon-card").evaluateAll((cards) => cards.map((c) => Math.round(c.getBoundingClientRect().top)));
    expect(tops).toHaveLength(4);
    const rows = [...new Set(tops)].map((t) => tops.filter((x) => x === t).length);
    expect([[4], [2, 2]]).toContainEqual(rows);
  });
}

for (const width of [1440, 1100, 900]) {
  test(`at ${width} px the Pipelines table shows its Failed runs column whole, even with long pipeline names, and so does Needs attention`, async ({ page }) => {
    // Longer names than the mock's, as a real deployment has (customer_health_pipeline, …).
    await page.route("**/api/v1/stages/prod/health/pipelines", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      for (const p of body.pipelines) p.job = `${p.job}_customer_health_pipeline`;
      await route.fulfill({ response: res, json: body });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/monitoring?stage=prod");
    await expect(pipelines(page)).toBeVisible();
    const fit = await pipelines(page).evaluate((r) => {
      const head = [...r.querySelectorAll("th")].find((th) => th.textContent === "Failed runs")!;
      return { overflow: r.scrollWidth - r.clientWidth, right: head.getBoundingClientRect().right, edge: r.getBoundingClientRect().right };
    });
    expect(fit.overflow).toBeLessThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(fit.edge + 0.5);
    // The list to act on fits too: its Notification column is never cut.
    expect(await attention(page).evaluate((r) => r.scrollWidth - r.clientWidth)).toBeLessThanOrEqual(0);
    await expect(pipelines(page).getByRole("row", { name: /sales_orders_customer_health_pipeline/ })).toContainText("1 failed in last 24h");
  });
}

test("screenshots: monitoring", async ({ page }) => {
  await shoot(page, "monitoring", async () => {
    await page.goto("/monitoring?stage=prod");
    await expect(row(page, "Log archive")).toBeVisible();
    await expect(pipelines(page)).toBeVisible();
  });
  await shoot(page, "monitoring-unavailable", async () => {
    await page.goto("/monitoring?stage=prod&mock=unavailable");
    await expect(attention(page)).toContainText("Incidents cannot be read");
  });
  await shoot(page, "monitoring-services-healthy", async () => {
    await page.goto("/monitoring?stage=prod&mock=healthy");
    await expect(page.getByText(/^6 of 6 healthy/)).toBeVisible();
    await expect(pipelines(page)).toBeVisible();
  });
  await shoot(page, "monitoring-dev", async () => {
    await page.goto("/monitoring?stage=dev");
    await expect(attention(page)).toContainText("Dagster could not be read");
  });
});
