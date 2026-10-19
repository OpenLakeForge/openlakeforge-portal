import { defineConfig, passthroughImageService } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
  // Rendered per request: the routes are a deploy-time parameter that
  // OpenLakeForge mounts into the container (see src/lib/routes.ts), not
  // something known when the image is built.
  output: "server",
  adapter: node({ mode: "standalone" }),
  build: {
    // One self-contained HTML document: OpenLakeForge's e2e check expects the
    // only href attributes on the page to be route links, so no
    // <link rel="stylesheet">.
    inlineStylesheets: "always",
  },
  // The image runs dist/ alone, without node_modules: bundle every server
  // dependency, and skip sharp (the portal transforms no images).
  image: { service: passthroughImageService() },
  vite: { ssr: { noExternal: true } },
});
