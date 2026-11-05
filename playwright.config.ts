import { defineConfig } from "@playwright/test";

const port = Number(process.env.PW_PORT ?? 5199);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results/artifacts", // screenshots go to test-results/screenshots, kept apart from traces
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    trace: "retain-on-failure",
    // Set PW_CHROMIUM when the installed browser is not the revision this Playwright version expects.
    launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined },
  },
  webServer: {
    command: `npm run mock -- --port ${port} --strictPort`,
    url: `${baseURL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
