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
  // Only the checks that did not pass are listed; the 14 passes wait behind their count.
  const checks = page.getByRole("region", { name: "Quality check results" });
  await expect(checks.getByRole("row")).toHaveCount(4);
  await expect(checks.getByRole("row").nth(1)).toContainText("ERROR");
  await expect(checks.getByRole("row", { name: /cast\.ordered_at/ })).toContainText("WARN");
  await expect(checks.getByRole("row", { name: /schema\.amount_type/ })).toContainText("Blocked the run");
  await expect(checks).not.toContainText("PASS");
  await expect(card(page, "Quality checks")).toContainText("3 of 17 did not pass");
  await expect(page.getByRole("region", { name: "Passed quality checks" })).toBeHidden();
  await card(page, "Quality checks").getByText("14 passed").click();
  await expect(page.getByRole("region", { name: "Passed quality checks" }).getByRole("row")).toHaveCount(15);
  await expect(card(page, "Data quality")).toContainText("2 error · 1 warn · 14 passed · 1 blocking");
  await expect(page.getByRole("list", { name: "Quality reports" }).getByRole("link")).toHaveCount(0);
  await expect(card(page, "What failed")).toContainText("These reports are not downloadable here");
});

test("the failure summary comes first and carries the logs, reports, runbook, Dagster and the job's runs; no Next step", async ({ page }) => {
  await page.goto(`/monitoring/prod/runs/${FAILED}?mock=admin`);
  const what = card(page, "What failed");
  await expect(what).toContainText("SchemaMismatchError");
  await expect(page.locator(".run-card h2").first()).toHaveText("What failed");
  await expect(page.locator(".run-card h2").nth(1)).toHaveText("Logs");
  await expect(card(page, "Next step")).toHaveCount(0);
  await expect(what.getByText("When", { exact: true })).toBeVisible();
  await expect(what).toContainText(/Ended .*, after 1 min 5\d s/);
  await expect(what.getByRole("link", { name: /Runbook/ })).toHaveAttribute("href", "http://docs.olf.localhost/runbooks/alerting#failed_run");
  await expect(what.getByRole("link", { name: /Open in Dagster/ })).toHaveAttribute("href", `http://dagster-prod.olf.localhost/runs/${FAILED}`);
  await expect(page.getByRole("link", { name: /Open in Dagster/ })).toHaveCount(1);
  await expect(what.getByRole("link", { name: "All runs of sales_orders" })).toHaveAttribute("href", "/monitoring/prod/runs?job=sales_orders");
  await expect(what.getByRole("list", { name: "Quality reports" }).getByRole("link")).toHaveCount(2);
  await what.getByRole("link", { name: /^Logs/ }).click();
  await expect(page).toHaveURL(/#run-logs-h$/);
  // The logs sit at full width, as wide as the summary above them.
  const [a, b] = await Promise.all([what.boundingBox(), card(page, "Logs").boundingBox()]);
  expect(Math.round(b!.width)).toBe(Math.round(a!.width));
});

test("each open incident of the run links its runbook section in a new tab", async ({ page }) => {
  await page.goto(`/monitoring/prod/runs/${FAILED}`);
  const incidents = card(page, "Open incidents");
  await expect(incidents).toContainText("latest run failed");
  const failed = incidents.getByRole("link", { name: "Runbook for failed_run (opens in a new tab)" });
  await expect(failed).toHaveText("Runbook ↗");
  await expect(failed).toHaveAttribute("href", "http://docs.olf.localhost/runbooks/alerting#failed_run");
  await expect(failed).toHaveAttribute("target", "_blank");
  await expect(failed).toHaveAttribute("rel", "noopener noreferrer");
  await expect(incidents.getByRole("link", { name: "Runbook for quality_blocking (opens in a new tab)" }))
    .toHaveAttribute("href", "http://docs.olf.localhost/runbooks/alerting#quality_blocking");
  await expect(incidents.getByRole("link", { name: /Runbook/ })).toHaveCount(2);
});

for (const [what, runbook] of [["null", null], ["absent (an older API)", undefined], ["not a web address", "ftp://docs.example/runbooks"]] as const) {
  test(`the run's open incidents show no runbook link or placeholder when it is ${what}`, async ({ page }) => {
    await page.route("**/api/v1/stages/prod/alerts/incidents", async (route) => {
      const body = await (await route.fetch()).json();
      for (const i of body.incidents) {
        if (runbook === undefined) delete i.runbook; else i.runbook = runbook;
      }
      await route.fulfill({ json: body });
    });
    await page.goto(`/monitoring/prod/runs/${FAILED}`);
    const incidents = card(page, "Open incidents");
    await expect(incidents).toContainText("latest run failed");
    await expect(incidents).toContainText("Delivered opened notification");
    await expect(incidents.getByRole("link")).toHaveCount(0);
    await expect(incidents).not.toContainText("Runbook");
  });
}

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
  // Opened at warning and above: the run's 8 warnings, then all 308 lines on request.
  await expect(logs).toContainText("8 lines");
  await logs.getByRole("button", { name: "Show all levels" }).click();
  await expect(logs).toContainText("200+ lines");
  await logs.getByRole("button", { name: "Load more" }).click();
  await expect(logs).toContainText("308 lines");
  await expect(logs.getByRole("button", { name: "Load more" })).toHaveCount(0);
  const days = page.getByRole("region", { name: "Run log lines" }).getByRole("rowheader");
  await expect(days).toHaveCount(2);
  await expect(logs).toContainText("trino");
  await logs.getByRole("checkbox", { name: "Only this run's lines" }).check();
  await expect(page.getByRole("region", { name: "Run log lines" })).not.toContainText("trino");
});

test("a stage with no log archive (log_retention_days null) shows no retention", async ({ page }) => {
  await page.goto(`/monitoring/prod/runs/${FAILED}?mock=not-provided`);
  await expect(card(page, "Logs")).toContainText("Archived logs are not available");
  await expect(card(page, "Logs")).not.toContainText("Kept");
});

test("with log access the run's window shows each line's time and level, and the filters ask the API again", async ({ page }) => {
  await page.goto(`/monitoring/prod/runs/${FAILED}?mock=admin`);
  const lines = page.getByRole("region", { name: "Run log lines" });
  // The logs open on what matters: warning and above, with the way back to every level in plain sight.
  await expect(card(page, "Logs").getByRole("combobox", { name: "Level" })).toHaveValue("warning");
  await expect(lines.getByRole("row")).toHaveCount(4);
  await expect(card(page, "Logs")).toContainText("Showing warnings and above only.");
  await card(page, "Logs").getByRole("button", { name: "Jump to first error" }).click();
  await expect(lines.getByRole("row", { name: /floe_schema_mismatch/ })).toBeFocused();
  await card(page, "Logs").getByRole("button", { name: "Show all levels" }).click();
  await expect(lines.getByRole("row")).toHaveCount(12);
  await expect(lines.getByRole("row", { name: /floe_schema_mismatch/ })).toContainText(/\d\d:\d\d:\d\d\.\d{3}\s*ERROR/);
  // A v1 record has no time and no level: both cells stay empty.
  const v1 = lines.getByRole("row", { name: /\[v1\] exit code 1/ });
  await expect(v1.getByRole("cell").nth(0)).toBeEmpty();
  await expect(v1.getByRole("cell").nth(1)).toBeEmpty();
  const only = card(page, "Logs").getByRole("checkbox", { name: "Only this run's lines" });
  await expect(only).toHaveAccessibleDescription(/hides other workloads' lines from that window/);
  await only.check();
  await expect(lines.getByRole("row")).toHaveCount(10);
  await card(page, "Logs").getByRole("combobox", { name: "Level" }).selectOption("error");
  await expect(lines.getByRole("row")).toHaveCount(3);
});

test("a run with no warning line falls back to all levels and says so", async ({ page }) => {
  await page.goto(`/monitoring/prod/runs/${CRM}?mock=admin`);
  const logs = card(page, "Logs");
  await expect(logs).toContainText("No line at warning or above in the run's window, so all levels are shown.");
  await expect(logs.getByRole("combobox", { name: "Level" })).toHaveValue("");
  await expect(page.getByRole("region", { name: "Run log lines" })).toContainText("Run succeeded");
});

test("an API without log_retention_days reads the run's day from list_logs, at warning and above", async ({ page }) => {
  await page.route("**/api/v1/monitoring-capabilities", async (route) => {
    const body = await (await route.fetch()).json();
    for (const s of body.stages) delete s.log_retention_days;
    await route.fulfill({ json: body });
  });
  const reads: URL[] = [];
  page.on("request", (r) => { if (r.url().includes("/logs")) reads.push(new URL(r.url())); });
  await page.goto(`/monitoring/prod/runs/${FAILED}?mock=admin`);
  const logs = card(page, "Logs");
  await expect(logs).toContainText(/Archived \d{4}-\d\d-\d\d \(UTC\) · run c94cbcb0/);
  await expect(page.getByRole("region", { name: "Run log lines" }).getByRole("row")).toHaveCount(4);
  await expect(logs.getByRole("checkbox")).toHaveCount(0);
  await expect(logs.getByRole("combobox", { name: "Level" }).getByRole("option")).toHaveText(["All levels", "Warning and above", "Error and above"]);
  expect([...new Set(reads.map((u) => `${u.pathname} ${u.searchParams.get("severity")}`))]).toEqual(["/api/v1/stages/prod/logs warning"]);
  await logs.getByRole("button", { name: "Show all levels" }).click();
  await expect(page.getByRole("region", { name: "Run log lines" }).getByRole("row")).toHaveCount(9);
});

test("an incident and a pipelines row link to their run", async ({ page }) => {
  await page.goto("/monitoring?stage=prod");
  await expect(attention(page).getByRole("row", { name: /Quality check failed/ }).getByRole("link", { name: "Open run c94cbcb0" }))
    .toHaveAttribute("href", `/monitoring/prod/runs/${FAILED}`);
  await page.getByRole("region", { name: "Pipeline health" }).getByRole("row", { name: /crm_accounts/ }).getByRole("link", { name: "Open run 4be0c1a9" }).click();
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
