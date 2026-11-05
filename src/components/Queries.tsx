import { useEffect, useRef, useState } from "react";
import {
  ApiError, cancelQuery, exportUrl, getCapabilities, listSchemas, listTables, pollQuery, submitQuery,
  type Cell, type Column, type Page, type QueryResult, type RunStatus, type StageCapability,
} from "../lib/query-api";
import { depthOf } from "../lib/depth";
import { SqlEditor } from "./SqlEditor";

const POLL_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const messageOf = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong.");

// ── explorer data ───────────────────────────────────────────────────────────

type ListStatus = "loading" | "ok" | "expired" | "denied" | "unavailable";
const statusOf = (e: unknown): ListStatus =>
  e instanceof ApiError && e.status === 401 ? "expired" : e instanceof ApiError && e.status === 403 ? "denied" : "unavailable";

/** A cursor-paged list that reloads when `key` changes and is skipped while `enabled` is false. */
function useList<T>(load: (cursor?: string) => Promise<Page<T>>, key: string, enabled = true) {
  const [s, set] = useState<{ items: T[]; next: string | null; status: ListStatus; error?: string }>(
    { items: [], next: null, status: "loading" },
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    set({ items: [], next: null, status: "loading" });
    loadRef.current().then(
      (p) => live && set({ items: p.items, next: p.next_cursor, status: "ok" }),
      (e) => live && set({ items: [], next: null, status: statusOf(e), error: messageOf(e) }),
    );
    return () => { live = false; };
  }, [key, enabled]);
  const more = () => {
    if (!s.next) return;
    loadRef.current(s.next).then(
      (p) => set((prev) => ({ ...prev, items: [...prev.items, ...p.items], next: p.next_cursor })),
      (e) => set((prev) => ({ ...prev, status: statusOf(e), error: messageOf(e) })),
    );
  };
  return { ...s, more };
}

function useDebounced(value: string, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The distinct empty / denied / unavailable / expired states of an explorer list. */
function ListNote({ status, error, empty, noun }: { status: ListStatus; error?: string; empty: boolean; noun: string }) {
  if (status === "loading") return <p className="q-note" role="status">Loading {noun}…</p>;
  if (status === "denied") return <p className="q-note q-warn" role="alert">You do not have access to these {noun}. {error}</p>;
  if (status === "expired") return <p className="q-note q-warn" role="alert">{error}</p>;
  if (status === "unavailable") return <p className="q-note q-warn" role="alert">The {noun} cannot be listed right now. {error}</p>;
  // An empty list is not proof nothing exists: hidden objects may simply not be listed.
  return empty ? <p className="q-note">No {noun} visible to you.</p> : null;
}

function LoadMore({ next, onMore }: { next: string | null; onMore(): void }) {
  return next ? <button type="button" className="q-link" onClick={onMore}>Load more</button> : null;
}

function SchemaNode({ stage, schema, q, forceOpen }: { stage: string; schema: string; q: string; forceOpen: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = open || forceOpen;
  const tables = useList((c) => listTables(stage, schema, q, c), `${stage}|${schema}|${q}`, shown);
  return (
    <li>
      <button type="button" className="q-schema" aria-expanded={shown} onClick={() => setOpen(!shown)} disabled={forceOpen}>
        <span aria-hidden="true">{shown ? "⌄" : "▸"}</span> {schema}
      </button>
      {shown && (
        <div className="q-tables">
          <ul>
            {tables.items.map((t) => (
              <li key={t.name} className="q-table-row">
                <span aria-hidden="true" className="q-glyph">▦</span>
                <span>{t.name}</span>
                <span className="q-type">{t.type}</span>
              </li>
            ))}
          </ul>
          <ListNote status={tables.status} error={tables.error} empty={tables.items.length === 0} noun="tables" />
          <LoadMore next={tables.next} onMore={tables.more} />
        </div>
      )}
    </li>
  );
}

function Explorer({ stage, schema, search, onSearch, onSchemas }: {
  stage: string; schema: string; search: string; onSearch(v: string): void; onSchemas(names: string[]): void;
}) {
  const q = useDebounced(search.trim(), 250);
  // shortcut: search matches schema names under "All schemas" and table names inside a chosen schema;
  // searching table names across schemas needs a backend search endpoint.
  const schemas = useList((c) => listSchemas(stage, schema ? "" : q, c), `${stage}|${schema ? "" : q}`);
  useEffect(() => {
    if (!schema && !q && schemas.status === "ok") onSchemas(schemas.items.map((s) => s.name));
  }, [schemas.items, schemas.status, schema, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const names = schema ? [schema] : schemas.items.map((s) => s.name);
  return (
    <section className="q-card q-explorer" aria-labelledby="q-explorer-h">
      <div className="q-card-head"><h2 id="q-explorer-h">Explorer</h2></div>
      <div className="q-search">
        <input type="search" aria-label="Search the explorer" placeholder={schema ? "Search tables…" : "Search schemas…"}
          value={search} onChange={(e) => onSearch(e.target.value)} />
      </div>
      <div className="q-tree">
        {schema ? null : <ListNote status={schemas.status} error={schemas.error} empty={names.length === 0} noun="schemas" />}
        <ul>{names.map((n) => <SchemaNode key={`${stage}/${n}`} stage={stage} schema={n} q={q} forceOpen={!!schema} />)}</ul>
        {schema ? null : <LoadMore next={schemas.next} onMore={schemas.more} />}
      </div>
    </section>
  );
}

// ── results ─────────────────────────────────────────────────────────────────

type RunState = RunStatus | "failed"; // "failed" is the UI's own: the API reports failures as HTTP errors
type Run = {
  stage: string; schema: string; id?: string; status: RunState; columns: Column[]; rows: Cell[][];
  truncated: boolean; rowCount?: number; elapsedMs?: number; next?: string | null; error?: string;
};
const fromApi = (stage: string, schema: string, r: QueryResult): Run => ({
  stage, schema, id: r.id, status: r.status, columns: r.columns ?? [], rows: r.rows ?? [], truncated: !!r.truncated,
  rowCount: r.row_count, elapsedMs: r.elapsed_ms, next: r.next_cursor,
});
// A follow-up response holds only the next rows (empty once the submit carried everything), so append and
// keep what is shown; the response's row_count and elapsed_ms cover that call alone.
const merge = (cur: Run, r: QueryResult): Run => ({
  ...cur, status: r.status, columns: r.columns?.length ? r.columns : cur.columns, rows: [...cur.rows, ...(r.rows ?? [])],
  truncated: cur.truncated || !!r.truncated, next: r.next_cursor, error: undefined,
  rowCount: cur.rows.length + (r.rows?.length ?? 0), elapsedMs: (cur.elapsedMs ?? 0) + (r.elapsed_ms ?? 0),
});
const active = (s: RunState) => s === "queued" || s === "running";
const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const STATUS: Record<RunState, string> = {
  queued: "RUNNING", running: "RUNNING", succeeded: "COMPLETED", failed: "FAILED", cancelled: "CANCELLED",
};

function CellView({ value }: { value: Cell }) {
  if (value === null) return <span className="q-null">NULL</span>;
  return <>{typeof value === "object" ? JSON.stringify(value) : String(value)}</>; // text only, never HTML
}

function ResultTable({ run }: { run: Run }) {
  return (
    <div className="q-scroll" role="region" aria-label="Query results" tabIndex={0}>
      <table className="q-table">
        <thead>
          <tr>
            <th scope="col" className="q-idx">#</th>
            {run.columns.map((c, i) => (
              <th scope="col" key={i}>{c.name}<span className="q-coltype"> / {c.type}</span></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.rows.map((row, r) => (
            <tr key={r}>
              <td className="q-idx">{String(r + 1).padStart(2, "0")}</td>
              {row.map((v, i) => <td key={i}><CellView value={v} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Results({ run, schema, cancelling, formats, onMore, paging, stages }: {
  stages: string[]; run: Run | null; schema: string; cancelling: boolean; formats: string[]; onMore(): void; paging: boolean;
}) {
  const [format, setFormat] = useState("csv");
  const chosen = formats.includes(format) ? format : formats[0];
  const canExport = !!run && run.status === "succeeded" && !!run.id && !!chosen;
  const label = cancelling ? "CANCELLING" : run ? STATUS[run.status] : "";
  const tone = run?.status === "succeeded" ? "ok" : run && !active(run.status) ? "bad" : "busy";
  return (
    <section className="q-card" aria-labelledby="q-results-h">
      <div className="q-card-head q-results-head">
        <h2 id="q-results-h">Results</h2>
        {run && (
          <>
            <span className={`q-status q-${tone}`} role="status">● {label}</span>
            <span className="q-meta">
              {run.status === "succeeded" && run.rowCount !== undefined && `${run.rowCount} ROWS · `}
              {run.elapsedMs !== undefined && `${duration(run.elapsedMs)} · `}{run.stage.toUpperCase()}<span className="depth" data-depth={depthOf(Math.max(0, stages.indexOf(run.stage)), stages.length)} />{run.schema && ` · ${run.schema}`}
            </span>
          </>
        )}
        <span className="q-spacer" />
        <select className="q-select q-format" aria-label="Export format" value={chosen ?? ""} disabled={!formats.length}
          onChange={(e) => setFormat(e.target.value)}>
          {formats.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
        </select>
        {canExport
          ? <a className="q-btn" href={exportUrl(run.stage, run.id!, chosen)} download>↓ Download</a>
          : <span className="q-btn" aria-disabled="true">↓ Download</span>}
      </div>
      {run && run.schema !== schema && (
        <p className="q-note q-pad">
          This result ran with {run.schema ? `default schema ${run.schema}` : "no default schema"}; the selection has changed. Run again to apply it.
        </p>
      )}
      {!run && <p className="q-note q-pad">Run a query to see results here.</p>}
      {run?.error && <p className="q-note q-warn q-pad" role="alert">{run.error}</p>}
      {run && run.columns.length > 0 && <ResultTable run={run} />}
      {run?.status === "succeeded" && run.rows.length === 0 && !run.error && <p className="q-note q-pad">The query returned no rows.</p>}
      {run && (run.truncated || run.next) && (
        <p className="q-foot">
          {run.truncated && "Truncated: the server returned only part of the result. "}
          {run.next && <button type="button" className="q-link" onClick={onMore} disabled={paging}>Load more rows</button>}
        </p>
      )}
    </section>
  );
}

// ── workspace ───────────────────────────────────────────────────────────────

type Caps = { state: "loading" } | { state: "ready"; stages: StageCapability[] } | { state: "unavailable" | "expired"; message: string };

function EngineBadge() {
  return (
    <div className="q-engine">
      <img className="icon logo" src="/logos/trino.svg" alt="" width="40" height="40" loading="lazy" />
      <span><strong>Trino</strong><span className="label">Query engine</span></span>
    </div>
  );
}

export function QueryWorkspace() {
  const [caps, setCaps] = useState<Caps>({ state: "loading" });
  const [stage, setStage] = useState("");
  const [schema, setSchema] = useState("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [sql, setSql] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [paging, setPaging] = useState(false);
  const [note, setNote] = useState("");
  const busy = useRef(false); // set synchronously, so a second submit in the same tick is refused
  const gen = useRef(0); // bumped to abandon an in-flight run's polling

  useEffect(() => {
    getCapabilities().then(
      (c) => {
        const stages = c.stages.filter((s) => s.available);
        setCaps({ state: "ready", stages });
        setStage(stages[0]?.stage ?? "");
      },
      (e) => setCaps({
        state: e instanceof ApiError && e.status === 401 ? "expired" : "unavailable",
        message: e instanceof ApiError && e.status === 404 ? "This deployment does not provide the query workspace." : messageOf(e),
      }),
    );
  }, []);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(""), 2500);
    return () => clearTimeout(t);
  }, [note]);

  const running = !!run && active(run.status);

  function abandon() {
    gen.current++;
    busy.current = false;
    setCancelling(false);
    if (run?.id && active(run.status)) cancelQuery(run.stage, run.id).catch(() => {});
    setRun(null);
  }

  // A stage switch drops the old result (it belongs to the previous stage) and never re-runs the SQL.
  function pickStage(next: string) {
    if (next === stage) return;
    abandon();
    setStage(next);
    setSchema("");
    setSchemas([]);
    setSearch("");
  }

  async function submit() {
    if (busy.current || !sql.trim() || !stage) return;
    busy.current = true;
    const mine = ++gen.current;
    const st = stage;
    const sc = schema; // the context this run belongs to, whatever is selected later
    setRun({ stage: st, schema: sc, status: "running", columns: [], rows: [], truncated: false });
    try {
      let r = await submitQuery(st, sql, sc || undefined); // "All schemas" sends no default schema
      let cur = fromApi(st, sc, r);
      while (gen.current === mine) {
        setRun(cur);
        if (!active(r.status)) break;
        await sleep(POLL_MS);
        if (gen.current !== mine) break;
        r = await pollQuery(st, r.id, r.next_cursor ?? undefined); // the previous response's cursor, always
        cur = merge(cur, r);
      }
      if (gen.current !== mine) cancelQuery(st, r.id).catch(() => {}); // cancelled while the POST was in flight
    } catch (e) {
      if (gen.current === mine) setRun({ stage: st, schema: sc, status: "failed", columns: [], rows: [], truncated: false, error: messageOf(e) });
    } finally {
      if (gen.current === mine) busy.current = false;
    }
  }

  async function cancel() {
    if (!run) return;
    gen.current++;
    setCancelling(true);
    try {
      if (run.id) await cancelQuery(run.stage, run.id);
      setRun({ ...run, status: "cancelled" });
    } catch (e) {
      setRun({ ...run, status: "failed", error: messageOf(e) });
    } finally {
      setCancelling(false);
      busy.current = false;
    }
  }

  async function more() {
    if (!run?.id || !run.next || paging) return;
    setPaging(true);
    try {
      const r = await pollQuery(run.stage, run.id, run.next);
      setRun((cur) => cur && merge(cur, r));
    } catch (e) {
      setRun((cur) => cur && { ...cur, error: messageOf(e) });
    } finally {
      setPaging(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(sql);
      setNote("SQL copied");
    } catch {
      setNote("Copy failed");
    }
  }

  async function format() {
    try {
      const { format: fmt } = await import("sql-formatter"); // only on an explicit click
      setSql(fmt(sql, { language: "trino" }));
    } catch {
      setNote("Cannot format this SQL");
    }
  }

  const header = (
    <div className="q-head">
      <div>
        <p className="eyebrow">Queries · Trino</p>
        <h1>Query your lakehouse, <em>at any depth.</em></h1>
        <p className="lede">Run ad-hoc SQL on your lakehouse.</p>
      </div>
      <EngineBadge />
    </div>
  );

  if (caps.state === "loading") return <>{header}<p className="q-note" role="status">Checking the query engine…</p></>;
  if (caps.state !== "ready" || caps.stages.length === 0) {
    return (
      <>
        {header}
        <p className="empty">
          <span className="label">{caps.state === "expired" ? "Session expired" : "Not available"}</span>
          {caps.state === "ready"
            ? "No query engine is available on any stage of this deployment."
            : caps.message}
        </p>
      </>
    );
  }

  const formats = caps.stages.find((s) => s.stage === stage)?.export_formats ?? [];
  return (
    <>
      {header}
      <div className="q-context">
        <label>
          <span className="q-label">Stage</span>
          <select className="q-select" value={stage} onChange={(e) => pickStage(e.target.value)}>
            {caps.stages.map((s) => <option key={s.stage} value={s.stage}>{s.stage.toUpperCase()}</option>)}
          </select>
        </label>
        <label>
          <span className="q-label">Schema</span>
          <select className="q-select q-wide" aria-describedby="q-ctx" value={schema} onChange={(e) => { setSchema(e.target.value); setSearch(""); }}>
            <option value="">All schemas</option>
            {schemas.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      <div className="q-grid">
        <section className="q-card q-editor" aria-labelledby="q-editor-h">
          <div className="q-card-head q-toolbar">
            <h2 id="q-editor-h">SQL editor</h2>
            <span className="q-spacer" />
            <span className="q-note" role="status">{note}</span>
            <button type="button" className="q-text-btn" onClick={format} disabled={!sql.trim()}>Format</button>
            <button type="button" className="q-text-btn" onClick={copy} aria-label="Copy SQL" disabled={!sql}>Copy</button>
          </div>
          <SqlEditor value={sql} onChange={setSql} onRun={submit} />
          <div className="q-actions">
            <span className="q-hint">
              Ctrl/Cmd + Enter to run · Your permissions apply
              <span id="q-ctx" className="q-ctx">
                {schema ? `Unqualified tables resolve in ${schema}` : "Qualify tables as schema.table"}
              </span>
            </span>
            {running || cancelling
              ? <button type="button" className="q-run q-cancel" onClick={cancel} disabled={cancelling}>{cancelling ? "Cancelling…" : "■ Cancel"}</button>
              : <button type="button" className="q-run" onClick={submit} disabled={!sql.trim()}>▶ RUN</button>}
          </div>
        </section>
        <Explorer key={stage} stage={stage} schema={schema} search={search} onSearch={setSearch} onSchemas={setSchemas} />
      </div>
      <Results stages={caps.stages.map((s) => s.stage)} run={run} schema={schema} cancelling={cancelling} formats={formats} onMore={more} paging={paging} />
    </>
  );
}
