import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  ApiError, baseName, createFolder, deleteObjects, downloadUrl, getFileCapabilities, listBuckets, listObjects, messageOf, parentPrefix,
  renameObject, formatTime,
  type Bucket, type FileCapabilities, type FileOperation, type FileObject, type Folder,
} from "../lib/files-api";
import { DeleteDialog, itemOf, NewFolderDialog, RenameDialog, UploadDialog, type Item } from "./FilesDialogs";
import { Icon } from "./FilesIcons";
import { FilesTable, type RowAction, type Sort } from "./FilesTable";
import { useUploads } from "./useUploads";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Browsers stream a download from a plain link, so a click on a detached anchor starts it. */
function startDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
}

const url = (p: { stage: string; bucket?: string; prefix?: string }) => {
  const q = new URLSearchParams({ stage: p.stage });
  if (p.bucket) q.set("bucket", p.bucket);
  if (p.bucket && p.prefix) q.set("prefix", p.prefix);
  return `/files?${q}`;
};

type Caps = { state: "loading" } | { state: "ready"; caps: FileCapabilities } | { state: "error"; message: string; expired: boolean };
type Buckets = { status: "loading" | "ok" | "error"; items: Bucket[]; error?: string };

function Header() {
  return (
    <div className="q-head">
      <div>
        <h1>Files</h1>
        <p className="f-sub">Browse and manage your lakehouse buckets.</p>
      </div>
      <div className="q-engine">
        <span className="icon" aria-hidden="true"><Icon name="database" size={20} /></span>
        <span><strong>SeaweedFS</strong><span className="label">Object storage</span></span>
      </div>
    </div>
  );
}

// ── buckets ─────────────────────────────────────────────────────────────────

function BucketsCard({ stage, buckets, find, onRefresh }: { stage: string; buckets: Buckets; find: string; onRefresh(): void }) {
  const shown = buckets.items.filter((b) => b.name.toLowerCase().includes(find.trim().toLowerCase()));
  return (
    <section className="q-card" aria-labelledby="f-buckets-h">
      <div className="f-card-head">
        <h2 id="f-buckets-h">Buckets</h2>
        {buckets.status === "ok" && <span className="f-count">{shown.length}</span>}
        <span className="q-spacer" />
        <button type="button" className="f-btn f-outline" onClick={onRefresh}><Icon name="refresh" size={14} />Refresh</button>
      </div>
      {buckets.status === "loading" && <p className="q-note q-pad" role="status">Loading buckets…</p>}
      {buckets.status === "error" && <p className="q-note q-warn q-pad" role="alert">{buckets.error}</p>}
      {buckets.status === "ok" && shown.length === 0 && <p className="q-note q-pad">{find.trim() ? "No bucket matches." : "No buckets."}</p>}
      {shown.length > 0 && (
        <div className="f-scroll">
          <table className="f-table f-buckets">
            <thead><tr><th scope="col">Name</th><th scope="col" className="f-when">Created</th><th scope="col" className="f-more"><span className="f-sr">Open</span></th></tr></thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.name} className="f-bucket-row">
                  <td className="f-name">
                    <span className="f-bucket-ico"><Icon name="database" size={16} /></span>
                    <Link to={url({ stage, bucket: b.name })} className="f-folder-link f-row-link">{b.name}</Link>
                  </td>
                  <td className="f-when f-mono">{formatTime(b.created_at, false)}</td>
                  <td className="f-more f-chevron" aria-hidden="true"><Icon name="chevronRight" size={14} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── browse ──────────────────────────────────────────────────────────────────

type Listing = { key: string; status: "loading" | "ok" | "error"; folders: Folder[]; files: FileObject[]; next: string | null; error?: string };
type Loc = { stage: string; bucket: string; prefix: string };
type Kind = { kind: "folder" } | { kind: "upload" } | { kind: "rename"; item: Item } | { kind: "delete"; items: Item[] };
// The place a dialog opened on travels with it, so confirming acts there whatever is browsed by then.
type Dialog = null | (Kind & { at: Loc });

function Browse({ stage, bucket, prefix, ops, uploads, uploaded }: {
  stage: string; bucket: string; prefix: string; ops: FileOperation[];
  uploads: ReturnType<typeof useUploads>; uploaded: number;
}) {
  const [find, setFind] = useState("");
  const debounced = useDebounced(find, 250);
  const q = find ? debounced : ""; // clearing applies at once, so a folder change never lists with the old text
  const listPrefix = prefix + q; // a typed prefix narrows the listing on the server, so paging stays right
  const where = `${stage}|${bucket}|${listPrefix}`;
  const [reload, setReload] = useState(0);
  const [stored, setListing] = useState<Listing>({ key: "", status: "loading", folders: [], files: [], next: null });
  // Rows of another place are never shown, not even for the frame before the effect below resets them.
  const listing: Listing = stored.key === where ? stored : { key: where, status: "loading", folders: [], files: [], next: null };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<Sort>("asc");
  const [dialog, setDialog] = useState<Dialog>(null);
  const show = (k: Kind) => setDialog({ ...k, at: { stage, bucket, prefix } });
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState(false);
  const can = (op: FileOperation) => ops.includes(op);

  useEffect(() => { setFind(""); setSelected(new Set()); setDialog(null); }, [stage, bucket, prefix]); // a pending dialog belongs to the place it opened on
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(""), 2500);
    return () => clearTimeout(t);
  }, [note]);

  useEffect(() => {
    let live = true;
    // A refresh keeps the rows on screen; moving to another place starts empty.
    setListing((cur) => (cur.key === where ? { ...cur, status: "loading" } : { key: where, status: "loading", folders: [], files: [], next: null }));
    listObjects(stage, bucket, listPrefix).then(
      (p) => live && setListing({ key: where, status: "ok", folders: p.folders, files: p.files, next: p.next_cursor }),
      (e) => live && setListing({ key: where, status: "error", folders: [], files: [], next: null, error: messageOf(e) }),
    );
    return () => { live = false; };
  }, [where, reload, uploaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const paging = useRef(false); // set synchronously, so a second click in the same tick is refused
  const [loadingMore, setLoadingMore] = useState(false);
  async function more() {
    const cursor = listing.next;
    if (!cursor || paging.current) return;
    paging.current = true;
    setLoadingMore(true);
    try {
      const p = await listObjects(stage, bucket, listPrefix, cursor);
      // Only the response to the cursor the list still waits on is appended; a stale one is dropped.
      setListing((cur) => (cur.key === where && cur.next === cursor ? { ...cur, folders: [...cur.folders, ...p.folders], files: [...cur.files, ...p.files], next: p.next_cursor } : cur));
    } catch (e) {
      setListing((cur) => ({ ...cur, error: messageOf(e) }));
    } finally {
      paging.current = false;
      setLoadingMore(false);
    }
  }

  const items = useMemo<Item[]>(() => {
    const dir = sort === "asc" ? 1 : -1;
    const byName = (a: Item, b: Item) => dir * a.key.localeCompare(b.key, undefined, { numeric: true });
    const folders = listing.folders.map((f): Item => ({ key: f.prefix, folder: true })).sort(byName);
    const files = listing.files.filter((f) => !f.key.endsWith("/")).map(itemOf).sort(byName);
    return [...folders, ...files];
  }, [listing.folders, listing.files, sort]);

  // Rows that vanished (after a refresh or delete) cannot stay selected.
  useEffect(() => {
    setSelected((cur) => {
      const keep = new Set(items.filter((i) => cur.has(i.key)).map((i) => i.key));
      return keep.size === cur.size ? cur : keep;
    });
  }, [items]);

  const refresh = () => setReload((n) => n + 1);
  const picked = items.filter((i) => selected.has(i.key));

  function act(a: RowAction, keys: string[]) {
    const chosen = items.filter((i) => keys.includes(i.key));
    if (!chosen.length) return;
    if (a === "download") chosen.filter((i) => !i.folder).forEach((i) => startDownload(downloadUrl(stage, bucket, i.key)));
    else if (a === "rename" && chosen.length === 1) show({ kind: "rename", item: chosen[0] });
    else if (a === "delete") show({ kind: "delete", items: chosen });
    else if (a === "copy") {
      navigator.clipboard.writeText(`s3://${bucket}/${chosen[0].key}`).then(() => setNote("S3 URI copied"), () => setNote("Copy failed"));
    }
  }

  function openUpload(files?: File[]) {
    if (!uploads.active) uploads.clear();
    show({ kind: "upload" });
    if (files?.length) uploads.add(files, { stage, bucket, prefix });
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(`s3://${bucket}/${prefix}`);
      setNote("Path copied");
    } catch {
      setNote("Copy failed");
    }
  }

  const segments = prefix.split("/").filter(Boolean);
  const rowAllowed: Record<RowAction, boolean> = {
    download: can("download_object"), rename: can("rename_object"), copy: true, delete: can("delete_objects"),
  };
  const onlyFiles = picked.length > 0 && picked.every((i) => !i.folder);
  const empty = listing.status === "ok" && items.length === 0 && !q;
  const here = prefix ? `${baseName(prefix)}/` : `${bucket}/`;
  const link = (p: string) => url({ stage, bucket, prefix: p });

  return (
    <>
      <div className="f-crumb-row">
        <nav aria-label="Breadcrumb">
          <ol className="f-crumbs">
            <li><Link to={url({ stage })}>Buckets</Link></li>
            <li aria-hidden="true" className="f-sep">/</li>
            <li>{segments.length ? <Link to={link("")} className="f-mono">{bucket}</Link> : <span className="f-mono f-current" aria-current="page">{bucket}</span>}</li>
            {segments.map((s, i) => {
              const p = `${segments.slice(0, i + 1).join("/")}/`;
              return [
                <li key={`${p}-sep`} aria-hidden="true" className="f-sep">/</li>,
                <li key={p}>{i === segments.length - 1 ? <span className="f-mono f-current" aria-current="page">{s}</span> : <Link to={link(p)} className="f-mono">{s}</Link>}</li>,
              ];
            })}
          </ol>
        </nav>
        <span className="q-note" role="status">{note}</span>
        <button type="button" className="f-text-btn" onClick={copyPath}><Icon name="copy" size={14} />Copy path</button>
      </div>

      <section className={`q-card${dragging ? " f-dragging" : ""}`} aria-labelledby="f-objects-h"
        onDragOver={(e) => { if (can("upload_object") && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
        onDrop={(e) => {
          setDragging(false);
          if (!can("upload_object") || !e.dataTransfer.files.length) return;
          e.preventDefault();
          openUpload([...e.dataTransfer.files]);
        }}>
        <div className="f-card-head">
          <h2 id="f-objects-h">Objects</h2>
          <span className="f-count">
            {items.length}{listing.next ? "+" : ""} {items.length === 1 ? "item" : "items"}{picked.length > 0 && ` · ${picked.length} selected`}
          </span>
          <span className="q-spacer" />
          {uploads.active && dialog?.kind !== "upload" && (
            <button type="button" className="f-text-btn" onClick={() => show({ kind: "upload" })}>
              Uploading {uploads.items.filter((i) => i.status === "queued" || i.status === "uploading").length}…
            </button>
          )}
          <div className="f-toolbar" role="toolbar" aria-label="Object actions">
            <button type="button" className="f-btn f-outline f-square" aria-label="Refresh" onClick={refresh}><Icon name="refresh" size={14} /></button>
            {can("download_object") && <button type="button" className="f-btn f-outline" disabled={!onlyFiles} onClick={() => act("download", picked.map((i) => i.key))}><Icon name="download" size={14} />Download</button>}
            {can("rename_object") && <button type="button" className="f-btn f-outline" disabled={picked.length !== 1} onClick={() => act("rename", [picked[0].key])}><Icon name="pencil" size={14} />Rename</button>}
            {can("delete_objects") && <button type="button" className="f-btn f-danger" disabled={picked.length === 0} onClick={() => act("delete", picked.map((i) => i.key))}>Delete</button>}
            {can("create_folder") && <button type="button" className="f-btn f-outline" onClick={() => show({ kind: "folder" })}><Icon name="plus" size={14} />Create folder</button>}
            {can("upload_object") && <button type="button" className="f-btn f-primary" onClick={() => openUpload()}><Icon name="upload" size={14} />Upload</button>}
          </div>
        </div>
        <div className="f-find">
          <Icon name="search" size={16} />
          <input type="search" aria-label="Find objects by prefix" placeholder={`Find objects by prefix in ${here}`} value={find} onChange={(e) => setFind(e.target.value)} />
        </div>

        {listing.status === "error" && <p className="q-note q-warn q-pad" role="alert">{listing.error}</p>}
        {listing.status === "loading" && items.length === 0 && <p className="q-note q-pad" role="status">Loading objects…</p>}
        {empty && (
          <div className="f-empty">
            <Icon name="folder" size={28} />
            <p>Empty folder</p>
            <div className="f-empty-actions">
              {can("create_folder") && <button type="button" className="f-btn f-outline" onClick={() => show({ kind: "folder" })}><Icon name="plus" size={14} />Create folder</button>}
              {can("upload_object") && <button type="button" className="f-btn f-primary" onClick={() => openUpload()}><Icon name="upload" size={14} />Upload</button>}
            </div>
          </div>
        )}
        {listing.status === "ok" && items.length === 0 && q && <p className="q-note q-pad">No objects match.</p>}
        {items.length > 0 && (
          <FilesTable base={prefix} items={items} selected={selected} sort={sort} onSort={() => setSort(sort === "asc" ? "desc" : "asc")}
            onSelect={(key, on) => setSelected((cur) => { const n = new Set(cur); if (on) n.add(key); else n.delete(key); return n; })}
            onToggleAll={(on) => setSelected(on ? new Set(items.map((i) => i.key)) : new Set())}
            linkTo={(p) => link(p)} allowed={rowAllowed} onAction={act} />
        )}
        {listing.next && (
          <p className="f-foot"><button type="button" className="q-link" onClick={more} disabled={loadingMore}>Load more</button></p>
        )}
      </section>

      {dialog?.kind === "folder" && (
        <NewFolderDialog prefix={dialog.at.prefix} onClose={() => setDialog(null)}
          create={async (name) => { await createFolder(dialog.at.stage, dialog.at.bucket, `${dialog.at.prefix}${name}/`); refresh(); }} />
      )}
      {dialog?.kind === "rename" && (
        <RenameDialog item={dialog.item} onClose={() => setDialog(null)}
          rename={async (name) => {
            const { item } = dialog;
            await renameObject(dialog.at.stage, dialog.at.bucket, item.key, `${parentPrefix(item.key)}${name}${item.folder ? "/" : ""}`);
            setSelected(new Set());
            refresh();
          }} />
      )}
      {dialog?.kind === "delete" && (
        <DeleteDialog items={dialog.items} base={dialog.at.prefix} onClose={() => setDialog(null)}
          remove={async () => {
            const r = await deleteObjects(dialog.at.stage, dialog.at.bucket, dialog.items.map((i) => i.key));
            setSelected(new Set());
            refresh();
            return r.errors;
          }} />
      )}
      {dialog?.kind === "upload" && (
        <UploadDialog prefix={dialog.at.prefix} items={uploads.items} add={(f) => uploads.add(f, dialog.at)} cancel={uploads.cancel}
          onHide={() => setDialog(null)} />
      )}
    </>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

export function Files() {
  const [params, setParams] = useSearchParams();
  const [caps, setCaps] = useState<Caps>({ state: "loading" });
  const [find, setFind] = useState("");
  const [buckets, setBuckets] = useState<Buckets>({ status: "loading", items: [] });
  const [reloadBuckets, setReloadBuckets] = useState(0);
  const [uploaded, setUploaded] = useState(0);
  const uploads = useUploads(caps.state === "ready" ? caps.caps.maxUploadBytes : 0, () => setUploaded((n) => n + 1));

  useEffect(() => {
    getFileCapabilities().then(
      (c) => setCaps({ state: "ready", caps: c }),
      (e) => setCaps({ state: "error", message: messageOf(e), expired: e instanceof ApiError && e.status === 401 }),
    );
  }, []);

  const stages = caps.state === "ready" ? caps.caps.stages : [];
  const wanted = params.get("stage");
  const stageCap = stages.find((s) => s.stage === wanted) ?? stages[0];
  const stage = stageCap?.stage ?? "";
  const bucket = params.get("bucket") ?? "";
  const prefix = bucket ? params.get("prefix") ?? "" : "";
  const canList = !!stageCap?.operations.includes("list_buckets");

  useEffect(() => {
    if (!stage || !canList) return;
    let live = true;
    setBuckets({ status: "loading", items: [] });
    listBuckets(stage).then(
      (items) => live && setBuckets({ status: "ok", items }),
      (e) => live && setBuckets({ status: "error", items: [], error: messageOf(e) }),
    );
    return () => { live = false; };
  }, [stage, canList, reloadBuckets]);

  const go = useCallback((p: { stage?: string; bucket?: string; prefix?: string }) => {
    const next = new URLSearchParams({ stage: p.stage ?? stage });
    if (p.bucket) next.set("bucket", p.bucket);
    if (p.bucket && p.prefix) next.set("prefix", p.prefix);
    setParams(next);
  }, [stage, setParams]);

  if (caps.state === "loading") return <><Header /><p className="q-note" role="status">Checking your access…</p></>;
  if (caps.state === "error" || stages.length === 0) {
    return (
      <>
        <Header />
        <p className="empty">
          <span className="label">{caps.state === "error" && caps.expired ? "Session expired" : "Not available"}</span>
          {caps.state === "error" ? caps.message : "Files are not available to you on any stage."}
        </p>
      </>
    );
  }

  const names = buckets.items.map((b) => b.name);
  const bucketOptions = bucket && !names.includes(bucket) ? [bucket, ...names] : names;
  return (
    <>
      <Header />
      <div className="q-context">
        <label>
          <span className="q-label">Stage</span>
          <select className="q-select" value={stage} onChange={(e) => { setFind(""); go({ stage: e.target.value }); }}>
            {stages.map((s) => <option key={s.stage} value={s.stage}>{s.stage.toUpperCase()}</option>)}
          </select>
        </label>
        {bucket ? (
          <label>
            <span className="q-label">Bucket</span>
            <select className="q-select q-wide f-mono" value={bucket} onChange={(e) => go({ bucket: e.target.value })}>
              {bucketOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        ) : (
          <label>
            <span className="q-label">Find bucket</span>
            <span className="f-find f-find-inline">
              <Icon name="search" size={16} />
              <input type="search" className="f-input" placeholder="Filter by name…" value={find} onChange={(e) => setFind(e.target.value)} />
            </span>
          </label>
        )}
      </div>
      {bucket
        ? <Browse key={stage} stage={stage} bucket={bucket} prefix={prefix} ops={stageCap.operations} uploads={uploads} uploaded={uploaded} />
        : <BucketsCard stage={stage} buckets={buckets} find={find} onRefresh={() => setReloadBuckets((n) => n + 1)} />}
    </>
  );
}
