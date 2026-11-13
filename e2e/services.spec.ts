import { expect, test } from "@playwright/test";
import { shoot } from "./shots";

test("services are grouped by stage and open in a new tab", async ({ page }) => {
  await page.goto("/services");
  for (const heading of ["DEV", "PROD", "Shared"]) await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
  const dev = page.getByRole("region", { name: "DEV" });
  await expect(dev.getByRole("link")).toHaveCount(2);
  const card = dev.getByRole("link", { name: /Orchestration/ });
  await expect(card).toHaveAttribute("href", "http://dagster-dev.olf.localhost");
  await expect(card).toHaveAttribute("target", "_blank");
  await expect(card).toHaveAttribute("rel", /noopener/);
});

test("the lake-bed contours are decorative", async ({ page }) => {
  await page.goto("/services");
  const contours = page.locator("svg.contours");
  await expect(contours).toHaveAttribute("aria-hidden", "true");
  await expect(contours.locator("path")).toHaveCount(9);
});

test("screenshots: services", async ({ page }) => {
  await shoot(page, "services", async () => {
    await page.goto("/services");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});
