import { PALETTE_SIZE, TRANSPARENT_INDEX } from '@wts/shared'

/**
 * How one overlay is drawn.
 *
 * Every pixel is a square, and the controls deform it. There is no shape *mode*, because a mode list
 * is just a handful of frozen points in this space with worse names — "Dot" is a full-radius stamp
 * at a small size, "Corner" is a rotated stamp translated into a corner and clipped, and "Full" and
 * "Square" were the same shape at two sizes, split only because one had a cheaper render path.
 *
 * Each stamp is clipped to its own cell, so translating or rotating past the edge cuts the stamp off
 * rather than bleeding into the neighbouring pixel. That clipping is what makes partial corners and
 * wedges reachable at all.
 *
 * Order matters: **translate, then rotate**, both about the cell's centre. The offset is therefore
 * measured along the stamp's own axes, so rotating a translated stamp swings it around rather than
 * sliding it sideways.
 *
 * **Scale is the entire performance story.** Drawing anything other than a plain full cell means
 * rendering each source pixel as an SxS block, and cost is quadratic: S=1 is free, S=3 costs 36 MB
 * per tile, S=5 costs 100 MB. So scale is derived, not offered — an appearance that happens to be a
 * plain full square pays nothing, and anything else opts into the bill by being asked for.
 */

export interface Appearance {
  /** Fraction of the cell the stamp covers, 0..1. */
  readonly size: number
  /** Corner rounding as a fraction of half the stamp: 0 is a square, 1 is a circle. */
  readonly radius: number
  /** Offset within the cell, in cell widths, applied before rotation. */
  readonly translateX: number
  readonly translateY: number
  /** Rotation of each stamp in degrees. 45 turns squares into diamonds. */
  readonly rotation: number
  readonly opacity: number
  /** Palette indices hidden for this overlay specifically. */
  readonly hiddenColours: readonly number[]
}

export const DEFAULT_APPEARANCE: Appearance = {
  size: 1,
  radius: 0,
  translateX: 0,
  translateY: 0,
  rotation: 0,
  opacity: 1,
  hiddenColours: [],
}

/**
 * A stored appearance, made safe to use.
 *
 * Anything persisted before a field existed simply lacks it, and `undefined` propagates straight
 * through the arithmetic into `NaN` — which reads back as `NaN%` in the UI and silently poisons
 * every transform in the renderer. Numbers are also clamped, because a stored value from an older
 * range is worse than no value at all.
 *
 * Returns null for an appearance that says nothing, so the overlay falls back to the global default
 * rather than to a half-populated object.
 */
export const normaliseAppearance = (raw: unknown): Appearance | null => {
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const value = source[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
  }
  const hidden = Array.isArray(source.hiddenColours)
    ? source.hiddenColours.filter((index): index is number => typeof index === 'number')
    : []
  return {
    size: number('size', DEFAULT_APPEARANCE.size, 0.05, 1),
    radius: number('radius', DEFAULT_APPEARANCE.radius, 0, 1),
    translateX: number('translateX', DEFAULT_APPEARANCE.translateX, -1, 1),
    translateY: number('translateY', DEFAULT_APPEARANCE.translateY, -1, 1),
    rotation: number('rotation', DEFAULT_APPEARANCE.rotation, 0, 360),
    opacity: number('opacity', DEFAULT_APPEARANCE.opacity, 0.05, 1),
    hiddenColours: hidden,
  }
}

/**
 * Whether this appearance is just the source pixels, untouched.
 *
 * Opacity is excluded on purpose: it is applied at draw time with `globalAlpha`, so it never costs a
 * re-stamp and never forces the expensive path.
 */
export const isPlain = (appearance: Appearance): boolean =>
  appearance.size >= 1 &&
  appearance.radius === 0 &&
  appearance.translateX === 0 &&
  appearance.translateY === 0 &&
  appearance.rotation === 0

/**
 * Render scale for an appearance.
 *
 * A plain full cell needs no upscaling. Anything else needs enough resolution for the deformation to
 * read — 3 is what Blue Marble uses and is the smallest that keeps a rotated or rounded stamp from
 * turning to mush.
 */
export const scaleFor = (appearance: Appearance): number => (isPlain(appearance) ? 1 : 3)

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

/** The controls, in the order they are shown. One row each, all the same shape. */
export const APPEARANCE_CONTROLS: ReadonlyArray<{
  key: 'size' | 'radius' | 'translateX' | 'translateY' | 'rotation' | 'opacity'
  label: string
  min: number
  max: number
  step: number
  /** How to read the value back to the user. */
  format: (value: number) => string
}> = [
  {
    key: 'size',
    label: 'Size',
    min: 0.1,
    max: 1,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'radius',
    label: 'Rounding',
    min: 0,
    max: 1,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'translateX',
    label: 'Offset X',
    min: -0.5,
    max: 0.5,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'translateY',
    label: 'Offset Y',
    min: -0.5,
    max: 0.5,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'rotation',
    label: 'Rotation',
    min: 0,
    max: 90,
    step: 1,
    format: (v) => `${Math.round(v)}°`,
  },
  {
    key: 'opacity',
    label: 'Opacity',
    min: 0.05,
    max: 1,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
]
