# Runtime & storage platform

Type: grilling
Status: resolved
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/12

## Question

Hono is settled as the framework. What does it run on, and what backs object storage, relational
storage, and the live-progress aggregation layer?

The telemetry model leans hard on **one Durable Object per template** for exact live progress with
cheap batched flushing. That is a Cloudflare-specific primitive, so this decision is load-bearing.

Candidates:

- **Cloudflare Workers + R2 + D1 + Durable Objects** — the model was designed against this. DOs give
  single-threaded per-template consistency for free; R2 fits content-addressed chunks; the whole
  thing is cheap at alliance scale.
- **Node or Bun + S3-compatible + Postgres** — self-hostable anywhere, familiar operationally, but
  the live-counter layer needs replacing (Redis? in-process with sticky routing? advisory locks?).

Sub-questions:

- Is **self-hosting** a requirement? Alliances running their own server is the premise of the whole
  project, and "you must have a Cloudflare account" is a real adoption cost.
- If Workers: do R2, D1, and DO free tiers cover a realistic alliance, and where is the first wall?
- If not Workers: what replaces the DO's exact-live-progress guarantee, and is the fallback
  (accept ~1m staleness everywhere) acceptable?
- Does the answer need to be one platform, or can the storage layer be an interface with two
  implementations without that becoming its own project?

Blocks the chunk-delivery-auth decision, since CDN behaviour differs by platform.

## Answer

**Cloudflare, with narrow seams kept for a later port.**

### Platform

Workers + R2 + D1 + Durable Objects. Cloudflare is accepted as the platform for v1; the
non-Cloudflare implementation is deferred to v2 or later.

- **R2** — content-addressed chunks and the tile store.
- **D1** — all metadata, and **all five decay-ladder tiers plus current status**. D1 is the system
  of record.
- **Durable Objects** — live counters and sub-1m accumulation only. A DO flushes a 1m row to D1 and
  is a **write-absorption buffer, not a store**.

Note on the reasoning: DO transactional storage *is* durable across eviction — eviction drops
in-memory state, not written storage. D1-as-system-of-record was chosen for backup, single-place
cross-template querying, and no fan-out on group rollups, not because DO storage is lossy.

### Portability seams

Three narrow, use-case-shaped interfaces — `putChunk`/`getChunk`, not a generic S3 wrapper:

| Seam | v1 implementation | Later |
|---|---|---|
| Blob store | R2 | S3-compatible |
| SQL store | D1 | Postgres |
| Counter store | Durable Object | counters table (`UPDATE … RETURNING` is equally atomic) |

Both counter implementations are exact, so nothing degrades when ported. **Risk to manage**: with no
second implementation in v1, these interfaces can quietly accrete Cloudflare assumptions. Cheap
guard is in-memory implementations written for tests.

### Free-tier posture

Free-tier viable for small alliances; larger alliances upgrade to Workers Paid ($5/mo).

Verified limits (2026-08-03):

| | Free | Paid (included) |
|---|---|---|
| DO requests | 100k / day | 1M / month |
| DO rows written | 100k / day | 50M / month |
| DO SQLite storage | 5 GB | 5 GB-month |
| D1 rows written | 100k / day | 50M / month |
| D1 rows read | 5M / day | 25B / month |
| D1 storage | 5 GB | 5 GB included |

Durable Objects **are** available on the free plan (SQLite-backed only), so there is no paid
prerequisite to run a server.

Two design constraints follow, and they are good engineering regardless of plan:

- **Never write empty buckets.** A template nobody touched for an hour costs zero rows, not 60.
  This turns the ceiling from "N templates" into "N template-minutes of actual activity".
- **Batch client-side.** DO request count tracks client traffic, not DO count — so one report
  covering many templates, never one report per template.

### DO sharding

Configurable per server instance:

```
shardStrategy: 'single' | 'per-template' | 'dynamic'
```

- **`single`** — default, and the only strategy implemented in v1. One DO for the whole server:
  1,440 rows/day total, trivially free-tier viable, and enough to prototype against.
- **`per-template`** — stubbed, deferred. Maximum write parallelism; ~1,440 rows/day per active
  template.
- **`dynamic`** — stubbed, deferred. Auto-split and merge on live demand. Needs counter-state
  migration, routing that stays consistent mid-move, and a story for reports arriving during a
  split — substantial machinery, wrong phase.

Sharding is the right lever for **rows written**, not for requests. Changing strategy later is a
one-off recount, not a live migration.

### Local development

**`wrangler dev`** (Miniflare) — real R2, D1, and DO emulation, so dev matches production including
the DO alarm semantics the telemetry model depends on. The portable Node path is deferred with the
rest of v2.
