# OpenLakeForge Portal

**The front door of an [OpenLakeForge](https://github.com/OpenLakeForge/openlakeforge) lakehouse: every service on the cluster, grouped by stage, one click away.**

The portal is what you see at the base domain of a deployed OpenLakeForge
stack (`http://olf.localhost` on the local kind profile). Today it lists the
user-facing routes (orchestration, reporting, query, governance and sign-in),
each under the shared services or the stage (`dev`, `prod`, …) it belongs to.
It is built with [Astro](https://astro.build), rendered on the server, and
styled with the OpenLakeForge **Deep Water** design system.

> **Status: early.** This repository starts as the route index. It is meant
> to grow into a full platform UI (runs, assets, catalog and SQL in one place,
> in the spirit of Databricks or dbt Cloud) while staying a client of
> OpenLakeForge's provider contracts.

## Quick start

Requires Node.js 22 or later.

```bash
npm install
npm run dev       # http://localhost:4321, using src/data/routes.example.json
npm test          # unit tests (vitest)
npm run build     # server build in dist/
OLF_ROUTES_FILE=src/data/routes.example.json npm start   # serve dist/ on :4321
```

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
| Contents | `node:22-alpine` and the self-contained `dist/`, no `node_modules` |

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
  [`src/lib/routes.ts`](src/lib/routes.ts). An unknown service still gets a
  card, with a monogram.
- **Until OpenLakeForge switches to this image,** it serves an equivalent page
  rendered by Terraform (`index.html.tftpl` in the portal module).

## Project layout

```text
src/
  pages/index.astro        the page: header, hero, one section per stage, footer
  pages/healthz.ts         liveness endpoint for the container
  components/              Header, Hero, StageSection, ServiceCard, Mark, Footer
  lib/routes.ts            reads and validates the routes, groups them into stages
  lib/routes.test.ts       unit tests
  data/routes.example.json sample routes for local development
  styles/tokens.css        Deep Water design tokens (the --olf-* variables)
  styles/global.css        page-level layout
public/
  logos/                   service logos (Dagster, Superset, Trino, Dex, OpenMetadata)
  brand/                   OpenLakeForge mark and the ripple / bathymetry motifs
Dockerfile                 the release image (node:22-alpine + dist/)
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
- **Motifs:** depth markers (`00 m`, `10 m`, …) as section labels, lake-bed
  contours behind the hero, ripple lines as dividers.

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
