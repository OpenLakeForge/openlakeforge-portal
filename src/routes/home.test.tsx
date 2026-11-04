// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Index } from "../components/Index";
import { loader } from "./home";

const file = join(mkdtempSync(join(tmpdir(), "olf-portal-")), "routes.json");
const write = (routes: unknown) => writeFileSync(file, typeof routes === "string" ? routes : JSON.stringify(routes));
const trino = { stage: "shared", name: "query", url: "https://trino.olf.localhost" };
const signOut = { stage: "shared", name: "sign-out", url: "http://oauth2.olf.localhost/oauth2/sign_out" };

/** Call the loader the way React Router does and unwrap its data() result. */
const load = () => {
  const result = loader() as unknown as { data: ReturnType<typeof loader> extends { data: infer D } ? D : never; init: ResponseInit };
  return { ...result, headers: new Headers(result.init.headers) };
};

afterEach(() => vi.unstubAllEnvs());

describe("home loader", () => {
  it("is never cached and returns only what the page renders", () => {
    vi.stubEnv("OLF_ROUTES_FILE", file);
    write({ "shared/query": trino, "shared/sign-out": signOut });
    const { data, headers } = load();
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(Object.keys(data).sort()).toEqual(["problem", "routeCount", "signOut", "stages"]);
    expect(JSON.stringify(data)).not.toContain(file);
    expect(data.signOut).toBe(signOut.url);
  });

  it("reflects a changed routes file on the next call", () => {
    vi.stubEnv("OLF_ROUTES_FILE", file);
    write({ "shared/query": trino });
    expect(load().data.routeCount).toBe(1);
    write({ "shared/query": trino, "stage/dev/orchestration": { stage: "dev", name: "orchestration", url: "http://d.olf.localhost" } });
    expect(load().data.routeCount).toBe(2);
  });

  it("reports an unreadable file instead of throwing", () => {
    vi.stubEnv("OLF_ROUTES_FILE", file);
    write("{not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { data } = load();
    expect(data.stages).toEqual([]);
    expect(data.problem).toMatch(/Cannot read the routes file/);
  });
});

describe("service index", () => {
  it("lists each service as a link that opens in a new tab", () => {
    vi.stubEnv("OLF_ROUTES_FILE", file);
    write({ "shared/query": trino });
    const { data } = load();
    render(<Index routeCount={data.routeCount} stages={data.stages} problem={data.problem} />);
    const link = within(screen.getByRole("region", { name: "Shared" })).getByRole("link");
    expect(link).toHaveAttribute("href", trino.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAccessibleName(/Query/);
  });

  it("says why there are no services", () => {
    render(<Index routeCount={0} stages={[]} problem="Cannot read the routes file /x." />);
    expect(screen.getByText("Cannot read the routes file /x.")).toBeInTheDocument();
  });
});
