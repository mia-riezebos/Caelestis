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

- [ ] **Does the Durable Object runtime's own alarm retry pre-empt our explicit backoff?** The
      platform retries a throwing `alarm()` on its own schedule. If it fires before our computed
      deadline, the 1s→60s backoff is decorative. Needs miniflare with real alarm delivery. Also
      tracked on `25-durable-object-test-harness`.
- [ ] **A real alarm firing on wall-clock time.** Every test injects the clock. Record a delta under
      `wrangler dev`, wait ~90s, confirm a D1 row appears with the correct `bucket_start`.
- [ ] **A real D1 outage.** Backoff, retention, and the crash-window trade-off were all validated
      against injected failures only.
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
