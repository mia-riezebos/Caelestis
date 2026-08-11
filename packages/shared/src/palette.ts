/**
 * wplace's palette, in wplace's own index order.
 *
 * **The index is the contract.** Paint requests carry palette indices rather than RGB, so anything
 * that classifies a report depends on this ordering being right. 31 free colours, then 32 premium,
 * then transparent at 63 — a 64-entry palette whose last slot is "no pixel here".
 *
 * Index 63 is Transparent. wplace lets you *paint* it, so it is a real colour on their palette and
 * not a gap — but inside a template it means **wildcard**, "this pixel may be anything", rather than
 * "this pixel must be erased". Nothing draws it and nothing may count it wrong.
 *
 * ## Source: wplace's own palette array, read out of their bundle
 *
 * Their client carries it literally, as `[{name, rgb}, …]` with Transparent first:
 *
 * ```js
 * [{name:"Transparent",rgb:[0,0,0]},{name:"Black",rgb:[0,0,0]},{name:"Dark Gray",rgb:[60,60,60]}, …]
 * ```
 *
 * **Their array index is this file's index + 1**, because they put Transparent at 0 and we put it
 * last at 63. Their `id="color-N"` swatches use that same array index, so `color-N` is our `N - 1`.
 *
 * Free versus premium is not a field on those objects — it is positional, and their own accessor is
 * the definition:
 *
 * ```js
 * hasColor(t) { return t < 32 ? true : ((extraColorsBitmap ?? 0) & 1 << (t - 32)) !== 0 }
 * ```
 *
 * So their 0–31 are free and 32–63 are premium: 31 free here once Transparent moves to the end, and
 * 32 premium. Ownership bit for our index `i` is therefore `1 << (i - 31)`.
 *
 * The values were cross-checked against the rendered swatches — every hex, every name and the split
 * agree between the bundle array and the DOM.
 *
 * ## This replaces two earlier palettes, each wrong in a different way
 *
 * **First**, one recovered by clustering the pixels of a real `.wplace` file. That file carried ±2
 * per-channel noise from a quantiser artefact upstream, so five entries sat 1–2 off the true colour,
 * `#180006` was a spurious cluster 24 away from black, and ten colours were missing because the
 * artwork never used them. Clustering recovers modes, and a mode of a noisy distribution is not the
 * value that generated it.
 *
 * **Second**, one copied from `mia-cx/ditherette`. Its *set* of colours was right and its free and
 * premium split was right, but **31 of the 63 were at the wrong index** — every position from 18
 * onward was permuted — and its Teal was `#10AE82` against wplace's `#10AEA6`.
 *
 * That is not a cosmetic difference. `extraColorsBitmap` from `/me` is indexed by wplace's ordering,
 * so a permuted table marks the wrong colours as owned; and since paint requests carry indices, any
 * classification built on it attributes activity to the wrong colour. The failure is silent in both
 * directions, because a self-consistent wrong table still round-trips: quantise to it, render from
 * it, and the picture looks perfect while every index in storage is a lie.
 *
 * The lesson both times: a palette is not something to derive, infer, or inherit. Read it from the
 * thing that defines it.
 */

/** Whether a colour is available to everyone or has to be bought. */
export type PaletteKind = 'free' | 'premium'

export interface PaletteColour {
  /** wplace's own index. This is what a paint request sends. */
  readonly index: number
  /** wplace's label, as far as it is known — see the note on staleness above. */
  readonly name: string
  /** Uppercase `#RRGGBB`. */
  readonly hex: string
  readonly rgb: readonly [number, number, number]
  readonly kind: PaletteKind
}

const ENTRIES: ReadonlyArray<readonly [string, string, PaletteKind]> = [
  ['Black', '#000000', 'free'],
  ['Dark Gray', '#3C3C3C', 'free'],
  ['Gray', '#787878', 'free'],
  ['Light Gray', '#D2D2D2', 'free'],
  ['White', '#FFFFFF', 'free'],
  ['Deep Red', '#600018', 'free'],
  ['Red', '#ED1C24', 'free'],
  ['Orange', '#FF7F27', 'free'],
  ['Gold', '#F6AA09', 'free'],
  ['Yellow', '#F9DD3B', 'free'],
  ['Light Yellow', '#FFFABC', 'free'],
  ['Dark Green', '#0EB968', 'free'],
  ['Green', '#13E67B', 'free'],
  ['Light Green', '#87FF5E', 'free'],
  ['Dark Teal', '#0C816E', 'free'],
  ['Teal', '#10AEA6', 'free'],
  ['Light Teal', '#13E1BE', 'free'],
  ['Dark Blue', '#28509E', 'free'],
  ['Blue', '#4093E4', 'free'],
  ['Cyan', '#60F7F2', 'free'],
  ['Indigo', '#6B50F6', 'free'],
  ['Light Indigo', '#99B1FB', 'free'],
  ['Dark Purple', '#780C99', 'free'],
  ['Purple', '#AA38B9', 'free'],
  ['Light Purple', '#E09FF9', 'free'],
  ['Dark Pink', '#CB007A', 'free'],
  ['Pink', '#EC1F80', 'free'],
  ['Light Pink', '#F38DA9', 'free'],
  ['Dark Brown', '#684634', 'free'],
  ['Brown', '#95682A', 'free'],
  ['Beige', '#F8B277', 'free'],
  ['Medium Gray', '#AAAAAA', 'premium'],
  ['Dark Red', '#A50E1E', 'premium'],
  ['Light Red', '#FA8072', 'premium'],
  ['Dark Orange', '#E45C1A', 'premium'],
  ['Light Tan', '#D6B594', 'premium'],
  ['Dark Goldenrod', '#9C8431', 'premium'],
  ['Goldenrod', '#C5AD31', 'premium'],
  ['Light Goldenrod', '#E8D45F', 'premium'],
  ['Dark Olive', '#4A6B3A', 'premium'],
  ['Olive', '#5A944A', 'premium'],
  ['Light Olive', '#84C573', 'premium'],
  ['Dark Cyan', '#0F799F', 'premium'],
  ['Light Cyan', '#BBFAF2', 'premium'],
  ['Light Blue', '#7DC7FF', 'premium'],
  ['Dark Indigo', '#4D31B8', 'premium'],
  ['Dark Slate Blue', '#4A4284', 'premium'],
  ['Slate Blue', '#7A71C4', 'premium'],
  ['Light Slate Blue', '#B5AEF1', 'premium'],
  ['Light Brown', '#DBA463', 'premium'],
  ['Dark Beige', '#D18051', 'premium'],
  ['Light Beige', '#FFC5A5', 'premium'],
  ['Dark Peach', '#9B5249', 'premium'],
  ['Peach', '#D18078', 'premium'],
  ['Light Peach', '#FAB6A4', 'premium'],
  ['Dark Tan', '#7B6352', 'premium'],
  ['Tan', '#9C846B', 'premium'],
  ['Dark Slate', '#333941', 'premium'],
  ['Slate', '#6D758D', 'premium'],
  ['Light Slate', '#B3B9D1', 'premium'],
  ['Dark Stone', '#6D643F', 'premium'],
  ['Stone', '#948C6B', 'premium'],
  ['Light Stone', '#CDC59E', 'premium'],
]

const toRgb = (hex: string): readonly [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
]

/** The 63 paintable colours, at wplace's indices 0..62. */
export const WPLACE_PALETTE: readonly PaletteColour[] = ENTRIES.map(([name, hex, kind], index) => ({
  index,
  name,
  hex,
  rgb: toRgb(hex),
  kind,
}))

/**
 * The index meaning "no pixel here".
 *
 * Last rather than first, because that is where wplace puts it. Storing chunks with any other
 * convention would mean translating on every read and getting it wrong once.
 */
export const TRANSPARENT_INDEX = 63

/** Entries in a full palette including the transparent slot, so 0..63 are all valid indices. */
export const PALETTE_SIZE = TRANSPARENT_INDEX + 1

/** RGB triples at wplace's indices, for nearest-colour matching. */
export const PALETTE_RGB: ReadonlyArray<readonly [number, number, number]> = WPLACE_PALETTE.map(
  (colour) => colour.rgb,
)
