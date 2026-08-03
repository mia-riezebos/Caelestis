# Template storage & chunk model

Type: grilling
Status: resolved
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/2

## Question

How does a template get from upload to something the userscript can composite onto a single wplace
tile, and how is it stored?

## Answer

**Templates arrive pre-quantised.** A separate existing tool owns creation and palette
quantisation. The server does not quantise.

**Upload is validate-then-slice:**

1. Accept RGBA PNG or already-indexed PNG.
2. **Validate**: every non-transparent pixel must be an exact wplace palette colour. Reject the
   whole upload otherwise — one malformed template would otherwise poison every connected client's
   overlay.
3. **Convert to PLTE indexed PNG** if not already indexed. ~1 byte/px instead of 4, and the palette
   index is the form the renderer wants anyway.
4. **Slice on wplace's 1000×1000 tile boundaries.** A template becomes N chunks, each scoped to
   exactly one tile.

**Storage is content-addressed:**

```
chunks/{sha256}.png     immutable, cache-forever
```

Editing a template only invalidates the tiles that actually changed; unchanged chunks keep their
hash and stay cached. Same scheme is reused elsewhere in the system.

**Chunk record:**

```
{ tile: [x, y], offset: [px, py], hash, w, h }
```

### Client-side decode gotcha

`drawImage` returns RGBA and the browser may colour-manage or premultiply it, silently breaking
exact palette matching. Decode with:

```js
createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
```

Then RGBA → palette index is an exact `Map<u32, idx>` lookup, since wplace palette colours are
distinct. Cache the decoded `Uint8Array` of indices per chunk — it is re-read on every render.

Fallback if a browser still misbehaves: inflate the PNG directly (pako) to read true PLTE indices.
Heavier, exact, only if needed.
