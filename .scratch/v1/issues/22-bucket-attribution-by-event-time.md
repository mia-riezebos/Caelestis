# Bucket attribution by event time, not flush time

Type: grilling
Status: open
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/23

## Question

`TelemetryShard.alarm()` currently assigns flushed counters to the minute bucket **the flush ran in**,
not the minute the paint actually happened. `CounterDelta` carries no timestamp, so the shard has no
other option.

### Why it matters

The alarm is scheduled 60s after the *first* unflushed record, not aligned to minute boundaries. So:

- Activity at `t=100s` (bucket 60) schedules an alarm for `t=160s`.
- The alarm fires and computes `bucketStart = floor(160/60)*60 = 120`.
- That activity lands in bucket **120**, a minute later than it occurred.
- Activity at `t=155s` (genuinely bucket 120) lands in the same bucket — so two events a full minute
  apart are indistinguishable, and one of them is simply in the wrong place.

Up to a full bucket of skew, on a ladder whose finest tier is 1m and whose whole point is 1m
precision. Pace graphs read this directly.

### Shape of the fix

- `CounterDelta` gains the event timestamp (or a precomputed `bucketStart`). The caller — the paint
  event handler — has it; the shard cannot derive it.
- `pending_counters` becomes keyed by `(template_id, bucket_start)` rather than `template_id` alone.
- The alarm flushes only **closed** buckets (`bucket_start + 60 <= now`). A closed bucket cannot
  receive more activity, which makes a single write with replace semantics both correct and
  idempotent — the property `appendBuckets` is specified on.

### The remaining edge case to decide

Late arrivals for an already-flushed bucket. Clients batch, and a report can arrive after its bucket
closed and flushed. Options:

- **Re-flush the full cumulative value** for that bucket — requires the shard to retain flushed
  totals rather than deleting them, so replace semantics stay correct.
- **Fold late arrivals into the current open bucket** — simpler, reintroduces a bounded smear.
- **Drop them past a grace period** — simplest, loses data, but the tile-diff anchor corrects
  template correctness anyway (it cannot correct per-user attribution).

How late can a report legitimately be? That depends on the client batching window, which is not
settled yet.

## Context

Found while reviewing the `#13` backend wiring. The wiring itself is correct and verified; this is a
gap in the `CounterStore` port's design, not in its implementation.
