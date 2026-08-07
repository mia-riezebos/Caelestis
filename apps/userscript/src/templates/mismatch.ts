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
 * How many tiles may be scanned in one frame.
 *
 * A scan is up to a million comparisons. Turning the feature on with a screen full of tiles asks for
 * all of them at once, and doing that in one frame is a stall measured in seconds — the same mistake
 * as the shader version, moved to the CPU. One per frame fills the screen in under half a second and
 * never blocks a frame for more than a scan.
 */
const SCANS_PER_FRAME = 1
let scansLeft = SCANS_PER_FRAME

/** Called once per frame by the renderer, before it asks for anything. */
export const beginMismatchFrame = (): void => {
  scansLeft = SCANS_PER_FRAME
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
  if (scansLeft <= 0) return null
  scansLeft--

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

  const hidden = new Set(hiddenColoursFor(template.appearance))
  const markUnpainted = template.appearance?.markUnpainted === true
  const found: number[] = []
  for (let y = top; y < bottom; y++) {
    const templateRow = (y - template.originY) * template.width - template.originX
    const tileRow = (y - tileTop) * TILE_SIZE - tileLeft
    for (let x = left; x < right; x++) {
      const wanted = template.indices[templateRow + x]
      // A pixel we are not drawing is a pixel whose colour we are not asserting: the wildcard asks
      // for nothing, and a filtered colour is one the user has said to stop showing. Neither can be
      // wrong, and marking them would bury the ones that are.
      if (wanted === undefined || wanted === TRANSPARENT_INDEX || hidden.has(wanted)) continue
      const placed = pixels[tileRow + x]
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
