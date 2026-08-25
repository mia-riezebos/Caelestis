# Caelestis

Caelestis is a fast, customisable template overlay for [wplace.live](https://wplace.live). It gives
groups a shared template server, keeps local and shared templates in one tree, and tracks painting
progress without making the browser scan the whole template first.

The project has three parts that work together:

- a userscript that renders templates and adds painting tools to Wplace;
- a self-hostable server for shared templates, access control, and telemetry;
- a web dashboard for progress, pace, contributions, and timelapses.

## Install the userscript

Install a userscript manager such as Violentmonkey, then open the stable installer:

**[Install Caelestis](https://github.com/mia-riezebos/Caelestis/releases/latest/download/caelestis.user.js)**

The installer follows the latest GitHub release. Once installed, open Wplace and use the Caelestis
button rail to import a local template or connect to a template server.

The official dashboard is at [caelestis.mia.cx](https://caelestis.mia.cx). Private servers ask for
the same access token used by the userscript.

## What it does

### Shared templates

- Import PNG images, Blue Marble exports, and `.wplace` files.
- Publish templates to a server so everyone connected to it sees the same artwork and organisation.
- Organise local and server templates with nested folders, ordering, drag and drop, and search.
- Connect to several template servers at once.
- Move templates between folders or upload local templates to a server you administer.

### A configurable overlay

- Render templates through WebGL without baking every appearance change into new image tiles.
- Adjust pixel size, rounding, position, rotation, opacity, and colour visibility per template.
- Switch between small-pixel, full-pixel, and corner pixel styles.
- Mark mismatches, unpainted pixels, or every pixel of the selected paint colour.
- Pick colours from the template itself, including when visible pixels do not fill their source cell.
- Jump to the next missing pixel for a colour, then to mismatches once that colour is complete.

### Shared progress

- Show progress for templates, folders, and whole servers.
- Break progress down by colour and sort the palette by what still needs work.
- Record contribution totals, painting pace, progress history, and timelapses.
- Keep local counters responsive while the server remains the shared source of truth.

## Privacy and telemetry

`Report my activity` and `Share tiles` are enabled by default and can be disabled independently in
the userscript settings.

Caelestis reports paint activity and fetched tiles only where a server template exists. It sends
that data only to the server providing the template. The server uses it for progress bars,
contributions, pace and progress charts, and timelapses.

## Development

Caelestis is a pnpm monorepo. It requires Node.js 22.13 or newer and pnpm 11.13.0.

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts the backend, frontend, and userscript development tasks. The backend applies its
local D1 migrations before Wrangler starts. The userscript task rebuilds and reinjects changes into
the configured debug Chromium session.

Run the complete local checks with:

```sh
pnpm lint
pnpm check
pnpm test
pnpm build
```

## Repository layout

```text
apps/
  backend/       Hono API on Cloudflare Workers, D1, R2, and Durable Objects
  frontend/      SvelteKit progress dashboard
  userscript/    Wplace integration, WebGL renderer, template UI, and telemetry client
packages/
  shared/        Template, palette, PNG, tiling, hashing, and telemetry code
  wire-schema/   Runtime validation for data crossing the network
  ui/            Reserved package for future shared UI components
```

The backend keeps its Hono routes root-relative. Its Worker mounts them under `/backend`, which lets
the frontend and API share one domain. When a server is added by origin, the userscript uses
`/backend` automatically. Supplying a URL with another path overrides that default.

## Self-hosting

The included Wrangler files describe the deployment at `caelestis.mia.cx`. A fork must replace the
Cloudflare account IDs, routes, D1 database, and R2 bucket with its own resources.

After configuring those bindings, apply the database migrations and set a bootstrap admin token:

```sh
pnpm --dir apps/backend exec wrangler d1 migrations apply DB --remote
pnpm --dir apps/backend exec wrangler secret put ADMIN_TOKEN
pnpm --dir apps/backend exec wrangler deploy
pnpm --dir apps/frontend deploy
```

Keep the bootstrap token somewhere safe. It can create normal admin and read tokens, but the server
never returns its value through the API.

Production deployments run from `.github/workflows/deploy.yml` after a push to `main`. The workflow
needs a `CLOUDFLARE_API_TOKEN` repository secret with access to the configured Workers, D1, and R2
resources.

## Userscript releases

Userscript releases use Changesets. A user-facing userscript change should include a changeset for
`@caelestis/userscript`. Merging the generated release pull request builds the userscript, publishes
the GitHub release, and updates the stable installer.

See [Userscript releases](docs/userscript-releases.md) for the full release process.

## Issues

Report bugs and request features in the [GitHub issue tracker](https://github.com/mia-riezebos/Caelestis/issues).
