# Server-side tile store & mirroring protocol

Type: grilling
Status: open
Blocked by: 11
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/18

## Question

The server — not the userscript — holds tile history. How do tiles get there, how are they stored,
and what does that let the server compute that the client no longer has to?

This moves crowd-sourced tile mirroring **into** v1 scope (it was previously deferred with the web
frontend). The frontend still owns *rendering* timelapses; v1 owns *capturing* the data.

### Why the split changed

The client keeps no tile history — at most an in-session cache of what it is currently displaying.
Everything historical lives server-side. That makes the client dramatically simpler: fetch tile →
composite for display → offer it to the server → done. No client-side diffing, no previous-tile
bookkeeping.

It also **resolves repair-vs-fresh classification**: the server has the pre-paint tile state, so it
can classify a paint event without trusting anything the client says about prior canvas state.

### To decide

- **Offer protocol.** Hash-first: the client sends `{tile, sha256, ts}` and the server replies with
  which tiles it actually wants, so unchanged tiles cost one small field on a request that is
  already happening. Confirm this shape and where it piggybacks.
- **Upload cost.** Tiles are 70–125 KB and served `no-store`, so a user panning around re-fetches
  constantly. Needs throttling: skip offers for hashes already offered this session, and rate-limit
  per client. What are the actual limits?
- **Storage layout.** Content-addressed `tiles/{sha256}.png` plus a `tile_history(tile, ts, hash,
  reporter)` timeline — same scheme as chunks, so unchanged tiles cost nothing and dedup is
  automatic.
- **Retention.** Every distinct hash for N days, then thin to daily keyframes? Sized against the
  real 70–125 KB figure and the tile count an alliance actually covers.
- **Trust.** A client can fabricate a tile. Quorum (prefer a hash reported by ≥2 distinct users,
  mark single-reporter tiles unconfirmed), plus the server fetching directly from wplace for
  spot-checks and for tiles nobody visits. Crowd-source the bulk, server-fetch the gaps.
- **Staleness honesty.** Tiles nobody visits go stale, and a stale mirror reads as current truth.
  Where does `last seen` surface?
- **Courtesy.** Identifying User-Agent on direct server fetches, trivial rate, scoped strictly to
  tiles our templates touch.
