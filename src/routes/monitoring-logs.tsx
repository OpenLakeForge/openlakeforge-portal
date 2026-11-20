import { data } from "react-router";
import { MonitoringLogs } from "../components/MonitoringLogs";
import { loadRoutes, sections } from "../lib/routes.server";
import type { Route } from "./+types/monitoring-logs";

export const meta = ({ params }: Route.MetaArgs) => [{ title: `Logs · ${params.stage.toUpperCase()} · Monitoring · OpenLakeForge` }];

// As on Runs: the stage names come from the deployed routes; every line comes from the Platform API.
export function loader({ params }: Route.LoaderArgs) {
  const stages = sections(loadRoutes().routes).map((s) => s.stage).filter((s) => s !== "shared");
  return data({ stage: params.stage, stages }, { headers: { "Cache-Control": "no-store" } });
}

export const headers: Route.HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export default function MonitoringLogsRoute({ loaderData }: Route.ComponentProps) {
  // Keyed by stage, so switching stage starts from a clean page.
  return <MonitoringLogs key={loaderData.stage} stage={loaderData.stage} stages={loaderData.stages} />;
}
