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
