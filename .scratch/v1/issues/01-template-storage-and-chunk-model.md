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

## Amendment — 2026-08-03: the server quantises on ingest

**Reverses this ticket's original rule** that uploads must arrive palette-conformant and are rejected
otherwise.

The trigger: a real `.wplace` file carries ±2 per-channel deviation from a colour-management or
canvas-readback artefact upstream (see `28-native-wplace-format`). Under the original rule it would be
rejected despite being, in substance, a correctly quantised image.

**New behaviour: every non-transparent pixel is mapped to its nearest wplace palette colour in RGBA
space. No dithering, no threshold, no rejection.**

### What this gives up, stated plainly

The reject rule existed so a malformed template could not poison every connected client's overlay.
That guarantee is gone: a photograph now uploads successfully and produces a conformant-looking but
meaningless template.

Partial replacement — **the upload response reports what happened** rather than gating on it: share of
pixels moved, mean and max distance moved, and the resulting distinct-colour count. An uploader who
sees "94% of pixels moved, mean distance 31" knows immediately that something is wrong, without the
server refusing on their behalf.

For reference, the observed artefact sits at: 99.985% of pixels within distance 2, worst case 4. The
palette's own closest pair is 8 apart (`#948C6B` vs `#9C846B`), so anything past 4 is ambiguous by
construction.

### Alpha

wplace has no partial transparency — a pixel is painted or it is not. **?** Alpha ≥ 128 quantises to a
palette colour; below that becomes fully transparent. Named here because "quantise in RGBA space" does
not by itself say what happens to a half-transparent pixel, and silently averaging alpha into the
distance metric would match opaque palette entries against translucent pixels.

### Why this is affordable in a Worker

Naively this is 4.16M pixels × 59 palette entries ≈ 245M distance computations for a single 1612×2584
upload — far past any CPU budget.

**Memoise by distinct colour.** Real images have very few: the observed file has 6,137, so the work is
6,137 × 59 ≈ 362k comparisons, then one `Map` lookup per pixel. Three orders of magnitude cheaper, and
it degrades gracefully — a genuine photograph has more distinct colours, but the cache still bounds
the work at (distinct colours × palette size).

A fixed 5-bit-per-channel lookup table was the obvious alternative and is worse here: it introduces up
to ±4 of its own error before matching, which the palette's minimum separation of 8 cannot absorb.

## Amendment — 2026-08-08: the local store is a cache, and locally-imported templates are separate

The userscript now persists templates in IndexedDB and can import an image directly, which makes it
useful with no server at all. Neither of those changes where a *shared* template lives.

- **The server remains the source of truth for anything shared.** Local storage is a cache. A
  template can be updated, swapped or removed server-side, and the userscript is expected to notice:
  the ETag-polled manifest is what says something changed, and a changed template is re-fetched
  rather than assumed still current. Cached chunks are content-addressed, so "has this changed" is
  answerable without downloading anything.
- **A locally-imported template is a different kind of object.** It never had a server, so nothing
  can update it and nothing should try. It is the standalone path and the on-ramp — place an image,
  see it, then push it to a server — rather than an offline copy of a shared one.

Not yet settled, and now fog on the map: what the userscript does when a cached template's server
says it is gone, and whether a locally-imported template can be promoted to a shared one in place or
must be re-uploaded.
