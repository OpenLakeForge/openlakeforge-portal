// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryWorkspace } from "./Queries";

type Reply = { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;
type Handler = (url: URL, init: RequestInit) => Reply;

const caps = {
  query_available: true,
  stages: [
    { stage: "dev", query: { engine: "trino", available: true, export_formats: ["csv", "json"] } },
    { stage: "uat", query: { engine: "trino", available: true, export_formats: ["csv"] } },
    { stage: "prod", query: { engine: "trino", available: false, export_formats: [] } },
  ],
};
const done = (over = {}) => ({
  id: "q1", status: "succeeded", columns: [{ name: "channel", type: "varchar" }, { name: "note", type: "varchar" }],
  rows: [["direct", null], ["<img src=x onerror=alert(1)>", "ok"]], truncated: false, row_count: 2, elapsed_ms: 800, ...over,
});

/** Stub fetch per test: handlers by "METHOD /path"; every call is recorded. */
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
  "GET /api/v1/query-capabilities": { body: caps },
  "GET /api/v1/stages/dev/schemas": { body: { schemas: ["bronze", "silver"], next_cursor: null } },
  "GET /api/v1/stages/dev/schemas/bronze/tables": { body: { tables: [{ name: "orders", type: "table" }], next_cursor: null } },
};

const ready = async () => { render(<QueryWorkspace />); await screen.findByRole("combobox", { name: /stage/i }); };
const editorView = async () => {
  const dom = await waitFor(() => { const e = document.querySelector<HTMLElement>(".cm-editor"); if (!e) throw new Error("no editor"); return e; });
  return EditorView.findFromDOM(dom)!;
};
async function type(sql: string) {
  const view = await editorView();
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sql } });
  await waitFor(() => expect(screen.getByRole("button", { name: /run/i })).toBeEnabled()); // React saw the change
}
const run = () => userEvent.click(screen.getByRole("button", { name: /run/i }));

beforeEach(() => {
  // jsdom has no layout, which CodeMirror's measuring expects.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => vi.unstubAllGlobals());

describe("capabilities", () => {
  it.each([[{ status: 404 }], [{ body: { query_available: false, stages: [] } }]])("shows the unavailable state, with no editor", async (reply) => {
    api({ "GET /api/v1/query-capabilities": reply });
    render(<QueryWorkspace />);
    expect(await screen.findByText(/does not provide the query workspace/)).toBeInTheDocument();
    expect(document.querySelector(".cm-editor")).toBeNull();
    expect(screen.queryByRole("button", { name: /run/i })).toBeNull();
  });

  it("treats a network failure as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    render(<QueryWorkspace />);
    expect(await screen.findByText("The Platform API cannot be reached.")).toBeInTheDocument();
  });

  it("says when the session expired", async () => {
    api({ "GET /api/v1/query-capabilities": { status: 401 } });
    render(<QueryWorkspace />);
    expect(await screen.findByText(/session has expired/)).toBeInTheDocument();
  });

  it("offers only the stages reported available", async () => {
    api(base);
    await ready();
    const options = within(screen.getByRole("combobox", { name: /stage/i })).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["DEV", "UAT"]);
  });
});

describe("explorer", () => {
  it("lists schemas, then the tables of an expanded schema", async () => {
    api(base);
    await ready();
    await userEvent.click(await screen.findByRole("button", { name: /bronze/ }));
    expect(await screen.findByText("orders")).toBeInTheDocument();
  });

  it("searches schemas through the API", async () => {
    const calls = api({
      ...base,
      "GET /api/v1/stages/dev/schemas": (url) => ({ body: { schemas: url.searchParams.get("q") ? ["silver"] : ["bronze", "silver"], next_cursor: null } }),
    });
    await ready();
    await screen.findByRole("button", { name: /bronze/ });
    await userEvent.type(screen.getByRole("searchbox"), "sil");
    await waitFor(() => expect(screen.queryByRole("button", { name: /bronze/ })).toBeNull());
    expect(calls.some((c) => c.url.searchParams.get("q") === "sil")).toBe(true);
  });

  it("shows denied apart from empty", async () => {
    api({ ...base, "GET /api/v1/stages/dev/schemas": { status: 403, body: { detail: "no grant" } } });
    await ready();
    expect(await screen.findByText(/do not have access to these schemas/)).toBeInTheDocument();
  });

  it("shows unavailable, and an empty list as not visible rather than absent", async () => {
    api({ ...base, "GET /api/v1/stages/dev/schemas": { status: 502 } });
    await ready();
    expect(await screen.findByText(/schemas cannot be listed right now/)).toBeInTheDocument();
    vi.unstubAllGlobals();
    api({ ...base, "GET /api/v1/stages/dev/schemas": { body: { schemas: [], next_cursor: null } } });
    document.body.innerHTML = "";
    await ready();
    expect(await screen.findByText("No schemas visible to you.")).toBeInTheDocument();
  });

  it("filters the explorer by schema without ever sending it with the query", async () => {
    const calls = api({ ...base, "POST /api/v1/stages/dev/queries": { body: done() } });
    await ready();
    await screen.findByRole("button", { name: /bronze/ });
    await screen.findByRole("option", { name: "bronze" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /schema/i }), "bronze");
    expect(screen.queryByRole("button", { name: /silver/ })).toBeNull();
    await type("select 1");
    await run();
    await screen.findByText("COMPLETED", { exact: false });
    const post = calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(post.init.body as string)).toEqual({ sql: "select 1" });
    expect(post.url.search).toBe("");
  });
});

describe("running", () => {
  it("renders results as text, with NULL distinct from a value", async () => {
    const calls = api({ ...base, "POST /api/v1/stages/dev/queries": { body: done() } });
    await ready();
    await type("select channel from t");
    await run();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("NULL")).toBeInTheDocument();
    expect(within(table).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(table.querySelector("img")).toBeNull();
    expect(within(table).getByRole("columnheader", { name: /channel/ })).toHaveTextContent("channel / varchar");
    expect(screen.getByText(/2 ROWS/)).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.init.headers).toEqual({ "Content-Type": "application/json" });
    expect(post.init.credentials).toBe("same-origin");
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute("href", "/api/v1/stages/dev/queries/q1/export?format=csv");
  });

  it("points Download at the chosen format and flags truncation", async () => {
    api({ ...base, "POST /api/v1/stages/dev/queries": { body: done({ truncated: true }) } });
    await ready();
    await type("select 1");
    await run();
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: /export format/i }), "json");
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute("href", expect.stringContaining("format=json"));
    expect(screen.getByText(/Truncated/)).toBeInTheDocument();
  });

  it("pages with the cursor", async () => {
    const calls = api({
      ...base,
      "POST /api/v1/stages/dev/queries": { body: done({ rows: [["a", "x"]], next_cursor: "c2" }) },
      "GET /api/v1/stages/dev/queries/q1": { body: done({ rows: [["b", "y"]], next_cursor: null }) },
    });
    await ready();
    await type("select 1");
    await run();
    await userEvent.click(await screen.findByRole("button", { name: /load more rows/i }));
    await screen.findByText("b");
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(calls.at(-1)!.url.searchParams.get("cursor")).toBe("c2");
  });

  it("refuses a duplicate submit, including from the keyboard", async () => {
    let release!: (r: { body: unknown }) => void;
    const calls = api({ ...base, "POST /api/v1/stages/dev/queries": new Promise((r) => { release = r; }) });
    await ready();
    await type("select 1");
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    fireEvent.keyDown(content, { key: "Enter", code: "Enter", keyCode: 13, ctrlKey: true });
    fireEvent.keyDown(content, { key: "Enter", code: "Enter", keyCode: 13, ctrlKey: true });
    expect(await screen.findByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    release({ body: done() });
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: /run/i })).toBeEnabled();
  });

  it("cancels a running query", async () => {
    const calls = api({
      ...base,
      "POST /api/v1/stages/dev/queries": { body: { id: "q9", status: "running", columns: [], rows: [], truncated: false, row_count: 0, elapsed_ms: 0 } },
      "DELETE /api/v1/stages/dev/queries/q9": { body: {} },
    });
    await ready();
    await type("select 1");
    await run();
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    expect(await screen.findByText(/CANCELLED/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE" && c.url.pathname.endsWith("/q9"))).toBe(true);
    expect(screen.getByRole("button", { name: /run/i })).toBeEnabled();
  });

  it.each([
    [401, {}, /session has expired/],
    [403, { detail: "denied by polaris" }, /Access denied\. denied by polaris/],
    [400, { detail: "line 1: syntax error" }, /rejected\. line 1: syntax error/],
    [504, {}, /timed out/],
  ])("maps a %i to a clear message", async (status, body, message) => {
    api({ ...base, "POST /api/v1/stages/dev/queries": { status, body } });
    await ready();
    await type("select 1");
    await run();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByText(/FAILED/)).toBeInTheDocument();
  });

  it("drops the result on a stage switch and does not re-run", async () => {
    const calls = api({
      ...base,
      "GET /api/v1/stages/uat/schemas": { body: { schemas: ["gold"], next_cursor: null } },
      "POST /api/v1/stages/dev/queries": { body: done() },
    });
    await ready();
    await type("select 1");
    await run();
    await screen.findByRole("table");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /stage/i }), "uat");
    expect(screen.queryByRole("table")).toBeNull();
    expect(await screen.findByRole("button", { name: /gold/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /bronze/ })).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

describe("editor actions", () => {
  it("copies the SQL and confirms it", async () => {
    api(base);
    const user = userEvent.setup();
    await ready();
    await type("select 1");
    await user.click(screen.getByRole("button", { name: "Copy SQL" }));
    expect(await screen.findByText("SQL copied")).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe("select 1");
  });

  it("formats only on an explicit click", async () => {
    api(base);
    await ready();
    await type("select a,b from t where x=1");
    expect((await editorView()).state.doc.toString()).toBe("select a,b from t where x=1");
    await userEvent.click(screen.getByRole("button", { name: "Format" }));
    await waitFor(async () => expect((await editorView()).state.doc.toString()).toContain("\n"));
  });
});
