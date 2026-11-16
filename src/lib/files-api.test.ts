// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError, baseName, createFolder, deleteObjects, downloadUrl, extensionOf, formatSize, formatTime, getFileCapabilities, listBuckets,
  listObjects, nameProblem, parentPrefix, renameObject, uploadObject,
} from "./files-api";

type Call = { method: string; url: URL; init: RequestInit };
function stub(status: number, body: unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? "GET", url: new URL(input, "http://portal.test"), init });
    return new Response(JSON.stringify(body), { status });
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("requests", () => {
  it("reads file-capabilities", async () => {
    const calls = stub(200, { stages: [{ stage: "dev", operations: ["list_buckets"] }], max_upload_bytes: 10 });
    expect(await getFileCapabilities()).toEqual({ stages: [{ stage: "dev", operations: ["list_buckets"] }], maxUploadBytes: 10 });
    expect(calls[0].url.pathname).toBe("/api/v1/file-capabilities");
    expect(calls[0].init.credentials).toBe("same-origin");
  });

  it("lists buckets of a stage", async () => {
    const calls = stub(200, { buckets: [{ name: "b", created_at: null }] });
    expect(await listBuckets("dev")).toEqual([{ name: "b", created_at: null }]);
    expect(calls[0].url.pathname).toBe("/api/v1/stages/dev/buckets");
  });

  it("lists objects with prefix, cursor and limit, encoding the bucket", async () => {
    const calls = stub(200, { prefix: "a/", folders: [], files: [], next_cursor: null });
    await listObjects("dev", "my bucket", "a/b c/", "cur", 50);
    expect(calls[0].url.pathname).toBe("/api/v1/stages/dev/buckets/my%20bucket/objects");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ prefix: "a/b c/", cursor: "cur", limit: "50" });
  });

  it("builds a plain download link", () => {
    expect(downloadUrl("dev", "b", "raw/a b&c.csv")).toBe("/api/v1/stages/dev/buckets/b/objects/content?key=raw%2Fa+b%26c.csv");
  });

  it("posts folders, renames and deletes as JSON", async () => {
    const calls = stub(200, {});
    await createFolder("dev", "b", "x/y/");
    await renameObject("dev", "b", "x/", "z/");
    await deleteObjects("dev", "b", ["a", "d/"]);
    expect(calls.map((c) => [c.method, c.url.pathname, c.init.body])).toEqual([
      ["POST", "/api/v1/stages/dev/buckets/b/folders", '{"prefix":"x/y/"}'],
      ["POST", "/api/v1/stages/dev/buckets/b/objects/rename", '{"from":"x/","to":"z/"}'],
      ["POST", "/api/v1/stages/dev/buckets/b/objects/delete", '{"keys":["a","d/"]}'],
    ]);
    expect(calls.every((c) => (c.init.headers as Record<string, string>)["Content-Type"] === "application/json")).toBe(true);
  });
});

describe("errors", () => {
  it.each([
    [403, "Writes under the audit prefix are refused.", "Writes under the audit prefix are refused."],
    [409, "object 'x' already exists", "object 'x' already exists"],
    [422, "renaming moves more than 1000 objects", "renaming moves more than 1000 objects"],
    [403, undefined, "Access denied."],
    [401, undefined, "Your session has expired. Reload the page to sign in again."],
  ])("status %i shows the API's detail", async (status, detail, message) => {
    stub(status, detail ? { detail } : {});
    await expect(listBuckets("dev")).rejects.toMatchObject({ status, message });
  });

  it("ignores a non-string detail", async () => {
    stub(422, { detail: [{ msg: "bad" }] });
    await expect(listBuckets("dev")).rejects.toMatchObject({ status: 422, message: "The request was rejected." });
  });

  it("reports a network failure as status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await expect(listBuckets("dev")).rejects.toMatchObject({ status: 0, message: "The Platform API cannot be reached." });
  });
});

/** A scriptable XMLHttpRequest. */
class FakeXhr {
  static last: FakeXhr;
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  onload?: () => void; onerror?: () => void; onabort?: () => void;
  status = 0; responseText = ""; method = ""; url = ""; headers: Record<string, string> = {}; sent: unknown;
  constructor() { FakeXhr.last = this; }
  open(m: string, u: string) { this.method = m; this.url = u; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send(b: unknown) { this.sent = b; }
  abort() { this.onabort?.(); }
  reply(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.(); }
}

describe("uploadObject", () => {
  const file = new Blob(["hello"]);
  const base = { stage: "dev", bucket: "b", key: "raw/a.txt", file };
  const withXhr = () => vi.stubGlobal("XMLHttpRequest", FakeXhr);

  it("PUTs the bytes as octet-stream, reports progress and resolves", async () => {
    withXhr();
    const progress: number[] = [];
    const p = uploadObject({ ...base, onProgress: (f) => progress.push(f) });
    const x = FakeXhr.last;
    expect(x.method).toBe("PUT");
    expect(x.url).toBe("/api/v1/stages/dev/buckets/b/objects/content?key=raw%2Fa.txt&overwrite=false");
    expect(x.headers["Content-Type"]).toBe("application/octet-stream");
    expect(x.sent).toBe(file);
    x.upload.onprogress!({ lengthComputable: true, loaded: 1, total: 4 });
    x.reply(201, { key: "raw/a.txt", size: 5 });
    expect(await p).toEqual({ key: "raw/a.txt", size: 5 });
    expect(progress).toEqual([0.25]);
  });

  it.each([[409, "object exists"], [413, "too big"]])("rejects %i with the API's detail", async (status, detail) => {
    withXhr();
    const p = uploadObject(base);
    FakeXhr.last.reply(status, { detail });
    await expect(p).rejects.toMatchObject({ status, message: detail });
    await expect(p).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects a network failure, and an abort with AbortError", async () => {
    withXhr();
    const a = uploadObject(base);
    FakeXhr.last.onerror!();
    await expect(a).rejects.toMatchObject({ status: 0 });

    const ctl = new AbortController();
    const b = uploadObject({ ...base, signal: ctl.signal });
    ctl.abort();
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("helpers", () => {
  it("formats sizes", () => {
    expect([0, 512, 2150, 50_540_000, 5 * 1024 ** 3].map(formatSize)).toEqual(["0 B", "512 B", "2.1 KB", "48.2 MB", "5.0 GB"]);
  });
  it("formats times in UTC", () => {
    expect(formatTime("2026-11-16T09:42:10Z")).toBe("2026-11-16 09:42");
    expect(formatTime("2026-09-02T08:00:00Z", false)).toBe("2026-09-02");
    expect(formatTime(null)).toBe("—");
  });
  it("splits keys", () => {
    expect(baseName("raw/orders/")).toBe("orders");
    expect(baseName("raw/a.txt")).toBe("a.txt");
    expect(parentPrefix("raw/orders/")).toBe("raw/");
    expect(parentPrefix("a.txt")).toBe("");
    expect(extensionOf("a.PARQUET")).toBe("parquet");
    expect(extensionOf(".hidden")).toBe("");
    expect(extensionOf("noext")).toBe("");
  });
  it("rejects bad names", () => {
    expect(nameProblem("")).toBeTruthy();
    expect(nameProblem("a/b")).toBeTruthy();
    expect(nameProblem("..")).toBeTruthy();
    expect(nameProblem("2026-11-17")).toBeUndefined();
  });
});
