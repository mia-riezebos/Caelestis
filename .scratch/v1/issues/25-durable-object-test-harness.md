# Durable Object test harness

Type: task
Status: open
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/27

## Question

`TelemetryShard` has **no tests**. Every claim about it rests on `MemoryCounterStore`, its in-memory
twin, plus throwaway harnesses that reviewers built under `/tmp` and deleted.

That gap was named independently by four reviewers across the #26 review loop, and it is not
theoretical — the loop found a case where the two implementations genuinely diverged (chunk selection
order: `ORDER BY template_id, bucket_start` versus Map insertion order), which the suite could not
have caught. Acceptance criterion 8 says the in-memory store implements the same semantics as the
Durable Object; today nothing enforces that.

The reviewers' harnesses were also more capable than the checked-in suite: they ran the real
`TelemetryShard` against a `node:sqlite` fake of `DurableObjectState` with real
`sql.exec`/`transactionSync`/alarm semantics, modelled cold starts by reconstructing the shard over
the same SQLite file, and injected D1 failures at every flush point. All of that was thrown away.

## To decide and build

- **`@cloudflare/vitest-pool-workers`**, which runs tests inside workerd with real Durable Object
  and D1 bindings, or a lighter `node:sqlite` fake of `DurableObjectState` like the reviewers used?
  The former is real; the latter is fast and has no workerd dependency in CI.
- **A differential test** that drives both implementations through the same operation sequence and
  asserts identical observable state — `readPending`, `readDroppedLateCount`, alarm time, flushed
  totals. This is the direct enforcement of criterion 8, and it would have caught the chunk-order
  divergence immediately.
- **Property tests worth keeping**, ported from what the reviewers ran: `history + pending ==
  accepted` after drain; `history + pending` never *exceeds* accepted at any intermediate step;
  "outstanding rows implies an alarm is scheduled"; crash injection at both flush points with cold
  restart over the same storage.
- Whether these run on every commit or only on a slower CI job.

## One thing only a real runtime can settle

The Durable Object runtime retries a throwing `alarm()` on its own schedule, which **may pre-empt the
explicit backoff** added in #26. No reviewer could verify this — it needs miniflare with real alarm
delivery. If the platform's retry does pre-empt ours, the backoff is decorative and the interaction
needs rethinking.
