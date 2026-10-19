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

/**
 * How each contract service is presented. Logos come from OpenLakeForge's
 * docs/architecture/diagrams/src/overview/logos.json, which records their
 * sources. A service missing here still gets a card, with a monogram.
 */
const presentation: Record<string, { title: string; summary: string; logo: string }> = {
  orchestration: { title: "Orchestration", summary: "Runs, schedules and asset lineage.", logo: "/logos/dagster.svg" },
  reporting: { title: "Reporting", summary: "Dashboards over the Gold marts.", logo: "/logos/superset.png" },
  query: { title: "Query", summary: "SQL over every Iceberg table.", logo: "/logos/trino.svg" },
  identity: { title: "Sign-in", summary: "The login page every service sends you to.", logo: "/logos/dex.svg" },
  governance_service: { title: "Governance", summary: "Catalog, glossary and column-level lineage.", logo: "/logos/openmetadata.svg" },
};

const titleCase = (value: string) => value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The routes to render: the JSON file named by OLF_ROUTES_FILE (the same
 * shape as the portal module's `links` variable in OpenLakeForge), or the
 * bundled example so `npm run dev` works without a cluster.
 */
export function loadRoutes(): Record<string, Route> {
  const file = process.env.OLF_ROUTES_FILE;
  return file ? JSON.parse(readFileSync(file, "utf-8")) : example;
}

/** Shared services first, then each stage in name order, each a step deeper. */
export function sections(routes: Record<string, Route>): Section[] {
  const byStage = new Map<string, Service[]>();
  for (const key of Object.keys(routes).sort()) {
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
