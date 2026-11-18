import type { HealthState } from "../lib/health-api";

const LABEL: Record<HealthState, string> = {
  healthy: "Healthy", warning: "Warning", critical: "Critical", unknown: "Unknown", disabled: "Disabled",
};

/** Figma `MON / Status badge`: one of the five `HealthState`s. The dot is decoration; the word carries the state. */
export function StatusBadge({ state }: { state: HealthState }) {
  return (
    <span className="mon-badge" data-state={state}>
      <span className="mon-dot" aria-hidden="true" />
      {LABEL[state]}
    </span>
  );
}
