# Capacity estimates & free-tier ceiling

Type: task
Status: open
Blocked by: 17
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
