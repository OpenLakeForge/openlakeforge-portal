// How a log line reads on one row. The stored line is never changed: opening a row shows it whole.

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
/** Dagster's console prefix, `<time> - <logger> - <LEVEL> - `: the row already has its time and level. */
const PREFIX = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:[.,]\d+)?(?: ?[+-]\d{4}|Z)? - [\w.]+ - (?:DEBUG|INFO|WARNING|ERROR|CRITICAL) - /;
/** A run id, with the pid Dagster writes after it. */
const RUN_ID = /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12} - (?:\d+ - )?/g;

/** The line without its terminal colour codes. */
export const plain = (line: string) => line.replace(ANSI, "");

/** The line's message: no colour codes, and none of the console prefix a row repeats. */
export const message = (line: string) => plain(line).replace(PREFIX, "").replace(RUN_ID, "");
