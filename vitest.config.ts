import { defineConfig } from "vitest/config";

// Separate from vite.config.ts: the React Router plugin only works in its own dev/build.
export default defineConfig({ test: { setupFiles: ["./vitest.setup.ts"] } });
