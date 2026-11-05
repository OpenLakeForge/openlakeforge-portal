import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type Plugin } from "vite";

// OLF_MOCK_API=1 (npm run mock) serves a fake /api/v1 from the dev server. mock/api.ts is loaded by Vite
// at that moment rather than imported, so build, start and an image context without mock/ never touch it.
const mockApi = (): Plugin => ({
  name: "olf-mock-api",
  apply: "serve",
  async configureServer(server) {
    const { handle } = await server.ssrLoadModule("/mock/api.ts");
    server.middlewares.use("/api/v1", (req, res, next) => { handle(req, res).catch(next); });
  },
});

export default defineConfig({ plugins: [reactRouter(), ...(process.env.OLF_MOCK_API === "1" ? [mockApi()] : [])] });
