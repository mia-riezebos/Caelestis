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
- **Stack.** Server = Hono (runtime undecided, see `11-runtime-and-storage-platform`).
  Userscript = TypeScript, deep modules, esbuild, Violentmonkey.
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
  as ground-truth anchors, DO memory for live truth, time series on an exponential decay ladder
  capped at 6h buckets. **Amended 2026-08-03**: tile history lives server-side, so the server (not
  the client) computes diffs, anchors, and repair classification.
- [Rendering model](issues/05-rendering-model.md) — tile-fetch interception, culling by tile-index
  lookup, viewing modes as one `{shape, size, anchor, opacity}` parameterisation.
- [Runtime & storage platform](issues/11-runtime-and-storage-platform.md) — Cloudflare Workers + R2
  + D1 + DO, with three narrow seams kept for a later port. D1 is the system of record and holds
  every ladder tier; the DO is a write-absorption buffer for live counters and sub-1m data.
  `shardStrategy: 'single'` in v1, `per-template` and `dynamic` stubbed. `wrangler dev` locally.
  Free-tier viable for small alliances.

## Not yet specified

- **Telemetry wire schema and the functional CRUD surface** it maps onto. Blocked on knowing the
  real shape of the wplace paint request and pixel-info responses.
- **Empty-tile synthesis behaviour** — confirmed that wplace returns a real HTTP 404 for unpainted
  tiles, so the shim branches on status. Still open: exactly what it hands back in that case, and
  whether fabricating a response perturbs MapLibre's or wplace's own logic.
- **Multi-server merge UX** — how conflicting/overlapping templates from different servers are
  surfaced, and where the "what did this server just add" trust diff lives in the userscript UI.
- **Admin surface without a web frontend** — how an alliance leader provisions invite codes, uploads
  templates, and edits the tree when the only UI is the userscript.
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

## Out of scope

- **Web frontend** — dashboard, progress/pace/ETA charts, timelapse, server-rendered composites,
  per-user contribution graphs. Explicitly deferred until v1 runs; returns as its own map. v1 still
  *captures* the data these need, and `packages/ui` is built to serve both hosts, so the frontend is
  deferred rather than designed out.
- **Template creation and quantisation tooling** — a separate existing tool owns this. The server
  validates that uploads are already palette-conformant and does not quantise.
