// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Files } from "./Files";
import { AppShell } from "./Shell";

type Reply = { status?: number; body?: unknown };
type Handler = (url: URL, init: RequestInit) => Reply | Promise<Reply>;

const ALL = ["list_buckets", "list_objects", "download_object", "upload_object", "create_folder", "rename_object", "delete_objects"];
const caps = (operations = ALL, stages = ["dev"]) => ({ stages: stages.map((stage) => ({ stage, operations })), max_upload_bytes: 1000 });
const BUCKET = "openlakeforge-dev-bronze";
const listing = (over = {}) => ({
  prefix: "raw/orders/",
  folders: [{ prefix: "raw/orders/2026-11-14/" }, { prefix: "raw/orders/2026-11-15/" }],
  files: [
    { key: "raw/orders/_manifest.json", size: 2150, last_modified: "2026-11-16T09:42:00Z" },
    { key: "raw/orders/orders_2026-11-16.parquet", size: 50_540_000, last_modified: "2026-11-16T09:41:00Z" },
  ],
  next_cursor: null, ...over,
});

function api(handlers: Record<string, Handler | Reply>) {
  const calls: { method: string; url: URL; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://portal.test");
    const method = init.method ?? "GET";
    calls.push({ method, url, init });
    const h = handlers[`${method} ${url.pathname}`];
    if (!h) return new Response(JSON.stringify({ detail: "no handler" }), { status: 404 });
    const r = await (typeof h === "function" ? h(url, init) : h);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }));
  return calls;
}
const base = {
  "GET /api/v1/file-capabilities": { body: caps() },
  "GET /api/v1/stages/dev/buckets": { body: { buckets: [
    { name: BUCKET, created_at: "2026-09-02T08:00:00Z" }, { name: "openlakeforge-dev-silver", created_at: "2026-09-02T08:00:00Z" },
  ] } },
  [`GET /api/v1/stages/dev/buckets/${BUCKET}/objects`]: { body: listing() },
};
const objects = `/api/v1/stages/dev/buckets/${BUCKET}/objects`;

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}
const open = (entry = "/files") => render(<MemoryRouter initialEntries={[entry]}><Files /><Where /></MemoryRouter>);
const browse = `/files?stage=dev&bucket=${BUCKET}&prefix=${encodeURIComponent("raw/orders/")}`;
const row = (name: string) => screen.getByRole("row", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
const pick = (name: string) => userEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
const button = (name: string | RegExp) => screen.getByRole("button", { name });

afterEach(() => vi.unstubAllGlobals());

describe("access", () => {
  it("says so when the API reports no stage", async () => {
    api({ "GET /api/v1/file-capabilities": { body: { stages: [], max_upload_bytes: 0 } } });
    open();
    expect(await screen.findByText("Files are not available to you on any stage.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows the API's 403 detail", async () => {
    api({ "GET /api/v1/file-capabilities": { status: 403, body: { detail: "Your role cannot browse files." } } });
    open();
    expect(await screen.findByText("Your role cannot browse files.")).toBeInTheDocument();
  });

  it("offers only the stages file-capabilities reports", async () => {
    api({ ...base, "GET /api/v1/file-capabilities": { body: caps(ALL, ["dev", "uat"]) } });
    open();
    const select = await screen.findByRole("combobox", { name: /stage/i });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["DEV", "UAT"]);
  });

  it("hides the actions a stage does not allow", async () => {
    api({ ...base, "GET /api/v1/file-capabilities": { body: caps(["list_buckets", "list_objects", "download_object"]) } });
    open(browse);
    await screen.findByText("_manifest.json");
    expect(button("Download")).toBeInTheDocument();
    for (const n of ["Upload", "Create folder", "Rename", "Delete"]) expect(screen.queryByRole("button", { name: n })).toBeNull();
  });
});

describe("buckets", () => {
  it("lists name and created date, filters client-side and opens a bucket", async () => {
    api(base);
    open();
    expect(await screen.findByRole("link", { name: BUCKET })).toBeInTheDocument();
    expect(screen.getAllByText("2026-09-02")).toHaveLength(2);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Created", "Open"]);
    await userEvent.type(screen.getByPlaceholderText("Filter by name…"), "silver");
    expect(screen.queryByRole("link", { name: BUCKET })).toBeNull();
    await userEvent.click(screen.getByRole("link", { name: "openlakeforge-dev-silver" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/files?stage=dev&bucket=openlakeforge-dev-silver");
  });

  it("shows the API's error", async () => {
    api({ ...base, "GET /api/v1/stages/dev/buckets": { status: 403, body: { detail: "No file access on stage 'dev'." } } });
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("No file access on stage 'dev'.");
  });
});

describe("browsing", () => {
  it("lists folders first, with type, size and time, and keeps the place in the URL", async () => {
    const calls = api(base);
    open(browse);
    expect(await screen.findByText("2026-11-14/")).toBeInTheDocument();
    expect(calls.find((c) => c.url.pathname === objects)!.url.searchParams.get("prefix")).toBe("raw/orders/");
    const names = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[1].textContent);
    expect(names).toEqual(["2026-11-14/", "2026-11-15/", "_manifest.json", "orders_2026-11-16.parquet"]);
    expect(row("orders_2026-11-16.parquet")).toHaveTextContent("parquet48.2 MB2026-11-16 09:41");
    expect(screen.getByText("4 items")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "2026-11-14/" }));
    expect(screen.getByTestId("where")).toHaveTextContent(encodeURIComponent("raw/orders/2026-11-14/"));
  });

  it("has a clickable breadcrumb and copies the S3 path", async () => {
    api(base);
    open(browse);
    await screen.findByText("_manifest.json");
    const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(crumbs.getByRole("link", { name: "Buckets" })).toBeInTheDocument();
    expect(crumbs.getByText("orders")).toHaveAttribute("aria-current", "page");
    await userEvent.click(crumbs.getByRole("link", { name: "raw" }));
    expect(screen.getByTestId("where")).toHaveTextContent(`prefix=raw%2F`);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await userEvent.click(button("Copy path"));
    expect(writeText).toHaveBeenCalledWith(`s3://${BUCKET}/raw/`);
  });

  it("filters by prefix on the server", async () => {
    const calls = api(base);
    open(browse);
    await screen.findByText("_manifest.json");
    await userEvent.type(screen.getByRole("searchbox", { name: "Find objects by prefix" }), "orders_");
    await waitFor(() => expect(calls.some((c) => c.url.pathname === objects && c.url.searchParams.get("prefix") === "raw/orders/orders_")).toBe(true));
  });

  it("loads more from next_cursor", async () => {
    const calls = api({
      ...base,
      [`GET ${objects}`]: (url) => url.searchParams.get("cursor")
        ? { body: listing({ folders: [], files: [{ key: "raw/orders/z.txt", size: 1, last_modified: "2026-11-16T09:00:00Z" }], next_cursor: null }) }
        : { body: listing({ next_cursor: "c1" }) },
    });
    open(browse);
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("z.txt")).toBeInTheDocument();
    expect(calls.at(-1)!.url.searchParams.get("cursor")).toBe("c1");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("shows the empty folder state with both actions", async () => {
    api({ ...base, [`GET ${objects}`]: { body: listing({ folders: [], files: [] }) } });
    open(browse);
    expect(await screen.findByText("Empty folder")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Create folder" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Upload" })).toHaveLength(2);
  });

  it("shows the listing error", async () => {
    api({ ...base, [`GET ${objects}`]: { status: 403, body: { detail: "No access to the audit prefix." } } });
    open(browse);
    expect(await screen.findByRole("alert")).toHaveTextContent("No access to the audit prefix.");
  });
});

describe("selection and toolbar", () => {
  it("enables Rename for one item, Download for files only, Delete for any", async () => {
    api(base);
    open(browse);
    await screen.findByText("_manifest.json");
    expect([button("Download"), button("Rename"), button("Delete")].map((b) => (b as HTMLButtonElement).disabled)).toEqual([true, true, true]);
    await pick("_manifest.json");
    expect([button("Download"), button("Rename"), button("Delete")].map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, false, false]);
    await pick("2026-11-14/");
    expect([button("Download"), button("Rename"), button("Delete")].map((b) => (b as HTMLButtonElement).disabled)).toEqual([true, true, false]);
    expect(screen.getByText("· 2 selected", { exact: false })).toBeInTheDocument();
  });

  it("selects all, with a partial state in the header", async () => {
    api(base);
    open(browse);
    await screen.findByText("_manifest.json");
    const all = screen.getByRole("checkbox", { name: "Select all" }) as HTMLInputElement;
    await pick("_manifest.json");
    expect(all.indeterminate).toBe(true);
    await userEvent.click(all);
    expect(all.indeterminate).toBe(false);
    expect(screen.getAllByRole("checkbox", { checked: true })).toHaveLength(5);
    await userEvent.click(all);
    expect(screen.queryAllByRole("checkbox", { checked: true })).toHaveLength(0);
  });

  it("runs the row menu", async () => {
    api(base);
    open(browse);
    await screen.findByText("_manifest.json");
    await userEvent.click(screen.getByRole("button", { name: "Actions for _manifest.json" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Download", "Rename", "Copy S3 URI", "Delete"]);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Actions for 2026-11-14/" }));
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Download" })).toBeNull();
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: "Delete 1 item?" })).toBeInTheDocument();
  });

  it("supports the keyboard: arrows, Space, F2, Delete, Esc", async () => {
    api(base);
    open(browse);
    await screen.findByText("_manifest.json");
    const table = screen.getByRole("region", { name: "Object list" });
    table.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown} ");
    expect(screen.getByRole("checkbox", { name: "Select _manifest.json" })).toBeChecked();
    await userEvent.keyboard("{F2}");
    const rename = screen.getByRole("dialog", { name: "Rename" });
    expect(within(rename).getByRole("textbox")).toHaveValue("_manifest.json");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    table.focus();
    await userEvent.keyboard("{Delete}");
    expect(screen.getByRole("dialog", { name: "Delete 1 item?" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a folder with Enter", async () => {
    api(base);
    open(browse);
    await screen.findByText("_manifest.json");
    screen.getByRole("region", { name: "Object list" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("where")).toHaveTextContent(encodeURIComponent("raw/orders/2026-11-14/"));
  });
});

describe("dialogs", () => {
  it("traps focus in a dialog and closes on Esc", async () => {
    api(base);
    open(browse);
    await screen.findByText("_manifest.json");
    await userEvent.click(button("Create folder"));
    const dialog = screen.getByRole("dialog", { name: "New folder" });
    expect(within(dialog).getByRole("textbox")).toHaveFocus();
    for (let i = 0; i < 6; i++) {
      await userEvent.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("creates a folder under the current prefix, and refuses a slash without calling the API", async () => {
    const calls = api({ ...base, [`POST /api/v1/stages/dev/buckets/${BUCKET}/folders`]: { status: 201, body: { prefix: "raw/orders/2026-11-17/" } } });
    open(browse);
    await screen.findByText("_manifest.json");
    await userEvent.click(button("Create folder"));
    await userEvent.type(screen.getByRole("textbox", { name: "Folder name" }), "a/b{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("A name cannot contain /.");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    const input = screen.getByRole("textbox", { name: "Folder name" });
    await userEvent.clear(input);
    await userEvent.type(input, "2026-11-17{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const post = calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(post.init.body as string)).toEqual({ prefix: "raw/orders/2026-11-17/" });
    expect(calls.filter((c) => c.url.pathname === objects)).toHaveLength(2); // refreshed
  });

  it("shows a 409 from create folder", async () => {
    api({ ...base, [`POST /api/v1/stages/dev/buckets/${BUCKET}/folders`]: { status: 409, body: { detail: "folder 'raw/orders/x/' already exists" } } });
    open(browse);
    await screen.findByText("_manifest.json");
    await userEvent.click(button("Create folder"));
    await userEvent.type(screen.getByRole("textbox", { name: "Folder name" }), "x{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("renames a file, selecting the name but not the extension", async () => {
    const calls = api({ ...base, [`POST ${objects}/rename`]: { body: { moved: 1 } } });
    open(browse);
    await screen.findByText("_manifest.json");
    await pick("orders_2026-11-16.parquet");
    await userEvent.click(button("Rename"));
    const input = screen.getByRole("textbox", { name: "New name" }) as HTMLInputElement;
    expect(input.value).toBe("orders_2026-11-16.parquet");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "orders_2026-11-16".length]);
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Rename" })).toBeDisabled(); // unchanged
    await userEvent.type(input, "{End}x{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.init.body as string)).toEqual({
      from: "raw/orders/orders_2026-11-16.parquet", to: "raw/orders/orders_2026-11-16.parquetx",
    });
  });

  it("renames a folder with a trailing slash on both ends", async () => {
    const calls = api({ ...base, [`POST ${objects}/rename`]: { body: { moved: 3 } } });
    open(browse);
    await screen.findByText("_manifest.json");
    await pick("2026-11-14/");
    await userEvent.click(button("Rename"));
    const input = screen.getByRole("textbox", { name: "New name" });
    expect(input).toHaveValue("2026-11-14");
    await userEvent.clear(input);
    await userEvent.type(input, "archive{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.init.body as string)).toEqual({ from: "raw/orders/2026-11-14/", to: "raw/orders/archive/" });
  });

  it("lists what is deleted, warns, and deletes the selection", async () => {
    const calls = api({ ...base, [`POST ${objects}/delete`]: { body: { deleted: ["a"], errors: [] } } });
    open(browse);
    await screen.findByText("_manifest.json");
    await pick("2026-11-14/");
    await pick("_manifest.json");
    await userEvent.click(button("Delete"));
    const dialog = screen.getByRole("dialog", { name: "Delete 2 items?" });
    expect(within(dialog).getByText("2026-11-14/")).toBeInTheDocument();
    expect(within(dialog).getByText("2.1 KB")).toBeInTheDocument();
    expect(within(dialog).getByText("This can’t be undone.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.init.body as string)).toEqual({ keys: ["raw/orders/2026-11-14/", "raw/orders/_manifest.json"] });
  });

  it("keeps the dialog open and shows per-key failures", async () => {
    api({ ...base, [`POST ${objects}/delete`]: { body: { deleted: [], errors: [{ key: "raw/orders/_manifest.json", detail: "access denied" }] } } });
    open(browse);
    await screen.findByText("_manifest.json");
    await pick("_manifest.json");
    await userEvent.click(button("Delete"));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("_manifest.json: access denied");
  });
});

describe("upload", () => {
  class FakeXhr {
    static all: FakeXhr[] = [];
    upload: { onprogress?: (e: unknown) => void } = {};
    onload?: () => void; onerror?: () => void; onabort?: () => void;
    status = 0; responseText = ""; url = "";
    constructor() { FakeXhr.all.push(this); }
    open(_m: string, u: string) { this.url = u; }
    setRequestHeader() {}
    send() {}
    abort() { this.onabort?.(); }
    reply(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.(); }
  }
  const file = (name: string, size: number) => new File([new Uint8Array(size)], name);

  it("uploads several files with progress, then refreshes the listing", async () => {
    FakeXhr.all = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const calls = api(base);
    open(browse);
    await screen.findByText("_manifest.json");
    await userEvent.click(button("Upload"));
    const dialog = screen.getByRole("dialog", { name: "Upload" });
    await userEvent.upload(within(dialog).getByLabelText("Choose files"), [file("a.csv", 10), file("b.csv", 20)]);
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1)); // one at a time; the second waits
    expect(within(dialog).getByText("Queued")).toBeInTheDocument();
    expect(decodeURIComponent(FakeXhr.all[0].url)).toContain("key=raw/orders/a.csv");
    FakeXhr.all[0].upload.onprogress!({ lengthComputable: true, loaded: 5, total: 10 });
    expect(await within(dialog).findByText("50%")).toBeInTheDocument();
    FakeXhr.all[0].reply(201, { key: "raw/orders/a.csv", size: 10 });
    await waitFor(() => expect(FakeXhr.all).toHaveLength(2));
    FakeXhr.all[1].reply(409, { detail: "object 'raw/orders/b.csv' already exists" });
    expect(await within(dialog).findByText("object 'raw/orders/b.csv' already exists")).toBeInTheDocument();
    expect(within(dialog).getByText("Done")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.pathname === objects).length).toBeGreaterThan(1);
  });

  it("refuses a file over max_upload_bytes without sending it", async () => {
    FakeXhr.all = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    api(base);
    open(browse);
    await screen.findByText("_manifest.json");
    await userEvent.click(button("Upload"));
    await userEvent.upload(screen.getByLabelText("Choose files"), file("big.bin", 2000));
    expect(await screen.findByText("Too large: the limit is 1000 B.")).toBeInTheDocument();
    expect(FakeXhr.all).toHaveLength(0);
  });

  it("opens the dialog when files are dropped on the list", async () => {
    FakeXhr.all = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    api(base);
    open(browse);
    await screen.findByText("_manifest.json");
    const card = screen.getByRole("region", { name: "Object list" }).closest("section")!;
    fireEvent.drop(card, { dataTransfer: { files: [file("dropped.txt", 5)], types: ["Files"] } });
    const dialog = await screen.findByRole("dialog", { name: "Upload" });
    expect(within(dialog).getByText("dropped.txt")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /Uploading 1/ })).toBeInTheDocument(); // the background indicator
  });
});

describe("navigation item", () => {
  const shell = () => render(<MemoryRouter><AppShell>x</AppShell></MemoryRouter>);
  const nav = () => within(screen.getByRole("navigation", { name: "Primary" }));

  it("appears under Queries when a stage is offered", async () => {
    api(base);
    shell();
    expect(await nav().findByRole("link", { name: "Files" })).toHaveAttribute("href", "/files");
    expect(nav().getAllByRole("link").map((l) => l.textContent)).toEqual(["Services", "Queries", "Files"]);
  });

  it.each([
    ["no stages", { body: { stages: [], max_upload_bytes: 0 } }],
    ["a denied request", { status: 403, body: { detail: "no" } }],
  ])("is absent with %s", async (_n, reply) => {
    const calls = api({ "GET /api/v1/file-capabilities": reply });
    shell();
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(nav().queryByRole("link", { name: "Files" })).toBeNull();
  });
});

describe("review fixes", () => {
  it("closes a pending dialog when browser Back changes the bucket", async () => {
    const other = "openlakeforge-dev-silver";
    const calls = api({ ...base, [`GET /api/v1/stages/dev/buckets/${other}/objects`]: { body: listing({ prefix: "", folders: [], files: [{ key: "_manifest.json", size: 5, last_modified: "2026-11-16T09:42:00Z" }] }) } });
    function Back() {
      const nav = useNavigate();
      return <button type="button" onClick={() => nav(-1)}>go back</button>;
    }
    render(
      <MemoryRouter initialEntries={[`/files?stage=dev&bucket=${BUCKET}`, `/files?stage=dev&bucket=${other}`]} initialIndex={1}>
        <Files /><Back />
      </MemoryRouter>,
    );
    await screen.findByText("_manifest.json");
    await pick("_manifest.json");
    await userEvent.click(button("Delete"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(button("go back"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("sends one request for a cursor however often Load more is clicked", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls = api({
      ...base,
      [`GET ${objects}`]: async (url) => {
        if (!url.searchParams.get("cursor")) return { body: listing({ next_cursor: "c1" }) };
        await gate;
        return { body: listing({ folders: [], files: [{ key: "raw/orders/z.txt", size: 1, last_modified: "2026-11-16T09:00:00Z" }], next_cursor: null }) };
      },
    });
    open(browse);
    const more = await screen.findByRole("button", { name: "Load more" });
    fireEvent.click(more);
    fireEvent.click(more);
    expect(more).toBeDisabled();
    release();
    expect(await screen.findByText("z.txt")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.searchParams.get("cursor") === "c1")).toHaveLength(1);
    expect(screen.getAllByText("z.txt")).toHaveLength(1);
  });

  it("opens the row menu above the trigger when there is no room below", async () => {
    api(base);
    open(browse);
    await screen.findByText("_manifest.json");
    vi.stubGlobal("innerHeight", 300);
    const trigger = screen.getByRole("button", { name: "Actions for _manifest.json" });
    trigger.getBoundingClientRect = () => ({ top: 260, bottom: 290, left: 0, right: 400, width: 30, height: 30, x: 0, y: 260, toJSON() {} });
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(150);
    await userEvent.click(trigger);
    expect(screen.getByRole("menu").style.top).toBe("106px"); // 260 - 150 - 4, not 294 (below)
    height.mockRestore();
  });
});

describe("stale rows", () => {
  it("never shows the previous folder's rows under the new folder's names", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    api({
      ...base,
      [`GET ${objects}`]: async (url) => {
        if (url.searchParams.get("prefix") === "raw/") { await gate; return { body: listing({ prefix: "raw/", folders: [{ prefix: "raw/orders/" }], files: [] }) }; }
        return { body: listing() };
      },
    });
    open(browse);
    await screen.findByText("_manifest.json");
    await userEvent.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "raw" }));
    expect(screen.queryByText("_manifest.json")).toBeNull();
    expect(screen.queryByText("orders/2026-11-14/")).toBeNull();
    release();
    expect(await screen.findByText("orders/")).toBeInTheDocument();
  });
});
