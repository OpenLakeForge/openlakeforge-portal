import { data } from "react-router";
import { MonitoringMetrics } from "../components/MonitoringMetrics";
import { loadRoutes, sections } from "../lib/routes.server";
import type { Route } from "./+types/monitoring-metrics";

export const meta = () => [{ title: "Metrics · Monitoring · OpenLakeForge" }];

// As on the overview: the stage names come from the deployed routes; every series comes from the Platform API.
export function loader() {
  const stages = sections(loadRoutes().routes).map((s) => s.stage).filter((s) => s !== "shared");
  return data({ stages }, { headers: { "Cache-Control": "no-store" } });
}

export const headers: Route.HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export default function MonitoringMetricsRoute({ loaderData }: Route.ComponentProps) {
  return <MonitoringMetrics stages={loaderData.stages} />;
}
