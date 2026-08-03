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

**2. The embedded image is the un-quantised source.** `colorType: 6` (RGBA), and 6,137 distinct
opaque colours — with tell-tale near-duplicates like `(60,60,60)` beside `(60,61,60)`, and
`(170,170,170)` beside `(170,170,171)`. The dominant colours *are* palette colours with noise around
them, so `dithering` / `colorPaletteMode` / `colorMetric` are editor settings applied at display
time, not baked into the stored pixels.

## The tension

**Import conflicts with a settled decision.** The server validates that uploads are already
palette-conformant and explicitly does not quantise — that belongs to the separate creation tool. But
a `.wplace` file is by definition not conformant, so accepting one either means quantising on the
server or rejecting nearly every real file.

Options:

- **Import belongs in the creation tool.** It already owns quantisation; teaching it to read
  `.wplace` costs nothing architecturally and keeps the server's contract intact. Probably right.
- **Server accepts `.wplace` and quantises on import**, as a narrowly-scoped exception. Convenient
  for users, but reopens a decision made deliberately, and quantisation quality is exactly what the
  dedicated tool exists to get right.
- **Server accepts `.wplace` metadata only**, pairing it with a separately-supplied conformant image.
  Awkward, and it is not really "native support".

**Export has no such tension and is a clean win.** We hold the pixels, the placement and the name, so
we can emit a valid `.wplace` that opens in wplace's own editor. Worth doing regardless of what
import does.

## To decide

- Where import lives, per the above.
- Whether templates store the **original lat/lng bounds** alongside derived canvas-pixel bounds. Round
  trips are lossless if we do; if we only keep pixels, an export re-derives bounds and floating-point
  drift creeps in.
- Whether `opacity`, `dithering`, `colorPaletteMode`, `colorMetric`, `locked` are preserved verbatim
  for round-trip fidelity, or dropped as editor state that means nothing to us.
- Whether the wplace `id` is retained, so a re-import recognises a template it has seen before.
