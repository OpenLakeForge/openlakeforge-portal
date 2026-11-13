import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRoutes, parseRoutes, sections, signOutUrl } from "./routes.server";

const routes = {
  "stage/prod/orchestration": { stage: "prod", name: "orchestration", url: "http://dagster-prod.olf.localhost" },
  "stage/dev/orchestration": { stage: "dev", name: "orchestration", url: "http://dagster-dev.olf.localhost" },
  "stage/dev/query": { stage: "dev", name: "query", url: "https://trino-dev.olf.localhost" },
  "shared/new_thing": { stage: "shared", name: "new_thing", url: "http://new.olf.localhost" },
};

const writeRoutes = (content: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "olf-portal-")), "routes.json");
  writeFileSync(file, content);
  return file;
};

describe("sections", () => {
  it("puts shared services first, then DEV, UAT, PROD, then unknown stages by name", () => {
    const uat = { stage: "uat", name: "orchestration", url: "http://dagster-uat.olf.localhost" };
    const qa = { stage: "qa", name: "orchestration", url: "http://dagster-qa.olf.localhost" };
    const result = sections(parseRoutes({ ...routes, "stage/qa/orchestration": qa, "stage/uat/orchestration": uat }));
    expect(result.map((s) => [s.stage, s.heading])).toEqual([["shared", "Shared"], ["dev", "DEV"], ["uat", "UAT"], ["prod", "PROD"], ["qa", "QA"]]);
  });

  it("presents known services by capability and falls back to a monogram", () => {
    const [shared, dev] = sections(parseRoutes(routes)).map((s) => s.services);
    const query = dev.find((s) => s.name === "query");
    const unknown = shared.find((s) => s.name === "new_thing");
    expect(query).toMatchObject({ title: "Query", host: "trino-dev.olf.localhost", logo: "/logos/trino.svg" });
    expect(unknown).toMatchObject({ title: "New Thing", monogram: "Ne", summary: "", logo: undefined });
  });
});

describe("signOutUrl", () => {
  const signOut = "http://oauth2.olf.localhost/oauth2/sign_out";
  const withSignOut = { ...routes, "shared/sign-out": { stage: "shared", name: "sign-out", url: signOut } };

  it("returns the sign-out url and keeps it out of the service cards", () => {
    const parsed = parseRoutes(withSignOut);
    expect(signOutUrl(parsed)).toBe(signOut);
    expect(sections(parsed)[0].services.map((s) => s.name)).not.toContain("sign-out");
  });

  it("is undefined when authentication is off", () => {
    expect(signOutUrl(parseRoutes(routes))).toBeUndefined();
  });
});

describe("parseRoutes", () => {
  it("rejects a document that is not an object", () => {
    expect(() => parseRoutes([])).toThrow(/JSON object/);
  });

  it("rejects a route without an http(s) url, naming its ref", () => {
    expect(() => parseRoutes({ "shared/x": { stage: "shared", name: "x", url: "javascript:alert(1)" } })).toThrow(/shared\/x/);
  });
});

describe("loadRoutes", () => {
  it("reads the routes file", () => {
    const result = loadRoutes(writeRoutes(JSON.stringify(routes)), false);
    expect(result.problem).toBeUndefined();
    expect(Object.keys(result.routes)).toHaveLength(4);
  });

  it("uses the bundled example only in development", () => {
    expect(Object.keys(loadRoutes(undefined, true).routes).length).toBeGreaterThan(0);
    expect(loadRoutes(undefined, false)).toEqual({ routes: {}, problem: "OLF_ROUTES_FILE is not set." });
  });

  it("renders nothing, with a reason, when the file is missing or invalid", () => {
    expect(loadRoutes("/nonexistent/routes.json", false).problem).toMatch(/Cannot read/);
    expect(loadRoutes(writeRoutes("{not json"), false).routes).toEqual({});
  });
});
