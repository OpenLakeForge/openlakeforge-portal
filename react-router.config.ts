import type { Config } from "@react-router/dev/config";

// Rendered per request: the routes are a deploy-time parameter that
// OpenLakeForge mounts into the container (see src/lib/routes.server.ts), not
// something known when the image is built.
export default { appDirectory: "src", ssr: true } satisfies Config;
