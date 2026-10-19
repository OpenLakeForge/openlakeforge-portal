# OpenLakeForge Portal

**The front door of an [OpenLakeForge](https://github.com/OpenLakeForge/openlakeforge) lakehouse: every service on the cluster, grouped by stage, one click away.**

The portal is what you see at the base domain of a deployed OpenLakeForge
stack (`http://olf.localhost` on the local kind profile). Today it is a
static index of the user-facing routes: orchestration, reporting, query,
governance and sign-in, each listed under the shared services or the stage
(`dev`, `prod`, …) it belongs to. It is built with [Astro](https://astro.build)
and styled with the OpenLakeForge **Deep Water** design system.

> **Status: early.** This repository starts as the static index. It is meant
> to grow into a full platform UI (runs, assets, catalog and SQL in one place,
> in the spirit of Databricks or dbt Cloud) while staying a client of
> OpenLakeForge's provider contracts.

## Quick start

Requires Node.js 22 or later.

```bash
npm install
npm run dev       # http://localhost:4321, using src/data/routes.example.json
npm run build     # static site in dist/
npm run preview   # serve dist/
```

### Render your own cluster's routes

The page is built from a JSON file with the same shape as the `links`
variable of OpenLakeForge's portal Terraform module (`infra/terraform/modules/access/portal`).
It maps each contract ref to the route's stage, service name and URL:

```json
{
  "stage/dev/orchestration": { "stage": "dev", "name": "orchestration", "url": "http://dagster-dev.olf.localhost" },
  "shared/query": { "stage": "shared", "name": "query", "url": "http://trino.olf.localhost" }
}
```

Point `OLF_ROUTES_FILE` at it when building:

```bash
OLF_ROUTES_FILE=./routes.json npm run build
```

Without it, the bundled [`src/data/routes.example.json`](src/data/routes.example.json) is used.

## How it fits with OpenLakeForge

- **OpenLakeForge owns the contract; the portal is a client.** Routes, stages
  and enabled services come from the access contract. The portal never
  hardcodes a hostname or assumes a provider, so the same build works locally,
  on AWS and on Azure.
- **Services are named by capability.** Cards read *Orchestration*, *Query*,
  *Governance*… with the implementing tool's logo. Presentation lives in
  [`src/lib/routes.ts`](src/lib/routes.ts). An unknown service still gets a
  card, with a monogram.
- **Self-contained output.** Stylesheets are inlined and fonts are bundled, so
  the page works inside an offline cluster. The only `href` attributes on the
  page are route links: OpenLakeForge's e2e landing-page check
  (`check_portal_lists_routes`) compares them with the contract.
- **Until this replaces it,** OpenLakeForge serves an equivalent page rendered
  by Terraform (`index.html.tftpl` in the portal module).

## Project layout

```text
src/
  pages/index.astro        the page: header, hero, one section per stage, footer
  components/              Header, Hero, StageSection, ServiceCard, Mark, Footer
  lib/routes.ts            loads the routes and groups them into stages
  data/routes.example.json sample routes for local development
  styles/tokens.css        Deep Water design tokens (the --olf-* variables)
  styles/global.css        page-level layout
public/
  logos/                   service logos (Dagster, Superset, Trino, Dex, OpenMetadata)
  brand/                   OpenLakeForge mark and the ripple / bathymetry motifs
```

## Design system

The portal and the [documentation website](https://github.com/OpenLakeForge/openlakeforge-website)
share one visual language, **Deep Water**: technical like a terminal, calm
like a lake. Dark is the default (the deep lake); light follows the OS.

- **Colour:** sea-blue neutrals (`abyss`), the brand blue (`lake`), the azure of
  the logo's ripples (`shallows`). Status colours are the only non-blue hues.
- **Type:** Instrument Serif for the one display line, Space Grotesk for
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
