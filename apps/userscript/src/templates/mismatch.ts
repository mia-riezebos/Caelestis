import { TILE_SIZE, type TileCoord, TRANSPARENT_INDEX } from '@wts/shared'
import { count } from '../debug.js'
import {
  draftPixels,
  ensureTilePixels,
  onTilePixel,
  tilePixels,
  UNPAINTED,
} from '../tile-transform.js'
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
  /**
   * The two kinds of disagreement, kept apart.
   *
   * Whether the second kind counts is not a property of the tile — it depends on how much of the
   * *template* is still unpainted, which is not knowable while scanning one tile of it. Deciding at
   * the point the answer is read means the threshold, and the switch above it, cost nothing to change
   * their mind about: no tile is rescanned for either.
   */
  readonly wrong: Mismatches
  readonly unpainted: Mismatches
  /** Pixels this tile asserts a colour for. The denominator the threshold is measured against. */
  readonly asserted: number
  /** The two concatenated, built the first time they are asked for together. */
  both: Mismatches | null
}

const answerFrom = (entry: Cached, includeUnpainted: boolean): Mismatches => {
  if (!includeUnpainted || entry.unpainted.length === 0) return entry.wrong
  if (entry.wrong.length === 0) return entry.unpainted
  if (entry.both === null) {
    const both = new Float32Array(entry.wrong.length + entry.unpainted.length)
    both.set(entry.wrong)
    both.set(entry.unpainted, entry.wrong.length)
    entry.both = both
  }
  return entry.both
}

/**
 * Whether this template is finished enough for its unpainted pixels to be worth marking.
 *
 * Summed over the tiles that have been scanned rather than over the template, because a template is
 * only ever partly loaded — the tiles off screen have no pixels to count. The tiles in front of
 * someone are the ones the answer is about, so the ratio is over those, and it settles as more of
 * them arrive rather than being wrong until the last one does.
 */
const countsUnpainted = (template: PlacedTemplate): boolean => {
  const appearance = appearanceOf(template)
  if (!appearance.markUnpainted) return false
  const key = signature(template)
  let asserted = 0
  let unpainted = 0
  for (const [cacheKey, entry] of cache) {
    if (!cacheKey.startsWith(`${template.id}|`) || entry.key !== key) continue
    asserted += entry.asserted
    unpainted += entry.unpainted.length / 2
  }
  if (asserted === 0) return false
  return unpainted / asserted <= appearance.unpaintedLimit
}

const cache = new Map<string, Cached>()

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
 * Answers a frame asked for and could not afford, to be redone when the page is idle.
 *
 * A tile that has just been re-fetched needs a full rescan, and waiting for a frame to pay for it
 * means the work happens during the frame — competing with the map for the same milliseconds, at
 * exactly the moment someone is panning. Idle time is free, and until it arrives the previous answer
 * is still on screen.
 */
const stale = new Set<string>()
let idleScheduled = false

type IdleWindow = typeof globalThis & {
  requestIdleCallback?: (callback: (deadline: { timeRemaining: () => number }) => void) => void
}

const runIdleScan = (deadline: { timeRemaining: () => number }): void => {
  idleScheduled = false
  // Borrow the frame budget: the same guard, spending idle time instead of a frame's.
  scanDeadline = performance.now() + Math.max(deadline.timeRemaining(), 1)
  for (const cacheKey of [...stale]) {
    if (performance.now() >= scanDeadline) break
    const [id, coords] = cacheKey.split('|')
    const [x, y] = (coords ?? '').split('/').map(Number)
    const template = localTemplates().find((candidate) => candidate.id === id)
    if (template === undefined || x === undefined || y === undefined) {
      stale.delete(cacheKey)
      continue
    }
    mismatchesIn(template, { x, y })
    count('mismatch:rescanned while idle')
  }
  scanDeadline = 0
  if (stale.size > 0) scheduleIdleScan()
  for (const listener of changeListeners) listener()
}

const scheduleIdleScan = (): void => {
  if (idleScheduled) return
  const idle = (globalThis as IdleWindow).requestIdleCallback
  if (idle === undefined) return
  idleScheduled = true
  idle(runIdleScan)
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

/**
 * Which colours this template is not claiming — the switches, not what is on screen.
 *
 * Deliberately not `hiddenColoursFor`, which is what the *renderer* asks and which answers with the
 * follow-the-selection mode's set while that mode is driving. A colour switched off by hand is a
 * colour the user has said to stop caring about, and marking it would bury the ones that matter. A
 * colour hidden because it is not the one currently being placed is nothing of the sort — it is
 * hidden for this minute, to see one colour at a time.
 *
 * Reading the mode here made the markers vanish along with the pixels, which is backwards: seeing
 * every mismatch while placing one colour is how you work through them a colour at a time.
 */
const assertedHidden = (template: PlacedTemplate): readonly number[] =>
  appearanceOf(template).hiddenColours

/**
 * Everything that changes what a scan finds, so a stale entry is never returned.
 *
 * "Count unpainted" is deliberately not part of it, nor is its threshold. Both decide which of two
 * lists to hand back, not what goes in them, so neither is a reason to look at a tile again.
 */
const signature = (template: PlacedTemplate): string =>
  `${template.moved}|${assertedHidden(template).join(',')}`

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
    return answerFrom(existing, countsUnpainted(template))
  }

  /**
   * Out of budget: keep showing the last answer rather than none.
   *
   * The old answer is out of date by exactly the pixels that have changed since, and those are
   * patched into it the moment they change — so it is not stale in the way that matters, and a
   * recompute is a background refresh rather than a correction. Returning null instead meant every
   * marker on a tile blinked out for as long as the rescan was queued, which reads as the feature
   * being broken rather than busy.
   *
   * Null is kept for the one case it belongs to: no answer has ever been computed for this tile.
   */
  if (performance.now() >= scanDeadline) {
    stale.add(cacheKey)
    scheduleIdleScan()
    if (existing === undefined) return null
    count('mismatch:showed the previous answer while busy')
    return answerFrom(existing, countsUnpainted(template))
  }
  stale.delete(cacheKey)

  const tileLeft = tile.x * TILE_SIZE
  const tileTop = tile.y * TILE_SIZE
  const left = Math.max(template.originX, tileLeft)
  const top = Math.max(template.originY, tileTop)
  const right = Math.min(template.originX + template.width, tileLeft + TILE_SIZE)
  const bottom = Math.min(template.originY + template.height, tileTop + TILE_SIZE)
  if (right <= left || bottom <= top) {
    const empty = new Float32Array(0)
    cache.set(cacheKey, {
      source: pixels,
      key,
      wrong: empty,
      unpainted: empty,
      asserted: 0,
      both: empty,
    })
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
  for (const index of assertedHidden(template)) asserted[index] = 0

  // Local aliases: property lookups on the template inside a million-iteration loop are not free.
  const wantedPixels = template.indices
  const templateWidth = template.width
  const originX = template.originX
  const originY = template.originY

  /**
   * The draft layer, if this tile has one. Three states, and the answer needs all three.
   *
   * A pixel placed and not submitted is not on the server, so comparing the template against the
   * server alone says a pixel just fixed is still wrong. Merging the draft into the server instead
   * needed an override map to survive the next fetch and put that bookkeeping on the path that runs
   * while someone is painting. Resolving at the comparison is the whole of it:
   *
   *     effective = drafted here ? draft : server
   */
  const draft = draftPixels(tile)

  /**
   * The two kinds, separated as they are found.
   *
   * An empty pixel is only "not done yet" when nobody chose it, so a pixel drafted Transparent is
   * never one of these — it arrives as `TRANSPARENT_INDEX` rather than `UNPAINTED`, and lands in
   * `wrong` with the rest of the mistakes.
   */
  const wrong: number[] = []
  const unpainted: number[] = []
  let assertedHere = 0
  for (let y = top; y < bottom; y++) {
    let templateAt = (y - originY) * templateWidth + (left - originX)
    let tileAt = (y - tileTop) * TILE_SIZE + (left - tileLeft)
    for (let x = left; x < right; x++, templateAt++, tileAt++) {
      const wanted = wantedPixels[templateAt] as number
      if (asserted[wanted] === 0) continue
      assertedHere++
      const drafted = draft === null ? UNPAINTED : (draft[tileAt] as number)
      const placed = drafted !== UNPAINTED ? drafted : (pixels[tileAt] as number)
      if (placed === wanted) continue
      if (placed === UNPAINTED) unpainted.push(x, y)
      else wrong.push(x, y)
    }
  }

  const entry: Cached = {
    source: pixels,
    key,
    wrong: new Float32Array(wrong),
    unpainted: new Float32Array(unpainted),
    asserted: assertedHere,
    both: null,
  }
  cache.set(cacheKey, entry)
  count('mismatch:tiles scanned')
  count('mismatch:pixels marked', wrong.length / 2)
  count('mismatch:pixels unpainted', unpainted.length / 2)
  return answerFrom(entry, countsUnpainted(template))
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
const patchTile = (tile: TileCoord, x: number, y: number, drafted: number): void => {
  // The write says what was drafted. What matters is the effective colour, which falls back to the
  // server's pixel wherever the draft has nothing — undrafting a pixel is a change too.
  const server = tilePixels(tile)
  const at = (y - tile.y * TILE_SIZE) * TILE_SIZE + (x - tile.x * TILE_SIZE)
  const placed =
    drafted !== UNPAINTED ? drafted : server === null ? UNPAINTED : (server[at] as number)
  let considered = 0
  for (const [cacheKey, entry] of cache) {
    if (!cacheKey.endsWith(`|${tile.x}/${tile.y}`)) continue
    considered++
    const id = cacheKey.slice(0, cacheKey.lastIndexOf('|'))
    const template = localTemplates().find((candidate) => candidate.id === id)
    if (template === undefined) {
      count('patch:no template for that answer')
      continue
    }

    const localX = x - template.originX
    const localY = y - template.originY
    if (localX < 0 || localY < 0 || localX >= template.width || localY >= template.height) {
      count('patch:pixel is outside the template')
      continue
    }
    const wanted = template.indices[localY * template.width + localX]
    if (wanted === undefined) {
      count('patch:no template pixel there')
      continue
    }

    const hidden = assertedHidden(template)
    const asserted =
      wanted !== TRANSPARENT_INDEX && wanted !== UNPAINTED && !hidden.includes(wanted)

    /**
     * Which list this pixel belongs in now, if any.
     *
     * The same split the scan makes, so a patched answer and a rescanned one agree. Whether the
     * unpainted list is *shown* is not decided here — it is decided when the answer is read, and a
     * pixel that moves in or out of that list can change the ratio it is decided by.
     */
    const belongs =
      !asserted || placed === wanted ? null : placed === UNPAINTED ? 'unpainted' : 'wrong'

    const listed = (marks: Mismatches): number => {
      for (let i = 0; i < marks.length; i += 2) {
        if (marks[i] === x && marks[i + 1] === y) return i
      }
      return -1
    }
    const inWrong = listed(entry.wrong)
    const inUnpainted = listed(entry.unpainted)
    const already = inWrong >= 0 ? 'wrong' : inUnpainted >= 0 ? 'unpainted' : null
    if (already === belongs) {
      count(`patch:already ${belongs ?? 'clear'} — wanted ${wanted}, placed ${placed}`)
      continue
    }

    const minus = (marks: Mismatches, at: number): Mismatches => {
      const next = new Float32Array(marks.length - 2)
      next.set(marks.subarray(0, at))
      next.set(marks.subarray(at + 2), at)
      return next
    }
    const plus = (marks: Mismatches): Mismatches => {
      const next = new Float32Array(marks.length + 2)
      next.set(marks)
      next[marks.length] = x
      next[marks.length + 1] = y
      return next
    }

    let { wrong, unpainted } = entry
    if (inWrong >= 0) wrong = minus(wrong, inWrong)
    if (inUnpainted >= 0) unpainted = minus(unpainted, inUnpainted)
    if (belongs === 'wrong') wrong = plus(wrong)
    if (belongs === 'unpainted') unpainted = plus(unpainted)

    cache.set(cacheKey, {
      source: entry.source,
      key: entry.key,
      wrong,
      unpainted,
      asserted: entry.asserted,
      both: null,
    })
    changed++
    count(belongs === null ? 'mismatch:pixel fixed' : `mismatch:pixel became ${belongs}`)
  }
  if (considered === 0) count('patch:no cached answer for that tile')
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

onTilePixel((tile, x, y, placed) => {
  count('patch:notified of a pixel')
  const before = changed
  patchTile(tile, x, y, placed)
  if (changed === before) return
  for (const listener of changeListeners) listener()
})
// Module scope on purpose: if this never appears, the body of this file never ran, and the listener
// above was never registered — which is a different failure from the listener deciding to do
// nothing, and the counters cannot otherwise tell the two apart.
count('patch:mismatch module loaded')

/** Forget everything for a template that has gone, so its tiles are not held alive by the cache. */
export const forgetMismatches = (id: string): void => {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${id}|`)) cache.delete(key)
  }
}
