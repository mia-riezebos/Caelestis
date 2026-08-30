# Capacity estimates & free-tier ceiling

Type: task
Status: resolved
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/22

## Question

How large an alliance actually fits on the Cloudflare free tier, and where is the first wall?

The runtime decision commits to "free-tier viable for small alliances", which is only honest if the
number is measured rather than asserted. Produce a model, then check it against real traffic once
something runs.

The original plan limits drifted after the platform and implementation changed. The current model
uses the limits verified in the Cloudflare documentation and calibrates query costs against D1
Insights rather than assuming that request count is a proxy for database work.

### Model to build

Inputs: active users, templates, tiles covered, paint rate per user, pan/fetch rate per user.

Outputs, per day:

- **D1 rows read and written** — status-query scans, 1m telemetry rows (only for buckets with
  activity), paint-event aggregate rows `(username, template, minute)`, tile-history rows, and
  compaction writes.
- **DO requests** — paint reports and alarm invocations. Tile offers no longer touch the Durable
  Object.
- **R2 storage and Class A/B operations** — chunks are tiny and static; the tile store is the real
  consumer at 70–125 KB per distinct tile version.
- **D1 storage** — ~2k time-series rows per template steady-state, plus tile history rows.

### Questions the model must answer

- With `shardStrategy: 'single'`, how many active users fit before a current free-tier quota is hit?
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

- [x] A tested model accepts active users, templates, covered tiles, paint traffic, tile-fetch
      traffic, active time, batching, tile size, and tile-change rate.
- [x] The model reports daily Worker and Durable Object requests, D1 reads and logical writes, D1
      retained rows, and R2 operations and storage growth.
- [x] The model reflects the current telemetry route, single-shard counter store, decay ladders,
      250 ms tile-offer batching, and lack of physical tile-blob GC.
- [x] A repeatable read-only command compares a production window with the corresponding model
      inputs and Cloudflare usage metrics.
- [x] The README gives one measured free-tier scenario, the first limit it reaches, and the first
      knob to turn.

## TODOs

- [x] Reconcile the capacity contract with the current telemetry pipeline and Cloudflare limits.
- [x] Implement and test the capacity model for Workers, Durable Objects, D1, and R2.
- [x] Add a repeatable live measurement command and compare a production window with the model.
- [x] Document the measured ceiling and first knob in the README, then run repository validation.

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
- Status traffic is split into periodic, post-offer, and lifecycle refreshes in the forward model.
  D1 Insights does not retain the HTTP request ids needed to measure historical offer batches, so
  observation keeps all measured status calls as a periodic-equivalent backfit rather than
  subtracting tile rows as though every row were a batch. It explicitly marks the resulting
  workload rates unsafe to scale. `CAELESTIS_ACTIVE_USER_HOURS` supplies the independent signal
  needed to make them scalable; status-only clients remain included either way.
- Paint reads scale per paint report. Offer and upload reads stay together as one calibrated cost
  per accepted client tile observation, which reproduces the measured baseline despite multi-tile
  batches and partial uploads. Only unclassified dashboard, manifest, and other reads remain a fixed
  optional residual. Persistent schema rows are included independently of telemetry retention.
- Focused validation: `pnpm --dir apps/backend exec vitest run src/capacity/model.test.ts` passed 9
  tests and `pnpm test:capacity` passed 12 tests. Backend, shared, and userscript type checks passed
  after building workspace outputs.
- `pnpm capacity:observe` uses read-only D1 SQL, D1 Insights, and Cloudflare GraphQL analytics. Its
  2026-08-30 production window measured 20,779 Worker requests, 58 Durable Object invocations,
  7,319,387 D1 rows read, 14,719 D1 rows written, 136 R2 Class A operations, 15,474 R2 Class B
  operations, and 71.4 MB of R2 payload storage.
- The recorded snapshot's D1 Insights rows remain the calibration source. Its aggregate tile unit
  preserves measured tile reads, but the status-equivalent clock is only a baseline backfit until an
  independent active-user-hours total is supplied. The command exposes that distinction instead of
  publishing the depressed per-hour workload rates as a bound. Residual Worker and R2 read traffic
  still comes from manifest, dashboard, and other paths outside the telemetry model.
- D1 reads are the first wall: D1 Insights measured 7,027,389 rows, or 141% of the 5 million rows
  read/day Free allowance. The 8,378 status calls scanned about 520 rows each and accounted for
  4,356,332 of those rows. Paint batching cannot reduce that fixed query traffic.
- The original scaled README scenarios omitted workload-dependent reads, and status-triggered calls
  mean the captured window cannot produce a finite upper rate without independent active time. The
  README therefore publishes periodic-status impossibility bounds: at most 10 eight-hour users for
  the 90-template query shape and at most 89 for the 10-template shape. Real paint and tile work
  only lowers those counts. A fresh `capacity:observe` run with independently measured user-hours
  can publish a narrower workload estimate; the local Cloudflare identity could not refresh the
  historical snapshot (`7403`).
- R2 storage observations now deduplicate by content hash, and missing GraphQL metrics stay null
  rather than becoming false zeroes.
- Limit sources, checked 2026-08-30:
  - https://developers.cloudflare.com/workers/platform/limits/
  - https://developers.cloudflare.com/durable-objects/platform/pricing/
  - https://developers.cloudflare.com/d1/platform/pricing/
  - https://developers.cloudflare.com/d1/observability/metrics-analytics/
  - https://developers.cloudflare.com/r2/pricing/
- Final validation passed: `pnpm lint`, `pnpm check`, `pnpm test`, `pnpm build`, and
  `git diff --check`.
