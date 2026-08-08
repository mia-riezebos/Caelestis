import { PALETTE_RGB, TRANSPARENT_INDEX } from './palette.js'

/**
 * Map every pixel of an upload onto the wplace palette.
 *
 * The server used to reject anything not already palette-conformant. That rule died on a real
 * `.wplace` file carrying ±2 per-channel deviation from a colour-management artefact upstream: in
 * substance a correctly quantised image, rejected on a technicality. Nearest-colour mapping accepts
 * it, at the cost of also accepting a photograph.
 *
 * The replacement for that guarantee is **reporting rather than gating** — see `QuantiseReport`. An
 * uploader who is told "94% of pixels moved, worst distance 31" knows immediately that something is
 * wrong, without the server refusing on their behalf.
 *
 * @see .scratch/v1/issues/01-template-storage-and-chunk-model.md
 */

/** Alpha at or above this is painted; below it the pixel is absent. */
export const OPAQUE_ALPHA_THRESHOLD = 128

export interface QuantiseReport {
  /** Non-transparent pixels considered. */
  readonly opaquePixels: number
  /** Of those, how many landed on a colour other than the one they arrived as. */
  readonly movedPixels: number
  /** Distinct input colours seen, which is what bounds the work. */
  readonly distinctColours: number
  /** Distinct palette entries in the result — a template using 3 colours is probably a mistake. */
  readonly distinctPaletteEntries: number
  /**
   * Mean and worst distance moved, as the **largest single-channel difference**, not Euclidean.
   *
   * That unit is chosen to line up with the observations already on record: the artefact that
   * motivated quantising sits at 99.985% of pixels within 2 and a worst case of 4, and the palette's
   * own closest pair (`#948C6B` / `#9C846B`) is 8 apart. Reporting Euclidean would make those
   * reference points incomparable and the numbers uninterpretable.
   */
  readonly meanDistance: number
  readonly maxDistance: number
}

export interface QuantiseResult {
  /** One byte per pixel, carrying wplace's own palette index. `TRANSPARENT_INDEX` means absent. */
  readonly indices: Uint8Array
  readonly report: QuantiseReport
}

/**
 * Quantise straight RGBA to palette indices.
 *
 * Naively this is pixels x palette-size distance computations — 245M for a single 1612x2584 upload,
 * far past any Worker budget. **The work is memoised by distinct colour instead**, because real
 * images have very few: the observed file has 6,137, so it costs 6,137 x 59 comparisons and then one
 * map lookup per pixel. It degrades gracefully rather than falling off a cliff — a genuine
 * photograph has more distinct colours, but the cache still bounds the work at
 * distinct-colours x palette-size.
 *
 * Matching is by squared Euclidean distance, which is the right nearest-colour metric. The *report*
 * uses per-channel distance for the reasons given on `QuantiseReport`; the two answer different
 * questions and are deliberately not the same number.
 */
export const quantiseToPalette = (pixels: Uint8Array, palette = PALETTE_RGB): QuantiseResult => {
  // Transparent everywhere, then paint over it. The absent case is by far the most common in a
  // template and this way it costs nothing per pixel.
  const indices = new Uint8Array(pixels.length / 4).fill(TRANSPARENT_INDEX)
  // Keyed by packed RGB, holding the chosen palette index and the per-channel distance moved, so a
  // repeated colour costs one lookup rather than a scan.
  const decided = new Map<number, { index: number; distance: number }>()

  let opaquePixels = 0
  let movedPixels = 0
  let totalDistance = 0
  let maxDistance = 0
  const used = new Set<number>()

  for (let pixel = 0; pixel < indices.length; pixel += 1) {
    const at = pixel * 4
    if ((pixels[at + 3] ?? 0) < OPAQUE_ALPHA_THRESHOLD) continue

    const red = pixels[at] ?? 0
    const green = pixels[at + 1] ?? 0
    const blue = pixels[at + 2] ?? 0
    const key = (red << 16) | (green << 8) | blue

    let choice = decided.get(key)
    if (choice === undefined) {
      let best = 0
      let bestDistance = Number.POSITIVE_INFINITY
      for (const [index, entry] of palette.entries()) {
        const dRed = red - entry[0]
        const dGreen = green - entry[1]
        const dBlue = blue - entry[2]
        const distance = dRed * dRed + dGreen * dGreen + dBlue * dBlue
        if (distance < bestDistance) {
          bestDistance = distance
          best = index
        }
      }
      // biome-ignore lint/style/noNonNullAssertion: best indexes into a non-empty palette
      const entry = palette[best]!
      choice = {
        index: best,
        distance: Math.max(
          Math.abs(red - entry[0]),
          Math.abs(green - entry[1]),
          Math.abs(blue - entry[2]),
        ),
      }
      decided.set(key, choice)
    }

    opaquePixels += 1
    if (choice.distance > 0) movedPixels += 1
    totalDistance += choice.distance
    if (choice.distance > maxDistance) maxDistance = choice.distance
    used.add(choice.index)
    indices[pixel] = choice.index
  }

  return {
    indices,
    report: {
      opaquePixels,
      movedPixels,
      distinctColours: decided.size,
      distinctPaletteEntries: used.size,
      meanDistance: opaquePixels === 0 ? 0 : totalDistance / opaquePixels,
      maxDistance,
    },
  }
}
