# Recon: map stack & how wplace draws its triangle mode

Type: research
Status: resolved
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/11

## Question

What renders the wplace map, and how does its existing top-left-triangle view mode actually work?

- **Which map library?** MapLibre, Leaflet, or hand-rolled canvas/WebGL. Check `window.maplibregl`,
  `window.L`, and what the map canvas is attached to.
- If MapLibre: is a custom layer with access to the projection matrix feasible from a userscript?
- **How is the triangle mode drawn** — a shader, a sprite/stamp atlas, a CSS/SVG mask, or an
  upscaled raster? Replicating it is a stated goal, and their approach is the cheapest hint.
- At what zoom levels does wplace itself switch rendering strategies?
- How stable are these internals — minified bundle with mangled names, or something addressable?

This is the single highest-leverage recon ticket: it decides whether vector rendering is a weekend
or a month, and it directly unblocks `13-render-path`.

## Findings (partial — 2026-08-03, AFK bundle inspection)

- **The map is MapLibre GL**, bundled into the SvelteKit app (found in
  `_app/immutable/nodes/5.*.js`; `maplibregl-*` class names, `maplibre_preloaded_worker_pool`).
  Not loaded from a CDN, so `window.maplibregl` is probably **not** exposed — reaching the map
  instance from a userscript needs another route (DOM canvas → internal handle, or patching a
  prototype before construction). Worth confirming in the browser.
- **Custom layers are in play**: the bundle contains the `"custom"` layer type alongside
  `"raster"`, `"canvas"`, and `"image"`. So the MapLibre custom-layer path — projection matrix,
  instanced quads, shader-based shapes — is technically available.
- Tiles are declared as a **raster source** with a `{x}/{y}` URL template, which is what makes the
  fetch-intercept approach work at all.

Unexpected and relevant: the bundle exposes native alliance endpoints that overlap this project's
territory — `/alliances/{id}/headquarters/manifest`, `/alliances/{id}/headquarters/snapshot`,
`/alliance/assets/{id}`, `/alliance/assets/drafts/{id}/paint`, `/alliance/assets/drafts/{id}/canvas`,
`/alliance/leaderboard/{id}`. wplace has already built some template-and-alliance machinery.
**Worth a look before building overlapping features** — see whether these are usable, whether they
constrain the design, or whether they are limited enough that this project still earns its place.

Still open:

- How the top-left-triangle view mode is actually drawn (shader vs stamp vs mask).
- Zoom thresholds at which wplace switches rendering strategy.
- Whether a userscript can practically obtain the MapLibre map instance.

## Findings — 2026-08-06, live page

**wplace is MapLibre GL JS on WebGL2, inside SvelteKit.** One canvas, `canvas.maplibregl-canvas`,
under `.maplibregl-canvas-container.maplibregl-interactive`, with the full
`maplibregl-ctrl-*` control scaffolding. Basemap style is OpenFreeMap `liberty`
(`maps.wplace.live/styles/liberty`, sprites `ofm_f384`).

This is the branch `13-render-path` called the good one: MapLibre means a custom layer would let us
draw per screen pixel rather than per tile pixel, stay sharp at high zoom, and put shape/size/anchor
into fragment-shader math.

**But the `Map` instance is not reachable from a userscript.** Probed for it directly:

- nothing map-shaped on `window` — the only matches are DOM built-ins and `__paraglide`
- no `_`/`__` back-references on `canvas.maplibregl-canvas` or on `.maplibregl-map`
- no `$$`/svelte keys on the container — Svelte 5 keeps component state in module scope, not on the
  element

So `map.addLayer(...)` is not available by simply finding the map. What *is* available, proved by
probe: a `document-start` patch of `HTMLCanvasElement.prototype.getContext` captures the map's canvas
and its WebGL2 context before MapLibre gets it.

That leaves three routes, and choosing between them is the open decision:

1. **Wrap the captured WebGL2 context** and inject our own draw calls into MapLibre's frame. Most
   powerful, deepest coupling to MapLibre's internals, most likely to break on their upgrade.
2. **Own canvas positioned over theirs**, reproducing the transform. Needs lat/lng/zoom and the exact
   projection; `13-render-path` warns one-pixel drift is constantly visible when the transform is
   reimplemented. Zoom is in the URL, which helps, but rotation/pitch would not be.
3. **Get the instance anyway** by patching something MapLibre touches during construction — e.g. its
   own container element methods — so we capture `this` at map-construction time. Worth one attempt
   before falling back to 1 or 2; it would give the supported public API rather than internals.

Route 3 first, then 1. Route 2 is the fallback that always works and always drifts.

## Is the Map instance reachable? No — six routes tried, all negative

The served bundle was downloaded (148 chunks, 4.0 MB; MapLibre lives in
`_app/immutable/nodes/5.*.js`) and read, then each candidate route was tested on the live page.

| route | result |
|---|---|
| global assignment | none. The only globals the bundle sets are `window.__svelte` (a uid counter, not a devtools root), `window.fetch`, `globalThis.__paraglide`, and `bits-ui` layer registries |
| back-reference on a DOM node | none on `canvas.maplibregl-canvas` or `.maplibregl-map` — no `_`/`__` own properties at all |
| Svelte component state | none. Svelte 5 keeps it in module scope; no `$$`/svelte keys on the container |
| listener objects on the canvas container | 52 listeners captured, **0** were objects. All anonymous closures, so nothing to read `_map` off |
| `ResizeObserver` callback | captured; the callback is a closure with no own properties |
| `Function.prototype.bind` thisArg | **534 binds captured, none with a map-like `thisArg`.** This build uses arrow functions and class fields, not `.bind(map)` |

Minified property names *do* survive — `_map` appears 307 times, `getCanvas` 27, `triggerRepaint` 18 —
so the back-pointers exist inside MapLibre's own handler and control objects. None of those objects
are reachable from outside module scope.

**Conclusion: `map.addLayer(...)` is not available to a userscript on this build.** Route 3 in the
list above is closed. Do not plan around getting the instance.

### What *is* reachable

Patching `HTMLCanvasElement.prototype.getContext` at document-start captures the map's canvas **and
its WebGL2 context before MapLibre receives it** — confirmed, and the wrapped context sees the real
traffic (2,470 `useProgram` calls and a steady stream of `uniformMatrix4fv` uploads during load).

That makes route 1 — wrap the GL context and draw in MapLibre's own frame — the live option, and it
does not need the Map at all: the MVP matrix MapLibre uploads *is* the transform, exactly, every
frame.

**Not yet established, and needed before committing to it:** which uniform is the view matrix.
Around 20 distinct 4×4 matrices are uploaded per frame and the first one is a constant, so the view
matrix has to be identified rather than assumed. Two page loads at different zooms produced the same
*first* matrix, which is why this is recorded as open rather than proven. Identify it by correlating
a matrix that changes across loads at different zoom/centre with one that stays fixed.

### Where that leaves the decision

1. **Wrap GL, identify the view matrix, draw our own pass.** No Map needed, exact transform, cost
   proportional to what is on screen. Deepest coupling to MapLibre's frame, so most exposed to their
   upgrades — but it is the only route that gives a real overlay.
2. **Rewrite tiles, as BlueMarble does, but cheaply** — no `drawMult` blow-up, no `getImageData`,
   indexed PNG in and out, and a chunk cache. Accepts that a filter change does not repaint until the
   user pans. Lowest risk, known to work, worst interaction with per-colour toggles.
3. **Own canvas, transform reproduced from the URL.** wplace's canvas coordinate system is Web
   Mercator at zoom 11 and `@wts/shared` already implements it, so the projection maths is not
   guesswork. The gap is that the URL updates on move-end, so the overlay would lag during a gesture.

Recommend attempting 1, with 2 as the fallback that always works.
## Resolution — 2026-08-08: confirmed live, and the map instance is ours

Every "worth confirming in the browser" above has been confirmed by building against it.

- **The map instance is obtainable.** It is captured while MapLibre constructs it, via
  `_canvasContainer` — so we hold the real `Map`, its `style`, and its layer order. `style._order`
  includes custom layers, which `getStyle()` omits; that difference matters for keeping our layers in
  the right place.
- **Custom layers work from a userscript**, and are what v1 ships — see `13-render-path`.
- **The projection matrix is readable without reimplementing it.** Hooking `getUniformLocation`
  turns an anonymous sixteen floats into a named `u_projection_matrix`, and MapLibre's *aligned*
  variant (used only while the map is still) is what makes our pixels land on the same device pixels
  as theirs.
- **Their filtering, measured**: `MIN_FILTER` always `LINEAR`, `MAG_FILTER` `NEAREST` for pixel art,
  and `generateMipmap: 0` — they never mipmap. So sub-1:1 moiré is ours to solve, which the shader
  does with 4×4 taps.
- **Their layers, named**: `pixel-art-layer` (one raster source for all tiles, `tileSize` 550),
  `hotspots-halo`, `hotspots-layer`, `paint-preview-<n>-<x>,<y>` (one image source per tile being
  drafted, **stored vertically flipped**), `pixel-hover`, and `paint-crosshair-annotations` — a
  custom layer holding 200×200 `Uint8Array` patches, one non-zero entry per drafted pixel. That last
  one is the only place a pixel drafted Transparent is distinguishable from an undrafted one.
- The **triangle view mode** was never chased, because it stopped mattering: shapes are a continuous
  parameterisation of our own rather than a replication of theirs (`14-v1-viewing-modes`).

The **native alliance endpoints** noted above are not a loose end: they already have a home in
`18-headquarters-canvas`, which lists the same surface and is in scope for v1 but sequenced last.

Nor do they reopen anything about membership. `03-auth-model` settled that: our own access tokens are
the mechanism, and an alliance check is an optional second-order config (`requireAllianceId`) that
raises the bar for operators who want it. It is never a gate, and nothing here depends on wplace's
notion of who is in an alliance.
