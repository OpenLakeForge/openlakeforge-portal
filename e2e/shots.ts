import type { Page } from "@playwright/test";

// Full-page screenshots for human review (CI uploads them), never compared pixel by pixel.
const VARIANTS = [
  { name: "dark", colorScheme: "dark", viewport: { width: 1280, height: 800 } },
  { name: "light", colorScheme: "light", viewport: { width: 1280, height: 800 } },
  { name: "390px", colorScheme: "dark", viewport: { width: 390, height: 844 } },
] as const;

/** Calls `show` (which navigates and reaches the state to capture) once per variant and saves each. */
export async function shoot(page: Page, name: string, show: () => Promise<void>) {
  for (const v of VARIANTS) {
    await page.emulateMedia({ colorScheme: v.colorScheme });
    await page.setViewportSize(v.viewport);
    await show();
    await page.screenshot({ path: `test-results/screenshots/${name}-${v.name}.png`, fullPage: true });
  }
}
