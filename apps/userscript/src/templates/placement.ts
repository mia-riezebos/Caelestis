import { WORLD_PIXELS } from '@caelestis/shared'

export interface HorizontalPlacement {
  readonly originX: number
  readonly width: number
  readonly wrapX?: boolean
}

export interface HorizontalSpan {
  readonly worldStart: number
  readonly worldEnd: number
  readonly sourceStart: number
  readonly sourceEnd: number
}

/** Contiguous world runs for a source whose last columns may wrap through the antimeridian. */
export const horizontalSpans = (template: HorizontalPlacement): readonly HorizontalSpan[] => {
  if (template.wrapX !== true || template.originX + template.width <= WORLD_PIXELS) {
    return [
      {
        worldStart: template.originX,
        worldEnd: template.originX + template.width,
        sourceStart: 0,
        sourceEnd: template.width,
      },
    ]
  }
  const eastWidth = WORLD_PIXELS - template.originX
  return [
    {
      worldStart: template.originX,
      worldEnd: WORLD_PIXELS,
      sourceStart: 0,
      sourceEnd: eastWidth,
    },
    {
      worldStart: 0,
      worldEnd: template.width - eastWidth,
      sourceStart: eastWidth,
      sourceEnd: template.width,
    },
  ]
}

export const horizontalSpanAt = (
  template: HorizontalPlacement,
  worldX: number,
): HorizontalSpan | null =>
  horizontalSpans(template).find((span) => worldX >= span.worldStart && worldX < span.worldEnd) ??
  null

/** Source column at a world x coordinate, or null when the template does not cover it. */
export const sourceXAt = (template: HorizontalPlacement, worldX: number): number | null => {
  const span = horizontalSpanAt(template, worldX)
  return span === null ? null : span.sourceStart + worldX - span.worldStart
}

/** A virtual contiguous origin for scanning one world run with the ordinary rectangle algorithm. */
export const virtualOriginXAt = (template: HorizontalPlacement, worldX: number): number | null => {
  const span = horizontalSpanAt(template, worldX)
  return span === null ? null : span.worldStart - span.sourceStart
}

export const horizontalCentre = (template: HorizontalPlacement): number =>
  template.wrapX === true
    ? (template.originX + template.width / 2) % WORLD_PIXELS
    : template.originX + template.width / 2

/** Shortest signed distance on the wrapping x axis. */
export const wrappedDeltaX = (from: number, to: number): number => {
  const direct = to - from
  if (Math.abs(direct) <= WORLD_PIXELS / 2) return direct
  return direct > 0 ? direct - WORLD_PIXELS : direct + WORLD_PIXELS
}
