/**
 * wplace's palette, in wplace's own index order.
 *
 * **The index is the contract.** Paint requests carry palette indices rather than RGB, so anything
 * that classifies a report depends on this ordering being right. 31 free colours, then 32 premium,
 * then transparent at 63 — a 64-entry palette whose last slot is "no pixel here".
 *
 * Source: `mia-cx/ditherette`, `src/lib/palette/wplace.ts`. The names there are known to lag wplace's
 * own labels; the hex values are good and are what this file takes.
 *
 * ## This replaces a palette that was wrong, not merely short
 *
 * The previous version was recovered by clustering the pixels of one real `.wplace` file, which
 * carried ±2 per-channel noise from a quantiser artefact upstream. `09-recon-palette` recorded that
 * "the underlying modes are exact palette values". They were not:
 *
 * - Five entries sat 1–2 off the true colour (`#F8A90A` for `#F6AA09`, `#F7DB3B` for `#F9DD3B`,
 *   `#60F9F4` for `#60F7F2`, `#E0A1F9` for `#E09FF9`, `#CB007B` for `#CB007A`).
 * - `#180006` was a spurious cluster 24 away from black and is not a palette colour at all.
 * - Ten real colours were missing, being ones that artwork did not use.
 *
 * Clustering recovers modes, and a mode of a noisy distribution is not the value that generated it.
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
  ['Pale Yellow', '#FFFABC', 'free'],
  ['Green', '#0EB968', 'free'],
  ['Light Green', '#13E67B', 'free'],
  ['Mint', '#87FF5E', 'free'],
  ['Deep Teal', '#0C816E', 'free'],
  ['Teal', '#10AE82', 'free'],
  ['Cyan', '#13E1BE', 'free'],
  ['Aqua', '#60F7F2', 'free'],
  ['Blue', '#28509E', 'free'],
  ['Light Blue', '#4093E4', 'free'],
  ['Indigo', '#6B50F6', 'free'],
  ['Periwinkle', '#99B1FB', 'free'],
  ['Purple', '#780C99', 'free'],
  ['Magenta', '#AA38B9', 'free'],
  ['Lavender', '#E09FF9', 'free'],
  ['Hot Pink', '#CB007A', 'free'],
  ['Rose', '#EC1F80', 'free'],
  ['Pink', '#F38DA9', 'free'],
  ['Brown', '#684634', 'free'],
  ['Tan', '#95682A', 'free'],
  ['Peach', '#F8B277', 'free'],
  ['Silver', '#AAAAAA', 'premium'],
  ['Crimson', '#A50E1E', 'premium'],
  ['Coral', '#FA8072', 'premium'],
  ['Burnt Orange', '#E45C1A', 'premium'],
  ['Olive', '#9C8431', 'premium'],
  ['Mustard', '#C5AD31', 'premium'],
  ['Sand', '#E8D45F', 'premium'],
  ['Moss', '#4A6B3A', 'premium'],
  ['Leaf', '#5A944A', 'premium'],
  ['Pistachio', '#84C573', 'premium'],
  ['Ocean', '#0F799F', 'premium'],
  ['Pale Aqua', '#BBFAF2', 'premium'],
  ['Sky Blue', '#7DC7FF', 'premium'],
  ['Violet', '#4D31B8', 'premium'],
  ['Slate Purple', '#4A4284', 'premium'],
  ['Soft Purple', '#7A71C4', 'premium'],
  ['Pale Violet', '#B5AEF1', 'premium'],
  ['Brick', '#9B5249', 'premium'],
  ['Dusty Rose', '#D18078', 'premium'],
  ['Light Coral', '#FAB6A4', 'premium'],
  ['Caramel', '#DBA463', 'premium'],
  ['Umber', '#7B6352', 'premium'],
  ['Taupe', '#9C846B', 'premium'],
  ['Beige', '#D6B594', 'premium'],
  ['Terracotta', '#D18051', 'premium'],
  ['Apricot', '#FFC5A5', 'premium'],
  ['Army', '#6D643F', 'premium'],
  ['Khaki', '#948C6B', 'premium'],
  ['Cream', '#CDC59E', 'premium'],
  ['Charcoal Blue', '#333941', 'premium'],
  ['Steel', '#6D758D', 'premium'],
  ['Pale Steel', '#B3B9D1', 'premium'],
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
