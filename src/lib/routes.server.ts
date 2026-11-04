import { readFileSync } from "node:fs";
import example from "../data/routes.example.json";

/** One user-facing route, as OpenLakeForge's access contract lists it. */
export interface Route {
  stage: string;
  name: string;
  url: string;
}

export interface Service extends Route {
  host: string;
  title: string;
  summary: string;
  logo?: string;
  monogram: string;
}

export interface Section {
  stage: string;
  heading: string;
  depth: string;
  services: Service[];
}

/** What the page renders: the routes, or why there are none. */
export type RoutesResult = { routes: Record<string, Route>; problem?: undefined } | { routes: Record<string, Route>; problem: string };

/**
 * How each contract service is presented. Logos come from OpenLakeForge's
 * docs/architecture/diagrams/src/overview/logos.json, which records their
 * sources. A service missing here still gets a card, with a monogram.
 */
const presentation: Record<string, { title: string; summary: string; logo: string }> = {
  orchestration: { title: "Orchestration", summary: "Runs, schedules and asset lineage.", logo: "/logos/dagster.svg" },
  reporting: { title: "Reporting", summary: "Dashboards over the Gold marts.", logo: "/logos/superset.png" },
  query: { title: "Query", summary: "SQL over every Iceberg table.", logo: "/logos/trino.svg" },
  governance_service: { title: "Governance", summary: "Catalog, glossary and column-level lineage.", logo: "/logos/openmetadata.svg" },
  admin: { title: "Admin", summary: "Members and roles, managed as GitHub teams.", logo: "/logos/github.svg" },
};

const titleCase = (value: string) => value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Check that a parsed routes document has the shape of the portal module's
 * `links` variable in OpenLakeForge: contract ref -> { stage, name, url },
 * with an http(s) URL. Throws with the offending ref otherwise.
 */
export function parseRoutes(document: unknown): Record<string, Route> {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("the routes document must be a JSON object keyed by contract ref");
  }
  const routes: Record<string, Route> = {};
  for (const [ref, value] of Object.entries(document)) {
    const route = value as Partial<Route> | null;
    if (
      typeof route?.stage !== "string" || route.stage === "" ||
      typeof route.name !== "string" || route.name === "" ||
      typeof route.url !== "string" || !/^https?:\/\/[^\s"<>]+$/.test(route.url)
    ) {
      throw new Error(`route ${JSON.stringify(ref)} needs a stage, a name and an http(s) url`);
    }
    routes[ref] = { stage: route.stage, name: route.name, url: route.url };
  }
  return routes;
}

/**
 * The routes to render, read on every request so a changed ConfigMap shows
 * without a restart. OpenLakeForge sets OLF_ROUTES_FILE (the container image
 * defaults it to /config/routes.json). `npm run dev` without it falls back to
 * the bundled example; a production server without it renders an empty
 * portal that says so, rather than made-up routes.
 */
export function loadRoutes(file = process.env.OLF_ROUTES_FILE, dev = import.meta.env.DEV): RoutesResult {
  if (!file) {
    return dev ? { routes: parseRoutes(example) } : { routes: {}, problem: "OLF_ROUTES_FILE is not set." };
  }
  try {
    return { routes: parseRoutes(JSON.parse(readFileSync(file, "utf-8"))) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`openlakeforge-portal: cannot use ${file}: ${reason}`);
    return { routes: {}, problem: `Cannot read the routes file ${file}.` };
  }
}

/** The header's Sign out button, not a service card: only present when authentication is on. */
const SIGN_OUT = "shared/sign-out";
export const signOutUrl = (routes: Record<string, Route>): string | undefined => routes[SIGN_OUT]?.url;

/** Shared services first, then each stage in name order, each a step deeper. */
export function sections(routes: Record<string, Route>): Section[] {
  const byStage = new Map<string, Service[]>();
  for (const key of Object.keys(routes).filter((ref) => ref !== SIGN_OUT).sort()) {
    const route = routes[key];
    const shown = presentation[route.name];
    const title = shown?.title ?? titleCase(route.name);
    const service: Service = {
      ...route,
      host: route.url.replace(/^[a-z]+:\/\//, ""),
      title,
      summary: shown?.summary ?? "",
      logo: shown?.logo,
      monogram: title.slice(0, 2),
    };
    byStage.set(route.stage, [...(byStage.get(route.stage) ?? []), service]);
  }
  const stages = [...byStage.keys()].sort((a, b) => (a === "shared" ? -1 : b === "shared" ? 1 : a.localeCompare(b)));
  return stages.map((stage, index) => ({
    stage,
    heading: titleCase(stage),
    depth: `${String(index * 10).padStart(2, "0")} m`,
    services: byStage.get(stage) ?? [],
  }));
}
