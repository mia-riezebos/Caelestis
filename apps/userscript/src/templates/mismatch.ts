import { TILE_SIZE, type TileCoord, TRANSPARENT_INDEX } from '@caelestis/shared'
import { count } from '../debug.js'
import {
  draftPixels,
  ensureTilePixels,
  onTilePixel,
  tilePixels,
  UNPAINTED,
} from '../tile-transform.js'
import { claimedHiddenFor } from './colour-filter.js'
import {
  appearanceOf,
  isTemplateVisible,
  localTemplates,
  onLocalChange,
  type PlacedTemplate,
} from './local-store.js'
import { type ScanJob, type ScanOutcome, scanTile } from './mismatch-scan.js'
import { forgetInWorker, hasWorker, scanInWorker } from './mismatch-worker.js'
import { horizontalSpans, sourceXAt } from './placement.js'

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

/** x,y,wanted-index triples in canvas pixels. Empty when the tile and template agree. */
export type Mismatches = Float32Array

interface Cached {
  /** Identity, not contents: a re-captured tile is a new array, and that is the signal to redo it. */
  readonly source: Uint8Array
  /** Identity of the template pixels this answer was computed against. */
  readonly templateSource: Uint8Array
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
  const total = coverageTotals.get(template.id)
  if (
    total === undefined ||
    total.asserted === 0 ||
    total.key !== key ||
    total.templateSource !== template.indices
  )
    return false
  return total.unpainted / total.asserted <= appearance.unpaintedLimit
}

const cache = new Map<string, Cached>()
const KEEP_ANSWERS = 128
const coverage = new Map<
  string,
  Pick<Cached, 'asserted' | 'key' | 'templateSource'> & {
    readonly templateId: string
    readonly unpainted: number
  }
>()
const coverageTotals = new Map<
  string,
  Pick<Cached, 'asserted' | 'key' | 'templateSource'> & { readonly unpainted: number }
>()

/**
 * A cache key is `${templateId}|${x}/${y}`, and only the tile half has a known shape. A server
 * template's id is `srv:<encoded-url>:<id>`, so the last separator is the split, never the first.
 */
const templateIdOf = (cacheKey: string): string => cacheKey.slice(0, cacheKey.lastIndexOf('|'))

const forgetCoverage = (cacheKey: string): void => {
  const entry = coverage.get(cacheKey)
  if (entry === undefined) return
  coverage.delete(cacheKey)
  const total = coverageTotals.get(entry.templateId)
  if (
    total === undefined ||
    total.key !== entry.key ||
    total.templateSource !== entry.templateSource
  )
    return
  const asserted = total.asserted - entry.asserted
  const unpainted = total.unpainted - entry.unpainted
  if (asserted === 0) coverageTotals.delete(entry.templateId)
  else coverageTotals.set(entry.templateId, { ...total, asserted, unpainted })
}

const rememberCoverage = (cacheKey: string, entry: Cached): void => {
  const templateId = templateIdOf(cacheKey)
  for (const [heldKey, held] of coverage) {
    if (
      held.templateId === templateId &&
      (held.templateSource !== entry.templateSource || held.key !== entry.key)
    ) {
      forgetCoverage(heldKey)
    }
  }
  forgetCoverage(cacheKey)
  const unpainted = entry.unpainted.length / 3
  coverage.set(cacheKey, {
    asserted: entry.asserted,
    key: entry.key,
    templateId,
    templateSource: entry.templateSource,
    unpainted,
  })
  const total = coverageTotals.get(templateId)
  coverageTotals.set(templateId, {
    asserted: (total?.asserted ?? 0) + entry.asserted,
    key: entry.key,
    templateSource: entry.templateSource,
    unpainted: (total?.unpainted ?? 0) + unpainted,
  })
}

const remember = (cacheKey: string, entry: Cached): void => {
  cache.delete(cacheKey)
  cache.set(cacheKey, entry)
  while (cache.size > KEEP_ANSWERS) {
    const oldest = cache.keys().next()
    if (!oldest.done) {
      cache.delete(oldest.value)
      forgetCoverage(oldest.value)
      // The counter is only meaningful while an answer or a scan refers to it. Kept past both, it
      // was the one structure here with no bound, growing with every tile ever painted on.
      if (!inFlight.has(oldest.value)) patchCount.delete(oldest.value)
    }
  }
}

/** Bumped whenever a cached answer is patched, so a listener can tell that anything happened. */
let changed = 0

const changeListeners: Array<() => void> = []

/**
 * One notification per task, however many answers changed in it.
 *
 * The listener is a full redraw, and a tile re-read announces every pixel that moved — so a
 * neighbouring group painting two hundred pixels of your template produced two hundred synchronous
 * repaints inside a single microtask, each one measuring and repositioning every overlay control.
 * Coalescing is safe because the listener asks "draw the current state", not "draw this change".
 */
let notifyScheduled = false

const notifyChanged = (): void => {
  if (notifyScheduled) return
  notifyScheduled = true
  queueMicrotask(() => {
    notifyScheduled = false
    for (const listener of changeListeners) {
      try {
        listener()
      } catch {
        count('mismatch:listener-failed')
      }
    }
  })
}

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
    const id = templateIdOf(cacheKey)
    const [x, y] = cacheKey
      .slice(id.length + 1)
      .split('/')
      .map(Number)
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
  notifyChanged()
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

/** The switches, not what is on screen — see `claimedHiddenFor` for why the two differ. */
const assertedHidden = (template: PlacedTemplate): readonly number[] =>
  claimedHiddenFor(appearanceOf(template))

/**
 * Everything that changes what a scan finds, so a stale entry is never returned.
 *
 * "Count unpainted" is deliberately not part of it, nor is its threshold. Both decide which of two
 * lists to hand back, not what goes in them, so neither is a reason to look at a tile again.
 */
const signature = (template: PlacedTemplate): string =>
  `${template.originX},${template.originY},${template.wrapX === true ? 1 : 0}|${template.moved}|${assertedHidden(template).join(',')}`

/**
 * Everything the comparison needs, gathered for whichever thread is going to run it.
 *
 * The two differ in one thing: what to send. A worker gets the rows the template actually covers,
 * sliced out so the copy is of the band rather than of a million pixels, and those slices are ours
 * to give away. Run here, nothing is copied at all — the arrays go in as they are, indexed from row
 * zero, which is what `bandTop` says.
 */
const buildJob = (
  template: PlacedTemplate,
  tile: TileCoord,
  pixels: Uint8Array,
  forWorker: boolean,
): ScanJob => {
  const tileLeft = tile.x * TILE_SIZE
  const tileTop = tile.y * TILE_SIZE
  const span = horizontalSpans(template).find(
    (candidate) => candidate.worldStart < tileLeft + TILE_SIZE && candidate.worldEnd > tileLeft,
  )
  const top = Math.max(template.originY, tileTop)
  const bottom = Math.min(template.originY + template.height, tileTop + TILE_SIZE)
  const bandTop = forWorker ? Math.max(0, Math.min(TILE_SIZE, top - tileTop)) : 0
  const bandBottom = forWorker
    ? Math.max(bandTop, Math.min(TILE_SIZE, bottom - tileTop))
    : TILE_SIZE
  const band = (source: Uint8Array | null): Uint8Array | null => {
    if (source === null) return null
    return forWorker ? source.slice(bandTop * TILE_SIZE, bandBottom * TILE_SIZE) : source
  }
  return {
    templateKey: template.id,
    indices: null,
    width: template.width,
    height: template.height,
    originX: span === undefined ? template.originX : span.worldStart - span.sourceStart,
    originY: template.originY,
    tileX: tile.x,
    tileY: tile.y,
    tileSize: TILE_SIZE,
    bandTop,
    server: band(pixels),
    // The draft layer, kept beside the server's pixels rather than merged into them. A pixel placed
    // and not submitted is not on the server, so comparing against the server alone says a pixel
    // just fixed is still wrong; the comparison resolves the two rather than either owning the other.
    draft: band(draftPixels(tile)),
    // A pixel we are not claiming cannot be wrong: the wildcard asserts no colour, a filtered colour
    // is one the user has said to stop caring about, and the sentinel is a state rather than a hue.
    ignored: [TRANSPARENT_INDEX, UNPAINTED, ...assertedHidden(template)],
    unpainted: UNPAINTED,
  }
}

const store = (
  cacheKey: string,
  source: Uint8Array,
  templateSource: Uint8Array,
  key: string,
  outcome: ScanOutcome,
): Cached => {
  const entry: Cached = { source, templateSource, key, ...outcome, both: null }
  rememberCoverage(cacheKey, entry)
  remember(cacheKey, entry)
  count('mismatch:tiles scanned')
  count('mismatch:pixels marked', outcome.wrong.length / 3)
  count('mismatch:pixels unpainted', outcome.unpainted.length / 3)
  return entry
}

/**
 * Tiles a worker is already looking at, against the tile array they were asked about.
 *
 * Without this, every frame between asking and answering asks again — sixty scans in flight for one
 * tile, each with its own band copied out of it.
 */
interface PendingScan {
  readonly pixels: Uint8Array
  readonly templateSource: Uint8Array
  /**
   * What the job was asked about, beyond the two byte arrays.
   *
   * The origin, the moved count and the hidden colours all change the answer while leaving both
   * arrays identical: moving a template or turning a colour off during a scan produced a reply that
   * matched on identity and was stored under its old signature, so obsolete markers stayed on screen
   * until a repaint happened to start a second scan.
   */
  readonly signature: string
  /**
   * How many patches the tile had taken when the job was built.
   *
   * A scan snapshots the draft layer into its job. A paint landing while it runs patches the cached
   * answer, and the reply then overwrote that patch with a result computed against the pre-paint
   * draft — matching on every other term, so nothing ever rescanned it.
   */
  readonly patches: number
}

/** Patches applied per cache key, so a scan can tell whether the ground moved under it. */
const patchCount = new Map<string, number>()

const inFlight = new Map<string, PendingScan>()

const requestScan = (
  template: PlacedTemplate,
  tile: TileCoord,
  pixels: Uint8Array,
  cacheKey: string,
  key: string,
): void => {
  const templateSource = template.indices
  const asked = signature(template)
  const patchesAtStart = patchCount.get(cacheKey) ?? 0
  const pending = inFlight.get(cacheKey)
  if (
    pending?.pixels === pixels &&
    pending.templateSource === templateSource &&
    pending.signature === asked &&
    pending.patches === patchesAtStart
  ) {
    stale.delete(cacheKey)
    return
  }
  // Identity by object, so the reply can tell "the entry is still mine" from "the answer is still
  // good". Those are different questions and folding them together leaked: a scan invalidated by a
  // paint left its entry behind, and `PendingScan.pixels` is the captured tile — a megabyte, pinned
  // for the session once the tile cache had evicted its own copy.
  const mine: PendingScan = { pixels, templateSource, signature: asked, patches: patchesAtStart }
  inFlight.set(cacheKey, mine)
  stale.delete(cacheKey)
  void scanInWorker(buildJob(template, tile, pixels, true), template.indices).then((outcome) => {
    // A later request replaced the entry, so it owns this key now and this reply is nobody's.
    if (inFlight.get(cacheKey) !== mine) return
    inFlight.delete(cacheKey)
    if (outcome === null || (patchCount.get(cacheKey) ?? 0) !== patchesAtStart) {
      // Either no worker to be had, or the ground moved under this scan while it ran. Both mean the
      // answer is not usable and the tile still needs one, so ask again rather than dropping it.
      stale.add(cacheKey)
      scheduleIdleScan()
      return
    }
    stale.delete(cacheKey)
    store(cacheKey, pixels, templateSource, key, outcome)
    changed++
    notifyChanged()
  })
}

/**
 * The disagreements between one template and one tile.
 *
 * Null means "not answerable yet" — the tile's pixels have not been captured — which is different
 * from an empty result, and the caller should draw nothing rather than assume agreement.
 *
 * A tile whose answer is out of date keeps showing the one it has. It is wrong by exactly the pixels
 * that have changed since, and those are patched into it as they change, so a recompute is a
 * background refresh rather than a correction — where returning null would blink every marker on the
 * tile out for as long as the rescan took.
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
  if (
    existing !== undefined &&
    existing.source === pixels &&
    existing.templateSource === template.indices &&
    existing.key === key
  ) {
    stale.delete(cacheKey)
    remember(cacheKey, existing)
    return answerFrom(existing, countsUnpainted(template))
  }

  if (hasWorker()) {
    requestScan(template, tile, pixels, cacheKey, key)
    return existing === undefined ? null : answerFrom(existing, countsUnpainted(template))
  }

  /**
   * No worker: scan here, but only so much of it per frame.
   *
   * A budget in time rather than in tiles. A scan is up to a million comparisons but usually far
   * fewer — a template covers only part of a tile, and most tiles are not covered at all — so "one
   * tile per frame" made a screenful take as many frames as there were tiles regardless of whether
   * that was 2ms of work or 20. This is checked *between* tiles, so one scan can still overrun it;
   * the guarantee is that the budget bounds the queue, not any single scan.
   */
  if (performance.now() >= scanDeadline) {
    stale.add(cacheKey)
    scheduleIdleScan()
    if (existing === undefined) return null
    count('mismatch:showed the previous answer while busy')
    return answerFrom(existing, countsUnpainted(template))
  }
  stale.delete(cacheKey)

  const entry = store(
    cacheKey,
    pixels,
    template.indices,
    key,
    scanTile(buildJob(template, tile, pixels, false), template.indices),
  )
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
const patchTile = (tile: TileCoord, x: number, y: number, _announced: number): void => {
  // What matters is the effective colour: the draft where there is one, the server's pixel where
  // there is not. The announced value cannot stand in for either, because two producers announce
  // through the same channel — a write announces what was drafted, and a tile re-read announces
  // what the server now says. Reading the second as a draft put a marker back on a pixel the user's
  // own draft still covers.
  const server = tilePixels(tile)
  const draft = draftPixels(tile)
  const at = (y - tile.y * TILE_SIZE) * TILE_SIZE + (x - tile.x * TILE_SIZE)
  const drafted = draft === null ? UNPAINTED : (draft[at] as number)
  const placed =
    drafted !== UNPAINTED ? drafted : server === null ? UNPAINTED : (server[at] as number)
  // Counted whether or not this patch changes anything, so a scan in flight can see that the ground
  // moved under it and drop its result rather than writing a pre-paint answer over it.
  //
  // Over both maps, not just the cache. A template's first scan has no cached answer yet, only an
  // in-flight one, so counting cache keys alone left exactly that scan uncountable: a paint landing
  // during it changed nothing the identity checks look at, and the pre-paint answer was cached and
  // then reused indefinitely.
  // The keys for this tile, collected once. Usually one or two, against a cache of 128 — so this is
  // both the snapshot the loop below needs and far less than copying the whole cache per pixel.
  //
  // A snapshot rather than a live iteration, because `remember` deletes and re-inserts the key it
  // patches, which would move it behind a live iterator and show it to us twice, and can evict a
  // different key while we are walking.
  const suffix = `|${tile.x}/${tile.y}`
  const keys: string[] = []
  for (const key of cache.keys()) {
    if (key.endsWith(suffix)) keys.push(key)
  }
  for (const key of keys) patchCount.set(key, (patchCount.get(key) ?? 0) + 1)
  for (const key of inFlight.keys()) {
    if (key.endsWith(suffix) && !cache.has(key)) patchCount.set(key, (patchCount.get(key) ?? 0) + 1)
  }
  // Read once. This runs per announced pixel, and a tile re-read announces every pixel that moved —
  // hundreds to thousands in one go. `localTemplates()` copies and sorts the whole list, so asking
  // it per cache key per pixel was the cost of the whole function, several hundred thousand
  // copy-and-sorts on the decode path for one busy tile.
  const templates = localTemplates()
  for (const cacheKey of keys) {
    const entry = cache.get(cacheKey)
    if (entry === undefined) continue
    const id = templateIdOf(cacheKey)
    const template = templates.find((candidate) => candidate.id === id)
    if (template === undefined || entry.templateSource !== template.indices) continue

    const localX = sourceXAt(template, x)
    const localY = y - template.originY
    if (localX === null || localY < 0 || localY >= template.height) continue
    const wanted = template.indices[localY * template.width + localX]
    if (wanted === undefined) continue

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
      for (let i = 0; i < marks.length; i += 3) {
        if (marks[i] === x && marks[i + 1] === y) return i
      }
      return -1
    }
    const inWrong = listed(entry.wrong)
    const inUnpainted = listed(entry.unpainted)
    const already = inWrong >= 0 ? 'wrong' : inUnpainted >= 0 ? 'unpainted' : null
    if (already === belongs) continue

    const minus = (marks: Mismatches, at: number): Mismatches => {
      const next = new Float32Array(marks.length - 3)
      next.set(marks.subarray(0, at))
      next.set(marks.subarray(at + 3), at)
      return next
    }
    const plus = (marks: Mismatches): Mismatches => {
      const next = new Float32Array(marks.length + 3)
      next.set(marks)
      next[marks.length] = x
      next[marks.length + 1] = y
      next[marks.length + 2] = wanted
      return next
    }

    let { wrong, unpainted } = entry
    if (inWrong >= 0) wrong = minus(wrong, inWrong)
    if (inUnpainted >= 0) unpainted = minus(unpainted, inUnpainted)
    if (belongs === 'wrong') wrong = plus(wrong)
    if (belongs === 'unpainted') unpainted = plus(unpainted)

    const patched = {
      source: entry.source,
      templateSource: entry.templateSource,
      key: entry.key,
      wrong,
      unpainted,
      asserted: entry.asserted,
      both: null,
    }
    rememberCoverage(cacheKey, patched)
    remember(cacheKey, patched)
    changed++
    count(belongs === null ? 'mismatch:pixel fixed' : `mismatch:pixel became ${belongs}`)
  }
}

/**
 * Notified when a cached answer changes outside a frame.
 *
 * Painting is not a map movement, so nothing asks MapLibre to draw when it happens — and a marker
 * that has been cleared in memory but not on screen is indistinguishable from one that has not been
 * cleared at all. This is what turns a patch, or a worker's answer, into a repaint.
 */
export const onMismatchesChanged = (listener: () => void): void => {
  changeListeners.push(listener)
}

onTilePixel((tile, x, y, placed) => {
  const before = changed
  patchTile(tile, x, y, placed)
  if (changed === before) return
  notifyChanged()
})

/** Forget everything for a template that has gone, so its tiles are not held alive by the cache. */
export const forgetMismatches = (id: string): void => {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${id}|`)) cache.delete(key)
  }
  for (const key of [...coverage.keys()]) {
    if (key.startsWith(`${id}|`)) forgetCoverage(key)
  }
  coverageTotals.delete(id)
  for (const key of [...inFlight.keys()]) {
    if (key.startsWith(`${id}|`)) inFlight.delete(key)
  }
  for (const key of [...patchCount.keys()]) {
    if (key.startsWith(`${id}|`)) patchCount.delete(key)
  }
  for (const key of [...stale]) {
    if (key.startsWith(`${id}|`)) stale.delete(key)
  }
  forgetInWorker(id)
}

let knownTemplateIds = new Set<string>()
onLocalChange(() => {
  const current = new Set(localTemplates().map((template) => template.id))
  for (const id of knownTemplateIds) {
    if (!current.has(id)) forgetMismatches(id)
  }
  knownTemplateIds = current
})
