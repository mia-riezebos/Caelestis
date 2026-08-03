# Native `.wplace` template format — import and export

Type: grilling
Status: open
Blocked by: 16
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/31

## Question

wplace's own editor saves templates as `.wplace` — a single JSON file. Supporting it directly would
let alliance members move templates in and out of this server without a conversion step.

## The format, observed

From a real 11 MB file (`cba.wplace`, `schemaVersion: "1"`):

```json
{
  "id": "0f385d42-efa7-4a1b-8266-1fc59c0b9aee",
  "schemaVersion": "1",
  "name": "cba.png",
  "opacity": 0.5,
  "image": { "dataUrl": "data:image/png;base64,…", "width": 1612, "height": 2584 },
  "bounds": { "north": -78.824…, "south": -78.911…, "west": -122.862…, "east": -122.578… },
  "colorMetric": "…", "colorPaletteMode": "…", "dithering": false, "useLegacyColors": false,
  "order": 0, "locked": false
}
```

Maps onto our model cleanly in places: `order` is z-order, `opacity` is a viewing-mode setting,
`name` is the template name, `bounds` is placement.

## Two findings that matter beyond this ticket

**1. Placement is lat/lng, and it pins the projection.** Image width ÷ longitude span and height ÷
latitude span both give **2,048,000 px exactly** — so the canvas is **Web Mercator at zoom 11,
2048 × 2048 tiles of 1000 px**. The file's computed position, tile (325, 1781), matches tiles
observed in a live session. Recorded on `06-recon-tile-serving`, which it also corrected.

**2. The embedded image is stored verbatim — wplace does not re-encode it.** Initially misread as
un-quantised source, because the file holds 6,137 distinct colours. It is not: clustering shows
**59 modes accounting for 100.000% of pixels**, and 40 of those clusters have exactly **125 members**
— 5³, every combination of −2…+2 on each channel, with the smaller counts explained by clipping at 0
and 255.

That is a **colour-management or canvas-readback artefact** in the producing pipeline, not anything
wplace did, and not deliberate jitter — dithering picks between palette entries rather than perturbing
them, and would not spread evenly across all 125 combinations. An sRGB → display-profile → sRGB round
trip through a canvas produces exactly this signature.

It is the same hazard already recorded for the userscript's *decode* path in
`01-template-storage-and-chunk-model`: the browser may colour-manage or premultiply, silently breaking
exact palette matching. Same bug class, opposite end of the pipeline, same fix —
`createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })`, and
`getContext('2d', { colorSpace: 'srgb' })` for a 2D readback.

So a `.wplace` file contains exactly the pixels it was given.

## No tension after all

Import was thought to conflict with the server's contract of never quantising, on the assumption that
`.wplace` always holds un-quantised source. It does not. **A file produced from a correctly quantised
image is palette-conformant, and the server can accept it unchanged.**

Import and export are therefore both straightforward:

- **Import**: parse JSON, decode the data URL, convert lat/lng `bounds` to canvas pixels, validate
  palette conformance as with any upload, slice into tiles. `order` becomes `sort_order`, `name`
  becomes the template name.
- **Export**: emit the same shape from stored pixels and placement, so the file opens in wplace's own
  editor.

Non-conformant files are rejected by the existing upload validation, exactly like any other
non-conformant image. No exception to the no-quantising rule is needed.

## To decide

- Whether templates store the **original lat/lng bounds** alongside derived canvas-pixel bounds.
  Recorded in the schema draft as `bounds_*`, nullable — round trips stay lossless instead of
  re-deriving and accumulating float drift.
- Whether `opacity`, `dithering`, `colorPaletteMode`, `colorMetric`, `locked` are preserved verbatim
  for round-trip fidelity, or dropped as editor state that means nothing to us.
- Whether the wplace `id` is retained, so a re-import recognises a template it has seen before.
