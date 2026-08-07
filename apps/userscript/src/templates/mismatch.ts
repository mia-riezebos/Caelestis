import { TILE_SIZE, type TileCoord, TRANSPARENT_INDEX } from '@wts/shared'
import { count } from '../debug.js'
import { tilePixels, UNPAINTED } from '../tile-transform.js'
import { hiddenColoursFor } from './colour-filter.js'
import type { PlacedTemplate } from './local-store.js'

/**
 * Which pixels of a template the canvas disagrees with, per tile.
 *
 * Found here rather than in a shader, and that is the whole point. A template has a handful of wrong
 * pixels and the screen has millions of fragments; asking the question per fragment made the cost
 * scale with the wrong thing, badly enough to take the GPU down. Asking it per pixel, once, and
 * handing the answers to the renderer as a list makes it scale with the number of answers.
 *
 * Once per tile per filter change, not per frame. The comparison walks the part of the template that
 * falls inside one tile — a million pixels at the very most — which is fine to do occasionally and
 * ruinous to do sixty times a second, hence the cache.
 */

/** x,y pairs in canvas pixels. Empty when the tile and template agree. */
export type Mismatches = Float32Array

interface Cached {
  /** Identity, not contents: a re-captured tile is a new array, and that is the signal to redo it. */
  readonly source: Uint8Array
  readonly key: string
  readonly result: Mismatches
}

const cache = new Map<string, Cached>()

/**
 * How long scanning may take in one frame, in milliseconds.
 *
 * A budget in time rather than in tiles. A scan is up to a million comparisons but usually far
 * fewer — a template covers only part of a tile, and most tiles are not covered at all — so "one
 * tile per frame" made a screenful take as many frames as there were tiles regardless of whether
 * that was 2ms of work or 20. Spending a slice of the frame instead does the cheap ones together
 * and still never blocks on the expensive ones.
 *
 * Eight milliseconds leaves room in a 16ms frame for MapLibre to draw the map it is in the middle
 * of. This is checked *between* tiles, so one scan can still overrun it; the guarantee is that the
 * budget bounds the queue, not any single scan.
 */
const SCAN_BUDGET_MS = 8
let scanDeadline = 0

/** Called once per frame by the renderer, before it asks for anything. */
export const beginMismatchFrame = (): void => {
  scanDeadline = performance.now() + SCAN_BUDGET_MS
}

/** Everything that changes the answer, so a stale entry is never returned. */
const signature = (template: PlacedTemplate): string => {
  const appearance = template.appearance
  const hidden = hiddenColoursFor(appearance).join(',')
  return `${template.moved}|${appearance?.markUnpainted === true}|${hidden}`
}

/**
 * The disagreements between one template and one tile.
 *
 * Null means "not answerable yet" — the tile's pixels have not been captured — which is different
 * from an empty result, and the caller should draw nothing rather than assume agreement.
 */
export const mismatchesIn = (template: PlacedTemplate, tile: TileCoord): Mismatches | null => {
  const pixels = tilePixels(tile)
  if (pixels === null) return null

  const cacheKey = `${template.id}|${tile.x}/${tile.y}`
  const key = signature(template)
  const existing = cache.get(cacheKey)
  if (existing !== undefined && existing.source === pixels && existing.key === key) {
    return existing.result
  }
  // Out of budget: answer next frame rather than block this one. A stale result would be worse than
  // none, since it would put crosshairs on pixels that have since been fixed.
  if (performance.now() >= scanDeadline) return null

  const tileLeft = tile.x * TILE_SIZE
  const tileTop = tile.y * TILE_SIZE
  const left = Math.max(template.originX, tileLeft)
  const top = Math.max(template.originY, tileTop)
  const right = Math.min(template.originX + template.width, tileLeft + TILE_SIZE)
  const bottom = Math.min(template.originY + template.height, tileTop + TILE_SIZE)
  if (right <= left || bottom <= top) {
    const empty = new Float32Array(0)
    cache.set(cacheKey, { source: pixels, key, result: empty })
    return empty
  }

  /**
   * "Is this colour one we are asserting", as a lookup rather than a question.
   *
   * A pixel we are not drawing is a pixel whose colour we are not claiming: the wildcard asks for
   * nothing, and a filtered colour is one the user has said to stop showing. Neither can be wrong,
   * and marking them would bury the ones that are.
   *
   * Folding all of that into one table before the loop is most of the speed here. A `Set.has` per
   * pixel is a hash of a boxed number a million times over, for an answer that only has 256 possible
   * inputs.
   */
  const asserted = new Uint8Array(256)
  asserted.fill(1)
  asserted[TRANSPARENT_INDEX] = 0
  asserted[UNPAINTED] = 0
  for (const index of hiddenColoursFor(template.appearance)) asserted[index] = 0

  const markUnpainted = template.appearance?.markUnpainted === true
  // Local aliases: property lookups on the template inside a million-iteration loop are not free.
  const wantedPixels = template.indices
  const templateWidth = template.width
  const originX = template.originX
  const originY = template.originY

  const found: number[] = []
  for (let y = top; y < bottom; y++) {
    let templateAt = (y - originY) * templateWidth + (left - originX)
    let tileAt = (y - tileTop) * TILE_SIZE + (left - tileLeft)
    for (let x = left; x < right; x++, templateAt++, tileAt++) {
      const wanted = wantedPixels[templateAt] as number
      if (asserted[wanted] === 0) continue
      const placed = pixels[tileAt] as number
      if (placed === wanted) continue
      if (placed === UNPAINTED && !markUnpainted) continue
      found.push(x, y)
    }
  }

  const result = new Float32Array(found)
  cache.set(cacheKey, { source: pixels, key, result })
  count('mismatch:tiles scanned')
  count('mismatch:pixels marked', found.length / 2)
  return result
}

/** Forget everything for a template that has gone, so its tiles are not held alive by the cache. */
export const forgetMismatches = (id: string): void => {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${id}|`)) cache.delete(key)
  }
}
