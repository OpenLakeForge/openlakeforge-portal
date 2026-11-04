// The Platform API contract for the query workspace (openlakeforge #800 query
// execution, #801 discovery), in one place so aligning with the final backend
// shape is a small diff. Same-origin and cookie-authenticated: no token in JS.
// Discovery types follow the written #801 backend; the execution types below are
// briefed, not built yet.
// shortcut: hand-written types and an assumed shape (rows as arrays aligned to
// columns, error as a string); generate them from the committed OpenAPI spec
// once #800/#801 land.

const BASE = "/api/v1";

export type StageCapability = { stage: string; engine: "trino"; available: boolean; export_formats: string[] };
export type Page<T> = { items: T[]; next_cursor: string | null };
export type Column = { name: string; type: string };
export type Cell = string | number | boolean | null | object;
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type QueryResult = {
  id: string;
  status: RunStatus;
  columns: Column[];
  rows: Cell[][];
  truncated: boolean;
  row_count: number;
  elapsed_ms: number;
  error?: string;
  next_cursor?: string | null;
};

/** status 0 is a network failure. `message` is safe, truthful text to show as is. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function explain(status: number, detail?: string): string {
  const more = detail ? ` ${detail}` : "";
  if (status === 0) return "The Platform API cannot be reached.";
  if (status === 401) return "Your session has expired. Reload the page to sign in again.";
  if (status === 403) return `Access denied.${more}`;
  if (status === 404) return `Not found.${more}`;
  if (status === 400 || status === 409 || status === 422) return `The query was rejected.${more}`;
  if (status === 413) return "The result is too large to export.";
  if (status === 502 || status === 503) return "The query engine is unreachable. Try again shortly.";
  if (status === 504) return "The query timed out.";
  return `The request failed (${status}).${more}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      credentials: "same-origin",
      ...init,
      // The API's CSRF guard needs a JSON content type on every state-changing call.
      headers: init.method && init.method !== "GET" ? { "Content-Type": "application/json" } : undefined,
    });
  } catch {
    throw new ApiError(0, explain(0));
  }
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, explain(res.status, typeof body?.detail === "string" ? body.detail : undefined));
  return body as T;
}

const seg = encodeURIComponent;
const qs = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};

// Discovery (#801) shapes, normalised here so the components never see them.
export const getCapabilities = async () => {
  const c = await request<{
    query_available: boolean;
    stages: { stage: string; query: { engine: "trino"; available: boolean; export_formats: string[] } }[];
  }>("/query-capabilities");
  // query_available false is the same as an older API without the endpoint: unavailable.
  if (!c.query_available) throw new ApiError(404, explain(404));
  return { stages: c.stages.map((s): StageCapability => ({ stage: s.stage, ...s.query })) };
};

export const listSchemas = async (stage: string, q: string, cursor?: string): Promise<Page<{ name: string }>> => {
  const p = await request<{ schemas: string[]; next_cursor: string | null }>(
    `/stages/${seg(stage)}/schemas${qs({ q, cursor, limit: "100" })}`,
  );
  return { items: p.schemas.map((name) => ({ name })), next_cursor: p.next_cursor };
};

export const listTables = async (stage: string, schema: string, q: string, cursor?: string): Promise<Page<{ name: string; type: string }>> => {
  const p = await request<{ tables: { name: string; type: string }[]; next_cursor: string | null }>(
    `/stages/${seg(stage)}/schemas/${seg(schema)}/tables${qs({ q, cursor, limit: "100" })}`,
  );
  return { items: p.tables, next_cursor: p.next_cursor };
};

// Only the SQL is sent: the schema selector filters the explorer, never the query.
export const submitQuery = (stage: string, sql: string) =>
  request<QueryResult>(`/stages/${seg(stage)}/queries`, { method: "POST", body: JSON.stringify({ sql }) });

export const pollQuery = (stage: string, id: string, cursor?: string) =>
  request<QueryResult>(`/stages/${seg(stage)}/queries/${seg(id)}${qs({ cursor })}`);

export const cancelQuery = (stage: string, id: string) =>
  request<unknown>(`/stages/${seg(stage)}/queries/${seg(id)}`, { method: "DELETE" });

/** A plain download link: the browser streams it, no JS buffering. */
export const exportUrl = (stage: string, id: string, format: string) =>
  `${BASE}/stages/${seg(stage)}/queries/${seg(id)}/export${qs({ format })}`;
