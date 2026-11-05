import { expect, test } from "@playwright/test";

test("the sidebar marks the current page", async ({ page }) => {
  const nav = page.getByRole("navigation", { name: "Primary" });
  await page.goto("/services");
  await expect(nav.getByRole("link", { name: "Services" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Queries" })).not.toHaveAttribute("aria-current");
  await nav.getByRole("link", { name: "Queries" }).click();
  await expect(page).toHaveURL(/\/queries$/);
  await expect(nav.getByRole("link", { name: "Queries" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Services" })).not.toHaveAttribute("aria-current");
});
