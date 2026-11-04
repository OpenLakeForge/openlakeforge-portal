import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  // OpenLakeForge's Logout redirects to exactly /signed-out.html, outside the sign-in perimeter.
  route("signed-out.html", "routes/signed-out.tsx"),
  route("healthz", "routes/healthz.ts"),
] satisfies RouteConfig;
