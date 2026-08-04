# wplace template server — v1

Label: `wayfinder:map`
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/1

## Destination

A **running v1**: a Hono server that hosts alliance templates plus telemetry, and a Violentmonkey
userscript that renders those templates over wplace.live with viewing modes and a toggle tree.

Spec-driven, but not spec-only — as tickets resolve we write prototypes and code, and keep the spec
updated until v1 actually runs.

## Notes

- **Execution override.** This map carries execution, not just decisions. Wayfinder's plan-don't-do
  default is OFF for this effort: tickets may produce running code, and the spec is a living
  document updated as tickets resolve.
- **Stack.** Server = Hono on Cloudflare Workers + R2 + D1 + DO. Userscript = TypeScript, deep
  modules, esbuild, Violentmonkey. **wplace itself is SvelteKit + Tailwind + DaisyUI, and the
  userscript should look at home in it** — by adopting DaisyUI's theme variables through the shadow
  boundary, never their purged utility classes. See `19-shared-ui-components`. Turborepo + pnpm: `apps/{backend,userscript,frontend}`,
  `packages/{shared,ui}`.
- **All UI is userscript-side in v1**, and the userscript shows **current state and alarms only** —
  no charts, no history, no pace. Everything time-series is frontend-only for now, and may come back
  to the userscript once the frontend has designed that UI. This narrows the userscript's read
  surface to manifest, chunks, current status, and alarms.
- **Skills to consult.** `/grilling` + `/domain-modeling` by default; `/prototype` when the question
  is "how should this look or behave"; `/research` for wplace recon; `/setup-ts-deep-modules` for
  userscript module layout; `/codebase-design` for server structure.
- **Tracker.** Files under `.scratch/v1/` are the working copy. GitHub issues on
  `mia-riezebos/wplace-template-server` are the mirror, batch-synced after scratch edits settle.
- **Payload discipline (standing constraint).** The userscript never transmits session cookies,
  captcha tokens, wplace user ids, or raw wplace request bodies. Username + painted pixels +
  timestamp is the ceiling.

## Decisions so far

- [Template storage & chunk model](issues/01-template-storage-and-chunk-model.md) — pre-quantised
  uploads, validated then sliced on wplace tile boundaries, stored content-addressed as indexed PNG.
- [Manifest, group tree & z-order](issues/02-manifest-group-tree-and-z-order.md) — materialized-path
  tree, one parent per template, sparse sort orders, ETag-polled manifest gates all interception.
- [Auth model](issues/03-auth-model.md) — server-generated high-entropy invite codes, three scopes
  (read/report/admin), signed URLs for read, bearer for admin, one env admin token to bootstrap.
- [Telemetry model](issues/04-telemetry-model.md) — POST events as the delta stream, tile snapshots
  as ground-truth anchors and the only progress source, DO memory for live truth, time series on a decay ladder
  capped at 6h buckets. **Amended 2026-08-03**: tile history lives server-side, so the server (not
  the client) computes diffs, anchors, and repair classification.
- [Repo layout & build pipeline](issues/12-repo-layout-and-build.md) — turborepo + pnpm, backend wired to
  Cloudflare behind three port interfaces, `wrangler dev` locally, vitest against in-memory adapters.
- [Rendering model](issues/05-rendering-model.md) — tile-fetch interception, culling by tile-index
  lookup, viewing modes as one `{shape, size, anchor, opacity}` parameterisation.
- [Bucket attribution by event time](issues/22-bucket-attribution-by-event-time.md) — counters are
  bucketed by event time, not flush time; only buckets closed past a 30s grace are flushed; flushed
  buckets are retained an hour so a late arrival rewrites the cumulative total; past that, dropped
  and counted. Hardened across a four-cycle review loop — see PR #26.
- [Runtime & storage platform](issues/11-runtime-and-storage-platform.md) — Cloudflare Workers + R2
  + D1 + DO, with three narrow seams kept for a later port. D1 is the system of record and holds
  every ladder tier; the DO is a write-absorption buffer for live counters and sub-1m data.
  `shardStrategy: 'single'` in v1, `per-template` and `dynamic` stubbed. `wrangler dev` locally.
  Free-tier viable for small alliances.

## Pre-v1: the first deployable, shareable cut

Ahead of v1 there is a smaller target — something that runs and can be handed to one alliance. It has
**no frontend on the server at all**, which settles a question the admin surface was waiting on:

- **One private admin token, from the environment.** Provisioned by the operator as a secret, not
  minted through any UI. It is the root credential and the only one that exists before the server has
  been talked to.
- **Admin tokens provision other tokens.** Everything else — read tokens for members, report tokens
  for the userscript — is minted by an admin token through the API. Shipped in PR #35.
- **The admin UI is in the userscript.** Until a frontend exists, provisioning, listing and revoking
  tokens happens in the userscript's primary drawer, behind admin scope. That is the same surface
  `29-per-overlay-map-controls` gives the tree, with an admin section that simply is not rendered for
  a read or report holder.

This is deliberately a narrower target than v1 and it changes what "done" means for the next few
slices: a thing one alliance can actually use beats a complete feature matrix nobody has run.

Consequence worth stating: **the userscript becomes an admin client, not only a viewer.** Its read
surface was narrowed on the assumption it only displays state; token administration is a write
surface, and the scope ladder is what keeps it invisible to everyone who should not have it.

## Deferred until a running prototype

Sharp questions with known methods, waiting only on something that runs — kept as a standing
register in [Deferred until a running prototype](issues/26-deferred-until-prototype.md). Distinct
from the fog below: these are not unspecifiable, just unanswerable yet. Add to it whenever a decision
rests on reasoning that only real behaviour can confirm.

## Not yet specified

- **Telemetry wire schema and the functional CRUD surface** it maps onto. No longer blocked — the
  real paint request is recorded in `07-recon-paint-request` and `packages/shared` needs updating to
  its multi-tile shape.
- ~~Empty-tile synthesis behaviour~~ — **dissolved.** In-range unpainted tiles return 200 with a
  near-empty PNG; only out-of-range coordinates 404. The canvas is Web Mercator zoom 11, 2048×2048
  tiles. There is no synthesis path and nothing to fabricate. See `06-recon-tile-serving`.
- **The two userscript surfaces** — a primary menu button in wplace's own right-hand rail opening a
  drawer with the whole node tree, and a three-dot button to the right of each overlay, top-aligned,
  expanding into that overlay's display mode, opacity, mismatch highlighting, colour filters and
  focus. Captured in
  [Per-overlay controls on the map](issues/29-per-overlay-map-controls.md). Carries two things the
  viewing-modes ticket does not: mismatch highlighting is a new axis outside
  `{shape, size, anchor, opacity}`, and a progress chart there would contradict the userscript's
  current-state-only read surface.
- **Multi-server merge UX** — how conflicting/overlapping templates from different servers are
  surfaced, and where the "what did this server just add" trust diff lives in the userscript UI.
- **Admin surface without a web frontend** — how an alliance leader uploads templates and edits the
  tree when the only UI is the userscript. **The credential half is settled** (see the pre-v1
  decision below); what remains is template upload and tree editing from inside the userscript.
- **Decay-ladder compaction** — the actual cascade job, its trigger, and the differing fold
  functions for state columns vs delta columns.
- **Abuse and rate limiting** at 1000+ user alliance scale, including report throttling and the
  quorum rules for trusting client-supplied data.
- **Deployment, secrets, migrations, and testing strategy** — now Cloudflare-shaped: `wrangler.toml`
  bindings, D1 migrations, secret management, and how the three seams get in-memory implementations
  for tests.
- **Non-Cloudflare implementation** — the Node/Postgres/S3 side of the three portability seams.
  Deferred to v2 or later; the interfaces exist in v1 but nothing exercises them, so they will need
  a real audit before anyone trusts them.

## Deferred beyond v1

- **Authoring templates on wplace itself** — shipping ditherette's Rust/WASM resize, dither and
  quantisation core in the userscript, so an alliance leader crops, dithers and places a template
  against the live canvas rather than exporting from a separate tool. **v3 or later**; captured in
  [Ditherette's WASM core in the userscript](issues/30-ditherette-wasm-in-the-userscript.md). Two v1
  choices keep it possible at no cost: the palette stays a parameter rather than being embedded, and
  the server quantises on ingest regardless of what a client did — which is what makes client-side
  dithering an enhancement rather than a dependency.

## Out of scope

- **Web frontend** — dashboard, progress/pace/ETA charts, timelapse, server-rendered composites,
  per-user contribution graphs. Explicitly deferred until v1 runs; returns as its own map. v1 still
  *captures* the data these need, and `packages/ui` is built to serve both hosts, so the frontend is
  deferred rather than designed out.
- **Template creation tooling** — a separate existing tool owns authoring. **Quantisation is no
  longer out of scope**: as of 2026-08-03 the server quantises on ingest, mapping every pixel to the
  nearest palette colour with no dithering and no rejection. See the amendment on
  `01-template-storage-and-chunk-model`.
- **Pixel-level attribution via wplace's pixel-info endpoint** — one request per pixel, so verifying
  anything meaningful would hit rate limits immediately and make us a bad neighbour. Attribution
  comes from self-reported paints; progress comes from tile diffs. Grief is *detected*, never
  attributed.
