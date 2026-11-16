// The Platform API contract for the Files explorer (openlakeforge #1114), in one place so aligning with
// the final backend shape is a small diff. Same-origin and cookie-authenticated: no token, endpoint or
// permission logic in JS. The UI hides what file-capabilities does not offer; the API stays the authority.
// Every failure is an HTTP error with {detail}. shortcut: hand-written types; generate them from the OpenAPI spec.

import { ApiError } from "./query-api";

export { ApiError };
const BASE = "/api/v1";

export type FileOperation =
  | "list_buckets" | "list_objects" | "download_object" | "upload_object"
  | "create_folder" | "rename_object" | "delete_objects";
export type FileStage = { stage: string; operations: FileOperation[] };
export type FileCapabilities = { stages: FileStage[]; maxUploadBytes: number };
export type Bucket = { name: string; created_at: string | null };
export type Folder = { prefix: string };
export type FileObject = { key: string; size: number; last_modified: string };
export type Listing = { prefix: string; folders: Folder[]; files: FileObject[]; next_cursor: string | null };
export type DeleteResult = { deleted: string[]; errors: { key: string; detail: string }[] };

/** status 0 is a network failure. `message` is safe, truthful text to show as is. */
export function explain(status: number, detail?: string): string {
  if (status === 0) return "The Platform API cannot be reached.";
  if (status === 401) return `Your session has expired. Reload the page to sign in again.${detail ? ` ${detail}` : ""}`;
  if (detail) return detail; // 403, 404, 409, 413, 422...: the API says exactly what was refused
  if (status === 403) return "Access denied.";
  if (status === 404) return "Not found.";
  if (status === 409) return "That already exists.";
  if (status === 411) return "The upload needs a known size.";
  if (status === 413) return "The file is too large.";
  if (status === 422) return "The request was rejected.";
  return `The request failed (${status}).`;
}

const detailOf = (body: unknown) =>
  typeof (body as { detail?: unknown } | undefined)?.detail === "string" ? (body as { detail: string }).detail : undefined;

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
  if (!res.ok) throw new ApiError(res.status, explain(res.status, detailOf(body)));
  return body as T;
}

const seg = encodeURIComponent;
const qs = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};
const bucketPath = (stage: string, bucket: string) => `/stages/${seg(stage)}/buckets/${seg(bucket)}`;

export const getFileCapabilities = async (): Promise<FileCapabilities> => {
  const c = await request<{ stages?: FileStage[]; max_upload_bytes?: number }>("/file-capabilities");
  return { stages: c.stages ?? [], maxUploadBytes: c.max_upload_bytes ?? 0 };
};

export const listBuckets = async (stage: string): Promise<Bucket[]> =>
  (await request<{ buckets: Bucket[] }>(`/stages/${seg(stage)}/buckets`)).buckets;

export const listObjects = (stage: string, bucket: string, prefix: string, cursor?: string, limit = 100) =>
  request<Listing>(`${bucketPath(stage, bucket)}/objects${qs({ prefix, cursor, limit: String(limit) })}`);

/** A plain download link: the browser streams it, no JS buffering. */
export const downloadUrl = (stage: string, bucket: string, key: string) =>
  `${BASE}${bucketPath(stage, bucket)}/objects/content${qs({ key })}`;

export const createFolder = (stage: string, bucket: string, prefix: string) =>
  request<{ prefix: string }>(`${bucketPath(stage, bucket)}/folders`, { method: "POST", body: JSON.stringify({ prefix }) });

/** Both ends in "/" for a folder, or neither for a file. */
export const renameObject = (stage: string, bucket: string, from: string, to: string) =>
  request<{ moved: number }>(`${bucketPath(stage, bucket)}/objects/rename`, { method: "POST", body: JSON.stringify({ from, to }) });

/** A key ending in "/" deletes the whole prefix. */
export const deleteObjects = (stage: string, bucket: string, keys: string[]) =>
  request<DeleteResult>(`${bucketPath(stage, bucket)}/objects/delete`, { method: "POST", body: JSON.stringify({ keys }) });

/**
 * Uploads one file as application/octet-stream. fetch has no upload progress, so this is its own XHR path
 * (request() forces JSON). Aborting through `signal` rejects with an AbortError.
 */
export function uploadObject(o: {
  stage: string; bucket: string; key: string; file: Blob; overwrite?: boolean;
  onProgress?(fraction: number): void; signal?: AbortSignal;
}): Promise<{ key: string; size: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open("PUT", `${BASE}${bucketPath(o.stage, o.bucket)}/objects/content${qs({ key: o.key, overwrite: o.overwrite ? "true" : "false" })}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total) o.onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      o.signal?.removeEventListener("abort", abort);
      let body: unknown;
      try { body = JSON.parse(xhr.responseText); } catch { /* no JSON body */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as { key: string; size: number });
      reject(new ApiError(xhr.status, explain(xhr.status, detailOf(body))));
    };
    xhr.onerror = () => { o.signal?.removeEventListener("abort", abort); reject(new ApiError(0, explain(0))); };
    xhr.onabort = () => { o.signal?.removeEventListener("abort", abort); reject(new DOMException("Upload cancelled", "AbortError")); };
    if (o.signal?.aborted) return reject(new DOMException("Upload cancelled", "AbortError"));
    o.signal?.addEventListener("abort", abort);
    xhr.send(o.file);
  });
}

// ── display helpers ────────────────────────────────────────────────────────

export const messageOf = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong.");

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** UTC, so what is shown does not depend on the viewer's clock: "2026-11-16 09:42". */
export function formatTime(iso: string | null | undefined, withTime = true): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "—";
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withTime ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
}

/** The last segment of a key or folder prefix, without a trailing slash. */
export const baseName = (key: string) => key.replace(/\/$/, "").split("/").pop() ?? "";
/** The folder prefix that holds a key or folder prefix ("" at the top). */
export const parentPrefix = (key: string) => {
  const parts = key.replace(/\/$/, "").split("/");
  parts.pop();
  return parts.length ? `${parts.join("/")}/` : "";
};
export const extensionOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "";
};

/** A folder or file name the user typed: a single, non-empty path segment. Returns the problem, if any. */
export function nameProblem(name: string): string | undefined {
  if (!name.trim()) return "Enter a name.";
  if (name.includes("/")) return "A name cannot contain /.";
  if (name === "." || name === "..") return "That name is not allowed.";
  return undefined;
}
