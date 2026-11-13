# OpenLakeForge Portal

**The front door of an [OpenLakeForge](https://github.com/OpenLakeForge/openlakeforge) lakehouse: every service on the cluster, grouped by stage, one click away.**

The portal is what you see at the base domain of a deployed OpenLakeForge
stack (`http://olf.localhost` on the local kind profile). Today it lists the
user-facing routes (orchestration, reporting, query, governance) and, with
the GitHub issuer, an Admin link to the organisation's teams, each under the
shared services or the stage (`dev`, `prod`, …) it belongs to. It also serves
`/signed-out.html`, the page OpenLakeForge's Logout lands on.
It is a [React Router](https://reactrouter.com) (framework mode) app in
TypeScript, rendered on the server by Node, and styled with the OpenLakeForge **Deep Water** design system.

> **Status: early.** This repository starts as the route index. It is meant
> to grow into a full platform UI (runs, assets, catalog and SQL in one place,
> in the spirit of Databricks or dbt Cloud) while staying a client of
> OpenLakeForge's provider contracts.

## Quick start

Requires Node.js 22.22 or later.

```bash
npm install
npm run dev       # http://localhost:5173, using src/data/routes.example.json
npm test          # unit tests (vitest, React Testing Library)
npm run mock      # dev server with a fake Platform API (see below)
npm run typecheck # route types and tsc
npm run build     # server and client build in build/
OLF_ROUTES_FILE=src/data/routes.example.json PORT=8080 npm start   # serve build/ on :8080
```

## Run the UI against a mock backend

To review the whole portal, including the SQL workspace, without deploying
OpenLakeForge on Kubernetes:

```bash
npm run mock      # http://localhost:5173 with a fake /api/v1 and src/data/routes.example.json
```

[`mock/api.ts`](mock/api.ts) imitates the Platform API's query and discovery
endpoints with small in-memory fixtures (stages `dev` and `prod`; schemas
`bronze`, `silver`, `gold_sales`, `information_schema`, plus `scratch` in dev).
It is mounted by the Vite dev server only when `OLF_MOCK_API=1`, which
`npm run mock` sets; it lives outside `src/`, so `npm run build` and the image
never contain it. These words in the SQL pick a behaviour:

| SQL | What it shows |
| --- | --- |
| `SELECT * FROM silver.orders` | A normal result, with a NULL and an HTML-looking string (rendered as text). |
| `SELECT * FROM orders` | With a schema chosen, the table resolves there. With "All schemas" it is a 400: "Schema must be specified when session schema is not set". |
| `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`, `MERGE` first | A 403 "only read queries ... are offered in the portal yet". |
| `syntax_error` | A 400 with a Trino-style message. |
| `slow` | The query stays running for five polls, so Cancel can be tried. |
| `big` | A result returned in pages of 100 rows while running, cut at 250 rows and marked truncated. |

Export (CSV, JSON), cancel and the schema and table search all work. The
browser tests in `e2e/` (Playwright) run against this mock: `npm run test:ui`.
They save full-page screenshots of `/services` and `/queries` (dark, light and
390 px wide) in `test-results/screenshots/` for review; CI uploads them as the
`ui-review` artifact. In a sandbox whose Chromium is not the revision Playwright
expects, set `PW_CHROMIUM` to its path. Locally run `npx playwright install chromium` once.

## Routes are a deploy-time parameter

The image is the same for every cluster. The routes are not baked in: they
are read **on every request** from the JSON file named by `OLF_ROUTES_FILE`
(`/config/routes.json` in the image). OpenLakeForge writes that file when it
deploys, so a changed route shows up without rebuilding or restarting the
portal.

The file has the same shape as the `links` variable of OpenLakeForge's portal
Terraform module: contract ref → stage, service name and URL.

```json
{
  "stage/dev/orchestration": { "stage": "dev", "name": "orchestration", "url": "http://dagster-dev.olf.localhost" },
  "shared/query": { "stage": "shared", "name": "query", "url": "http://trino.olf.localhost" }
}
```

- Every route needs a non-empty `stage` and `name` and an `http(s)` URL. A
  malformed file is logged and the page says it cannot read the routes. It
  never shows partial or made-up links.
- `npm run dev` without `OLF_ROUTES_FILE` uses
  [`src/data/routes.example.json`](src/data/routes.example.json). A production
  server without it shows an empty portal that says so.

## Container image and releases

Each release publishes a multi-arch image (linux/amd64, linux/arm64):

```text
ghcr.io/openlakeforge/openlakeforge-portal:<version>
```

| | |
| --- | --- |
| Port | `8080` (`PORT`) |
| Routes | `/config/routes.json` (`OLF_ROUTES_FILE`), read-only |
| Health | `GET /healthz` → `200 ok` |
| User | `65534:65534` (nobody); runs on a read-only root filesystem |
| Contents | `node:22-alpine`, `build/` and the production `node_modules` (`react-router-serve` runs the build) |

**To release:** bump `version` in `package.json`, merge, then push the
matching tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The [release workflow](.github/workflows/release.yml) checks that the tag
matches `package.json`, then builds and pushes the image with a build
provenance attestation. It also creates a GitHub release whose notes carry the
image digest. [CI](.github/workflows/ci.yml) runs the tests, the build, and a
check that the served page links exactly the configured routes, both from
Node and from the image (as nobody, read-only).

## Preview a branch on OpenLakeForge

To try a branch on a real stack without a release, the
[preview workflow](.github/workflows/preview.yml) publishes a throwaway image:

- It runs on pull requests from this repository (forks get no `packages: write`)
  and, through **Run workflow**, on any branch.
- It pushes `ghcr.io/openlakeforge/openlakeforge-portal:pr-<number>`, or
  `:branch-<name>` for a manual run, for linux/amd64 and linux/arm64. It makes no
  GitHub release and no `latest` or semver tag, so a preview never looks like a release.
- The job summary ends with a line to copy into a var file for OpenLakeForge's
  local deploy (`--var-file`):

  ```hcl
  portal_image = "ghcr.io/openlakeforge/openlakeforge-portal:pr-12@sha256:<digest>"
  ```

Preview images are not pinned in `release/component-catalog.yaml`; only a
tagged release is.

## How it fits with OpenLakeForge

- **OpenLakeForge owns the contract; the portal is a client.** Routes, stages
  and enabled services come from the access contract. The portal never
  hardcodes a hostname or assumes a provider, so one image serves local, AWS
  and Azure.
- **OpenLakeForge pins a release by digest** in `release/component-catalog.yaml`
  and deploys it from its portal Terraform module. The module mounts a
  ConfigMap holding `routes.json` (`jsonencode(var.links)`) at `/config`.
- **The page stays checkable.** It is rendered on the server, so the HTML that
  is served contains the route links. Stylesheets are inlined and fonts
  bundled, so the only `href` attributes are those links. That is what
  OpenLakeForge's e2e landing-page check (`check_portal_lists_routes`) compares
  with the contract. It also keeps the page working in an offline cluster.
- **Services are named by capability.** Cards read *Orchestration*, *Query*,
  *Governance*… with the implementing tool's logo. Presentation lives in
  [`src/lib/routes.server.ts`](src/lib/routes.server.ts). An unknown service still gets a
  card, with a monogram.
- **Admin is a link, not a route.** With the GitHub issuer, members and
  roles are GitHub teams, so OpenLakeForge adds `shared/admin` pointing at
  `https://github.com/orgs/<org>/teams`. The identity login surface (Dex) is
  never listed: it has no page of its own to visit.
- **Sign out is a button, not a route.** With authentication on, OpenLakeForge
  adds `shared/sign-out` pointing at the perimeter's sign-out URL. The portal
  shows it as a "Sign out" button in the header and lists no card for it. With
  authentication off the entry is absent and so is the button.

## Project layout

```text
src/
  root.tsx                 HTML shell (inlined CSS), error boundary
  routes.ts                route table
  routes/home.tsx          the index: server loader reads the routes file per request, no-store
  routes/signed-out.tsx    where Logout lands, outside the perimeter
  routes/healthz.ts        liveness endpoint for the container
  components/              Page (header, footer, mark) and Index (hero, stage sections, service cards)
  lib/routes.server.ts     server-only: reads and validates the routes, groups them into stages
  lib/routes.server.test.ts, routes/home.test.tsx   unit tests
  data/routes.example.json sample routes for local development
  styles/tokens.css        Deep Water design tokens (the --olf-* variables)
  styles/global.css        page-level layout
  styles/portal.css        component styles
public/
  logos/                   service logos (Dagster, Superset, Trino, OpenMetadata, GitHub)
  brand/                   OpenLakeForge mark and the ripple / bathymetry motifs
Dockerfile                 the release image (node:22-alpine + build/)
.github/workflows/         ci.yml on every change, release.yml on v* tags
```

## Design system

The portal and the [documentation website](https://openlakeforge.dev) ([repository](https://github.com/OpenLakeForge/openlakeforge.dev))
share one visual language, **Deep Water**: technical like a terminal, calm
like a lake. Dark is the default (the deep lake); light follows the OS.

- **Colour:** sea-blue neutrals (`abyss`), the brand blue (`lake`), the azure of
  the logo's ripples (`shallows`). Status colours are the only non-blue hues.
- **Type:** Fraunces (soft, wonky) for the one display line, Space Grotesk for
  headings, Inter for text, JetBrains Mono for code, labels and hosts.
- **Motifs:** lake-bed contours behind the page title, on one flat dark blue. The
  site's depth markers stay on the site.

The source of truth is the [Figma design system](https://www.figma.com/design/40rDaa8G9IWLD26TYjcIRz).
`src/styles/tokens.css` mirrors its variables one to one, so components only
read semantic tokens such as `--olf-bg-surface` or `--olf-accent`.

## Logos

The service logos are copied from OpenLakeForge's
`docs/architecture/diagrams/src/overview/logos.json`, which records where each
one comes from (the projects' own repositories or the CNCF artwork). They
belong to their respective projects and are used here only to identify them.

## License

[Apache License 2.0](LICENSE)
