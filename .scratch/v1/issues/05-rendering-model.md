# Rendering model

Type: grilling
Status: resolved
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/6

## Question

How does the userscript get template pixels onto the wplace canvas, how does it avoid rendering
everything, and how are the viewing modes expressed?

## Answer

### Interception, not viewport math

wplace serves the canvas as tile PNGs and the userscript intercepts the tile fetch and composites.
So **culling is a hash-map lookup**:

```
tile fetch → not in template index? → pass through untouched
           → in index, 200?         → composite over the real tile
           → in index, 404?         → synthesize transparent 1000×1000, composite
```

Tile `1234/567` requested → `index[1234/567]` → composite only those chunks. Toggling a node
rebuilds the map; no refetch.

**Only fabricate a response where a template actually covers the tile.** wplace may rely on the 404
to know a region is empty, and its behaviour should not change anywhere it does not have to.

### Viewing modes — one parameterisation

```
{ scale S, shape, size k (1..S), anchor (3×3), opacity }
```

- **Pixel size slider** = `k`, centre anchor
- **wplace's top-left triangle** = `shape: triangle`, `anchor: tl`
- **Centre circle** = `shape: circle`, `anchor: center`, small `k`
- **Corner overlays** = any of the 9 anchors

Same code path, no special cases. Opacity is `globalAlpha` at composite time.

### Scale S is the whole performance story

Drawing anything smaller than a full pixel requires returning an **upscaled tile** from the
intercept — each source pixel becomes an S×S block. Cost is quadratic:

| S | Tile buffer | Notes |
|---|---|---|
| 1 | 4 MB | full-pixel modes only, free |
| 3 | 36 MB | proven — what Blue Marble uses |
| 5 | 100 MB | decent triangles, risky |

**Make S depend on the active mode.** Full-pixel + opacity → S=1, costs nothing. Only pay for
upscaling when a sub-pixel shape is actually on. A triangle at S=3 is 6 pixels and looks rough —
surface that tradeoff in the UI.

### Stamp atlas

Do not path-draw per pixel. On settings change, precompute one S×S RGBA stamp per palette colour for
the current `(shape, k, anchor)` — ~64 stamps, ~12 KB at S=3. Rendering a tile is then a memcpy per
source pixel. Rebuild on slider *release*, not on every input event. Opacity needs no rebuild, so
that slider can stay live.

### Vector alternative (deferred to `13-render-path`)

A canvas/WebGL overlay pays per **screen** pixel rather than per tile pixel — cheaper at typical
zoom, sharper, and it dissolves S entirely while making shape/size/anchor pure fragment-shader math.

The cost is coupling to wplace's map internals:

- **MapLibre** → custom layer, exact projection matrix, instanced quads. Clean and fast.
- **Leaflet or hand-rolled canvas** → hook pan/zoom and reimplement the transform. One-pixel drift
  is constantly visible and maddening.

Either way a **zoom threshold** is needed: below ~1 screen pixel per source pixel, shapes are
meaningless and a plain downscaled raster should take over.

**Position on record: ship the raster path first.** It is proven, decoupled from their internals,
and cannot break when they ship a frontend update. Vector as v2, once the map library is known.

## Amendment — 2026-08-08: vector shipped, and culling comes from their own matrix

The position above was overtaken. v1 renders in a MapLibre custom layer inside wplace's own canvas —
see `13-render-path` for the decision and `14-v1-viewing-modes` for what replaced the mode list. The
parameterisation this ticket settled as `{shape, size k, anchor, opacity}` is now
`{size, radius, offsetX, offsetY, rotation, opacity}`: shape and anchor both dissolved into it.

Two parts of this model changed shape:

- **Culling is not a tile-index lookup any more.** It is the set of tile quads wplace drew this
  frame, recovered from the projection matrix they uploaded. A tile nobody drew is a tile we cannot
  and need not draw over, so the cull is exact rather than computed — and it is also the coordinate
  reference everything else reads: where a per-overlay button goes, which canvas pixel is under the
  cursor, where an imported image lands.
- **The zoom threshold survives in two halves.** Below 3 device pixels per cell, shapes stop being
  drawn and pixels render solid. Below 1:1, the shader takes 4×4 taps — wplace never mipmap
  (`generateMipmap: 0`, measured), so the moiré at small scales is ours to fix.

### Colour filtering is part of this model, not a UI detail

Which colours an overlay draws has three inputs and a strict precedence:

1. **The wildcard** (index 63) asserts nothing and is never drawn.
2. **Hand-switched colours** — the global set, or an overlay's own set as a full **override** of it,
   never a union. An overlay with an opinion answers to its own switches only.
3. **Follow-the-selection** — a *mode*, not a filter: it shows only the colour wplace has selected,
   lasts while their drawer is open, writes nothing, and restores what was underneath when switched
   off. Each scope's mode beats that scope's own switches and reaches no further.

The distinction between (2) and (3) is load-bearing beyond rendering. A colour switched off by hand
is one the user has said to stop caring about, so nothing asserts it — no mismatch marker, and the
colour picker defers to wplace there. A colour hidden by the mode has said no such thing, so both
read straight past it. `hiddenColoursFor` answers the first question, `claimedHiddenFor` the second.
