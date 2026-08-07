import { TILE_SIZE, type TileCoord, TRANSPARENT_INDEX } from '@wts/shared'
import { count } from '../debug.js'
import {
  ensureTilePixels,
  onTileBulk,
  onTilePixel,
  tilePixels,
  UNPAINTED,
} from '../tile-transform.js'
import { hiddenColoursFor } from './colour-filter.js'
import {
  appearanceOf,
  isTemplateVisible,
  localTemplates,
  type PlacedTemplate,
} from './local-store.js'

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
 * How many answers to keep, across every template and tile.
 *
 * Unbounded, this grew with every tile ever visited — a marked tile's list can be tens of thousands
 * of coordinates — and together with the tile pixels themselves it took the tab out of memory.
 * Generous next to what fits on screen, so nothing being looked at is ever dropped.
 */
const KEEP_ANSWERS = 128

const evict = (): void => {
  while (cache.size > KEEP_ANSWERS) {
    // Insertion order, and a hit re-inserts, so the front is the least recently used.
    const oldest = cache.keys().next().value
    if (oldest === undefined) return
    cache.delete(oldest)
    count('mismatch:evicted an answer')
  }
}

/** Bumped whenever a cached answer is patched, so a listener can tell that anything happened. */
let changed = 0

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

/**
 * Whether anything currently wants to know what disagrees.
 *
 * Kept here rather than worked out at draw time so it can be answered before the first frame. The
 * tiles on screen at load are decoded exactly once, and if capture is not on by then we miss all of
 * them and have to read every one back from a preview later — paying twice for pixels that went
 * past us while we were not looking.
 */
export const wantsTilePixels = (): boolean =>
  localTemplates().some(
    (template) => isTemplateVisible(template) && appearanceOf(template).markMismatch,
  )

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
  if (pixels === null) {
    // Never decoded while we were watching. Go and get it rather than wait for wplace to.
    ensureTilePixels(tile)
    return null
  }

  const cacheKey = `${template.id}|${tile.x}/${tile.y}`
  const key = signature(template)
  const existing = cache.get(cacheKey)
  if (existing !== undefined && existing.source === pixels && existing.key === key) {
    // Re-inserted so a hit counts as recent: eviction takes from the front.
    cache.delete(cacheKey)
    cache.set(cacheKey, existing)
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
  evict()
  count('mismatch:tiles scanned')
  count('mismatch:pixels marked', found.length / 2)
  return result
}

/**
 * Update one cached answer for one changed pixel, instead of asking the tile again.
 *
 * Painting is the moment this matters. A placed pixel changes exactly one cell, and the write that
 * carried it already said which and to what — so rescanning a tile to find out whether the marker
 * should go is a million comparisons to learn one, on the interaction that most needs to stay
 * responsive.
 *
 * The rebuild is over the tile's own mismatches rather than its pixels, which is the difference
 * between thousands and a million.
 */
const patchTile = (tile: TileCoord, x: number, y: number, placed: number): void => {
  for (const [cacheKey, entry] of cache) {
    if (!cacheKey.endsWith(`|${tile.x}/${tile.y}`)) continue
    const id = cacheKey.slice(0, cacheKey.lastIndexOf('|'))
    const template = localTemplates().find((candidate) => candidate.id === id)
    if (template === undefined) continue

    const localX = x - template.originX
    const localY = y - template.originY
    if (localX < 0 || localY < 0 || localX >= template.width || localY >= template.height) continue
    const wanted = template.indices[localY * template.width + localX]
    if (wanted === undefined) continue

    const hidden = hiddenColoursFor(template.appearance)
    const asserted =
      wanted !== TRANSPARENT_INDEX && wanted !== UNPAINTED && !hidden.includes(wanted)
    const markUnpainted = template.appearance?.markUnpainted === true
    const wrong = asserted && placed !== wanted && !(placed === UNPAINTED && !markUnpainted)

    const marks = entry.result
    let at = -1
    for (let i = 0; i < marks.length; i += 2) {
      if (marks[i] === x && marks[i + 1] === y) {
        at = i
        break
      }
    }
    if (wrong === at >= 0) continue

    let next: Float32Array
    if (wrong) {
      next = new Float32Array(marks.length + 2)
      next.set(marks)
      next[marks.length] = x
      next[marks.length + 1] = y
    } else {
      next = new Float32Array(marks.length - 2)
      next.set(marks.subarray(0, at))
      next.set(marks.subarray(at + 2), at)
    }
    cache.set(cacheKey, { source: entry.source, key: entry.key, result: next })
    changed++
    count(wrong ? 'mismatch:pixel became wrong' : 'mismatch:pixel fixed')
  }
}

const changeListeners: Array<() => void> = []

/**
 * Notified when a cached answer changes outside a frame.
 *
 * Painting is not a map movement, so nothing asks MapLibre to draw when it happens — and a marker
 * that has been cleared in memory but not on screen is indistinguishable from one that has not been
 * cleared at all. This is what turns a patch into a repaint.
 */
export const onMismatchesChanged = (listener: () => void): void => {
  changeListeners.push(listener)
}

/**
 * A tile changed too much to reason about one pixel at a time, so drop what we knew about it.
 *
 * Dropping is cheaper than patching here, and by a lot: the next scan is one pass over the tile,
 * where patching would have been a scan of the answer list per changed pixel.
 */
onTileBulk((tile) => {
  const suffix = `|${tile.x}/${tile.y}`
  let dropped = 0
  for (const key of [...cache.keys()]) {
    if (!key.endsWith(suffix)) continue
    cache.delete(key)
    dropped++
  }
  if (dropped === 0) return
  count('mismatch:dropped answers for a bulk change', dropped)
  for (const listener of changeListeners) listener()
})

onTilePixel((tile, x, y, placed) => {
  const before = changed
  patchTile(tile, x, y, placed)
  if (changed === before) return
  for (const listener of changeListeners) listener()
})

/** Forget everything for a template that has gone, so its tiles are not held alive by the cache. */
export const forgetMismatches = (id: string): void => {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${id}|`)) cache.delete(key)
  }
}
