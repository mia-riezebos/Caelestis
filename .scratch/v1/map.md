# Caelestis — v1

Label: `wayfinder:map`
GitHub: https://github.com/mia-riezebos/Caelestis/issues/1

The project is named **Caelestis**, and the repo moved to `mia-riezebos/Caelestis` on 2026-08-08.
Older links here still resolve through GitHub's redirect.

## Destination

A **running v1**: a Hono server that hosts alliance templates plus telemetry, and a Violentmonkey
userscript that renders those templates over wplace.live with viewing modes and a toggle tree.

Spec-driven, but not spec-only — as tickets resolve we write prototypes and code, and keep the spec
updated until v1 actually runs.

**Standing risk, learned the hard way (2026-08-08).** "Not spec-only" cuts both ways: a long
implementation stretch left this map claiming a raster renderer we had already replaced, and its
frontier was three recon tickets that building had answered weeks earlier. Anything that gets
*decided by being built* still has to come back here, or the map quietly starts misdirecting whoever
reads it next.

## Notes

- **Execution override.** This map carries execution, not just decisions. Wayfinder's plan-don't-do
  default is OFF for this effort: tickets may produce running code, and the spec is a living
  document updated as tickets resolve.
- **Stack.** Server = Hono on Cloudflare Workers + R2 + D1 + DO. Userscript = TypeScript, deep
  modules, esbuild, Violentmonkey. **wplace itself is SvelteKit + Tailwind + DaisyUI, and the
  userscript should look at home in it** — by adopting DaisyUI's theme variables through the shadow
  boundary, never their purged utility classes. See `19-shared-ui-components`. Turborepo + pnpm: `apps/{backend,userscript,frontend}`,
  `packages/{shared,ui,wire-schema}`.
- **All UI is userscript-side in v1**, and the userscript shows **current state and alarms only** —
  no charts, no history, no pace. Everything time-series is frontend-only for now, and may come back
  to the userscript once the frontend has designed that UI. This narrows the userscript's read
  surface to manifest, chunks, current status, and alarms.
- **Skills to consult.** `/grilling` + `/domain-modeling` by default; `/prototype` when the question
  is "how should this look or behave"; `/research` for wplace recon; `/setup-ts-deep-modules` for
  userscript module layout; `/codebase-design` for server structure.
- **Tracker.** Files under `.scratch/v1/` are the working copy. GitHub issues on
  `mia-riezebos/Caelestis` are the mirror, batch-synced after scratch edits settle. (The repo moved
  on 2026-08-08; the old `wplace-template-server` name still resolves through GitHub's redirect, so
  older links above keep working.)
- **Payload discipline (standing constraint).** The userscript never transmits session cookies,
  captcha tokens, wplace user ids, or raw wplace request bodies. Username + painted pixels +
  timestamp is the ceiling.

## Decisions so far

- [Template storage & chunk model](issues/01-template-storage-and-chunk-model.md) — pre-quantised
  uploads, validated then sliced on wplace tile boundaries, stored content-addressed as indexed PNG.
- [Manifest, group tree & z-order](issues/02-manifest-group-tree-and-z-order.md) — materialized-path
  tree, one parent per template, ETag-polled manifest gates all interception. **Amended 2026-08-09**:
  templates may overlap anywhere, the no-overlap rule and the wire constraint enforcing it are gone,
  and no sort order reaches the wire at all — ordering is entirely the client's. The manifest is
  season-scoped and seasons are 1-based.
- [Auth model](issues/03-auth-model.md) — server-generated high-entropy invite codes, three scopes
  (read/report/admin), bearer for everything, one env admin token to bootstrap. **Amended
  2026-08-09**: there are no signed URLs anywhere. Read is bearer like the rest — see the chunk
  delivery decision below.
- [Telemetry model](issues/04-telemetry-model.md) — POST events as the delta stream, tile snapshots
  as ground-truth anchors and the only progress source, DO memory for live truth, time series on a decay ladder
  capped at 6h buckets. **Amended 2026-08-03**: tile history lives server-side, so the server (not
  the client) computes diffs, anchors, and repair classification.
- [Repo layout & build pipeline](issues/12-repo-layout-and-build.md) — turborepo + pnpm, backend wired to
  Cloudflare behind three port interfaces, `wrangler dev` locally, vitest against in-memory adapters.
- [Rendering model](issues/05-rendering-model.md) — one parameterisation rather than a mode list;
  colour filtering is part of the model, with an overlay's own set overriding the global one and
  follow-the-selection as a mode above both. **Amended 2026-08-08**: culling is the tile quads wplace
  drew this frame, recovered from their own matrix, not a tile-index lookup.
- [Bucket attribution by event time](issues/22-bucket-attribution-by-event-time.md) — counters are
  bucketed by event time, not flush time; only buckets closed past a 30s grace are flushed; flushed
  buckets are retained an hour so a late arrival rewrites the cumulative total; past that, dropped
  and counted. Hardened across a four-cycle review loop — see PR #26.
- [Runtime & storage platform](issues/11-runtime-and-storage-platform.md) — Cloudflare Workers + R2
  + D1 + DO, with three narrow seams kept for a later port. D1 is the system of record and holds
  every ladder tier; the DO is a write-absorption buffer for live counters and sub-1m data.
  `shardStrategy: 'single'` in v1, `per-template` and `dynamic` stubbed. `wrangler dev` locally.
  Free-tier viable for small alliances.
- [Recon: wplace tile serving](issues/06-recon-tile-serving.md) — `/files/s0/tiles/{x}/{y}.png`,
  1000², in-range unpainted returns a near-empty 200 and only out-of-range 404s. The read path is
  `fetch → arrayBuffer → Blob → ImageBitmap → texImage2D`, and identity survives none of it, so the
  tag rides on the buffer.
- [Recon: wplace colour palette](issues/09-recon-palette.md) — 63 colours committed as
  `WPLACE_PALETTE` with the free/premium split. Index 63 is a **wildcard** in a template, asserting
  nothing; `UNPAINTED = 255` is our own sentinel, outside their palette, because wplace store colour
  and absence as the same value.
- [Recon: map stack & triangle mode](issues/10-recon-map-stack-and-triangle-mode.md) — MapLibre,
  custom layers reachable from a userscript, the map instance capturable at construction, and the
  projection matrix readable back out of the GL context. They never mipmap.
- [Render path](issues/13-render-path.md) — **vector, in a custom layer inside wplace's own canvas**,
  reversing the raster-first position. The fetch intercept survived doing the opposite job: it reads
  tile pixels rather than compositing them.
- [v1 viewing modes & render scale](issues/14-v1-viewing-modes.md) — no modes and no render scale.
  Size, rounding, offset, rotation and opacity over a 64px stamp mask; anchors dissolved into offset.
  Colour presets (All/Free/Premium/Owned) are the only presets that survived.
- [Per-overlay controls on the map](issues/29-per-overlay-map-controls.md) — both surfaces ship: a
  rail button opening the tree and defaults, and a button beside each overlay owning that overlay.
  The menu never rebuilds itself, so every control in it restates itself in place.
- [Mismatch marking & the client-side pixel store](issues/31-mismatch-marking.md) — three arrays per
  tile (server, draft, template), compared on a worker thread, drawn as fixed-device-size crosshairs
  from a CPU-side list. Drafted-Transparent is read from wplace's crosshair annotations, the only
  place it is distinguishable. Marking unpainted pixels is gated on how little is left.

### Settled by building it — 2026-08-09

Four PRs landed on `main` and decided things this map was still describing differently. Recording
them here for the same reason as the 2026-08-07 batch above: the map misdirects whoever reads it next
otherwise.

- [Chunk delivery: signed URLs vs public-by-hash](https://github.com/mia-riezebos/Caelestis/issues/16)
  — **neither, as posed.** Content-addressed `GET /chunks/:hash` behind a read scope, answering
  `cache-control: private, max-age=31536000, immutable`. No signature to vary on, and deliberately no
  shared cache: `public` would let one authorised fetch make a chunk readable by anyone holding its
  hash. Client-side caching does the work; there is no CDN tier in front of chunks.
- [Nodes, seasons and manifest assembly](https://github.com/mia-riezebos/Caelestis/pull/37) — node
  CRUD under `/admin/nodes`, season-scoped manifest assembly, publication as a per-template flag.
  **Seasons are 1-based**: the wire, both route parsers and the Worker's `SEASON` binding all refuse
  0. The assembler drops a template whose node or chunks a torn read missed, rather than emitting a
  200 no client can decode.
- [Renaming a node moves its subtree](https://github.com/mia-riezebos/Caelestis/pull/38) —
  `PATCH /admin/nodes/:id` rewrites every descendant's path in one batch. Two rules came out of
  building it and now hold for *every* node write: **only the last path segment is ever the
  caller's**, with the prefix composed from the parent row inside the write, so a concurrent rename
  cannot leave a child under a prefix its parent no longer has; and **derived paths stay inside the
  BMP**, so SQLite's character count and the wire's UTF-16 count are the same number. The subtree
  match is a `substr`/`lower` prefix comparison and **not** `LIKE` — D1 caps LIKE/GLOB patterns at 50
  bytes while a node path may be 256 characters, so the obvious implementation is a production-only
  500 on every rename of anything but a shallow node.
- [Credentials named for what they hold](https://github.com/mia-riezebos/Caelestis/pull/56) —
  `created_with_token` rather than `created_by`, and `created_by_user_id` is nullable: authorship
  needs only a credential, while anything quorum-related needs an account.

**Standing caveat.** `migrations/0000_baseline.sql` is still edited in place rather than superseded.
That is only correct while nothing has been deployed from this schema. The moment a live D1 has
applied it, this becomes a forward-migration problem and every amendment above needs one.

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


### Claimed incidentally while building the userscript — 2026-08-07

These were open decision tickets. They were not worked as tickets; they were **answered by building
against the live page**, and the answers are recorded on the tickets rather than here. Listing them
so the map stops showing them as open questions.

- [Render path: raster intercept vs vector overlay](https://github.com/mia-riezebos/wplace-template-server/issues/14)
  — **overlay, not intercept.** Our own canvas over MapLibre's, aligned from MapLibre's own
  projection matrix. Blue Marble and Skirk were read: both rewrite the tile, and `drawMult = 3`
  means a 3000x3000 canvas and a 36 MB `getImageData` per tile per pan. Compositing also makes our
  pixels indistinguishable from wplace's, which per-colour filters need to tell apart.
- [Recon: map stack & how wplace draws its triangle mode](https://github.com/mia-riezebos/wplace-template-server/issues/11)
  — **MapLibre GL on WebGL2 under SvelteKit.** Their tile filtering is `MIN_FILTER=LINEAR`,
  `MAG_FILTER=NEAREST`, no mipmaps. The `Map` instance is reachable after all, by trapping a private
  field assignment during construction.
- [Recon: wplace tile serving](https://github.com/mia-riezebos/wplace-template-server/issues/7)
  — confirmed and **corrected**: the origin 404s for any tile it has no data for, and a service
  worker rewrites that into a 200 with a 73-byte blank PNG. What a client sees depends on whether it
  is SW-controlled.
- [v1 viewing modes & render scale](https://github.com/mia-riezebos/wplace-template-server/issues/15)
  — **built rather than decided**: shape, size, anchor and opacity per overlay, with `scale` derived
  from the shape so full-pixel modes stay free.
- [Native `.wplace` template format](https://github.com/mia-riezebos/wplace-template-server/issues/31)
  — **import works**, for `.wplace`, Blue Marble/Skirk, and plain images. Export does not exist.

**What this cost.** Wayfinder says the pull to just do the work is the signal you have reached the
edge of the map. That signal was there and was not taken: decisions got made inside commits instead
of on tickets, and one of them — sort order — was re-decided in the UI against a decision already
recorded, which is what prompted `31-ui-inventory`.

## Not yet specified

**Where the gap to a running v1 actually is, as of 2026-08-09.** The telemetry write path is the last
server-side hole: the Durable Object shard exists and is tested, and nothing mounts it, so the
userscript has nowhere to report to. Everything else it needs from a server — `/server`, `/manifest`,
`/chunks`, `/admin/nodes`, `/admin/templates`, `/admin/tokens` — is mounted and in use.

- **Telemetry wire schema and the functional CRUD surface** it maps onto. No longer blocked — the
  real paint request is recorded in `07-recon-paint-request` and `packages/shared` needs updating to
  its multi-tile shape.
- ~~Empty-tile synthesis behaviour~~ — **dissolved.** In-range unpainted tiles return 200 with a
  near-empty PNG; only out-of-range coordinates 404. The canvas is Web Mercator zoom 11, 2048×2048
  tiles. There is no synthesis path and nothing to fabricate. See `06-recon-tile-serving`.
- **The telemetry write path is the gap between here and a running v1.** The DO shard exists and is
  tested; no route mounts it, and the userscript reports nothing. Everything else the userscript
  needs from a server — manifest, nodes, templates, chunks, tokens — is mounted and in use.
- **Cache invalidation for shared templates.** The server owns shared templates and the manifest
  says when one changed; the userscript now caches them locally, so it needs a settled answer for
  re-fetch on change, and for what happens when a cached template's server says it is gone. See the
  2026-08-08 amendment on `01-template-storage-and-chunk-model`.
- **Promoting a locally-imported template to a shared one** — in place, or re-upload.
- **Does the palette grow?** A new colour would not break stored templates, but it would silently
  change what `Owned` and `Free` mean, and what a validated upload was validated against.
- **Multi-server merge UX** — how conflicting/overlapping templates from different servers are
  surfaced, and where the "what did this server just add" trust diff lives in the userscript UI.
- **Admin surface without a web frontend** — how an alliance leader uploads templates and edits the
  tree when the only UI is the userscript. **The credential half is settled** (see the pre-v1
  decision below), and as of 2026-08-09 the *server* half is built: `/admin/nodes` does full node
  CRUD including rename-with-subtree-move, and `/admin/templates` does upload and publication. What
  remains is entirely userscript-side — the UI that drives those routes.
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
