// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Services } from "../components/Services";
import { AppShell } from "../components/Shell";
import { loader as homeLoader } from "./home";
import Queries from "./queries";
import { loader as servicesLoader } from "./services";
import { loader as shellLoader } from "./shell";

const file = join(mkdtempSync(join(tmpdir(), "olf-portal-")), "routes.json");
const write = (routes: unknown) => writeFileSync(file, typeof routes === "string" ? routes : JSON.stringify(routes));
const trino = { stage: "shared", name: "query", url: "https://trino.olf.localhost" };
const signOut = { stage: "shared", name: "sign-out", url: "http://oauth2.olf.localhost/oauth2/sign_out" };
const dagster = (stage: string) => ({ stage, name: "orchestration", url: `http://d-${stage}.olf.localhost` });

/** Call a loader the way React Router does and unwrap its data() result. */
const unwrap = <T,>(result: unknown) => {
  const { data, init } = result as { data: T; init: ResponseInit };
  return { data, headers: new Headers(init.headers) };
};
const services = () => unwrap<Awaited<ReturnType<typeof servicesLoader>>["data"]>(servicesLoader());
const shell = () => unwrap<{ signOut?: string }>(shellLoader());

afterEach(() => vi.unstubAllEnvs());

/** The shell around a page at a path, as the router mounts it. */
const renderAt = (path: string, page: React.ReactNode, signOutUrl?: string) => {
  const Stub = createRoutesStub([{
    Component: () => <AppShell signOut={signOutUrl}>{page}</AppShell>,
    children: [{ path: "/services" }, { path: "/queries" }],
  }]);
  return render(<Stub initialEntries={[path]} />);
};

describe("entry points", () => {
  it("redirects / to /services", () => {
    const response = homeLoader() as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/services");
  });

  it("never caches the pages that show the routes", () => {
    vi.stubEnv("OLF_ROUTES_FILE", file);
    write({ "shared/query": trino });
    expect(services().headers.get("Cache-Control")).toBe("no-store");
    expect(shell().headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("loaders", () => {
  it("expose only what the pages render, and re-read the file each time", () => {
    vi.stubEnv("OLF_ROUTES_FILE", file);
    write({ "shared/query": trino, "shared/sign-out": signOut });
    expect(Object.keys(services().data).sort()).toEqual(["problem", "stages"]);
    expect(JSON.stringify(services().data)).not.toContain(file);
    expect(shell().data.signOut).toBe(signOut.url);
    write({ "shared/query": trino, "stage/dev/orchestration": dagster("dev") });
    expect(services().data.stages.map((s) => s.stage)).toEqual(["shared", "dev"]);
    expect(shell().data.signOut).toBeUndefined();
  });

  it("report an unreadable file instead of throwing", () => {
    vi.stubEnv("OLF_ROUTES_FILE", file);
    write("{not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { data } = services();
    expect(data.stages).toEqual([]);
    expect(data.problem).toMatch(/Cannot read the routes file/);
  });
});

describe("services page", () => {
  const stagesOf = (routes: Record<string, unknown>) => {
    vi.stubEnv("OLF_ROUTES_FILE", file);
    write(routes);
    return services().data.stages;
  };

  it("groups Shared, then DEV, UAT, PROD, only the stages present", () => {
    const stages = stagesOf({ "shared/query": trino, "p": dagster("prod"), "d": dagster("dev"), "u": dagster("uat") });
    render(<Services stages={stages} />);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Shared", "DEV", "UAT", "PROD"]);
    const only = stagesOf({ "shared/query": trino, "p": dagster("prod") });
    expect(only.map((s) => s.heading)).toEqual(["Shared", "PROD"]);
  });

  it("lists each service as a link that opens in a new tab, with no hero or counters", () => {
    render(<Services stages={stagesOf({ "shared/query": trino })} />);
    const link = within(screen.getByRole("region", { name: "Shared" })).getByRole("link");
    expect(link).toHaveAttribute("href", trino.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAccessibleName(/Query/);
    expect(screen.queryByText(/routes|services$/i)).toBeNull();
  });

  it("draws the depth contours as a hidden, decorative svg", () => {
    const { container } = render(<Services stages={[]} />);
    const contours = container.querySelector("svg.contours");
    expect(contours).toHaveAttribute("aria-hidden", "true");
    expect(contours?.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("says why there are no services, for a malformed or a missing file", () => {
    render(<Services stages={[]} problem="Cannot read the routes file /x." />);
    expect(screen.getByText("Cannot read the routes file /x.")).toBeInTheDocument();
    render(<Services stages={[]} />);
    expect(screen.getByText(/exposes no user-facing services/)).toBeInTheDocument();
  });
});

describe("app shell", () => {
  it("offers exactly Services and Queries, with the current one marked", async () => {
    renderAt("/queries", <Queries />);
    const nav = await screen.findByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([["Services", "/services"], ["Queries", "/queries"]]);
    expect(within(nav).getByRole("link", { name: "Queries" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Services" })).not.toHaveAttribute("aria-current");
  });

  it("marks Services on /services", async () => {
    renderAt("/services", <Services stages={[]} />);
    expect(await screen.findByRole("link", { name: "Services" })).toHaveAttribute("aria-current", "page");
  });

  it("renders the sign-out link only when the server knows one", async () => {
    renderAt("/services", null, signOut.url);
    expect(await screen.findByRole("link", { name: "Sign out" })).toHaveAttribute("href", signOut.url);
  });

  it("has no sign-out link without one", async () => {
    renderAt("/services", null);
    await screen.findByRole("navigation", { name: "Primary" });
    expect(screen.queryByRole("link", { name: "Sign out" })).toBeNull();
  });
});

describe("queries page", () => {
  it("renders inside the shell without needing the API at render time", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<Queries />);
    expect(screen.getByRole("heading", { name: "Query your lakehouse, at any depth." })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
