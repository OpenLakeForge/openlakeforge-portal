import { configDefaults, defineConfig } from "vitest/config";

// Separate from vite.config.ts: the React Router plugin only works in its own dev/build.
// e2e/ holds Playwright specs (npm run test:ui), which vitest must not pick up.
export default defineConfig({ test: { setupFiles: ["./vitest.setup.ts"], exclude: [...configDefaults.exclude, "e2e/**"] } });
