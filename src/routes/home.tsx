import { data } from "react-router";
import { Index } from "../components/Index";
import { Page } from "../components/Page";
import { loadRoutes, sections, signOutUrl } from "../lib/routes.server";
import type { Route } from "./+types/home";

// Runs on the server for every request: the mounted file is read each time, and
// only what the page renders (labels, public URLs) reaches the browser.
export function loader() {
  const { routes, problem } = loadRoutes();
  return data(
    { routeCount: Object.keys(routes).length, stages: sections(routes), signOut: signOutUrl(routes), problem },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const headers: Route.HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export default function Home({ loaderData }: Route.ComponentProps) {
  const { signOut, ...index } = loaderData;
  return (
    <Page signOut={signOut}>
      <Index {...index} />
    </Page>
  );
}
