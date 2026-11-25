import { describe, expect, it } from "vitest";
import { message, plain } from "./log-line";

const ID = "0ce10f05-d149-4e76-b5bd-f45b8011be56";

describe("a log line on one row", () => {
  it("drops colour codes and the daemon's time, logger and level", () => {
    const line = "\x1b[32m2026-11-24 18:02:07 +0000\x1b[0m - dagster.daemon.QueuedRunCoordinatorDaemon - \x1b[34mINFO\x1b[0m - Launched 1 runs.";
    expect(message(line)).toBe("Launched 1 runs.");
    expect(plain(line)).toBe("2026-11-24 18:02:07 +0000 - dagster.daemon.QueuedRunCoordinatorDaemon - INFO - Launched 1 runs.");
  });

  it("drops a run's id and pid", () => {
    expect(message(`2026-11-24 18:03:26 +0000 - dagster - DEBUG - order_revenue_pipeline - ${ID} - 1 - RUN_START - Started.`))
      .toBe("order_revenue_pipeline - RUN_START - Started.");
  });

  it("keeps an id that is part of the message, with what follows it", () => {
    for (const line of [`Failed to fetch job ${ID} - 404 - Not Found`, `Lease ${ID} - 1 - expired`]) {
      expect(message(line)).toBe(line);
      expect(message(`2026-11-24 18:03:26 +0000 - dagster - ERROR - ${line}`)).toBe(line);
    }
  });

  it("leaves any other line as it is", () => {
    for (const line of ["org.apache.iceberg.exceptions.RESTException: Table does not exist", `{"event":"run_started","dagster_run_id":"${ID}"}`, "Totals: files=6 rows=56"]) {
      expect(message(line)).toBe(line);
    }
  });
});
