import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  // Backward-compatible entry: the old landing page now lives at /services.
  index("routes/home.tsx"),
  layout("routes/shell.tsx", [
    route("services", "routes/services.tsx"),
    route("queries", "routes/queries.tsx"),
  ]),
  // OpenLakeForge's Logout redirects to exactly /signed-out.html, outside the sign-in perimeter.
  route("signed-out.html", "routes/signed-out.tsx"),
  route("healthz", "routes/healthz.ts"),
] satisfies RouteConfig;
