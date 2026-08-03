# Bucket attribution by event time, not flush time

Type: grilling
Status: resolved
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

## Answer

**Bucket by event time, flush only closed buckets after a grace period, and re-flush the full total
when a late arrival lands in a bucket already written.**

### Client batching: ~10 seconds

Corrects the volume model this ticket was reasoning with. A drain is **one or a few very large
requests** — the full 10k charges at once, or split into 2–5k jobs — followed by a short geometric
tail as 10% cashback is spent down (1000, 100, 10, 1). Not a thousand small requests.

So DO **request count is not a binding constraint**; a 10s window mostly just collapses the cashback
tail. What it does move pressure onto: a single report can carry **10k pixels**, roughly 100–150 KB
of JSON, every pixel of which the server classifies against template chunks. On the free plan that
meets the CPU-time ceiling long before any request ceiling. Recorded on `21-capacity-estimates`.

### Mechanism

1. **`CounterDelta` carries `occurredAt`.** The shard cannot derive it; the paint handler has it.
2. **`pending_counters` is keyed by `(template_id, bucket_start)`**, floored from `occurredAt`.
3. **The alarm flushes only buckets closed longer than a grace period** —
   `bucket_start + 60 + GRACE <= now`, `GRACE = 30s`. A closed-and-graced bucket cannot normally
   receive more activity, so a single write with replace semantics is both correct and idempotent,
   which is the property `appendBuckets` is specified on.
4. **Flushed buckets are retained, not deleted**, with their totals, for one hour. A late arrival for
   a retained bucket adds to that total and rewrites the D1 row with the new cumulative value —
   correct attribution at the true event time, replace semantics still valid.
5. **Past the retention window, late arrivals are dropped.** Unbounded retention is not an option and
   an hour is far beyond any legitimate lateness. This case should be counted, not silent.

### Consequence for `readPending`

It must sum **only unflushed** buckets. Retained flushed buckets are already in D1, and including
them would double-count against `live total = history + pending`.

### Alarm scheduling

Must be set for when the next pending bucket becomes flushable, not a blind +60s — otherwise a
bucket can sit past its grace period waiting for unrelated activity to trigger an alarm.
