import { data } from "react-router";
import { Monitoring } from "../components/Monitoring";
import { loadRoutes, sections } from "../lib/routes.server";
import type { Route } from "./+types/monitoring";

export const meta = () => [{ title: "Monitoring · OpenLakeForge" }];

// The stage names come from the deployed routes, as on Services; every health answer comes from the Platform API.
export function loader() {
  const stages = sections(loadRoutes().routes).map((s) => s.stage).filter((s) => s !== "shared");
  return data({ stages }, { headers: { "Cache-Control": "no-store" } });
}

export const headers: Route.HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export default function MonitoringRoute({ loaderData }: Route.ComponentProps) {
  return <Monitoring stages={loaderData.stages} />;
}
