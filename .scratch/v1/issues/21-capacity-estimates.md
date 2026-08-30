# Capacity estimates & free-tier ceiling

Type: task
Status: in progress
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/22

## Question

How large an alliance actually fits on the Cloudflare free tier, and where is the first wall?

The runtime decision commits to "free-tier viable for small alliances", which is only honest if the
number is measured rather than asserted. Produce a model, then check it against real traffic once
something runs.

Verified plan limits are recorded in `11-runtime-and-storage-platform`. The binding one is **100k
rows written/day** on both D1 and DO, and **100k DO requests/day**.

### Model to build

Inputs: active users, templates, tiles covered, paint rate per user, pan/fetch rate per user.

Outputs, per day:

- **D1 rows written** — 1m telemetry rows (only for buckets with activity), paint-event aggregate
  rows `(username, template, minute)`, tile-history rows, compaction writes.
- **DO requests** — paint reports and tile offers, after client-side batching.
- **R2 storage and Class A/B operations** — chunks are tiny and static; the tile store is the real
  consumer at 70–125 KB per distinct tile version.
- **D1 storage** — ~2k time-series rows per template steady-state, plus tile history rows.

### Questions the model must answer

- With `shardStrategy: 'single'`, how many active users before 100k DO requests/day is hit? This is
  probably the first wall, since it scales with people rather than templates.
- How much does client-side batching actually buy — what batch window turns a 100-user alliance from
  over-budget to under?
- What does the tile store cost per day for an alliance covering N tiles, at the observed 70–125 KB
  and whatever retention `17-server-tile-store` settles on?
- At what point does `per-template` sharding become necessary rather than merely faster?

### Then verify

Instrument a running server and compare against the model. An estimate nobody checked is worth
about as much as a guess.

Output: a short table in the README — "roughly N users and M templates fit free; beyond that,
Workers Paid" — plus whatever the model reveals about which knob to turn first.

## Acceptance criteria

- [ ] A tested model accepts active users, templates, covered tiles, paint traffic, tile-fetch
      traffic, active time, batching, tile size, and tile-change rate.
- [ ] The model reports daily Worker and Durable Object requests, D1 logical writes, D1 retained
      rows, and R2 operations and storage growth.
- [ ] The model reflects the current telemetry route, single-shard counter store, decay ladders,
      250 ms tile-offer batching, and lack of physical tile-blob GC.
- [ ] A repeatable read-only command compares a production window with the corresponding model
      inputs and Cloudflare usage metrics.
- [ ] The README gives one measured free-tier scenario, the first limit it reaches, and the first
      knob to turn.

## TODOs

- [x] Reconcile the capacity contract with the current telemetry pipeline and Cloudflare limits.
- [x] Implement and test the capacity model for Workers, Durable Objects, D1, and R2.
- [ ] Add a repeatable live measurement command and compare a production window with the model.
- [ ] Document the measured ceiling and first knob in the README, then run repository validation.

## Notes

- Issue #17 closed on 2026-08-30, and its real Berrycamp fixture corpus is present on `main`.
- Cloudflare's current Workers Free limits include 100,000 Worker requests/day. Durable Objects
  include 100,000 requests/day and no longer list a separate row-write allowance. D1 still includes
  100,000 rows written/day. R2 includes 10 GB-month, 1 million Class A operations/month, and
  10 million Class B operations/month.
- Current code sends one Durable Object RPC per accepted paint report plus alarm invocations. Tile
  offers do not call the Durable Object. The userscript batches tile offers for 250 ms and sends
  paint reports individually.
- SQL tile-history rows compact, but R2 tile blobs are not physically collected. The model must
  therefore report cumulative blob growth rather than implying that SQL retention frees R2 space.
- `per-template` sharding cannot extend the free request quota. It becomes relevant only if a paid
  deployment measures single-shard latency or overload before its account quotas.
- The model uses Poisson occupancy for active time buckets and fixed-window request batching. It
  reports logical D1 mutations and a conservative table-plus-index ceiling, including the full
  lifetime cost of each decay-ladder row. Live analytics supplies the actual billed count.
- Focused validation: `pnpm --dir apps/backend exec vitest run src/capacity/model.test.ts` passed 7
  tests; backend, shared, and userscript type checks passed after building workspace outputs.
- Limit sources, checked 2026-08-30:
  - https://developers.cloudflare.com/workers/platform/limits/
  - https://developers.cloudflare.com/durable-objects/platform/pricing/
  - https://developers.cloudflare.com/d1/platform/pricing/
  - https://developers.cloudflare.com/r2/pricing/
