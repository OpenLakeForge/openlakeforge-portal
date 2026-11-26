import { expect, test, type Page } from "@playwright/test";
import { shoot } from "./shots";

const nav = (page: Page) => page.getByRole("navigation", { name: "Primary" });
const attention = (page: Page) => page.getByRole("list", { name: "What needs attention" });
/** One item of the list to act on, and the same with its details opened, so its links can be used. */
const item = (page: Page, text: RegExp) => attention(page).getByRole("listitem").filter({ hasText: text });
async function openItem(page: Page, text: RegExp) {
  const found = item(page, text);
  await found.locator("summary").click();
  return found;
}
const pipelines = (page: Page) => page.getByRole("region", { name: "Pipeline health" });
const pipe = (page: Page, job: string) => pipelines(page).locator("tbody").filter({ has: page.getByRole("button", { name: `Details of ${job}` }) });
async function openPipe(page: Page, job: string) {
  await page.getByRole("button", { name: `Details of ${job}` }).click();
  return pipe(page, job);
}
const chip = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name} `) });
async function service(page: Page, name: string) {
  await chip(page, name).click();
  return page.getByRole("region", { name: "Service detail" });
}
const card = (page: Page, name: string) => page.getByRole("region", { name: `${name} summary` });

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
  await expect(item(page, /Pipelines cannot be read/)).toContainText("Unknown");
  await expect(item(page, /Pipelines cannot be read/)).toContainText("Dagster could not be read");
  await expect(await service(page, "Dagster")).toContainText("Dagster API · Unknown");
  await expect(await service(page, "Log archive")).toContainText("Last durable write unknown");
  await expect(pipelines(page)).toHaveCount(0);

  // Two stages are a segmented switch, not a list: Tab reaches it, an arrow key moves it, and the URL keeps the stage.
  await expect(page.getByRole("combobox", { name: "Stage" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Stage" }).getByRole("radio")).toHaveCount(2);
  await page.getByRole("radio", { name: "DEV" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/stage=prod$/);
  await expect(page.getByRole("radio", { name: "PROD" })).toBeChecked();
  await expect(page.getByRole("heading", { level: 2, name: "Critical PROD needs attention" })).toBeVisible();
  await expect(card(page, "Services")).toContainText("5/6");
  await expect(card(page, "Pipeline runs")).toContainText("Succeeded");
  await expect(chip(page, "Log archive")).toContainText("Warning");
  const archive = await service(page, "Log archive");
  await expect(archive).toContainText("Log spool age · Warning");
  // Each "ago" also says its absolute time to a screen reader, in the page's one zone.
  await expect(archive).toContainText(/Last durable write 12 min ago \(at [^)]+ UTC\)/);
  // Metrics answer on this deployment, so no chip stands in for them.
  await expect(chip(page, "Resource metrics")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Updated" })).toHaveAttribute("title", "Refreshes every 30 s");
});

test("with metrics off (Slim) the services say so, as Disabled", async ({ page }) => {
  await page.goto("/monitoring?stage=prod&mock=slim");
  await expect(chip(page, "Resource metrics")).toContainText("Disabled");
  await expect(await service(page, "Resource metrics")).toContainText("the deployment profile turns metrics off");
});

test("PROD's needs-attention list names each failing signal, service and open incident once, worst first, and the pipelines table lists every job", async ({ page }) => {
  await page.goto("/monitoring?stage=prod");
  const rows = attention(page).getByRole("listitem");
  // 6 signals (sales_orders run, freshness and quality; crm_accounts missed run and freshness; finance_ledger quality),
  // 3 of them joined by their incident, the log archive joined by its spool incident, and the ledger's schedule incident.
  await expect(rows).toHaveCount(8);
  await expect(rows.first()).toContainText("Critical");
  await expect(item(page, /Run failed/)).toContainText("run c94cbcb0");
  await expect(item(page, /Expected run did not start/)).toContainText("crm_accounts");
  await expect(item(page, /2 checks warned/)).toContainText("finance_ledger");
  await expect(rows.last()).toContainText("Warning");
  await expect(pipelines(page).locator("tbody")).toHaveCount(4);
  await expect(await openPipe(page, "finance_ledger")).toContainText("Stopped · finance_ledger_daily");
  await expect(pipe(page, "web_events")).toContainText("Healthy");
  // Failed runs are counted in the API's 24h window: an unreadable count is Unknown, never 0, and a read that stopped
  // short of the window says where its count starts.
  await expect(await openPipe(page, "sales_orders")).toContainText("1 failed in last 24h");
  await expect(await openPipe(page, "crm_accounts")).toContainText("the count of failed runs could not be read");
  await expect(await openPipe(page, "web_events")).toContainText(/0 failed since .*the run read stopped short of the last 24h/);
});

test("a pipelines read that fails reads unknown with Retry, and the stage's own answer stays", async ({ page }) => {
  await page.route("**/api/v1/stages/*/health/pipelines", (route) => route.fulfill({ status: 503, body: "{}" }));
  await page.goto("/monitoring?stage=prod");
  await expect(page.getByRole("heading", { level: 2, name: "Critical PROD needs attention" })).toBeVisible();
  const gap = item(page, /Pipelines cannot be read/);
  await expect(gap).toContainText("The monitoring API failed (503)");
  await expect(chip(page, "Trino")).toContainText("Healthy");
  await page.unroute("**/api/v1/stages/*/health/pipelines");
  await gap.getByRole("button", { name: /Retry/ }).click();
  await expect(pipelines(page).locator("tbody")).toHaveCount(4);
});

test("PROD shows quality counts per pipeline, and every open incident with its delivery in words, once", async ({ page }) => {
  await page.goto("/monitoring?stage=prod");
  await expect(card(page, "Data quality")).toContainText("Passed 28Warn 3Failed 2");
  await expect(card(page, "Data quality")).toContainText("counts from 3 of 4 pipelines · 1 incomplete");
  await expect(pipe(page, "crm_accounts")).toContainText("Counts unknown");
  await expect(pipe(page, "finance_ledger")).toContainText("Incomplete");
  await expect(await openPipe(page, "finance_ledger")).not.toContainText("not every result is in yet");
  // sales_orders' quality notification reached its discussion while the on-call webhook retries: delivered 1 of 2, never pending.
  for (const word of ["Delivered", "Delivered 1 of 2", "Undeliverable", "Unrouted", "Unknown"]) {
    await expect(attention(page).locator(".mon-delivery", { hasText: new RegExp(`^${word}$`) })).toHaveCount(1);
  }
  // A signal no incident is about says no notification went out.
  await expect(attention(page).locator(".mon-delivery", { hasText: /^None$/ })).toHaveCount(3);
  // Each item once: no two rows of the list say the same thing about the same scope.
  const items = await attention(page).getByRole("listitem").allTextContents();
  expect(new Set(items).size).toBe(items.length);
  await expect(item(page, /latest run failed/)).toHaveCount(1);
  await expect(page.getByRole("button", { name: /acknowledge/i })).toHaveCount(0);
  await expect(card(page, "Alerts")).toContainText("5incidents");
});

const BOOK = "http://docs.olf.localhost/runbooks/alerting";

test("each open incident links its runbook section in a new tab, on a joined row and on a service's row", async ({ page }) => {
  await page.goto("/monitoring?stage=prod");
  const joined = (await openItem(page, /Run failed/)).getByRole("link", { name: "Runbook for run_failed (opens in a new tab)" });
  await expect(joined).toHaveText("Runbook ↗ for run_failed (opens in a new tab)");
  await expect(joined.locator("[aria-hidden=true]")).toHaveText("↗");
  await expect(joined).toHaveAttribute("href", `${BOOK}#run_failed`);
  await expect(joined).toHaveAttribute("target", "_blank");
  await expect(joined).toHaveAttribute("rel", "noopener noreferrer");
  const archive = (await openItem(page, /No durable write/)).getByRole("link", { name: /^Runbook for service_degraded/ });
  await expect(archive).toHaveAttribute("href", `${BOOK}#service_degraded`);
  await expect(archive).toHaveAttribute("rel", "noopener noreferrer");
  // One per open incident; a signal no incident is about has none.
  await expect(attention(page).locator("a", { hasText: "Runbook" })).toHaveCount(5);
  const quiet = attention(page).getByRole("listitem").filter({ has: page.locator('.mon-delivery[data-status="none"]') });
  await expect(quiet).toHaveCount(3);
  await expect(quiet.locator("a", { hasText: "Runbook" })).toHaveCount(0);
});

for (const [what, runbook] of [["null", null], ["absent (an older API)", undefined], ["not a web address", "javascript:alert(1)"]] as const) {
  test(`an incident whose runbook is ${what} shows no link and no placeholder`, async ({ page }) => {
    await page.route("**/api/v1/stages/prod/alerts/incidents", async (route) => {
      const body = await (await route.fetch()).json();
      for (const i of body.incidents) {
        if (runbook === undefined) delete i.runbook; else i.runbook = runbook;
      }
      await route.fulfill({ json: body });
    });
    await page.goto("/monitoring?stage=prod");
    await expect(card(page, "Alerts")).toContainText("5incidents");
    await expect(item(page, /Run failed/).locator(".mon-delivery")).toHaveText("Delivered");
    await expect(attention(page).locator("a", { hasText: "Runbook" })).toHaveCount(0);
    await expect(attention(page)).not.toContainText("Runbook");
  });
}

test("DEV's stale alert evaluator reads stale, and its quality is not configured", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (r) => reads.push(r.url()));
  await page.goto("/monitoring?stage=dev");
  await expect(page.getByRole("note")).toContainText("Stale: the alert evaluator has not run since");
  await expect(card(page, "Data quality")).toContainText("no quality manifest reader is configured for this stage");
  expect(reads.filter((u) => u.endsWith("/health/quality"))).toEqual([]);
});

for (const [scenario, row, words, notification] of [
  ["unavailable", /Incidents cannot be read/, "the alert evaluator has not written a state yet", "Unknown"],
  ["empty", /Run failed/, "no incident is open for it, so none was sent", "None"],
  ["not-provided", /Alert incidents are not available/, "no alert evaluator, or no key to read its state, is configured", "Not available"],
] as const) {
  test(`incidents read as ${scenario}, never as a quiet stage`, async ({ page }) => {
    await page.goto(`/monitoring?stage=prod&mock=${scenario}`);
    await expect(item(page, row)).toContainText(words);
    await expect(item(page, /Run failed/).locator(".mon-delivery")).toHaveText(notification);
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
  await expect(item(page, /Pipeline health is not available/)).toContainText("Your role may not read pipeline health on stage PROD.");
  await expect(chip(page, "Trino")).toContainText("Healthy");
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
  test(`at 390 px (${colorScheme}) the page does not scroll sideways; the pipelines table scrolls in its own region`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/monitoring?stage=prod");
    await expect(pipelines(page)).toBeVisible();
    await expect(await service(page, "Trino")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(nav(page).getByRole("link", { name: "Monitoring" })).toBeVisible();
    await expect(pipelines(page)).toHaveAttribute("tabindex", "0"); // keyboard users can scroll it
  });
}

test("a service that needs attention links to its logs where the portal can show them", async ({ page }) => {
  await page.goto("/monitoring?stage=prod");
  const trino = await service(page, "Trino");
  // The mock's role may not read PROD's log archive, so no link is offered, and the panel says so.
  await expect(trino.getByRole("link", { name: /View logs/ })).toHaveCount(0);
  await page.goto("/monitoring?stage=dev");
  const link = (await service(page, "Trino")).getByRole("link", { name: "View logs of Trino" });
  await expect(link).toHaveAttribute("href", /\/monitoring\/dev\/logs\?date=\d{4}-\d\d-\d\d&hour=\d+&component=trino$/);
});

test("pipeline names link to their runs, and a failed count to those failed runs in the window shown", async ({ page }) => {
  await page.goto("/monitoring?stage=prod");
  const sales = await openPipe(page, "sales_orders");
  await expect(sales.getByRole("link", { name: "Runs of sales_orders", exact: true })).toHaveAttribute("href", "/monitoring/prod/runs?job=sales_orders");
  await expect(sales.getByRole("link", { name: /^1 failed in last 24h/ })).toHaveAttribute("href", "/monitoring/prod/runs?job=sales_orders&status=failed&window=24h");
  await expect((await openItem(page, /Run failed/)).getByRole("link", { name: "Runs of sales_orders", exact: true }))
    .toHaveAttribute("href", "/monitoring/prod/runs?job=sales_orders");
  await expect(sales.getByRole("link", { name: "Open run c94cbcb0" }).first()).toHaveAttribute("href", /\/monitoring\/prod\/runs\/c94cbcb0-/);
});

for (const width of [1440, 1100, 900, 390]) {
  test(`at ${width} px the summary gauges sit four across, two by two or one a row, never three and one`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/monitoring?stage=prod");
    await expect(pipelines(page)).toBeVisible();
    const tops = await page.locator(".mon-card").evaluateAll((cards) => cards.map((c) => Math.round(c.getBoundingClientRect().top)));
    expect(tops).toHaveLength(4);
    const rows = [...new Set(tops)].map((t) => tops.filter((x) => x === t).length);
    expect([[4], [2, 2], [1, 1, 1, 1]]).toContainEqual(rows);
  });
}

for (const width of [1440, 1100, 900]) {
  test(`at ${width} px the Pipelines table shows every column whole, even with long pipeline names`, async ({ page }) => {
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
    expect(await pipelines(page).evaluate((r) => r.scrollWidth - r.clientWidth)).toBeLessThanOrEqual(0);
  });
}

test("a run that failed before its quality checks finished reads unknown and incomplete, in the API's words", async ({ page }) => {
  await page.goto("/monitoring?stage=prod&mock=unfinished");
  const web = await openPipe(page, "web_events");
  await expect(web).toContainText("Unknown");
  await expect(web).toContainText("Incomplete");
  await expect(web).toContainText("2 passed");
  await expect(web.locator(".mon-quality-why")).toHaveText("the run failed before its quality checks finished");
  await expect(card(page, "Data quality")).toContainText("counts from 3 of 4 pipelines · 2 incomplete");
  // The other routes agree: web_events' latest run is that failed run, and its link opens the run.
  await expect(web).toContainText("Critical");
  await expect(web).toContainText("1 failed since");
  await web.getByRole("link", { name: "Open run 7f3a1c62" }).first().click();
  await expect(page).toHaveURL(/\/monitoring\/prod\/runs\/7f3a1c62-9e4b-4d08-b5a1-3c6e2d9f8b14$/);
  await expect(page.getByRole("heading", { level: 2, name: "web_events" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Run" })).toContainText("floe_bronze_web_events");
  await expect(page.getByRole("region", { name: "Quality checks", exact: true })).toContainText("2 passed");
});

test("screenshots: monitoring", async ({ page }) => {
  await shoot(page, "monitoring", async () => {
    await page.goto("/monitoring?stage=prod");
    await expect(chip(page, "Log archive")).toBeVisible();
    await expect(pipelines(page)).toBeVisible();
  });
  await shoot(page, "monitoring-unavailable", async () => {
    await page.goto("/monitoring?stage=prod&mock=unavailable");
    await expect(attention(page)).toContainText("Incidents cannot be read");
  });
  await shoot(page, "monitoring-services-healthy", async () => {
    await page.goto("/monitoring?stage=prod&mock=healthy");
    await expect(card(page, "Services")).toContainText("6/6");
    await expect(pipelines(page)).toBeVisible();
  });
  await shoot(page, "monitoring-quality-unfinished", async () => {
    await page.goto("/monitoring?stage=prod&mock=unfinished");
    await expect(pipe(page, "web_events")).toContainText("Incomplete");
  });
  await shoot(page, "monitoring-dev", async () => {
    await page.goto("/monitoring?stage=dev");
    await expect(attention(page)).toContainText("Dagster could not be read");
  });
});
