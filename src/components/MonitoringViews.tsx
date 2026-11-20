import { NavLink } from "react-router";

/** Monitoring's views, Overview, Metrics and Runs, keeping the stage when switching. Runs is per stage: it shows once one is known. */
export function MonitoringViews({ stage }: { stage?: string }) {
  const search = stage ? `?stage=${encodeURIComponent(stage)}` : "";
  return (
    <nav className="mon-views" aria-label="Monitoring views">
      <NavLink to={{ pathname: "/monitoring", search }} end>Overview</NavLink>
      <NavLink to={{ pathname: "/monitoring/metrics", search }}>Metrics</NavLink>
      {stage && <NavLink to={`/monitoring/${encodeURIComponent(stage)}/runs`} end>Runs</NavLink>}
    </nav>
  );
}
