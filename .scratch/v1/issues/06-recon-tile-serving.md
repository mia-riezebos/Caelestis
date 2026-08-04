# Recon: wplace tile serving

Type: research
Status: open
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/7

## Question

How exactly does wplace serve canvas tiles, and what happens for tiles that have never been painted?

Specifically:

- Tile URL scheme and host (confirm the `/files/sN/tiles/{x}/{y}.png` shape and which `sN`).
- Image format, dimensions, and typical byte size.
- Cache headers — are tiles CDN-cached, and with what TTL?
- **Empty tiles**: a real 404, or a 200 with a blank/placeholder body? This decides whether the shim
  branches on status or on content.
- Does anything else on the page depend on that 404 (e.g. wplace treating a region as empty)?
- Which transport does the tile request use — `fetch`, `XMLHttpRequest`, or an `<img>` element?
  Determines what the shim has to wrap.
- Does the renderer accept an oversized (upscaled) image in place of a tile without misaligning?

## Findings (partial — 2026-08-03, AFK bundle + live probe)

Confirmed from the SvelteKit bundle and direct requests:

- **Tile URL**: `https://backend.wplace.live/files/s{season}/tiles/{x}/{y}.png`.
  In the bundle as `` `${PP}/s${PT}/tiles/{x}/{y}.png` `` with `PP = "https://backend.wplace.live/files"`.
  Season is a runtime variable (`Math.trunc(t.season)`), currently **s0** — the shim must read it
  rather than hardcode it, since a season rollover would silently break every match.
- **Format / size**: `image/png`, ~70–125 KB per populated tile (0/0 → 70 KB, 1082/667 → 122 KB).
- **Empty tiles are a real HTTP 404** with a 146-byte `text/html` body. So the shim branches on
  **status**, not content. Resolves the open question and unblocks the empty-tile fog.
- **Caching**: `s-maxage=5, must-revalidate, no-store`, behind Cloudflare, with `ETag` and
  `Last-Modified` present. `no-store` means the browser will not retain tiles — **the userscript's
  own previous-tile cache is mandatory** for diffing; there is no browser cache to lean on.
- Edge revalidation every 5s means tile data is near-live, so diff-driven telemetry is viable.

Still open:

- Actual pixel dimensions of a tile (assumed 1000×1000, not yet verified).
- Which transport MapLibre uses for raster tiles — `fetch` vs `<img>`/`ImageRequest`. Decides the
  shim. Needs a browser observation.
- Whether the renderer accepts an oversized image in place of a tile without misaligning.

## Update — 2026-08-03: transport confirmed

Canvas tiles are fetched via **`fetch`** (DevTools Type column, initiator the SvelteKit bundle), so
wrapping `window.fetch` at `document-start` covers both tile reads and paint writes with one shim.
The only `xhr` in the session came from an unrelated third-party script.

Also visible: the basemap is MapLibre vector tiles (`.pbf`) from a separate host, entirely distinct
from the canvas raster tiles. The shim must not touch those.

Remaining open: verified pixel dimensions of a tile, and whether the renderer accepts an oversized
image without misaligning.

## Correction — 2026-08-03: unpainted tiles are 200, not 404

The earlier finding was **wrong**, and the error is instructive: the probe used tile `2200/1400`,
which is off the map entirely.

The canvas is **Web Mercator at zoom 11 — 2048 × 2048 tiles of 1000 px, world = 2,048,000 px**.
Derived from the `bounds` in a native `.wplace` file: image width ÷ longitude span and height ÷
latitude span both give 2,048,000.0 exactly, i.e. `2^11` tiles. Confirmed against a real file whose
computed position, tile (325, 1781), matches the tiles observed in a live session.

Re-probed:

| tile | status | bytes |
|---|---|---|
| `227/1024` (mid-Pacific) | **200** | 392 |
| `300/1024` | 200 | 7,644 |
| `325/1781` | 200 | 6,686 |
| `2047/2047` | 200 | 26,134 |
| `2048/1000` (out of range) | **404** | 146 |

So an unpainted but in-range tile returns a normal 200 with a tiny, essentially transparent PNG. A
404 means the coordinate does not exist.

### Consequences

- **The shim does not need an empty-tile branch.** Every tile a template can legitimately cover
  returns 200, so there is no synthesis path and nothing to fabricate. Simpler and less risky than
  the design assumed.
- **Telemetry loses a special case**: a blank tile is ordinary data arriving normally.
- **Tile coordinates are bounded 0..2047**, which is a cheap validation both sides can apply.
- A 404 now means a genuine bug — a template placed outside the canvas — rather than a normal state.
