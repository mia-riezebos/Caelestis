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

## How BlueMarble and SkirkMarble actually do it — read, not assumed

Both were cloned and read at `1f0…`/HEAD on 2026-08-06. **SkirkMarble is a fork of BlueMarble** —
same injected bridge, same message `source: 'blue-marble-canvas-change'`, same
`resolve(new Response(blobProcessed, …))`. Architecturally there is one design here, not two.

**They rewrite the tile. Neither draws a canvas over the map.** The chain, in BlueMarble's
`src/main.js`:

1. The script runs in the manager's sandbox (`@grant GM_getValue`, `GM_addStyle`, `GM.setValue`, …).
2. It `inject()`s a `<script>` element into the page so it can patch `window.fetch` in page context —
   the sandbox cannot do that directly.
3. The page-context patch clones every response. JSON goes to the sandbox as data. Anything
   `image/*` that is not the basemap is held: it generates a UUID, parks a resolver in a
   `fetchedBlobQueue`, and `postMessage`s the blob out.
4. The sandbox composites templates into the blob and posts it back.
5. The parked resolver returns `new Response(blobProcessed, { headers, status, statusText })`.

**This is worth knowing for us: `@grant` is not a fork in the road.** The earlier note here said
recon proved only the `@grant none` path. BlueMarble shows the sandboxed path works too, via the
injected-`<script>` bridge — at the cost of a `postMessage` round trip per tile, with the blob
crossing the boundary twice.

### Why it gets slow, which is the reason not to copy it

`templateManager.js` sets `drawMult = 3` — every template pixel is drawn as a dot inside a 3×3 cell,
so the template reads as sparse dots over wplace's real pixels rather than hiding them. That is a
neat trick for visibility without occlusion, and it is what makes it expensive:

- `drawSize = tileSize * drawMult` = **3000×3000**, so an `OffscreenCanvas` of 9 M pixels per tile.
- `context.getImageData(0, 0, drawSize, drawSize)` materialises **36 MB per tile** as an RGBA array.
- That is per tile, per pan — a dozen visible tiles is on the order of half a gigabyte of pixel work
  per view change, before any template compositing happens.
- Every template covering a tile is composited into that same canvas, so cost grows with template
  count as well as with view area.

Neither project has any cache invalidation tied to a filter change — no `reload`, no `refreshTile`,
no invalidate hook in `WindowFilter.js` or `templateManager.js`. Changing a colour filter therefore
does not repaint what is on screen; the user has to pan or zoom to make MapLibre re-request tiles.
That is the concrete cost of putting our pixels inside wplace's, and it is the argument for keeping
them in a layer of our own.

### What this means for our design

The interception stays, but as a **tap**, not a rewrite:

- strip the coordinates → know which tiles are in view
- keep wplace's actual pixels → offer to the server (ticket 17), and diff against the template for
  progress
- **return the response untouched**

Rendering goes on our own layer, so a per-colour toggle or a view-mode change is a redraw of our
layer alone: no re-fetch, no re-decode, no interaction with MapLibre's tile cache, and cost
proportional to what is on screen rather than to tile area × template count.

The open question is not whether to do this but how to reach the map — see the three routes in
`10-recon-map-stack-and-triangle-mode`.

## Alignment is solved: MapLibre tells us exactly where every tile is drawn

The overlay does not need the `Map` instance, and it does not need the URL (which does not update
during cursor interaction anyway). The transform is readable straight off the GL context.

**The key that unlocked it:** `gl.getUniformLocation(program, name)` takes the uniform's name as a
*string*. Hooking it builds a `WebGLUniformLocation → name` map, after which `uniformMatrix4fv` stops
being an anonymous blob of 16 floats. The uniforms MapLibre uploads are:

| uniform | uploads per load |
|---|---|
| `u_projection_matrix` | 20,304 |
| `u_label_plane_matrix` | 133 |
| `u_coord_matrix` | 133 |

**The method**, all of it installable from `document-start`:

1. Patch `HTMLCanvasElement.prototype.getContext` to wrap the WebGL2 context before MapLibre gets
   it — proved working.
2. Patch `getUniformLocation` to learn which location is `u_projection_matrix`.
3. Patch `uniformMatrix4fv` to keep the current value of that uniform.
4. Patch `texImage2D` to note which textures are 1000×1000 — those are wplace's tiles, and nothing
   else on the map is that size.
5. Patch `drawArrays`/`drawElements`; when the bound texture is one of those, the live
   `u_projection_matrix` is that tile's transform.

Transforming tile-local `(0,0)` and `(8192, 8192)` — MapLibre's tile extent, not our 1000 — through
that matrix gives the tile's screen rectangle in CSS pixels. Measured on a 1200×800 canvas at
zoom 11:

```
tile A   top-left (664, 373)    512 x 512
tile B   top-left (1176, 373)   512 x 512     664 + 512 = 1176
tile C   top-left (1176, -139)  512 x 512     373 - 512 = -139
```

A perfect grid, exact to the pixel, with no drift and nothing reimplemented — it is MapLibre's own
matrix, so it is correct by construction under pan, zoom, rotation and pitch alike.

**This fits our chunk model exactly.** Our chunks are whole tiles, so "where does tile `(x, y)` land
on screen" is precisely and only what an overlay needs. Draw each covered chunk into its quad on our
own canvas, stacked over `canvas.maplibregl-canvas`.

### The one remaining piece: which quad is which tile

The quads arrive without identity. Attribution by blob identity does **not** work — `Response.blob()`
returns a fresh `Blob`, so a `WeakMap` keyed on the blob we saw in the fetch shim never matches. That
was tried and returned zero attributions.

It only needs solving once per view, because the grid is uniform: given one correct attribution and
the spacing `S`, every other tile follows from
`screenTopLeft(x₂, y₂) = screenTopLeft(x₁, y₁) + ((x₂ - x₁)·S, (y₂ - y₁)·S)`.

Two ways to get that one anchor, neither yet built:

- **By byte length.** The fetch shim knows each tile's URL and its response size; match a texture
  upload to the tile whose PNG had that length. Unambiguous for painted tiles; empty ones are all
  73 bytes, but they are also the ones where attribution does not matter.
- **By position.** The shim knows the *set* of tiles in view. Sort the quads by screen position and
  the tile coordinates by `(x, y)`; on a uniform grid the two orderings agree.

Prefer the second — it needs no content inspection and cannot be confused by two tiles that happen to
compress to the same size.
