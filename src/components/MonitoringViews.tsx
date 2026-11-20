import { NavLink } from "react-router";

/** Monitoring's two views, Overview and Metrics, keeping the stage when switching. */
export function MonitoringViews({ stage }: { stage?: string }) {
  const search = stage ? `?stage=${encodeURIComponent(stage)}` : "";
  return (
    <nav className="mon-views" aria-label="Monitoring views">
      <NavLink to={{ pathname: "/monitoring", search }} end>Overview</NavLink>
      <NavLink to={{ pathname: "/monitoring/metrics", search }}>Metrics</NavLink>
    </nav>
  );
}
