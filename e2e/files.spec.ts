import { expect, test, type Page } from "@playwright/test";
import { shoot } from "./shots";

// The mock keeps one in-memory store for the whole run, so each test works on names of its own.
const BRONZE = "openlakeforge-dev-bronze";
const orders = `/files?stage=dev&bucket=${BRONZE}&prefix=raw%2Forders%2F`;
const nav = (page: Page) => page.getByRole("navigation", { name: "Primary" });
const dialog = (page: Page) => page.getByRole("dialog");
const rowOf = (page: Page, name: string) => page.getByRole("row").filter({ has: page.getByText(name, { exact: true }) });
const pick = (page: Page, name: string) => page.getByRole("checkbox", { name: `Select ${name}` }).check();

const customers = `/files?stage=dev&bucket=${BRONZE}&prefix=raw%2Fcustomers%2F`;
const stamp = Date.now();

async function openOrders(page: Page) {
  await page.goto(orders);
  await expect(page.getByText("_manifest.json", { exact: true })).toBeVisible();
}

test("a data-engineer sees Files under Queries and browses to a folder", async ({ page }) => {
  await page.goto("/services");
  await expect(nav(page).getByRole("link")).toHaveText(["Services", "Queries", "Files"]);
  await nav(page).getByRole("link", { name: "Files" }).click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByRole("heading", { name: "Files", level: 1 })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Stage" }).locator("option")).toHaveText(["DEV"]);
  await expect(page.getByRole("link", { name: /^openlakeforge-dev-/ })).toHaveCount(3);
  await page.getByPlaceholder("Filter by name…").fill("gold");
  await expect(page.getByRole("link", { name: /^openlakeforge-dev-/ })).toHaveCount(1);

  await page.getByPlaceholder("Filter by name…").fill("");
  await page.getByRole("link", { name: BRONZE }).click();
  await page.getByRole("link", { name: "raw/" }).click();
  await page.getByRole("link", { name: "orders/" }).click();
  await expect(page).toHaveURL(new RegExp(`bucket=${BRONZE}&prefix=raw%2Forders%2F$`));
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs).toContainText("Buckets/" + BRONZE + "/raw/orders");
  await expect(page.getByText("orders.avsc", { exact: true })).toBeVisible(); // the listing has loaded
  const names = await page.getByRole("row").locator("td:nth-child(2)").allTextContents();
  expect(names).toEqual(["2026-11-14/", "2026-11-15/", "2026-11-16/", "_manifest.json", "orders_2026-11-16.parquet", "orders.avsc"]);

  // Back, forward and reload keep the place.
  await page.goBack();
  await expect(page.getByRole("link", { name: "orders/", exact: true })).toBeVisible();
  await page.goForward();
  await page.reload();
  await expect(page.getByText("_manifest.json", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`prefix=raw%2Forders%2F$`));
});

test("the toolbar follows the selection and a file downloads", async ({ page }) => {
  await openOrders(page);
  const bar = page.getByRole("toolbar", { name: "Object actions" });
  for (const n of ["Download", "Rename", "Delete"]) await expect(bar.getByRole("button", { name: n })).toBeDisabled();
  await pick(page, "orders.avsc");
  for (const n of ["Download", "Rename", "Delete"]) await expect(bar.getByRole("button", { name: n })).toBeEnabled();
  await pick(page, "2026-11-14/");
  await expect(bar.getByRole("button", { name: "Download" })).toBeDisabled();
  await expect(bar.getByRole("button", { name: "Rename" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Select 2026-11-14/" }).uncheck();
  const download = page.waitForEvent("download");
  await bar.getByRole("button", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toBe("orders.avsc");
});

test("several files upload with progress and show in the listing; too large and existing names are refused", async ({ page }) => {
  await page.goto(customers);
  await expect(page.getByText("customers.csv", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(dialog(page)).toBeVisible();
  await page.getByLabel("Choose files").setInputFiles([
    { name: `up-one-${stamp}.csv`, mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") },
    { name: `up-two-${stamp}.csv`, mimeType: "text/csv", buffer: Buffer.from("c,d\n3,4\n") },
    { name: "customers.csv", mimeType: "application/json", buffer: Buffer.from("{}") },
    { name: "up-big.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(6 * 1024 * 1024) },
  ]);
  await expect(dialog(page).getByText("Done")).toHaveCount(2);
  await expect(dialog(page).getByText("object 'raw/customers/customers.csv' already exists")).toBeVisible();
  await expect(dialog(page).getByText(/^Too large: the limit is 5\.0 MB/)).toBeVisible();
  await dialog(page).getByRole("button", { name: "Hide" }).click();
  await expect(rowOf(page, `up-one-${stamp}.csv`)).toBeVisible();
  await expect(rowOf(page, `up-two-${stamp}.csv`)).toBeVisible();
  await page.keyboard.press("Escape");
});

test("create folder, rename a file and a folder, then delete several items", async ({ page }) => {
  const folder = `e2e-folder-${stamp}`, renamed = `e2e-renamed-${stamp}`, doc = `e2e-doc-${stamp}.txt`, doc2 = `e2e-doc-v2-${stamp}.txt`;
  const bar = page.getByRole("toolbar", { name: "Object actions" });
  await page.goto(customers);
  await expect(page.getByText("customers.csv", { exact: true })).toBeVisible();

  await bar.getByRole("button", { name: "Create folder" }).click();
  await dialog(page).getByRole("textbox", { name: "Folder name" }).fill("a/b");
  await dialog(page).getByRole("button", { name: "Create" }).click();
  await expect(dialog(page).getByRole("alert")).toHaveText("A name cannot contain /.");
  await dialog(page).getByRole("textbox", { name: "Folder name" }).fill(folder);
  await dialog(page).getByRole("button", { name: "Create" }).click();
  await expect(rowOf(page, `${folder}/`)).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);

  await bar.getByRole("button", { name: "Create folder" }).click();
  await dialog(page).getByRole("textbox", { name: "Folder name" }).fill(folder);
  await dialog(page).getByRole("button", { name: "Create" }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("already exists"); // the API's 409
  await dialog(page).getByRole("button", { name: "Cancel" }).click();

  // Rename a folder: the listing shows the new name.
  await pick(page, `${folder}/`);
  await bar.getByRole("button", { name: "Rename" }).click();
  await dialog(page).getByRole("textbox", { name: "New name" }).fill(renamed);
  await dialog(page).getByRole("button", { name: "Rename" }).click();
  await expect(rowOf(page, `${renamed}/`)).toBeVisible();
  await expect(rowOf(page, `${folder}/`)).toHaveCount(0);

  // Upload a file, then rename it through the row menu.
  await bar.getByRole("button", { name: "Upload" }).click();
  await page.getByLabel("Choose files").setInputFiles({ name: doc, mimeType: "text/plain", buffer: Buffer.from("hi") });
  await expect(dialog(page).getByText("Done")).toBeVisible();
  await dialog(page).getByRole("button", { name: "Hide" }).click();
  await page.getByRole("button", { name: `Actions for ${doc}` }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await dialog(page).getByRole("textbox", { name: "New name" }).fill(doc2);
  await dialog(page).getByRole("button", { name: "Rename" }).click();
  await expect(rowOf(page, doc2)).toBeVisible();
  await expect(rowOf(page, doc)).toHaveCount(0);

  // Delete the folder and the file together.
  await pick(page, `${renamed}/`);
  await pick(page, doc2);
  await bar.getByRole("button", { name: "Delete" }).click();
  await expect(dialog(page)).toContainText("Delete 2 items?");
  await expect(dialog(page)).toContainText("This can’t be undone.");
  await dialog(page).getByRole("button", { name: "Delete" }).click();
  await expect(rowOf(page, `${renamed}/`)).toHaveCount(0);
  await expect(rowOf(page, doc2)).toHaveCount(0);
  await expect(rowOf(page, "customers.csv")).toBeVisible();
});

test("an empty bucket shows the empty folder state, and a long folder pages in", async ({ page }) => {
  await page.goto("/files?stage=dev&bucket=openlakeforge-dev-gold");
  await expect(page.getByText("Empty folder")).toBeVisible();
  await page.goto("/files?stage=dev&bucket=openlakeforge-dev-silver&prefix=events%2F");
  await expect(page.getByRole("row")).toHaveCount(101); // header and a first page of 100
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("row")).toHaveCount(121);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
});

test("the keyboard drives the list and dialogs", async ({ page }) => {
  await openOrders(page);
  await page.getByRole("region", { name: "Object list" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(page.getByRole("checkbox", { name: "Select _manifest.json" })).toBeChecked();
  await page.keyboard.press("F2");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("textbox")).toBeFocused();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    await expect(dialog(page).locator(":focus")).toHaveCount(1); // focus never leaves the dialog
  }
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole("region", { name: "Object list" }).focus();
  await page.keyboard.press("Delete");
  await expect(dialog(page)).toContainText("Delete 1 item?");
  await page.keyboard.press("Escape");
});

test("Files is absent from the navigation for a viewer, and /files says so", async ({ page }) => {
  // Analyst and viewer get no stage from file-capabilities.
  await page.route("**/api/v1/file-capabilities", (route) => route.fulfill({ json: { stages: [], max_upload_bytes: 0 } }));
  await page.goto("/queries");
  await expect(nav(page).getByRole("link", { name: "Queries" })).toBeVisible();
  await expect(nav(page).getByRole("link", { name: "Files" })).toHaveCount(0);
  await page.goto("/files");
  await expect(page.getByText("Files are not available to you on any stage.")).toBeVisible();
});

test("screenshots: buckets and a folder", async ({ page }) => {
  await shoot(page, "files-buckets", async () => {
    await page.goto("/files");
    await expect(page.getByRole("link", { name: BRONZE })).toBeVisible();
  });
  await shoot(page, "files-browse", async () => {
    await openOrders(page);
    await pick(page, "_manifest.json");
  });
});
