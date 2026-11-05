import { expect, test, type Page } from "@playwright/test";
import { shoot } from "./shots";

const results = (page: Page) => page.getByRole("region", { name: "Query results" });
// The explorer's schema button; its arrow is aria-hidden.
const schema = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const alert = (page: Page) => page.getByRole("alert");

async function open(page: Page) {
  await page.goto("/queries");
  await expect(schema(page, "bronze")).toBeVisible(); // capabilities and schemas loaded
}

async function type(page: Page, sql: string) {
  await page.locator(".cm-content").fill(sql);
}

async function run(page: Page, sql: string) {
  await type(page, sql);
  await page.getByRole("button", { name: "▶ RUN" }).click();
}

test("the explorer lists schemas and their tables", async ({ page }) => {
  await open(page);
  for (const s of ["bronze", "gold_sales", "information_schema", "scratch", "silver"]) {
    await expect(schema(page, s)).toBeVisible();
  }
  await schema(page, "gold_sales").click();
  await expect(page.getByText("revenue_by_region")).toBeVisible();
  await expect(page.getByText("view", { exact: true })).toBeVisible();
  await expect(page.getByText("daily_orders")).toBeVisible();
});

test("search narrows schemas, and tables within a chosen schema", async ({ page }) => {
  await open(page);
  await page.getByLabel("Search the explorer").fill("gold");
  await expect(schema(page, "silver")).toHaveCount(0);
  await expect(schema(page, "gold_sales")).toBeVisible();
  await page.getByLabel("Search the explorer").fill("");
  await page.getByRole("combobox", { name: "Schema" }).selectOption("silver");
  await page.getByLabel("Search the explorer").fill("event");
  await expect(page.getByText("events", { exact: true })).toBeVisible();
  await expect(page.getByText("orders", { exact: true })).toHaveCount(0);
});

test("a chosen schema is the default for unqualified tables", async ({ page }) => {
  await open(page);
  await run(page, "SELECT * FROM orders");
  await expect(alert(page)).toContainText("Schema must be specified when session schema is not set");

  await page.getByRole("combobox", { name: "Schema" }).selectOption("silver");
  await expect(page.locator("#q-ctx")).toHaveText("Unqualified tables resolve in silver");
  await page.getByRole("button", { name: "▶ RUN" }).click();
  await expect(page.getByRole("status").filter({ hasText: "COMPLETED" })).toBeVisible();
  await expect(results(page).getByRole("columnheader", { name: /order_id/ })).toBeVisible();
  await expect(results(page).getByRole("row")).toHaveCount(6); // header and 5 rows
  await expect(results(page).locator(".q-null")).toHaveText("NULL");
  // HTML-looking text is shown as text, never parsed.
  await expect(results(page).getByText("<b>bold</b>")).toBeVisible();
  await expect(results(page).locator("script, b")).toHaveCount(0);
});

test("a write is refused with the API's message", async ({ page }) => {
  await open(page);
  await run(page, "DROP TABLE silver.orders");
  await expect(alert(page)).toContainText("only read queries (SELECT, WITH, VALUES, TABLE) are offered in the portal yet");
});

test("a syntax error shows the engine's message", async ({ page }) => {
  await open(page);
  await run(page, "syntax_error");
  await expect(alert(page)).toContainText("mismatched input 'syntax_error'");
});

test("a slow query can be cancelled", async ({ page }) => {
  await open(page);
  await run(page, "SELECT * FROM silver.orders -- slow");
  await expect(page.getByRole("status").filter({ hasText: "RUNNING" })).toBeVisible();
  await page.getByRole("button", { name: "■ Cancel" }).click();
  await expect(page.getByRole("status").filter({ hasText: "CANCELLED" })).toBeVisible();
  await expect(page.getByRole("button", { name: "▶ RUN" })).toBeVisible();
});

test("a big result is paged in and ends truncated", async ({ page }) => {
  await open(page);
  await run(page, "SELECT * FROM silver.orders -- big");
  // The API keeps the status running while it has more, so rows arrive page by page.
  await expect(page.getByRole("button", { name: "Load more rows" })).toBeVisible();
  await expect(page.getByText("Truncated: the server returned only part of the result.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("250 ROWS", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more rows" })).toHaveCount(0);
});

test("the result downloads as CSV", async ({ page }) => {
  await open(page);
  await run(page, "SELECT * FROM silver.orders");
  await expect(page.getByRole("status").filter({ hasText: "COMPLETED" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: /Download/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("query-results.csv");
});

test("Ctrl/Cmd+Enter runs the query", async ({ page }) => {
  await open(page);
  await type(page, "SELECT 1");
  await page.locator(".cm-content").press("ControlOrMeta+Enter");
  await expect(page.getByRole("status").filter({ hasText: "COMPLETED" })).toBeVisible();
  await expect(results(page).getByRole("columnheader", { name: /_col0/ })).toBeVisible();
});

test("screenshots: queries with a result", async ({ page }) => {
  await shoot(page, "queries", async () => {
    await open(page);
    await run(page, "SELECT * FROM silver.orders");
    await expect(page.getByRole("status").filter({ hasText: "COMPLETED" })).toBeVisible();
  });
});
