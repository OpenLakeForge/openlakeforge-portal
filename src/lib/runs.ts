// What a list of Dagster runs says, shared by the Runs page and the overview's runs gauge.

import type { Run } from "./health-api";

export type RunFilter = "failed" | "succeeded" | "in_progress";
export const RUN_FILTERS: readonly RunFilter[] = ["failed", "succeeded", "in_progress"];
/** Dagster's statuses of a run that has not ended. `CANCELED` ends a run without success or failure: it shows under All only. */
export const IN_PROGRESS = new Set(["QUEUED", "NOT_STARTED", "MANAGED", "STARTING", "STARTED", "CANCELING"]);

/** Whether a run's Dagster status is the one `filter` asks for. */
export function matchesStatus(status: string, filter: RunFilter | ""): boolean {
  if (filter === "failed") return status === "FAILURE";
  if (filter === "succeeded") return status === "SUCCESS";
  if (filter === "in_progress") return IN_PROGRESS.has(status);
  return true;
}

/** What the read covers of the window: everything, or only back to its oldest run when it reached the limit first. */
export function coverage(runs: Run[], limit: number, windowStart: number): { complete: boolean; oldest: number | null; coveredFrom: number | null } {
  const oldest = runs.length ? Math.min(...runs.map((r) => r.created_at)) : null;
  const complete = runs.length < limit;
  return { complete, oldest, coveredFrom: !complete && oldest !== null && oldest > windowStart ? oldest : null };
}
