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
