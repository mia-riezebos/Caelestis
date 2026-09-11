import {
  encodePresenceDraft,
  type PresenceDraft,
  type PresenceRect,
  quantiseRect,
  TILE_SIZE,
  type TileCoord,
  WORLD_PIXELS,
} from '@caelestis/shared'
import type { TileFrame } from './tile-transform.js'

/** Drafts past this many pixels publish their rect and count only; scanning stops here. */
export const MAX_PUBLISHED_DRAFT_PIXELS = 4_096

/**
 * The canvas-pixel rect the whole map canvas covers, read from where Wplace drew its tiles.
 *
 * Any tile quad is a complete affine reference: its on-screen rect and its tile coordinate give
 * the scale and the origin, so the canvas corners map straight back to canvas pixels. Nothing here
 * projects through MapLibre, which keeps this consistent with the overlay's own placement.
 *
 * A viewport straddling the antimeridian clamps to the canonical world; the far side is rare and
 * not worth a second rect on the wire.
 */
export const viewportRectIn = (frame: TileFrame): PresenceRect | null => {
  const reference = frame.quads[0]
  if (reference === undefined || reference.width <= 0 || reference.height <= 0) return null
  const scaleX = TILE_SIZE / reference.width
  const scaleY = TILE_SIZE / reference.height
  const originX = reference.tile.x * TILE_SIZE - reference.x * scaleX
  const originY = reference.tile.y * TILE_SIZE - reference.y * scaleY
  const left = Math.max(0, Math.floor(originX))
  const top = Math.max(0, Math.floor(originY))
  const right = Math.min(WORLD_PIXELS, Math.ceil(originX + frame.canvas.width * scaleX))
  const bottom = Math.min(WORLD_PIXELS, Math.ceil(originY + frame.canvas.height * scaleY))
  if (right <= left || bottom <= top) return null
  return quantiseRect({ x: left, y: top, w: right - left, h: bottom - top })
}

/**
 * The drafted pixels across every tile that holds any, as one bounded presence draft.
 *
 * `offsetsOf` yields tile-local `y * TILE_SIZE + x` offsets, the shape the draft capture keeps.
 */
export const draftIn = (
  tiles: readonly TileCoord[],
  offsetsOf: (tile: TileCoord) => Iterable<number>,
): PresenceDraft | null => {
  const pixels: { x: number; y: number }[] = []
  let truncated = false
  for (const tile of tiles) {
    const baseX = tile.x * TILE_SIZE
    const baseY = tile.y * TILE_SIZE
    for (const offset of offsetsOf(tile)) {
      if (pixels.length >= MAX_PUBLISHED_DRAFT_PIXELS) {
        truncated = true
        break
      }
      pixels.push({ x: baseX + (offset % TILE_SIZE), y: baseY + Math.floor(offset / TILE_SIZE) })
    }
    if (truncated) break
  }
  const draft = encodePresenceDraft(pixels)
  if (draft === null || !truncated) return draft
  // A cut-off scan cannot promise the mask is complete; hand peers the rect and a floor count.
  return { rect: draft.rect, pixels: draft.pixels }
}

/** Where `rect` lands on the canvas this frame, in device pixels, or null when off screen. */
export const rectOnScreen = (
  frame: TileFrame,
  rect: PresenceRect,
): {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
} | null => {
  const reference = frame.quads[0]
  if (reference === undefined || reference.width <= 0 || reference.height <= 0) return null
  const scaleX = reference.width / TILE_SIZE
  const scaleY = reference.height / TILE_SIZE
  const x = reference.x + (rect.x - reference.tile.x * TILE_SIZE) * scaleX
  const y = reference.y + (rect.y - reference.tile.y * TILE_SIZE) * scaleY
  const width = rect.w * scaleX
  const height = rect.h * scaleY
  if (x + width <= 0 || y + height <= 0 || x >= frame.canvas.width || y >= frame.canvas.height)
    return null
  return { x, y, width, height }
}
