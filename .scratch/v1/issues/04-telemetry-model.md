# Telemetry model

Type: grilling
Status: resolved
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/5

## Question

Where does progress and contribution data come from, how is it aggregated, and how is "exact live
progress" reconciled with cheap batched flushing?

## Answer

### Two sources, each authoritative for what it actually knows

| Source | Authoritative for | Blind to |
|---|---|---|
| **POST intercept** (200 responses only) | Who painted what, exactly when. Every event, zero extra requests. | Anyone not running the userscript — griefers, randoms, allies on mobile. |
| **GET tile diff** | Current true state of the canvas. | Tiles nobody happens to be looking at. |

POST alone is a monotonic "we painted N" counter that silently diverges from "N are currently
correct" — grief would be invisible. GET alone is sampled and depends on someone looking.

**Snapshots anchor, events interpolate.** A tile-diff snapshot sets an absolute anchor at time T;
POST events interpolate forward at minute resolution; the next anchor re-baselines and discards the
interpolation. High resolution without constant polling, self-correcting whenever anyone looks.

### Drift = free grief detection

Store both `derived` (anchor + events since) and `observed` (latest snapshot) per tile. The gap is
activity you did not cause:

- `observed < derived` → your work is being overwritten
- `observed > derived` → someone outside the alliance is filling it in

Alert on the first. Costs nothing extra.

### Live vs flushed — they do not conflict

**Durable Object memory is live truth; the SQL store is history.** The flush interval delays
durability of the time series, not visibility.

- Event arrives → DO updates in-memory counters → exact and immediately readable
- DO alarm every 1m → append one time-series row per template
- Live progress reads hit the DO (sub-ms, current); historical graphs read the SQL store

Two constraints:

- **Persist counters to DO transactional storage**, not just memory — DOs get evicted. Rehydrate on
  wake. The SQL store only ever receives time-series rows.
- **One DO per template, not per server**, or 1000-user alliances serialise on a single object. Live
  per-template progress is then exact; live *group* totals either fan out across template DOs (fine
  under ~100) or read cached node rollups and lag up to 1m. Surface which number is which.

### Volume: never store per-pixel events

Paint bursts are large — charge caps are unbounded (10k+ observed), and a single request can carry
thousands of pixels. 1000 users × 10k pixels would be 10M rows from one wave.

The paint POST is already scoped to one tile, so the client groups by template before sending:

```
wire:   { username, tile, pixels: [{x, y, color}], ts }
stored: events: (username, template_id, minute) → placed, correct, repairs
```

A 10k-pixel paint becomes 1–3 rows.

**Send raw coords; let the server classify.** The server holds the template chunks, so on-template /
wrong-colour classification needs no trust in the client. Keep coords ~24h for the damage view, then
drop them. (Repair-vs-fresh classification is unresolved — see the map's Not yet specified.)

**Only credit HTTP 200.** Failed paints — out of charges, rate limited — must not inflate anyone.
Check the response body too, in case wplace returns 200 with a rejection payload.

**Idempotency**: client-generated `event_id` so retries never double-count. POST events have exactly
one reporter each, so unlike snapshots they need no cross-client dedup.

### Rollups

- Group % is **pixel-weighted**: `sum(correct) / sum(total)`. Show the unweighted count alongside —
  "94% by pixels · 3 of 7 complete" — they answer different questions.
- **Forbid overlapping templates within a group** at upload, so sums cannot double-count.
- Cache `correct / total / drift / updated_at` on the node row; recompute on flush.
- **Store per tile, never per template.** A client reports only what it is looking at, so template
  totals must be assembled from the newest snapshot of *each* tile independently — otherwise partial
  coverage reads as a progress crash.
- A wplace 404 on a never-painted tile is valid data: **all blank**, not "no reading."

### Time series: exponential decay ladder

| Resolution | Retention | Points |
|---|---|---|
| 1m | 6h | 360 |
| 5m | 24h | 288 |
| 15m | 7d | 672 |
| 1h | 30d | 720 |
| 6h | forever | ~1460/yr |

~2k rows per template steady-state.

**Fold functions differ by column type — getting this backwards shows 500% completion:**

- `correct / wrong / blank` are **state** → fold by taking the **latest** value
- `placed / repairs / pace` are **deltas** → fold by **sum**

Compaction cascades on a timer: a 1m bucket ageing past 6h folds into 5m and the originals are
deleted, and so upward.

**Query side**: the client sends a time window and the server picks the coarsest tier yielding ≥~200
points. The client never knows the ladder exists.

### Pace, derived not stored

Store one delta series; derive every rolling window client-side:

```
pace_W(t) = (cum(t) − cum(t − W)) / W
```

Windows 30m / 1h / 2h / 3h / 6h / 12h / 1d, individually toggleable. One fetch covers all of them
and adding a window later costs nothing.

- **Window size is an ordered dimension, not categorical** — one hue, light→dark, thin→thick. Seven
  distinct hues would be wrong.
- **Show window W only if W ≥ 2× the active tier's resolution.** Grey out the rest in the legend
  rather than hiding them, or people think they are broken.
- Default two lines on (1h and 6h). Seven at once is noise.
- **Clip the leading edge** where the window is not fully covered — `pace_1d` on a 6h-old template
  reads artificially low otherwise.

## Amendment — 2026-08-03: the client keeps no tile history

Supersedes the client-side diffing described above.

**Tile history lives on the server, not in the userscript.** The client keeps at most an in-session
cache of the tile it is currently displaying; it never retains previous versions and never computes
diffs.

Revised split:

- **Client**: fetch tile → composite for display → offer `{tile, sha256, ts}` to the server → upload
  only if asked. Report paint events as before.
- **Server**: holds the tile timeline, so it computes the diffs, the progress anchors, attribution,
  and **repair-vs-fresh classification** — the last of which was previously unresolved precisely
  because nobody held pre-paint state.

Consequences:

- The "snapshots anchor, events interpolate" model is unchanged; only *who computes the anchor*
  moves. The server derives anchors from its own tile timeline instead of receiving counts.
- The client no longer needs to classify anything. It sends raw painted pixels and a username; the
  server decides on-template / wrong-colour / repair against data it holds itself. Strictly less
  trust in the client than before.
- Crowd-sourced tile mirroring moves **into** v1 scope — see
  `17-server-tile-store`. Timelapse *rendering* stays with the deferred frontend; v1 captures the
  frames.
- New cost to bound: tiles are 70–125 KB and served `no-store`, so upload offers need throttling.

## Amendment — 2026-08-03: the real paint request breaks two assumptions

Observed shape is recorded in `07-recon-paint-request`. Two things the model got wrong:

### 1. A paint request spans multiple tiles

The wire format assumed "the paint POST is already scoped to one tile, so the client groups by
template before sending". The real body carries a `tiles` array, each with its own coordinate
arrays. Revised:

```
wire: {
  eventId, username, season, ts,
  tiles: [{ x, y, pixels: { x: [], y: [], colors: [] } }],
  submitted: number,   // total pixels across all tiles
  painted: number      // what wplace reported accepting
}
```

The client no longer groups by template at all — it forwards the tile structure as observed and the
server maps pixels to templates. Less client logic, less client trust, and it stops the client
needing to know which templates cover which tiles just to file a report.

Storage is unchanged: aggregate to `(username, template_id, minute) → placed, correct, repairs` on
receipt. A 10k-pixel paint is still a handful of rows.

### 2. Acceptance is a count, not per-pixel

wplace answers `{"painted": 5}`. So partial acceptance is detectable but not attributable — there is
no way to learn *which* pixels landed.

Crediting rule:

- **`painted === submitted`** — the normal case. Classify and credit as designed.
- **`painted < submitted`** — credit the user `painted` toward their **placed** total, since that
  figure is still exact, but **do not credit template-level `correct` or `repairs`**. Mark the event
  partial and let the next tile-diff anchor establish template correctness from ground truth.

This keeps per-user contribution exact and per-template correctness honest, at the cost of a short
window where a partial paint is invisible in template progress. The anchor mechanism exists for
precisely this.

### 3. Pixel-info is narrower than hoped

It returns no timestamp and no colour. So it cannot date a change and cannot verify canvas state,
and general attribution by polling is off the table.

Its actual role: **identifying who overwrote our work**. Our own members' contributions arrive via
paint interception with exact who and when; pixel-info answers the one question that data cannot —
who made a change we did not make. That is grief attribution, and it only needs to run on pixels the
server's own tile history already shows changing.

### 4. Never forward `x-pawtect-token`

wplace's anti-cheat header. We neither replicate nor circumvent it — it simply must never reach our
server, under the same rule as cookies and session state.

## Amendment — 2026-08-03: pixel-info is dropped entirely

Attribution comes from **self-reported paints only**. Progress comes from **comparing current tiles
against past tiles**. Pixel-info is not used anywhere in the design.

**Why:** it answers one pixel per request. Verifying a template of any size means a request per
pixel — a single tile is a million — which hits rate limits immediately and would make this project
a bad neighbour on wplace's infrastructure. Whatever the endpoint could tell us is not worth that.

### What changes

- **Grief detection stays; grief attribution goes.** Drift between derived and observed still fires
  an alarm — *that* there is griefing is the useful signal. *Who* is doing it is left to members to
  work out themselves, with the userscript pointing them at the affected area.
- **Non-member contributions become anonymous but still visible.** If `observed > derived`, someone
  outside the alliance is helping; we count the pixels without knowing whose they are. That is fine.
- The whole rate-limiting and courtesy concern around polling wplace disappears. The only requests
  we make to wplace are the ones the user's own browser was making anyway.

### What survives unchanged

Paint interception gives exact who, what, and when for every member running the userscript — which
is the entire leaderboard. Tile diffs give ground truth for progress. Neither needed pixel-info; it
was only ever going to add attribution for changes we did not make.
