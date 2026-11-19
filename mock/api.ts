// A fake Platform API for running the portal UI without OpenLakeForge: in-memory fixtures behind the
// /api/v1 contract of platform-api (discovery.py, queries.py). Dev only: vite.config.ts mounts it when
// OLF_MOCK_API=1 (loaded with ssrLoadModule, never imported), and nothing under src/ imports it, so it can never reach build/.
// Special SQL (see README): syntax_error, slow, big, and write keywords.
// Health (#1127): prod needs attention (a failed pipeline, a stale log spool), dev cannot read Dagster (unknown).
// Monitoring capabilities (#1259) decide what the page calls; `?mock=<scenario>` on the page (read from the Referer)
// picks another role or state, see MONITORING_SCENARIOS and the README.
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
  if (parts[0] === "monitoring-capabilities" && method === "GET") return { json: monitoringCapabilities(scenarioOf(req)) };
  if (parts[0] === "file-capabilities" && method === "GET") {
    return { json: { stages: [{ stage: "dev", operations: FILE_OPS }], max_upload_bytes: MAX_UPLOAD } };
  }
  if (parts[0] !== "stages" || !parts[1]) throw new HttpError(404, "Not Found");
  const stage = parts[1];
  if (!STAGES.includes(stage)) throw new HttpError(404, `stage '${stage}' offers no query`);
  if (parts[2] === "buckets") return filesRoute(req, url, parts);
  if ((parts[2] === "health" || parts[2] === "alerts") && method === "GET") return monitoringRoute(scenarioOf(req), stage, parts.slice(2).join("/"));
  if (parts[2] === "runs" && parts[3] && method === "GET") return runRoute(scenarioOf(req), stage, parts[3], parts[4]);
  if (parts[2] === "logs" && method === "GET") return logsRoute(scenarioOf(req), stage, url);
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

// ── Monitoring capabilities (openlakeforge #1259) and the scenarios a reviewer can pick ───────────────────────

/** `?mock=` on the page: `no-access` (an analyst: no stage), `limited` (a role with get_stage_health only, so no
 * pipelines, quality or incidents read is made), `unauthorized` (the routes answer 403 although the capabilities
 * offered them), `not-provided` (no quality reader, no alert evaluator), and for quality and incidents `unknown`,
 * `unavailable`, `stale` and `empty` (see qualityHealth and alertIncidents). `admin` is a platform admin: the log
 * archive is read on prod too, so a failed run there shows its archived lines. */
const MONITORING_SCENARIOS = ["no-access", "limited", "unauthorized", "not-provided", "unknown", "unavailable", "stale", "empty", "admin"] as const;
type Scenario = (typeof MONITORING_SCENARIOS)[number] | undefined;
function scenarioOf(req: IncomingMessage): Scenario {
  let asked: string | null = null;
  try { asked = new URL(req.headers.referer ?? "").searchParams.get("mock"); } catch { /* no referer */ }
  return MONITORING_SCENARIOS.find((s) => s === asked);
}

const MONITORING_OPS = ["get_stage_health", "get_stage_service_health", "list_pipeline_health", "get_stage_quality_health",
  "list_logs", "list_stage_metrics", "get_stage_metric", "list_alert_incidents"];
const ROUTE_OPS: Record<string, string> = {
  health: "get_stage_health", "health/services": "get_stage_service_health", "health/pipelines": "list_pipeline_health",
  "health/quality": "get_stage_quality_health", "alerts/incidents": "list_alert_incidents",
};

/** As platform-api builds it from its settings: a data-engineer's view, so logs on dev only (both stages for `admin`). */
function monitoringCapabilities(scenario: Scenario) {
  if (scenario === "no-access") return { stages: [] };
  return {
    stages: STAGES.map((stage) => ({
      stage,
      operations: scenario === "limited" ? ["get_stage_health", "get_stage_service_health"]
        : MONITORING_OPS.filter((op) => op !== "list_logs" || stage === "dev" || scenario === "admin"),
      capabilities: [
        { name: "dagster", status: "available", reason: "a Dagster webserver is configured" },
        { name: "services", status: "available", reason: "service probes are configured" },
        stage === "prod" && scenario !== "not-provided" ? { name: "quality", status: "available", reason: "read from the stage's quality manifests" }
          : { name: "quality", status: "not_provided", reason: "no quality manifest reader is configured for this stage" },
        stage === "prod" ? { name: "quality-sync", status: "available", reason: "read from the reconciler's quality-sync summary" }
          : { name: "quality-sync", status: "not_provided", reason: "no quality results are published from this stage" },
        stage === "dev" || scenario === "admin" ? { name: "logs", status: "available", reason: "a log archive is configured" }
          : { name: "logs", status: "unavailable", reason: "the platform API holds no object-store key for the log archive" },
        { name: "metrics", status: "not_provided", reason: "no metrics source is connected to the API" },
        scenario === "not-provided" ? { name: "alerts", status: "not_provided", reason: "no alert evaluator, or no key to read its state, is configured" }
          : { name: "alerts", status: "available", reason: "the alert evaluator's state is configured" },
      ],
    })),
  };
}

/** The monitoring routes, each refused with 403 when the role may not call it, as the permission matrix does. */
function monitoringRoute(scenario: Scenario, stage: string, path: string): { status?: number; json?: unknown } {
  const op = ROUTE_OPS[path];
  if (!op) throw new HttpError(404, "Not Found");
  const access = monitoringCapabilities(scenario).stages.find((s) => s.stage === stage);
  if (!access?.operations.includes(op) || scenario === "unauthorized") throw new HttpError(403, `role analyst may not call ${op} on stage '${stage}'`);
  if (path === "health") return { json: stageHealth(stage) };
  if (path === "health/services") return { json: { stage, services: stageHealth(stage).services } };
  if (path === "health/pipelines") return { json: pipelinesHealth(stage) };
  if (path === "health/quality") return { json: qualityHealth(stage, scenario) };
  if (path === "alerts/incidents") return { json: alertIncidents(stage, scenario) };
  throw new HttpError(404, "Not Found");
}

// ── Health (openlakeforge #1127): StageHealth, fresh on every call ────────────────────────────────────────

const SERVICE_LABELS: Record<string, [string, string, string]> = {
  "dagster.read-api": ["Dagster API", "dagster", "Dagster"],
  "dagster.workloads": ["Dagster workloads", "dagster", "Dagster"],
  "trino.readiness": ["Trino coordinator", "trino", "Trino"],
  "polaris.readiness": ["Polaris catalog", "polaris", "Polaris"],
  "object-store.list": ["Object storage", "object-store", "Object storage"],
  "log-archive.spool-age": ["Log spool age", "log-archive", "Log archive"],
  "log-archive.newest-object": ["Newest archived log", "log-archive", "Log archive"],
  "quality-sync.publication": ["Quality publication", "quality-sync", "Quality sync"],
};

function stageHealth(stage: string) {
  const now = Date.now();
  const iso = (offset: number) => new Date(now + offset * 1000).toISOString();
  const svc = (component: string, source: string, state: string, reason: string, lastSuccess: number | null = null) => {
    const [display_name, service, service_display_name] = SERVICE_LABELS[component];
    return {
      component, display_name, service, service_display_name, source, state, reason,
      observed_at: iso(-18), expires_at: iso(42), max_age_seconds: 60, last_success_at: lastSuccess === null ? null : iso(-lastSuccess),
    };
  };
  const prod = stage === "prod";
  return {
    stage, state: prod ? "critical" : "unknown", evaluated_at: iso(-18), window: healthWindow(now, null), failed_runs: null,
    pipelines: prod ? PROD_PIPELINES.map(({ job, state }) => ({ job, domain: SCOPES[job]?.[0] ?? null, product: SCOPES[job]?.[1] ?? null, state, failed_runs: PROD_FAILED_RUNS[job][0] })) : [],
    services: [
      prod ? svc("dagster.read-api", "dagster-graphql", "healthy", "Dagster GraphQL answers")
        : svc("dagster.read-api", "dagster-graphql", "unknown", "the Dagster GraphQL API did not answer"),
      svc("dagster.workloads", "kubernetes", "healthy", "2 of 2 pods ready"),
      svc("trino.readiness", "trino-http", "healthy", "Coordinator accepts queries"),
      svc("polaris.readiness", "polaris-http", "healthy", "Catalog API responds"),
      svc("object-store.list", "s3", "healthy", "Buckets reachable"),
      prod ? svc("log-archive.spool-age", "log-collector", "warning", "No durable write for 12 min (limit 10 min)")
        : svc("log-archive.spool-age", "log-collector", "healthy", "Last durable write 42 s ago"),
      // dev's newest archived object cannot be read, so its last durable write is unknown (null), never a time.
      prod ? svc("log-archive.newest-object", "s3", "healthy", "an archived log was written within its bound", 12 * 60 + 20)
        : svc("log-archive.newest-object", "s3", "unknown", "the log archive could not be listed"),
      ...(prod ? [svc("quality-sync.publication", "quality-reconciler", "healthy", "the last pass published every result", 4 * 60)] : []),
    ],
    integrations: [
      prod ? { name: "dagster", status: "available", reason: "read from Dagster" } : { name: "dagster", status: "unavailable", reason: "Dagster could not be read" },
      { name: "services", status: "available", reason: "probed in the stage namespace" },
      prod ? { name: "quality", status: "available", reason: "read from the stage's quality manifests" }
        : { name: "quality", status: "not_provided", reason: "no quality manifest reader is configured for this stage" },
      prod ? { name: "quality-sync", status: "available", reason: "read from the reconciler's quality-sync summary" }
        : { name: "quality-sync", status: "not_provided", reason: "no quality results are published from this stage" },
      { name: "metrics", status: "not_provided", reason: "no metrics source is connected to the API" },
    ],
  };
}

// ── Pipeline health (openlakeforge #1127): PipelinesHealth. prod has a failed run with a failed blocking quality
// check, a missed run, a stopped schedule whose last run warned on quality, and one healthy pipeline. dev answers
// 200 with Dagster unavailable and no pipelines, as the API does when Dagster cannot be read.

/** Each job's domain and data product, from its definition's tags (#1272); web_events declares no product. */
const SCOPES: Record<string, [string, string]> = { sales_orders: ["sales", "orders"], crm_accounts: ["crm", "accounts"], finance_ledger: ["finance", "ledger"] };

/** Each prod job's failed runs in the window and, when its bounded read stopped short of the window, how many seconds
 * ago its count starts. crm_accounts' count could not be read (null, shown Unknown, never 0), so the stage sum is null
 * too; web_events runs hourly and its read reached its cap 6 h back. */
const PROD_FAILED_RUNS: Record<string, [number | null, number | null]> = {
  sales_orders: [1, null], crm_accounts: [null, null], finance_ledger: [0, null], web_events: [0, 6 * 3600],
};
const healthWindow = (now: number, coveredFrom: number | null) => ({
  range: "24h", from: new Date(now - 24 * 3600 * 1000).toISOString(), to: new Date(now).toISOString(),
  covered_from: coveredFrom === null ? null : new Date(now - coveredFrom * 1000).toISOString(),
});

const PROD_PIPELINES = [
  { job: "sales_orders", state: "critical" },
  { job: "crm_accounts", state: "critical" },
  { job: "finance_ledger", state: "warning" },
  { job: "web_events", state: "healthy" },
] as const;

function pipelinesHealth(stage: string) {
  const now = Date.now();
  const iso = (offset: number) => new Date(now + offset * 1000).toISOString();
  const secs = (offset: number) => Math.round(now / 1000 + offset);
  const H = 3600;
  const run = (job: string, id: string, status: string, ago: number, took = 240) =>
    ({ run_id: id, job_name: job, status, created_at: secs(-ago), started_at: secs(-ago + 5), ended_at: secs(-ago + took), tags: {} });
  const signal = (kind: string, state: string, reason: string, r: { run_id: string; ended_at: number } | null, maxAge: number | null) => {
    const observed = r ? r.ended_at * 1000 : now;
    return { kind, state, reason, run: r?.run_id ?? null, observed_at: new Date(observed).toISOString(), expires_at: maxAge === null ? null : new Date(observed + maxAge * 1000).toISOString(), due: null as string | null };
  };
  const daily = 24 * H + 900;
  const dagster = stage === "prod"
    ? { name: "dagster", status: "available", reason: "read from Dagster" }
    : { name: "dagster", status: "unavailable", reason: "Dagster could not be read" };
  const integrations = [
    dagster,
    { name: "services", status: "unavailable", reason: "service signals are served by the stage health route" },
    stage === "prod" ? { name: "quality", status: "available", reason: "read from the stage's quality manifests" }
      : { name: "quality", status: "not_provided", reason: "no quality manifest reader is configured for this stage" },
    { name: "metrics", status: "not_provided", reason: "no metrics source is connected to the API" },
  ];
  const thresholds = { run_max_age_seconds: 7 * 24 * H, schedule_max_age_seconds: 300, schedule_grace_seconds: 900, run_window: 25 };
  // The counts cover the default 24h window (openlakeforge#1319); the state and signals are never windowed.
  const window = healthWindow(now, null);
  if (stage !== "prod") return { stage, evaluated_at: iso(-18), window, failed_runs: null, thresholds, integrations, pipelines: [] };

  const salesFail = run("sales_orders", "c94cbcb0-5d1e-4a8e-9f0b-2f6c1a7e3b21", "FAILURE", 40 * 60, 120);
  const salesOk = run("sales_orders", "7a1f02de-93c4-4f0a-8d55-0b9e4c2a6f10", "SUCCESS", 23 * H);
  const crmOk = run("crm_accounts", "4be0c1a9-2d7f-4c63-a1e8-5f3b9d0e7c42", "SUCCESS", 23 * H + 30 * 60);
  const ledger = run("finance_ledger", "e5d27b8c-0f41-4a9e-b6c3-1d8a2f7e9b05", "SUCCESS", 2 * 24 * H);
  const web = run("web_events", "0d9c3e7a-6b28-4f15-a3d0-8e1c5b2f4a67", "SUCCESS", 25 * 60, 60);
  const health = (job: string, latest: ReturnType<typeof run>, success: ReturnType<typeof run> | null, failed: number | null,
    schedule: { name: string | null; status: string; last_expected_at: string | null }, signals: unknown[]) => ({
    job, domain: SCOPES[job]?.[0] ?? null, product: SCOPES[job]?.[1] ?? null, state: PROD_PIPELINES.find((p) => p.job === job)!.state, latest_run: latest, last_success: success,
    failed_runs: failed, covered_from: PROD_FAILED_RUNS[job]?.[1] === null ? null : iso(-PROD_FAILED_RUNS[job][1]!), schedule,
    freshness: { last_success_at: success ? new Date(success.ended_at * 1000).toISOString() : null, age_seconds: success ? secs(0) - success.ended_at : null },
    signals,
  });
  return {
    // web_events' read stopped short, so the window's own covered_from (which bounds the stage's sum) is set too.
    stage, evaluated_at: iso(-18), window: healthWindow(now, 6 * 3600), failed_runs: null, thresholds, integrations,
    pipelines: [
      health("sales_orders", salesFail, salesOk, PROD_FAILED_RUNS.sales_orders[0], { name: "sales_orders_daily", status: "running", last_expected_at: iso(-45 * 60) }, [
        signal("execution", "critical", "latest run failed", salesFail, daily),
        signal("latest_success", "healthy", "a successful run is on record", salesOk, daily),
        { ...signal("expected_run", "healthy", "the expected run started", null, 300) },
        signal("freshness", "critical", "no run succeeded since the previous due time plus its grace", salesOk, null),
        signal("quality", "critical", "a blocking quality check failed", salesFail, daily),
      ]),
      health("crm_accounts", crmOk, crmOk, PROD_FAILED_RUNS.crm_accounts[0], { name: "crm_accounts_daily", status: "running", last_expected_at: iso(-35 * 60) }, [
        signal("execution", "healthy", "latest run succeeded", crmOk, daily),
        signal("latest_success", "healthy", "a successful run is on record", crmOk, daily),
        { ...signal("expected_run", "critical", "an expected run did not start", null, 300), due: iso(-35 * 60) },
        signal("freshness", "critical", "no run succeeded since the previous due time plus its grace", crmOk, null),
        signal("quality", "healthy", "quality checks passed", crmOk, daily),
      ]),
      health("finance_ledger", ledger, ledger, PROD_FAILED_RUNS.finance_ledger[0], { name: "finance_ledger_daily", status: "stopped", last_expected_at: null }, [
        signal("execution", "healthy", "latest run succeeded", ledger, 7 * 24 * H),
        signal("latest_success", "healthy", "a successful run is on record", ledger, 7 * 24 * H),
        signal("expected_run", "disabled", "schedule is stopped", null, 300),
        { ...signal("freshness", "disabled", "schedule is stopped", null, null), observed_at: null },
        signal("quality", "warning", "quality checks warned", ledger, 7 * 24 * H),
      ]),
      health("web_events", web, web, PROD_FAILED_RUNS.web_events[0], { name: "web_events_hourly", status: "running", last_expected_at: iso(-25 * 60) }, [
        signal("execution", "healthy", "latest run succeeded", web, H + 900),
        signal("latest_success", "healthy", "a successful run is on record", web, H + 900),
        signal("expected_run", "healthy", "the expected run started", null, 300),
        signal("freshness", "healthy", "a run succeeded since the previous due time", web, null),
        signal("quality", "healthy", "quality checks passed", web, H + 900),
      ]),
    ],
  };
}

// ── Quality counts (openlakeforge #1257): StageQualityHealth. prod: sales_orders failed a blocking check,
// finance_ledger warned and its manifest is incomplete, crm_accounts has no usable manifest (counts null, never
// zeros), web_events passed. `unknown`: Dagster could not be read, so no counts at all. `empty`: no pipeline has
// quality evidence yet.

function qualityHealth(stage: string, scenario: Scenario) {
  const now = Date.now();
  const iso = (offset: number) => new Date(now + offset * 1000).toISOString();
  const quality = { name: "quality", status: "available", reason: "read from the stage's quality manifests" };
  const base = { stage, evaluated_at: iso(-18) };
  if (scenario === "unknown") {
    return { ...base, integrations: [{ name: "dagster", status: "unavailable", reason: "the read did not finish within 20 s" }, quality], totals: null, pipelines: [] };
  }
  const integrations = [{ name: "dagster", status: "available", reason: "read from Dagster" }, quality];
  if (scenario === "empty") return { ...base, integrations, totals: null, pipelines: [] };
  const counts = (passed: number, warn: number, error: number, blocking = 0, not_run = 0, unknown = 0) => ({ passed, warn, error, not_run, unknown, blocking });
  const entry = (job: string, domain: string | null, run_id: string | null, at: number | null, complete: boolean | null, state: string,
    c: ReturnType<typeof counts> | null, reason: string) =>
    ({ job, domain, product: SCOPES[job]?.[1] ?? null, run_id, observed_at: at === null ? null : iso(-at), complete, state, counts: c, reason });
  const pipelines = [
    entry("sales_orders", "sales", "c94cbcb0-5d1e-4a8e-9f0b-2f6c1a7e3b21", 40 * 60, true, "critical", counts(14, 1, 2, 1), "a blocking quality check failed"),
    entry("crm_accounts", "crm", null, null, null, "unknown", null, "no finished run of the pipeline has quality evidence yet"),
    entry("finance_ledger", "finance", "e5d27b8c-0f41-4a9e-b6c3-1d8a2f7e9b05", 2 * 24 * 3600, false, "warning", counts(8, 2, 0, 0, 1), "quality checks warned"),
    entry("web_events", null, "0d9c3e7a-6b28-4f15-a3d0-8e1c5b2f4a67", 25 * 60, true, "healthy", counts(6, 0, 0), "quality checks passed"),
  ];
  const known = pipelines.flatMap((p) => (p.counts ? [p.counts] : []));
  const totals = Object.fromEntries(Object.keys(counts(0, 0, 0)).map((k) => [k, known.reduce((n, c) => n + c[k as keyof typeof c], 0)]));
  return { ...base, integrations, totals, pipelines };
}

// ── Alert incidents (openlakeforge #1258): StageAlertIncidents. prod has one open incident per delivery status;
// dev's evaluator stopped running (stale). `stale` makes prod stale too, `unknown` has a state with no evaluation
// time (stale), `unavailable` cannot read the state (incidents null), `empty` has none open.

function alertIncidents(stage: string, scenario: Scenario) {
  const now = Date.now();
  const iso = (offset: number) => new Date(now + offset * 1000).toISOString();
  if (scenario === "unavailable") {
    return { stage, state: { status: "unavailable", reason: "the alert evaluator has not written a state yet", evaluated_at: null, stale: null }, incidents: null };
  }
  const stale = scenario === "stale" || (stage === "dev" && scenario !== "empty");
  const evaluated = stale ? iso(-47 * 60) : iso(-140);
  const state = scenario === "unknown"
    ? { status: "available", reason: "the alert state does not say when it was evaluated", evaluated_at: null, stale: true }
    : { status: "available", reason: stale ? `the alert evaluator has not run since ${evaluated}` : "read from the alert evaluator's state", evaluated_at: evaluated, stale };
  if (scenario === "empty") return { stage, state, incidents: [] };
  const incident = (id: string, condition: string, severity: string, scope: [string | null, string | null, string | null, string | null],
    opened: number, summary: string, runs: string[], delivery: Record<string, unknown>) => ({
    id, condition, severity, job: scope[1], domain: scope[1] ? SCOPES[scope[1]]?.[0] ?? null : null, product: scope[1] ? SCOPES[scope[1]]?.[1] ?? null : null,
    table: scope[2], component: scope[3],
    opened_at: iso(-opened), last_seen_at: iso(-140), summary, run_ids: runs, delivery,
  });
  if (stage === "dev") {
    return { stage, state, incidents: [incident("dev-health", "health_unreadable", "warning", [null, null, null, "dagster.read-api"], 50 * 60,
      "the stage health could not be read", [], { status: "delivered", event: "opened", attempts: 1, receivers: 1, delivered: 1 })] };
  }
  return {
    stage, state,
    incidents: [
      incident("prod-sales-failed", "failed_run", "critical", ["sales", "sales_orders", null, null], 38 * 60, "latest run failed",
        ["c94cbcb0-5d1e-4a8e-9f0b-2f6c1a7e3b21"], { status: "delivered", event: "opened", attempts: 1, receivers: 2, delivered: 2 }),
      incident("prod-sales-quality", "quality_blocking", "critical", ["sales", "sales_orders", "silver.orders", null], 38 * 60, "a blocking quality check failed",
        ["c94cbcb0-5d1e-4a8e-9f0b-2f6c1a7e3b21"], { status: "pending", event: "escalated", attempts: 2, receivers: 2, delivered: 1 }),
      incident("prod-crm-missed", "missed_run", "critical", ["crm", "crm_accounts", null, null], 20 * 60, "an expected run did not start",
        [], { status: "undeliverable", event: "opened", attempts: 10, receivers: 1, delivered: 0 }),
      incident("prod-spool", "service_degraded", "warning", [null, null, null, "log-archive.spool-age"], 12 * 60, "No durable write for 12 min (limit 10 min)",
        [], { status: "unrouted", event: "opened", attempts: 0, receivers: 0, delivered: 0 }),
      incident("prod-ledger-schedule", "schedule_mismatch", "warning", ["finance", "finance_ledger", null, null], 3 * 24 * 3600, "schedule is stopped",
        [], { status: "unknown", event: null, attempts: null, receivers: null, delivered: null }),
    ],
  };
}

// ── One run (openlakeforge #1271): Run, RunFailure and its archived lines. sales_orders' failed run has a failed
// Floe step and rejected rows; the other runs on record succeeded. `unknown` makes the event log and the manifest
// unreadable (steps and rows null, never empty); `unauthorized` and `limited` are refused with 403; dev's Dagster cannot
// be read (502); an id no pipeline has is a 404.

const FAILED_RUN = "c94cbcb0-5d1e-4a8e-9f0b-2f6c1a7e3b21";

function runsOnRecord() {
  const runs = (pipelinesHealth("prod").pipelines as { latest_run: Record<string, unknown> | null; last_success: Record<string, unknown> | null }[])
    .flatMap((p) => [p.latest_run, p.last_success]).filter((r): r is Record<string, unknown> => r !== null);
  return new Map(runs.map((r) => [r.run_id as string, r]));
}

function runRoute(scenario: Scenario, stage: string, id: string, sub: string | undefined): { json: unknown } {
  const op = sub === "failure" ? "get_run_failure" : sub === undefined ? "get_run" : undefined;
  if (!op) throw new HttpError(404, "Not Found");
  if (scenario === "unauthorized" || scenario === "limited" || scenario === "no-access") throw new HttpError(403, `role analyst may not call ${op} on stage '${stage}'`);
  if (stage !== "prod") throw new HttpError(502, `Dagster for stage '${stage}' could not be read`);
  const run = runsOnRecord().get(id);
  if (!run) throw new HttpError(404, `no run '${id}' in stage '${stage}'`);
  if (op === "get_run") return { json: run };
  const product = (run.job_name as string) in SCOPES;
  const failed = run.status === "FAILURE";
  const unknown = scenario === "unknown" && failed;
  return {
    json: {
      run_id: id, job: run.job_name, status: run.status,
      steps: unknown ? null : failed ? [{
        step: "floe_silver_orders", error_class: "SchemaMismatchError",
        message: "orders.amount: expected decimal(18,2), found string in orders_2026-11-16.csv; policy abort, 0 rows written to sales_silver.orders",
        message_truncated: true,
      }] : [],
      run_message: null, steps_truncated: false,
      rows: unknown || !product ? null : failed ? { rejected: 412, accepted: 0, complete: true } : { rejected: 0, accepted: 19402, complete: true },
      sources: [
        unknown ? { name: "dagster", status: "unavailable", reason: "the run's event log could not be read" }
          : { name: "dagster", status: "available", reason: failed ? "read from the run's event log" : "the run succeeded" },
        unknown ? { name: "quality", status: "unavailable", reason: "the run's quality manifest could not be read" }
          : product ? { name: "quality", status: "available", reason: "read from the run's quality manifest" }
            : { name: "quality", status: "not_provided", reason: "only a product pipeline's run writes a quality manifest" },
      ],
    },
  };
}

/** The log archive, as list_logs answers it: the role's stages only, lines of one UTC day, oldest first. */
function logsRoute(scenario: Scenario, stage: string, url: URL): { json: unknown } {
  const access = monitoringCapabilities(scenario).stages.find((s) => s.stage === stage);
  if (!access?.operations.includes("list_logs") || scenario === "unauthorized") throw new HttpError(403, `role data-engineer may not call list_logs on stage '${stage}'`);
  if (!url.searchParams.get("date")) throw new HttpError(422, "date is required");
  const runId = url.searchParams.get("run_id") ?? "";
  const floor = url.searchParams.get("severity");
  const rank: Record<string, number> = { INFO: 1, WARN: 2, ERROR: 3 };
  const min = floor === "error" ? 3 : floor === "warning" ? 2 : 0;
  const at = new Date().toISOString();
  const line = (container: string, level: string, t: string, text: string) => ({
    archived_at: at, namespace: `olf-${stage}`, pod: `dagster-run-${runId.slice(0, 8)}`, container, line: `${t} ${level.padEnd(5)} ${text}`, error: null,
    component: container, product: "orders", domain: "sales", run_id: runId, stage, source: "pod", stream: "stdout", missing: null, level,
  });
  const lines = runId !== FAILED_RUN ? [] : [
    line("floe", "INFO", "03:02:11.204", "Starting Silver load sales.orders"),
    line("floe", "INFO", "03:02:11.882", "Reading bronze crm/orders/2026-11-16 · 3 files"),
    line("floe", "INFO", "03:02:14.310", "Validating 19,402 rows against sales/orders"),
    line("floe", "WARN", "03:03:52.017", "floe_cast_error orders.ordered_at · 412 rows quarantined"),
    line("floe", "ERROR", "03:04:03.551", "floe_schema_mismatch orders.amount · expected decimal(18,2), found string"),
    line("floe", "ERROR", "03:04:03.552", "policy abort · stopping before commit, 0 rows written"),
    line("floe", "INFO", "03:04:05.118", "Report written to floe/reports/sales/run_c94cbcb0/"),
    line("dagster", "INFO", "03:04:05.240", "Step floe_silver_orders failed · Gold skipped"),
  ];
  return { json: { lines: lines.filter((l) => rank[l.level] >= min).map(({ level: _, ...l }) => l), truncated: false } };
}
