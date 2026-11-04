import { data } from "react-router";
import { Services } from "../components/Services";
import { loadRoutes, sections } from "../lib/routes.server";
import type { Route } from "./+types/services";

export const meta = () => [{ title: "Services · OpenLakeForge" }];

export function loader() {
  const { routes, problem } = loadRoutes();
  return data({ stages: sections(routes), problem }, { headers: { "Cache-Control": "no-store" } });
}

export const headers: Route.HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export default function ServicesPage({ loaderData }: Route.ComponentProps) {
  return <Services {...loaderData} />;
}
