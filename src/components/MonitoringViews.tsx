import { NavLink } from "react-router";

/** Monitoring's views, Overview, Metrics, Runs and Logs, keeping the stage when switching. Runs and Logs are per stage:
 * they show once one is known. Runs stays current on one run's page, which is under it. */
export function MonitoringViews({ stage }: { stage?: string }) {
  const search = stage ? `?stage=${encodeURIComponent(stage)}` : "";
  return (
    <nav className="mon-views" aria-label="Monitoring views">
      <NavLink to={{ pathname: "/monitoring", search }} end>Overview</NavLink>
      <NavLink to={{ pathname: "/monitoring/metrics", search }}>Metrics</NavLink>
      {stage && <NavLink to={`/monitoring/${encodeURIComponent(stage)}/runs`}>Runs</NavLink>}
      {stage && <NavLink to={`/monitoring/${encodeURIComponent(stage)}/logs`} end>Logs</NavLink>}
    </nav>
  );
}
