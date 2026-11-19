import { data } from "react-router";
import { MonitoringRun } from "../components/MonitoringRun";
import { loadRoutes } from "../lib/routes.server";
import type { Route } from "./+types/monitoring-run";

export const meta = ({ params }: Route.MetaArgs) => [{ title: `Run ${params.runId.slice(0, 8)} · Monitoring · OpenLakeForge` }];

// The stage's Dagster address comes from the deployed routes, as on Services, so "Open in Dagster" is a plain link to
// the run there: the browser never calls Dagster itself. Every answer about the run comes from the Platform API.
export function loader({ params }: Route.LoaderArgs) {
  const routes = Object.values(loadRoutes().routes);
  const dagster = routes.find((r) => r.stage === params.stage && r.name === "orchestration")?.url;
  return data({ stage: params.stage, runId: params.runId, dagster }, { headers: { "Cache-Control": "no-store" } });
}

export const headers: Route.HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export default function MonitoringRunRoute({ loaderData }: Route.ComponentProps) {
  // Keyed by run, so a link from one run to another starts from a clean page.
  return <MonitoringRun key={`${loaderData.stage}/${loaderData.runId}`} stage={loaderData.stage} runId={loaderData.runId} dagster={loaderData.dagster} />;
}
