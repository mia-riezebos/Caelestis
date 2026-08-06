# Render path: raster intercept vs vector overlay

Type: grilling
Status: open
Blocked by: 10
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/14

## Question

Does v1 composite templates by returning upscaled tiles from the fetch intercept, or by drawing into
a canvas/WebGL overlay above the map?

Position on record going in: **ship raster first**. It is proven (Blue Marble does exactly this), it
is decoupled from wplace's internals, and it cannot break when they ship a frontend update. Vector
is v2.

What `10-recon-map-stack-and-triangle-mode` may change:

- If wplace is **MapLibre** and a custom layer is reachable from a userscript, vector becomes
  dramatically cheaper — per screen pixel rather than per tile pixel, sharper at high zoom, no memory
  ceiling, and shape/size/anchor collapse into fragment-shader math with no stamp atlas and no `S`.
  That may be worth taking in v1 rather than building the raster path twice.
- If it is **Leaflet or hand-rolled**, the transform has to be reimplemented and one-pixel drift is
  constantly visible. Raster wins outright.

Decide also:

- The **zoom threshold** below which shapes are meaningless and a plain downscaled raster takes over.
- Whether both paths ship behind a setting, or whether that is two renderers' worth of maintenance
  for a v1.

## Recon findings — 2026-08-06, live page, Chromium + CDP

Answers the six questions in `handoff-userscript-browser.md`. Scripts in `.scratch/recon/`; probes
were installed with `Page.addScriptToEvaluateOnNewDocument`, which runs in the page's main world
before any page script — the same timing `@run-at document-start` gives.

**The raster intercept works end to end.** With a shim on `window.fetch` that decodes each tile,
draws over it and returns a fresh `Response`, 16 of 16 tiles were rewritten and rendered by wplace
with no errors and nothing else changed. Screenshot: `.scratch/recon/shot-tile-intercept.jpg` — the injected
magenta lands exactly on the tile grid.

| # | question | answer |
|---|---|---|
| 1 | how is a tile requested? | **`fetch`.** 0 XHR. `<img src>` is used only for `data:` URLs and an alliance avatar. A `fetch` shim is sufficient. |
| 2 | exact tile URL | `https://backend.wplace.live/files/s{season}/tiles/{x}/{y}.png`, **season `s0`**. `s1` 404s, so the segment is real and currently 0. |
| 3 | does wplace capture `fetch` early? | **No — we win.** Our shim saw every tile request. `window.fetch` is *not* our function afterwards, so the page does wrap it, but downstream of us: we are still in the chain. |
| 4 | CSP | `content-security-policy-report-only` only — **not enforced** — with `script-src 'unsafe-inline' 'unsafe-eval'`. No obstacle to blob workers or WASM. |
| 5 | is the tile response opaque? | **No.** Every tile carries `access-control-allow-origin: https://wplace.live`. Pixels are readable, so compositing over the real tile is available — we are not forced into draw-only-our-chunks. |
| 6 | what does a missing tile look like? | **Depends where you stand — see below.** The backend 404s; a service worker rewrites that to a 200. |

### Worth knowing beyond the six

- **Tiles are 1000×1000, 8-bit palette PNGs** — the same format `encodeIndexedPng` emits. No format
  negotiation needed between our chunks and theirs.
- Tile responses are `cache-control: s-maxage=5, must-revalidate, no-store`. The browser will not
  cache them, so the shim is hit on every pan — decode cost is per view, not per session, and our own
  chunk cache carries the weight.
- Wplace calls `createImageBitmap` on the tile `Blob`. Returning a `Response` wrapping a re-encoded
  PNG is transparent to that; no need to match byte-for-byte.
- Re-encoding is not free: a 58 KB source tile came back at 206 KB from `OffscreenCanvas`, because
  the canvas emits RGBA rather than palette. Irrelevant to correctness — it never touches the network
  — but it is memory per cached tile, and a reason to prefer our own indexed encoder if we ever
  cache the composited result.

### The one thing this does not prove

CDP's main world is equivalent to **`@grant none`**. Any `@grant` puts the script in the manager's
sandbox, where patching `window.fetch` may not be visible to the page at all. This recon therefore
proves the *page-context* path and says nothing about the sandboxed one. Build for `@grant none`, and
if token storage needs `GM_getValue`, verify the sandboxed path separately before depending on it —
see the note at the end of `handoff-userscript-browser.md`.

### Correction, and the reason for it: wplace runs a service worker

An earlier version of this write-up said `06-recon-tile-serving`'s "in-range unpainted tiles are 200
with a near-empty PNG" was not reproduced. That was wrong — it was bad sampling. The tiles used were
painted, and the out-of-range probes went straight to the origin, bypassing the layer that makes the
claim true.

`https://wplace.live/service-worker.js` intercepts tile requests. Measured, same three tiles, same
session, with `Network.setBypassServiceWorker` as the only difference:

| tile | service worker active | service worker bypassed |
|---|---|---|
| painted (`325/1782`) | 200, 58,252 b | 200, 58,252 b |
| empty in-range (`1015/1816`) | **200, 73 b** | **404**, 548 b HTML |
| out of range (`2048/1782`) | **200, 73 b** | **404**, 548 b HTML |

So the origin 404s for *any* tile it holds no data for, and does not distinguish "in range but
unpainted" from "not a tile". The service worker collapses both into a 73-byte blank PNG. What
`06-recon-tile-serving` recorded is what the page sees, and it is correct at that layer.

**The consequence for our shim, which is what matters.** A `window.fetch` shim sits *above* the
service worker, so what it observes depends on whether the page is SW-controlled at that moment —
and on a first visit or a hard reload it is not:

- **SW-controlled** — we see `200` with a 73-byte blank PNG. Status tells us nothing.
- **Not SW-controlled** — we see the real `404`.

Both mean the same thing: wplace holds nothing for this tile. The shim must treat them identically
and **must not read `response.ok` as "there is a tile here"**. Detect empty by content, and handle
404 as an ordinary, expected outcome rather than an error path. Getting this wrong makes the
behaviour depend on whether the user has visited before, which is about the worst possible shape for
a bug.
