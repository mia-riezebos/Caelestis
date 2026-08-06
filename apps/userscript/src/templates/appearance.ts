import { PALETTE_SIZE, TRANSPARENT_INDEX } from '@wts/shared'

/**
 * How one overlay is drawn.
 *
 * The parameterisation is `05-rendering-model`'s, unchanged: `{ scale S, shape, size k, anchor,
 * opacity }`. One code path covers every mode — a pixel-size slider is `k` with a centre anchor,
 * wplace's own look is a top-left triangle, a dot is a small centred circle — so there are no
 * special cases to keep in step.
 *
 * **`scale` is the entire performance story.** Drawing anything smaller than a whole pixel means
 * rendering each source pixel as an SxS block, and cost is quadratic: S=1 is free, S=3 costs 36 MB
 * per tile, S=5 costs 100 MB. So `scale` is derived from the shape rather than offered as a
 * control: full-pixel modes stay at 1 and pay nothing, and only a sub-pixel shape opts into the
 * bill.
 */

export type Shape = 'full' | 'square' | 'circle' | 'triangle'
export type Anchor = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br'

export interface Appearance {
  readonly shape: Shape
  /** Fraction of the pixel the stamp covers, 0..1. Ignored by `full`. */
  readonly size: number
  readonly anchor: Anchor
  readonly opacity: number
  /** Palette indices hidden for this overlay specifically. */
  readonly hiddenColours: readonly number[]
}

export const DEFAULT_APPEARANCE: Appearance = {
  shape: 'full',
  size: 1 / 3,
  anchor: 'c',
  opacity: 1,
  hiddenColours: [],
}

/**
 * Render scale for an appearance.
 *
 * A full pixel needs no upscaling. Anything sub-pixel needs enough resolution for the shape to read
 * — 3 is what Blue Marble uses and is the smallest that produces a recognisable triangle.
 */
export const scaleFor = (appearance: Appearance): number => (appearance.shape === 'full' ? 1 : 3)

/**
 * Whether a template pixel of this index should be left unpainted by the overlay.
 *
 * Index 63 is not "transparent" in a template — it is **wildcard**: this pixel may be anything.
 * wplace does let you paint 63, so it is a real colour on their palette, but a template that stored
 * it as a requirement would be demanding the canvas be *erased* there, which is a different and much
 * stronger claim than the one templates make. So the overlay draws nothing over a wildcard, leaving
 * whatever is underneath visible and correct.
 *
 * Progress must read it the same way when it is built: a wildcard matches whatever is already on
 * the canvas and can never be counted wrong.
 */
export const isColourHidden = (appearance: Appearance, index: number): boolean =>
  index === TRANSPARENT_INDEX || appearance.hiddenColours.includes(index)

/**
 * Every index a template can *require*, in palette order.
 *
 * Excludes the wildcard, which is why this is not simply the palette: a wildcard is a statement
 * about not caring, so it is never something to filter, count, or offer a switch for.
 */
export const drawableIndices = (): readonly number[] =>
  Array.from({ length: PALETTE_SIZE }, (_, index) => index).filter(
    (index) => index !== TRANSPARENT_INDEX,
  )

export const SHAPES: ReadonlyArray<{ id: Shape; label: string; hint: string }> = [
  { id: 'full', label: 'Full', hint: 'Solid pixels — cheapest, and what you paint' },
  { id: 'square', label: 'Square', hint: 'A smaller square inside each pixel' },
  { id: 'circle', label: 'Dot', hint: 'A dot, so the canvas shows around it' },
  { id: 'triangle', label: 'Corner', hint: "wplace's own look" },
]

export const ANCHORS: ReadonlyArray<{ id: Anchor; label: string }> = [
  { id: 'tl', label: 'Top left' },
  { id: 't', label: 'Top' },
  { id: 'tr', label: 'Top right' },
  { id: 'l', label: 'Left' },
  { id: 'c', label: 'Centre' },
  { id: 'r', label: 'Right' },
  { id: 'bl', label: 'Bottom left' },
  { id: 'b', label: 'Bottom' },
  { id: 'br', label: 'Bottom right' },
]

/** Where a stamp of fractional `size` sits inside a cell, as a 0..1 offset. */
export const anchorOffset = (anchor: Anchor, size: number): { x: number; y: number } => {
  const free = 1 - size
  const x = anchor.includes('l') ? 0 : anchor.includes('r') ? free : free / 2
  const y = anchor.startsWith('t') ? 0 : anchor.startsWith('b') ? free : free / 2
  return { x, y }
}
