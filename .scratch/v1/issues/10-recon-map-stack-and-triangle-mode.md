# Recon: map stack & how wplace draws its triangle mode

Type: research
Status: open
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
