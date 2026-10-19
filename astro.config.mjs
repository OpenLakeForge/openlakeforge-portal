import { defineConfig } from "astro/config";

export default defineConfig({
  build: {
    // One self-contained HTML file: the portal is served from inside the
    // cluster, and OpenLakeForge's e2e check expects the only href attributes
    // on the page to be route links, so no <link rel="stylesheet">.
    inlineStylesheets: "always",
  },
});
