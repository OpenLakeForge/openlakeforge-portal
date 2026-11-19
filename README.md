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
They save full-page screenshots of `/services`, `/queries`, `/files`, `/monitoring` and a failed run (dark, light and
390 px wide) in `test-results/screenshots/` for review; CI uploads them as the
`ui-review` artifact. In a sandbox whose Chromium is not the revision Playwright
expects, set `PW_CHROMIUM` to its path. Locally run `npx playwright install chromium` once.

The Files page (`/files`) is served by the same mock: stage `dev` only, buckets
`openlakeforge-dev-bronze`, `-silver` and `-gold`, with an in-memory object store, so upload,
new folder, rename and delete really change the listings (they reset when the dev server restarts).
`bronze/raw/orders/` has three day folders and three files, `silver/events/` has 120 files
(to try "Load more"), and `gold` is empty. Uploads are limited to 5 MiB. The mock has no roles:
to see the portal as a viewer, make `GET /api/v1/file-capabilities` return `{"stages": []}` (the
browser tests do this with `page.route`) and the Files item disappears.

The Monitoring page (`/monitoring`) first reads `GET /api/v1/monitoring-capabilities`: it offers only the stages
listed there, and each panel calls its route only when the role has that operation and the stage has its source.
It then reads `GET /api/v1/stages/{stage}/health` and
`GET /api/v1/stages/{stage}/health/pipelines` from the same mock, together, within one 10 s deadline. Service rows
are grouped by service (the worst row decides), and the banner shows the log archive's last durable write and the
last quality publication, or "unknown" when the API has none. `prod` needs
attention: `sales_orders` failed with a failed blocking quality check, `crm_accounts` missed its run,
`finance_ledger`'s schedule is stopped and its last run warned on quality, `web_events` is healthy, the log spool is
past its limit and metrics are not connected. "Needs attention" lists each warning or critical pipeline signal in
the API's words; the Pipelines table lists every job. `dev` reads unknown because Dagster cannot be read. No backend
state is ever shown green: an unreachable API, an expired probe or pipeline signal, or a missing source reads Unknown
or Disabled. When only the pipelines read fails, the stage's own answer stays and the pipelines read Unknown, with
Retry and the last good snapshot time.

Add `mock=<scenario>` to the page's address (`/monitoring?stage=prod&mock=limited`) to see another role or state;
the mock reads it from the request's Referer:

| `mock=` | What it shows |
| --- | --- |
| `no-access` | `monitoring-capabilities` lists no stage (an analyst): "No monitoring access", and no stage route is called. |
| `limited` | The role may call `get_stage_health` only: no pipelines read is made, and the panels say why. |
| `unauthorized` | The capabilities offer the stage but its routes answer 403: the API's words, as Disabled, with no Retry. |
| `not-provided` | No quality reader and no alert evaluator: both panels say "not configured", and neither route is called. |
| `unknown` | Quality: Dagster could not be read, so no counts. Incidents: the state does not say when it was evaluated, so stale. |
| `unavailable` | The alert state cannot be read: `incidents: null`, shown as "Incidents cannot be read", never as none. |
| `stale` | PROD's alert evaluator has stopped running: its incidents stay, flagged stale. |
| `empty` | No open incident in a current evaluation, and no pipeline with quality evidence yet. |
| `admin` | A platform admin: PROD's log archive is readable too, so the failed run shows its archived lines. |

Without `mock=`, PROD's Data quality card sums the known counts (`crm_accounts` has none: "Counts unknown", never
zeros; `finance_ledger`'s manifest is incomplete), and Open incidents lists one incident per delivery status
(delivered, pending, undeliverable, unrouted, unknown). DEV's alert evaluator is stale and DEV has no quality reader.

Each run named on the page (a Needs attention row, a pipeline's latest run, a quality row, an incident) links to its
**Failed run** screen, `/monitoring/<stage>/runs/<run_id>`. It reads
`GET /api/v1/stages/{stage}/runs/{run_id}/failure` (the failing steps, the first line of each error, redacted by the
API, and the rows Floe rejected), `GET /api/v1/stages/{stage}/runs/{run_id}` (start and end), the pipelines, quality
and incidents routes (domain and product, this run's quality counts, its open incidents), and, when the role may read
the stage's log archive, the run's lines from `GET /api/v1/stages/{stage}/logs` for its UTC day. "Open in Dagster" is
a plain link to the run on the stage's `orchestration` route; there is no Re-run in v0.7. A refused (403), unknown
(404) or unreachable run reads Disabled or Unknown in the API's words, never green; a part the API could not read
(`steps: null`, `rows: null`) says so and is never shown as "nothing failed" or zeros. In the mock, PROD's
`sales_orders` run `c94cbcb0…` failed a Floe step; `mock=unknown` makes its event log and manifest unreadable,
`mock=unauthorized` refuses it with 403, and a data-engineer (the default) is told PROD's archive is not theirs to read.

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
  "stage/dev/query": { "stage": "dev", "name": "query", "url": "http://trino-dev.olf.localhost" },
  "shared/governance_service": { "stage": "shared", "name": "governance_service", "url": "http://openmetadata.olf.localhost" }
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
  routes/files.tsx         the Files explorer (buckets, folders, upload, rename, delete)
  routes/monitoring.tsx    Monitoring overview: platform and pipeline health per stage, from the Platform API
  routes/monitoring-run.tsx Monitoring · Failed run: one run's failure, scope, quality, incidents and archived lines
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
