import { data, Outlet } from "react-router";
import { AppShell } from "../components/Shell";
import { loadRoutes, signOutUrl } from "../lib/routes.server";
import type { Route } from "./+types/shell";

// Runs on the server for every request: the mounted file is read each time, and
// only what the page renders (labels, public URLs) reaches the browser.
export function loader() {
  return data({ signOut: signOutUrl(loadRoutes().routes) }, { headers: { "Cache-Control": "no-store" } });
}

// Every page in the shell shows the sign-out link, so none may be cached.
export const headers: Route.HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export default function Shell({ loaderData }: Route.ComponentProps) {
  return (
    <AppShell signOut={loaderData.signOut}>
      <Outlet />
    </AppShell>
  );
}
