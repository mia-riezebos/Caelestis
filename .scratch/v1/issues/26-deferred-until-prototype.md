# Deferred until a running prototype

Type: task
Status: open
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/28

## Question

A standing register of things that **cannot be settled until something actually runs**. Not fog —
each item below is a sharp question with a known method; what is missing is a prototype to point it
at.

Keep this issue open for the life of the v1 map. Add to it whenever a decision gets made on
reasoning that only real behaviour can confirm, and strike items as they are answered. If an item
turns out to need a decision rather than a measurement, promote it to its own ticket.

---

## Backend — telemetry write path

Established across the four-cycle review loop on #26. Every claim below currently rests on injected
clocks and fake storage.

- [x] **Does the Durable Object runtime's own alarm retry pre-empt our explicit backoff?**
      **Answered by the docs, and it found a bug.** Cloudflare retries a throwing `alarm()` with
      exponential backoff "starting at a 2 second delay… with up to 6 retries allowed", and
      recommends catching inside the handler and scheduling a new alarm "if you want to make sure
      your alarm handler will be retried indefinitely". The shard was scheduling **and rethrowing**,
      which capped recovery at six attempts — roughly two minutes of D1 outage — after which
      `flush_batch` stranded until unrelated traffic re-armed the alarm. Now catches, logs, schedules
      and returns, so our backoff is the only retry mechanism and is indefinite.
      <https://developers.cloudflare.com/durable-objects/api/alarms/>
- [x] **A real alarm firing on wall-clock time.** Done under `wrangler dev` with no injected clock:
      recorded 7/5/1 at `t`, pending still 7/5/1 at t+30s, **0/0/0 at t+60s**, and D1 held
      `bucket_start_s = 1785766080` — exactly `floor(1785766127 / 60) * 60`. Bucketed by event time,
      not flush time, confirmed against the real runtime.
- [~] **A real D1 outage.** Partly observed by accident: `wrangler dev` does not apply migrations, so
      the first smoke run had no `telemetry_buckets` table and every flush failed. The shard retried
      quietly with zero errors surfacing and no data loss — the outage path, in the real runtime.
      Still unobserved: a mid-flight D1 failure after the table exists, and recovery across the full
      1s→60s backoff curve.
- [ ] **Whether the transient over-count after a crash is actually visible to a user**, and for how
      long in practice. The D1-first ordering accepts it deliberately; nobody has seen it.

## Backend — capacity

- [ ] **The free-tier ceiling, measured rather than modelled.** `21-capacity-estimates` builds the
      model; only real traffic closes it. The binding constraint is 100k rows written/day on both D1
      and DO.
- [ ] **CPU time to classify a 10k-pixel paint report** against template chunks. A single report can
      carry a full charge drain, and the free plan's CPU ceiling is likelier to bite than any request
      ceiling.
- [ ] **Real tile byte sizes over time**, to size tile-store retention. Observed 70–125 KB once.

## Userscript — rendering

- [ ] **Verified pixel dimensions of a wplace canvas tile.** 1000×1000 is assumed, never measured.
- [ ] **Does the renderer accept an oversized (upscaled) image in place of a tile** without
      misaligning? The whole raster path depends on this, and only Blue Marble's behaviour suggests
      it works.
- [ ] **Does fabricating a 200 for a 404 tile perturb MapLibre or wplace's own logic?** We know
      unpainted tiles are a real 404; we do not know what breaks if we answer one.
- [ ] **Can a userscript reach the MapLibre map instance?** It is bundled, not on `window`, so the
      vector render path may be unreachable in practice regardless of its merits.
- [ ] **How wplace draws its own top-left-triangle mode** — shader, stamp, or mask. Replicating it is
      a stated goal.
- [ ] **Whether a triangle at S=3 looks acceptable.** Six pixels. The tradeoff is named in
      `14-v1-viewing-modes`; nobody has looked at one.
- [ ] **Actual memory cost of the S=3 upscaled tile buffer** in a real session, against the 36 MB
      estimate.

## Userscript — bundle size

- [ ] **What Effect Schema costs the userscript bundle** (`25-effect-schema-for-wire-validation`).
      The bundle is currently ~720 bytes, so anything dominates it. There is a size at which the
      answer changes to server-side-only validation.
- [ ] **What Drizzle costs the Worker bundle** (`24-drizzle-for-schema-and-migrations`).

## wplace behaviour we could not observe

- [ ] **Does wplace ever return 200 with a rejection payload?** Untestable from the client: the submit
      button is disabled when charges are drained, so the request is never made. The `painted` count
      makes it moot for crediting, but it would change error handling.
- [ ] **Does the paint endpoint ever reject a subset and report which?** Only a count was observed.
- [ ] **Season rollover behaviour.** The season is a runtime value in both the tile URL and the paint
      body; nobody has seen one change.
- [ ] **Rate limits on tile fetches** for a client panning aggressively with the shim installed.

## Product questions that need users, not code

- [ ] **Alarm thresholds** (`20-userscript-alarms`) — how many lost pixels over what window is
      griefing rather than noise. Needs real grief data.
- [ ] **Whether repair-vs-fresh classification matches what alliances consider a repair.**
- [ ] **Whether the tile-mirror crowd-sourcing actually achieves useful coverage**, or whether most
      tiles go stale because nobody looks at them.
