// A fake Platform API for running the portal UI without OpenLakeForge: in-memory fixtures behind the
// /api/v1 contract of platform-api (discovery.py, queries.py). Dev only: vite.config.ts mounts it when
// OLF_MOCK_API=1 (loaded with ssrLoadModule, never imported), and nothing under src/ imports it, so it can never reach build/.
// Special SQL (see README): syntax_error, slow, big, and write keywords.
// Files routes (#1114) keep an in-memory object store, so upload, folders, rename and delete change the listings.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

type Row = (string | number | boolean | null)[];
const STAGES = ["dev", "prod"];
const READ_ONLY_REFUSAL =
  "only read queries (SELECT, WITH, VALUES, TABLE) are offered in the portal yet; writes and other statements are not";
const SCHEMA_REQUIRED = "line 1:15: Schema must be specified when session schema is not set";

const orders = [["order_id", "bigint"], ["customer", "varchar"], ["amount", "double"], ["note", "varchar"]];
const events = [["event_id", "bigint"], ["kind", "varchar"], ["payload", "varchar"]];
const region = [["region", "varchar"], ["revenue", "double"], ["comment", "varchar"]];
const info = [["table_schema", "varchar"], ["table_name", "varchar"]];
// schema -> table -> [name, type][]; every stage has these, dev adds a scratch schema.
const SCHEMAS: Record<string, Record<string, { view?: boolean; columns: string[][] }>> = {
  bronze: { raw_orders: { columns: orders }, raw_events: { columns: events } },
  silver: { orders: { columns: orders }, events: { columns: events } },
  gold_sales: { revenue_by_region: { view: true, columns: region }, daily_orders: { columns: orders } },
  information_schema: { tables: { columns: info }, columns: { columns: info }, schemata: { columns: info } },
};
const schemasOf = (stage: string) => {
  const all = stage === "dev" ? { ...SCHEMAS, scratch: { notes: { columns: events } } } : SCHEMAS;
  return Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : 1)));
};

/** Deterministic rows: ids count up; the last varchar column is NULL on row 2 and HTML-looking on row 3. */
function rowsFor(columns: string[][], count: number): Row[] {
  const lastText = columns.map(([, t]) => t).lastIndexOf("varchar");
  return Array.from({ length: count }, (_, k) => {
    const i = k + 1;
    return columns.map(([name, type], c): string | number | null => {
      if (type === "bigint") return i;
      if (type === "double") return Math.round(i * 1234.5) / 10;
      if (c === lastText && i === 2) return null;
      if (c === lastText && i === 3) return "<b>bold</b> <script>alert('xss')</script>";
      return `${name}-${i}`;
    });
  });
}

type Query = { stage: string; sql: string; columns: string[][]; rows: Row[]; sent: number; polls: number; cancelled: boolean };
const queries = new Map<string, Query>();
const PAGE = 100; // rows per response for `big`
const BIG_CAP = 250; // rows the server returns before it truncates, like query_page_rows
const SLOW_POLLS = 5;

class HttpError extends Error {
  constructor(readonly status: number, readonly detail: unknown) { super(String(detail)); }
}

function plan(stage: string, sql: string, schema?: string): { columns: string[][]; rows: Row[] } {
  if (/syntax_error/i.test(sql)) {
    throw new HttpError(400, "line 1:1: mismatched input 'syntax_error'. Expecting: 'ALTER', 'ANALYZE', 'CALL', 'COMMENT', 'COMMIT', 'CREATE', 'DEALLOCATE', 'DELETE', 'DENY', 'DESCRIBE', 'DROP', 'EXECUTE', 'EXPLAIN', 'GRANT', 'INSERT', 'MERGE', 'PREPARE', 'REFRESH', 'RESET', 'REVOKE', 'ROLLBACK', 'SET', 'SHOW', 'START', 'TRUNCATE', 'UPDATE', 'USE', <query>");
  }
  if (/^\s*(insert|update|delete|drop|create|alter|merge)\b/i.test(sql)) throw new HttpError(403, READ_ONLY_REFUSAL);
  const from = /\bfrom\s+"?([\w]+)"?(?:\."?([\w]+)"?)?/i.exec(sql);
  const count = /\bbig\b/i.test(sql) ? 1000 : 5;
  if (!from) return { columns: [["_col0", "integer"]], rows: [[1]] };
  const [, first, second] = from;
  if (schema && !(schema in schemasOf(stage))) throw new HttpError(400, `line 1:1: Schema '${schema}' does not exist`);
  if (!second && !schema) throw new HttpError(400, SCHEMA_REQUIRED);
  const [s, t] = second ? [first, second] : [schema!, first];
  const table = schemasOf(stage)[s]?.[t];
  if (!table) throw new HttpError(400, `line 1:15: Table 'lakehouse.${s}.${t}' does not exist`);
  return { columns: table.columns, rows: rowsFor(table.columns, count) };
}

/** The shape of queries.py's _response; columns come with the first rows, as Trino sends them. */
const result = (id: string, status: string, q: Query | null, rows: Row[], extra: object = {}) => ({
  id, status,
  columns: q && rows.length ? q.columns.map(([name, type]) => ({ name, type })) : [],
  rows, truncated: false, row_count: rows.length, elapsed_ms: 12, next_cursor: null, ...extra,
});

/** One response of a query. While Trino has more to send the status is "running" and the cursor is set. */
function advance(id: string, q: Query): object {
  if (q.cancelled) return result(id, "cancelled", null, []);
  if (/\bslow\b/i.test(q.sql) && q.polls++ < SLOW_POLLS) return result(id, "running", null, [], { next_cursor: `p${q.polls}` });
  if (!/\bbig\b/i.test(q.sql)) {
    const rows = q.sent ? [] : q.rows;
    q.sent = q.rows.length;
    return result(id, "succeeded", q, rows);
  }
  // big: PAGE rows per response while "running", then the cap cuts the result and marks it truncated.
  const rows = q.rows.slice(q.sent, Math.min(q.sent + PAGE, BIG_CAP));
  q.sent += rows.length;
  const done = q.sent >= BIG_CAP;
  return result(id, done ? "succeeded" : "running", q, rows, { next_cursor: done ? null : `o${q.sent}`, truncated: done });
}

function csvCell(v: unknown): string {
  if (v === null) return "";
  const s = typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v); // formula guard, as _cell
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function page(names: string[], url: URL) {
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const limit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(422, "limit must be between 1 and 200");
  const after = url.searchParams.get("cursor");
  let last: string | undefined;
  if (after) {
    try { last = Buffer.from(after, "base64url").toString(); } catch { /* falls through */ }
    if (last === undefined) throw new HttpError(400, "the cursor is not one this API issued");
  }
  const hits = names.filter((n) => n.toLowerCase().includes(q) && (last === undefined || n > last));
  const items = hits.slice(0, limit);
  return { items, next: hits.length > limit ? Buffer.from(items.at(-1)!).toString("base64url") : null };
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += chunk;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new HttpError(422, "invalid JSON body"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(422, "invalid body");
  return parsed as Record<string, unknown>;
}

async function route(req: IncomingMessage, url: URL): Promise<{ status?: number; json?: unknown; raw?: [string, string, string] }> {
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? "GET";
  if (parts[0] === "query-capabilities" && method === "GET") {
    return { json: { query_available: true, stages: STAGES.map((stage) => ({ stage, query: { engine: "trino", available: true, export_formats: ["csv", "json"] } })) } };
  }
  if (parts[0] === "file-capabilities" && method === "GET") {
    return { json: { stages: [{ stage: "dev", operations: FILE_OPS }], max_upload_bytes: MAX_UPLOAD } };
  }
  if (parts[0] !== "stages" || !parts[1]) throw new HttpError(404, "Not Found");
  const stage = parts[1];
  if (!STAGES.includes(stage)) throw new HttpError(404, `stage '${stage}' offers no query`);
  if (parts[2] === "buckets") return filesRoute(req, url, parts);
  if (parts[2] === "schemas" && method === "GET") {
    const schemas = schemasOf(stage);
    if (parts.length === 3) { const p = page(Object.keys(schemas), url); return { json: { schemas: p.items, next_cursor: p.next } }; }
    if (parts[4] === "tables") {
      const tables = schemas[parts[3]] ?? {};
      const p = page(Object.keys(tables).sort(), url);
      return { json: { tables: p.items.map((name) => ({ name, type: tables[name].view ? "view" : "table" })), next_cursor: p.next } };
    }
  }
  if (parts[2] === "queries") {
    if (parts.length === 3 && method === "POST") {
      const b = await body(req);
      const extra = Object.keys(b).filter((k) => k !== "sql" && k !== "schema");
      if (extra.length || typeof b.sql !== "string" || (b.schema !== undefined && typeof b.schema !== "string")) {
        throw new HttpError(422, [{ type: extra.length ? "extra_forbidden" : "string_type", loc: ["body", extra[0] ?? "sql"], msg: "Invalid field" }]);
      }
      const sql = b.sql.trim().replace(/;$/, "").trim();
      if (!sql) throw new HttpError(400, "the statement is empty");
      const { columns, rows } = plan(stage, sql, b.schema as string | undefined);
      const id = randomUUID();
      const q: Query = { stage, sql, columns, rows, sent: 0, polls: 0, cancelled: false };
      queries.set(id, q);
      return { json: advance(id, q) };
    }
    const id = parts[3];
    const q = queries.get(id);
    if (!q || q.stage !== stage) throw new HttpError(404, "no such query");
    if (parts.length === 4 && method === "GET") return { json: advance(id, q) };
    if (parts.length === 4 && method === "DELETE") { q.cancelled = true; return { json: result(id, "cancelled", null, []) }; }
    if (parts[4] === "export" && method === "GET") {
      const format = url.searchParams.get("format");
      if (format !== "csv" && format !== "json") throw new HttpError(422, "format must be csv or json");
      const names = q.columns.map(([n]) => n);
      const text = format === "json"
        ? JSON.stringify({ columns: names, rows: q.rows })
        : [names, ...q.rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
      return { raw: [format === "csv" ? "text/csv; charset=utf-8" : "application/json", `attachment; filename="query-results.${format}"`, text] };
    }
  }
  throw new HttpError(404, "Not Found");
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  try {
    const out = await route(req, new URL(req.url ?? "/", "http://mock"));
    if (out.raw) {
      res.writeHead(200, { "Content-Type": out.raw[0], "Content-Disposition": out.raw[1], "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
      return res.end(out.raw[2]);
    }
    res.writeHead(out.status ?? 200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(out.json));
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    res.writeHead(e.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: e.detail }));
  }
}

// ── Files (openlakeforge #1114): an in-memory object store per bucket ─────────────────────────────────

const FILE_OPS = ["list_buckets", "list_objects", "download_object", "upload_object", "create_folder", "rename_object", "delete_objects"];
const MAX_UPLOAD = 5 * 1024 * 1024; // small, so the "too large" refusal is easy to try
const MAX_RENAME = 1000;
type Stored = { size: number; modified: string; content: string };
const store = new Map<string, Map<string, Stored>>(); // bucket -> key -> object (stage dev only)
{
  const put = (bucket: string, key: string, size: number, modified: string) => {
    if (!store.has(bucket)) store.set(bucket, new Map());
    store.get(bucket)!.set(key, { size, modified, content: `mock content of ${key}\n` });
  };
  for (const bucket of ["openlakeforge-dev-bronze", "openlakeforge-dev-silver", "openlakeforge-dev-gold"]) store.set(bucket, new Map());
  const b = "openlakeforge-dev-bronze";
  for (const day of ["14", "15", "16"]) put(b, `raw/orders/2026-11-${day}/part-0001.parquet`, 12_400_000, `2026-11-${day}T09:30:00Z`);
  put(b, "raw/orders/_manifest.json", 2150, "2026-11-16T09:42:00Z");
  put(b, "raw/orders/orders_2026-11-16.parquet", 50_540_000, "2026-11-16T09:41:00Z");
  put(b, "raw/orders/orders.avsc", 3480, "2026-10-03T14:05:00Z");
  put(b, "raw/customers/customers.csv", 880_000, "2026-11-10T07:00:00Z");
  for (let i = 1; i <= 120; i++) put("openlakeforge-dev-silver", `events/e-${String(i).padStart(4, "0")}.json`, 1000 + i, "2026-11-12T10:00:00Z");
}
const BUCKET_CREATED = "2026-09-02T08:00:00Z";

function filesBucket(stage: string, name: string) {
  if (stage !== "dev") throw new HttpError(403, `You have no file access on stage '${stage}'.`);
  const objects = store.get(name);
  if (!objects) throw new HttpError(404, `bucket '${name}' not found`);
  return objects;
}

function listObjects(objects: Map<string, Stored>, url: URL) {
  const prefix = url.searchParams.get("prefix") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpError(422, "limit must be between 1 and 1000");
  const after = url.searchParams.get("cursor");
  const entries = new Map<string, { folder: boolean; key: string; obj?: Stored }>();
  for (const [key, obj] of objects) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (!rest) continue; // a folder's own marker
    const slash = rest.indexOf("/");
    if (slash >= 0) entries.set(prefix + rest.slice(0, slash + 1), { folder: true, key: prefix + rest.slice(0, slash + 1) });
    else entries.set(key, { folder: false, key, obj });
  }
  const last = after ? Buffer.from(after, "base64url").toString() : undefined;
  const sorted = [...entries.values()].sort((x, y) => (x.key < y.key ? -1 : 1)).filter((e) => last === undefined || e.key > last);
  const pageOf = sorted.slice(0, limit);
  return {
    prefix,
    folders: pageOf.filter((e) => e.folder).map((e) => ({ prefix: e.key })),
    files: pageOf.filter((e) => !e.folder).map((e) => ({ key: e.key, size: e.obj!.size, last_modified: e.obj!.modified })),
    next_cursor: sorted.length > limit ? Buffer.from(pageOf.at(-1)!.key).toString("base64url") : null,
  };
}

async function rawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function filesRoute(req: IncomingMessage, url: URL, parts: string[]): Promise<{ status?: number; json?: unknown; raw?: [string, string, string] }> {
  const method = req.method ?? "GET";
  const stage = parts[1];
  if (parts.length === 3 && parts[2] === "buckets" && method === "GET") {
    if (stage !== "dev") throw new HttpError(403, `You have no file access on stage '${stage}'.`);
    return { json: { buckets: [...store.keys()].map((name) => ({ name, created_at: BUCKET_CREATED })) } };
  }
  if (parts[2] !== "buckets" || !parts[3]) throw new HttpError(404, "Not Found");
  const objects = filesBucket(stage, parts[3]);
  const key = url.searchParams.get("key") ?? "";
  if (parts[4] === "objects" && parts.length === 5 && method === "GET") return { json: listObjects(objects, url) };
  if (parts[4] === "objects" && parts[5] === "content") {
    if (!key || key.endsWith("/")) throw new HttpError(422, "key must name an object");
    if (method === "GET") {
      const obj = objects.get(key);
      if (!obj) throw new HttpError(404, `object '${key}' not found`);
      return { raw: ["application/octet-stream", `attachment; filename="${key.split("/").pop()}"`, obj.content] };
    }
    if (method === "PUT") {
      const data = await rawBody(req);
      if (data.length > MAX_UPLOAD) throw new HttpError(413, `the upload exceeds the ${MAX_UPLOAD} byte limit`);
      if (objects.has(key) && url.searchParams.get("overwrite") !== "true") throw new HttpError(409, `object '${key}' already exists`);
      objects.set(key, { size: data.length, modified: new Date().toISOString(), content: data.toString("utf8") });
      return { status: 201, json: { key, size: data.length } };
    }
  }
  if (parts[4] === "folders" && method === "POST") {
    const b = await body(req);
    const prefix = b.prefix;
    if (typeof prefix !== "string" || !prefix.endsWith("/") || prefix === "/") throw new HttpError(422, "prefix must end with /");
    if ([...objects.keys()].some((k) => k.startsWith(prefix))) throw new HttpError(409, `folder '${prefix}' already exists`);
    objects.set(prefix, { size: 0, modified: new Date().toISOString(), content: "" });
    return { status: 201, json: { prefix } };
  }
  if (parts[4] === "objects" && parts[5] === "rename" && method === "POST") {
    const b = await body(req);
    const { from, to } = b;
    if (typeof from !== "string" || typeof to !== "string" || from.endsWith("/") !== to.endsWith("/")) {
      throw new HttpError(422, "from and to must both end with / (a folder) or neither (a file)");
    }
    const moving = [...objects.keys()].filter((k) => (from.endsWith("/") ? k.startsWith(from) : k === from));
    if (!moving.length) throw new HttpError(404, `'${from}' not found`);
    if (moving.length > MAX_RENAME) throw new HttpError(422, `renaming moves more than ${MAX_RENAME} objects`);
    if ([...objects.keys()].some((k) => (to.endsWith("/") ? k.startsWith(to) : k === to))) throw new HttpError(409, `'${to}' already exists`);
    for (const k of moving) {
      const dest = to + k.slice(from.length);
      objects.set(dest, objects.get(k)!);
      objects.delete(k);
    }
    return { json: { moved: moving.length } };
  }
  if (parts[4] === "objects" && parts[5] === "delete" && method === "POST") {
    const b = await body(req);
    if (!Array.isArray(b.keys) || b.keys.some((k) => typeof k !== "string")) throw new HttpError(422, "keys must be a list of strings");
    const deleted: string[] = [];
    for (const k of b.keys as string[]) {
      for (const have of [...objects.keys()]) if (k.endsWith("/") ? have.startsWith(k) : have === k) objects.delete(have);
      deleted.push(k);
    }
    return { json: { deleted, errors: [] } };
  }
  throw new HttpError(404, "Not Found");
}
