// How a log line reads on one row. The stored line is never changed: opening a row shows it whole.

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
/** A console prefix, `<time> - <logger> - <LEVEL> - `: the row already has its time and level. */
const PREFIX = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:[.,]\d+)?(?: ?[+-]\d{4}|Z)? - ([\w.]+) - (?:DEBUG|INFO|WARNING|ERROR|CRITICAL) - /;
/** A Dagster run line's `<job> - <run id> - <pid> - ` after that prefix (the pid is not always there): the job stays. */
const RUN_ID = /^([\w-]+ - )[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12} - (?:\d+ - )?/;

/** The line without its terminal colour codes. */
export const plain = (line: string) => line.replace(ANSI, "");

/** The line's message: no colour codes, and none of the console prefix a row repeats. An id inside the message stays. */
export function message(line: string): string {
  const text = plain(line);
  const prefix = PREFIX.exec(text);
  if (!prefix) return text;
  const rest = text.slice(prefix[0].length);
  return prefix[1] === "dagster" ? rest.replace(RUN_ID, "$1") : rest;
}
