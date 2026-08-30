import {
  BLANK,
  MATCH,
  type MismatchMask,
  mismatchClassAt,
  PALETTE_SIZE,
  parseTileKey,
  TILE_SIZE,
  type TileCoord,
  TRANSPARENT_INDEX,
} from '@caelestis/shared'
import { count } from '../debug.js'
import { measureProfile } from '../profile.js'
import {
  beginServerMismatchFrame,
  endServerMismatchFrame,
  onServerMismatchesChanged,
  serverMismatchMaskFor,
} from '../server-mismatch.js'
import {
  draftPixels,
  ensureTilePixels,
  loadTilePixels,
  onTilePixels,
  onTilePixelsAvailable,
  onTilePixelsEvicted,
  tilePixels,
  UNPAINTED,
} from '../tile-transform.js'
import { claimedHiddenFor } from './colour-filter.js'
import {
  appearanceOf,
  displayTemplates,
  isTemplateVisible,
  onLocalChange,
  type PlacedTemplate,
  templateTileKeys,
} from './local-store.js'
import { type MismatchMarks, packMismatchMark } from './mismatch-marks.js'
import { type ScanJob, type ScanOutcome, scanTile } from './mismatch-scan.js'
import { forgetInWorker, hasWorker, scanInWorker } from './mismatch-worker.js'
import { horizontalSpans, sourceXAt, wrappedDeltaX } from './placement.js'

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

/** Packed tile-local x/y/wanted-index marks. Empty when the tile and template agree. */
export type Mismatches = MismatchMarks

interface Cached extends ScanOutcome {
  /** Identity, not contents: a new local tile or server mask is the signal to redo the answer. */
  readonly source: Uint8Array
  /** Identity of the template pixels this answer was computed against. */
  readonly templateSource: Uint8Array
  readonly key: string
  /** Which coordinate lists this scan actually retained. Progress counts are always complete. */
  readonly wrongComplete: boolean
  readonly unpaintedComplete: boolean
  /**
   * The two kinds of disagreement, kept apart.
   *
   * Whether the second kind counts is not a property of the tile — it depends on how much of the
   * *template* is still unpainted, which is not knowable while scanning one tile of it. Deciding at
   * the point the answer is read means the threshold, and the switch above it, cost nothing to change
   * their mind about: no tile is rescanned for either.
   */
  /** The two concatenated, built the first time they are asked for together. */
  both: Mismatches | null
}

/** Counts for the part of a template whose Wplace tiles have actually been scanned. */
export interface TemplateProgress {
  readonly completed: number
  readonly mismatched: number
  readonly unpainted: number
  readonly known: number
  /** All non-transparent pixels the template asks for, including tiles not scanned yet. */
  readonly total: number
}

export interface TemplateColourProgress extends TemplateProgress {
  readonly index: number
}

export type ColourTargetKind = 'unpainted' | 'mismatched'

export interface ColourNavigationTarget {
  readonly templateId: string
  readonly x: number
  readonly y: number
  readonly kind: ColourTargetKind
}

export type ColourNavigationExclusion = Pick<
  ColourNavigationTarget,
  'kind' | 'templateId' | 'x' | 'y'
>

/** Every UI projection of one canonical template/tile classification. */
export interface TilePixelAccounting {
  /** Wrong-colour pixels only. */
  readonly mismatched: Mismatches
  /** Pixels with no server or draft colour. */
  readonly unpainted: Mismatches
  /** Wrong-colour and unpainted pixels, merged in spatial order. */
  readonly disagreements: Mismatches
  /** The configured marker projection, including unpainted only when its threshold allows it. */
  readonly markers: Mismatches
}

/** One synchronous view of the managed accounting state for a template. */
export interface TemplatePixelAccounting {
  /** The immutable desired palette indices owned by the template. */
  readonly wanted: Uint8Array
  readonly progress: TemplateProgress
  readonly colours: readonly TemplateColourProgress[]
  /** Read or schedule one tile's canonical classification. */
  readonly tile: (tile: TileCoord) => TilePixelAccounting | null
  /** Read or schedule only the unpainted coordinates needed by the selected-colour guide. */
  readonly unpainted: (tile: TileCoord) => Mismatches | null
  /** Ensure aggregate-only accounting exists for this tile. */
  readonly ensure: (tile: TileCoord) => boolean
  /** Navigate through locations derived from this same accounting state. */
  readonly nearest: (
    index: number,
    kind: ColourTargetKind,
    reference: { readonly x: number; readonly y: number },
    exclude?: ColourNavigationExclusion,
  ) => Promise<ColourNavigationTarget | null>
}

const markCoordinate = (mark: number): number => mark & 0xfffff

/** Merge two row-major classifications without losing the renderer's spatial-order invariant. */
const mergeMarks = (left: Mismatches, right: Mismatches): Mismatches => {
  const merged = new Uint32Array(left.length + right.length)
  let leftAt = 0
  let rightAt = 0
  let write = 0
  while (leftAt < left.length && rightAt < right.length) {
    const leftMark = left[leftAt] as number
    const rightMark = right[rightAt] as number
    if (markCoordinate(leftMark) <= markCoordinate(rightMark)) {
      merged[write++] = leftMark
      leftAt++
    } else {
      merged[write++] = rightMark
      rightAt++
    }
  }
  merged.set(left.subarray(leftAt), write)
  write += left.length - leftAt
  merged.set(right.subarray(rightAt), write)
  return merged
}

type AnswerKind = 'configured' | 'all' | 'unpainted'

const collectionFor = (
  kind: AnswerKind,
): { readonly wrong: boolean; readonly unpainted: boolean } => ({
  wrong: kind !== 'unpainted',
  unpainted: true,
})

const satisfies = (
  entry: Cached,
  collection: { readonly wrong: boolean; readonly unpainted: boolean },
): boolean =>
  (!collection.wrong || entry.wrongComplete) && (!collection.unpainted || entry.unpaintedComplete)

const answerFrom = (entry: Cached, kind: AnswerKind, template: PlacedTemplate): Mismatches => {
  if (kind === 'unpainted') return entry.unpainted
  const includeUnpainted = kind === 'all' || countsUnpainted(template)
  if (!includeUnpainted || entry.unpainted.length === 0) return entry.wrong
  if (entry.wrong.length === 0) return entry.unpainted
  if (entry.both === null) {
    entry.both = mergeMarks(entry.wrong, entry.unpainted)
    cacheBytes += entry.both.byteLength
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
const MAX_CACHED_ANSWERS = 512
const MAX_CACHED_ANSWER_BYTES = 32 * 1024 * 1024
let cacheBytes = 0
const coverage = new Map<
  string,
  Pick<Cached, 'asserted' | 'key' | 'templateSource'> & {
    readonly templateId: string
    readonly unpainted: number
  }
>()
const coverageTotals = new Map<
  string,
  Pick<Cached, 'asserted' | 'key' | 'templateSource'> & {
    readonly unpainted: number
  }
>()

interface ProgressCoverage {
  readonly templateId: string
  readonly templateSource: Uint8Array
  readonly key: string
  readonly completed: number
  readonly mismatched: number
  readonly unpainted: number
  readonly asserted: number
  readonly byColour: Uint32Array
}

type ProgressAnswer = Pick<
  Cached,
  | 'templateSource'
  | 'completed'
  | 'mismatched'
  | 'progressUnpainted'
  | 'progressAsserted'
  | 'progressByColour'
>

/**
 * Count-only answers survive the marker LRU, so panning does not erase progress behind you.
 *
 * This deliberately has no template-size cap. The project supports templates far larger than a
 * viewport, and evicting an already-scanned tile would make its progress silently run backwards.
 * Each entry retains aggregate and sparse per-colour counters plus two identities, never the tile
 * pixels or unpainted coordinates.
 */
const progressCoverage = new Map<string, ProgressCoverage>()
const progressKeys = new Map<string, Set<string>>()
const progressTotals = new Map<
  string,
  Omit<ProgressCoverage, 'templateId'> & { readonly byColour: Uint32Array }
>()

export const mismatchMemoryBytes = (): number => {
  const buffers = new Set<ArrayBufferLike>()
  const remember = (value: ArrayBufferView | null): void => {
    if (value !== null) buffers.add(value.buffer)
  }
  for (const entry of cache.values()) {
    remember(entry.wrong)
    remember(entry.unpainted)
    remember(entry.progressByColour)
    remember(entry.both)
  }
  for (const entry of progressCoverage.values()) remember(entry.byColour)
  for (const entry of progressTotals.values()) remember(entry.byColour)
  let bytes = 0
  for (const buffer of buffers) bytes += buffer.byteLength
  return bytes
}

/** Add or subtract sparse scan tuples from one template's dense palette counters. */
const mergeColourProgress = (target: Uint32Array, packed: Uint32Array, direction: 1 | -1): void => {
  for (let at = 0; at < packed.length; at += 4) {
    const index = packed[at]
    if (index === undefined || index >= PALETTE_SIZE) continue
    const targetAt = index * 3
    for (let offset = 0; offset < 3; offset++) {
      const value = packed[at + offset + 1] ?? 0
      target[targetAt + offset] =
        direction === 1
          ? (target[targetAt + offset] ?? 0) + value
          : Math.max(0, (target[targetAt + offset] ?? 0) - value)
    }
  }
}

/**
 * A cache key is `${templateId}|${x}/${y}`, and only the tile half has a known shape. A server
 * template's id is `srv:<encoded-url>:<id>`, so the last separator is the split, never the first.
 */
const templateIdOf = (cacheKey: string): string => cacheKey.slice(0, cacheKey.lastIndexOf('|'))

const tileOf = (cacheKey: string, templateId: string): TileCoord | null => {
  const separator = cacheKey.indexOf('/', templateId.length + 1)
  if (separator < 0) return null
  const x = Number(cacheKey.slice(templateId.length + 1, separator))
  const y = Number(cacheKey.slice(separator + 1))
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

const forgetProgress = (cacheKey: string): void => {
  const entry = progressCoverage.get(cacheKey)
  if (entry === undefined) return
  progressCoverage.delete(cacheKey)
  const keys = progressKeys.get(entry.templateId)
  keys?.delete(cacheKey)
  if (keys?.size === 0) progressKeys.delete(entry.templateId)
  const total = progressTotals.get(entry.templateId)
  if (
    total === undefined ||
    total.key !== entry.key ||
    total.templateSource !== entry.templateSource
  )
    return
  const asserted = total.asserted - entry.asserted
  if (asserted <= 0) {
    progressTotals.delete(entry.templateId)
    return
  }
  mergeColourProgress(total.byColour, entry.byColour, -1)
  progressTotals.set(entry.templateId, {
    ...total,
    asserted,
    completed: total.completed - entry.completed,
    mismatched: total.mismatched - entry.mismatched,
    unpainted: total.unpainted - entry.unpainted,
    byColour: total.byColour,
  })
}

const rememberProgress = (cacheKey: string, entry: ProgressAnswer, key: string): void => {
  const templateId = templateIdOf(cacheKey)
  const heldKeys = progressKeys.get(templateId)
  if (heldKeys !== undefined) {
    for (const heldKey of [...heldKeys]) {
      const held = progressCoverage.get(heldKey)
      if (
        held !== undefined &&
        (held.templateSource !== entry.templateSource || held.key !== key)
      ) {
        forgetProgress(heldKey)
      }
    }
  }
  forgetProgress(cacheKey)
  const one: ProgressCoverage = {
    templateId,
    templateSource: entry.templateSource,
    key,
    completed: entry.completed,
    mismatched: entry.mismatched,
    unpainted: entry.progressUnpainted,
    asserted: entry.progressAsserted,
    byColour: entry.progressByColour,
  }
  progressCoverage.set(cacheKey, one)
  const keys = progressKeys.get(templateId) ?? new Set<string>()
  keys.add(cacheKey)
  progressKeys.set(templateId, keys)
  const total = progressTotals.get(templateId)
  const byColour = total?.byColour ?? new Uint32Array(PALETTE_SIZE * 3)
  mergeColourProgress(byColour, one.byColour, 1)
  progressTotals.set(templateId, {
    templateSource: entry.templateSource,
    key,
    completed: (total?.completed ?? 0) + one.completed,
    mismatched: (total?.mismatched ?? 0) + one.mismatched,
    unpainted: (total?.unpainted ?? 0) + one.unpainted,
    asserted: (total?.asserted ?? 0) + one.asserted,
    byColour,
  })
}

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
  const unpainted = entry.unpainted.length
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

const cachedAnswerBytes = (entry: Cached): number =>
  entry.wrong.byteLength + entry.unpainted.byteLength + (entry.both?.byteLength ?? 0)

const deleteCachedAnswer = (cacheKey: string): void => {
  const existing = cache.get(cacheKey)
  if (existing === undefined) return
  cache.delete(cacheKey)
  cacheBytes -= cachedAnswerBytes(existing)
}

const remember = (cacheKey: string, entry: Cached): void => {
  const existing = cache.get(cacheKey)
  if (existing === entry) {
    cache.delete(cacheKey)
    cache.set(cacheKey, entry)
    return
  }
  if (existing !== undefined) cacheBytes -= cachedAnswerBytes(existing)
  cache.delete(cacheKey)
  cache.set(cacheKey, entry)
  cacheBytes += cachedAnswerBytes(entry)
}

/** Bumped whenever a cached answer is patched, so a listener can tell that anything happened. */
let changed = 0

/** Monotonic token for UI caches that derive progress from mismatch state. */
export const mismatchRevision = (): number => changed

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
let requestedThisFrame: Set<string> | null = null
let requestedForOutlines: Set<string> | null = null
let retainedForOutlines = new Set<string>()

/** Start the overlay layer's independent answer-retention pass. */
export const beginUnpaintedFrame = (): void => {
  requestedForOutlines = new Set()
}

/** Keep outline answers without resetting the marker layer's own frame request set. */
export const endUnpaintedFrame = (): void => {
  retainedForOutlines = requestedForOutlines ?? new Set()
  requestedForOutlines = null
}

/** Called once per frame by the renderer, before it asks for anything. */
export const beginMismatchFrame = (): void => {
  scanDeadline = performance.now() + SCAN_BUDGET_MS
  requestedThisFrame = new Set()
  beginServerMismatchFrame()
}

/**
 * Keep every answer the current viewport requested plus a bounded offscreen working set.
 *
 * A fixed-size LRU made marker count depend on how many template/tile intersections happened to be
 * visible: the 129th answer evicted the first while the same frame still needed both. Eviction only
 * considers offscreen answers after the frame has assembled, so a dense viewport remains complete
 * while nearby pan-back can reuse work it already paid for.
 */
export const endMismatchFrame = (): void => {
  const requested = requestedThisFrame
  requestedThisFrame = null
  scanDeadline = 0
  if (requested === null) {
    endServerMismatchFrame()
    return
  }
  for (const cacheKey of cache.keys()) {
    if (cache.size <= MAX_CACHED_ANSWERS && cacheBytes <= MAX_CACHED_ANSWER_BYTES) break
    if (requested.has(cacheKey) || retainedForOutlines.has(cacheKey)) continue
    deleteCachedAnswer(cacheKey)
    forgetCoverage(cacheKey)
    stale.delete(cacheKey)
  }
  for (const cacheKey of [...patchCount.keys()]) {
    if (!cache.has(cacheKey) && !inFlight.has(cacheKey)) patchCount.delete(cacheKey)
  }
  endServerMismatchFrame()
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
/** Progress-only tiles invalidated by paint; their previous aggregate remains visible until replaced. */
const staleProgress = new Set<string>()
/** Hidden local-template tiles whose pixels were explicitly requested by a progress consumer. */
const pendingProgressPixels = new Set<string>()
let idleScheduled = false

type IdleWindow = typeof globalThis & {
  requestIdleCallback?: (callback: (deadline: { timeRemaining: () => number }) => void) => void
}

const runIdleScan = (deadline: { timeRemaining: () => number }): void => {
  idleScheduled = false
  // Borrow the frame budget: the same guard, spending idle time instead of a frame's.
  scanDeadline = performance.now() + Math.max(deadline.timeRemaining(), 1)
  let ranOutOfTime = false
  const templatesById = new Map(displayTemplates().map((template) => [template.id, template]))
  for (const cacheKey of [...stale]) {
    if (performance.now() >= scanDeadline) {
      ranOutOfTime = true
      break
    }
    const id = templateIdOf(cacheKey)
    const tile = tileOf(cacheKey, id)
    const template = templatesById.get(id)
    if (template === undefined || tile === null) {
      stale.delete(cacheKey)
      continue
    }
    if (retainedForOutlines.has(cacheKey)) unpaintedIn(template, tile)
    else mismatchesIn(template, tile)
    count('mismatch:rescanned while idle')
  }
  for (const cacheKey of [...staleProgress]) {
    if (performance.now() >= scanDeadline) {
      ranOutOfTime = true
      break
    }
    const id = templateIdOf(cacheKey)
    const tile = tileOf(cacheKey, id)
    const template = templatesById.get(id)
    if (template === undefined || tile === null) {
      staleProgress.delete(cacheKey)
      pendingProgressPixels.delete(cacheKey)
      continue
    }
    progressIn(template, tile)
    count('mismatch:progress-only rescanned while idle')
  }
  scanDeadline = 0
  // A key can remain stale because its canvas pixels have not arrived yet. Retrying that key on a
  // zero-delay timer spins forever when the fetch fails. Pixel capture wakes the queue below; only
  // a scan that actually exhausted its time slice needs another immediate idle turn.
  if (ranOutOfTime && (stale.size > 0 || staleProgress.size > 0)) scheduleIdleScan()
  notifyChanged()
}

const scheduleIdleScan = (): void => {
  if (idleScheduled) return
  const idle = (globalThis as IdleWindow).requestIdleCallback
  idleScheduled = true
  if (idle !== undefined) {
    idle(runIdleScan)
    return
  }
  setTimeout(() => runIdleScan({ timeRemaining: () => SCAN_BUDGET_MS }), 0)
}

/**
 * Whether anything currently wants to know what disagrees.
 *
 * Kept here rather than worked out at draw time so it can be answered before the first frame. The
 * tiles on screen at load are decoded exactly once, and if capture is not on by then we miss all of
 * them and have to read every one back from a preview later — paying twice for pixels that went
 * past us while we were not looking.
 */
export const wantsTilePixels = (tile?: TileCoord): boolean => {
  const templates = displayTemplates().filter((template) => {
    // A server template's marker list comes from its server mismatch mask and its progress comes
    // from telemetry. Capturing the underlying Wplace tile as a fallback makes every newly visible
    // tile perform a million-pixel canvas read during a pan, precisely when the map needs its frame
    // budget most. Local templates have neither server source, so they keep exact-pixel capture for
    // both mismatch markers and progress (including when their marker switches are off).
    return template.serverUrl === undefined
  })
  if (tile === undefined)
    return (
      pendingProgressPixels.size > 0 || templates.some((template) => isTemplateVisible(template))
    )
  const left = tile.x * TILE_SIZE
  const top = tile.y * TILE_SIZE
  return templates.some((template) => {
    if (pendingProgressPixels.has(`${template.id}|${tile.x}/${tile.y}`)) return true
    return (
      isTemplateVisible(template) &&
      template.originY < top + TILE_SIZE &&
      template.originY + template.height > top &&
      horizontalSpans(template).some(
        (span) => span.worldStart < left + TILE_SIZE && span.worldEnd > left,
      )
    )
  })
}

/** The switches, not what is on screen — see `claimedHiddenFor` for why the two differ. */
const assertedHidden = (template: PlacedTemplate): readonly number[] =>
  claimedHiddenFor(appearanceOf(template))

/**
 * Everything that changes what a scan finds, so a stale entry is never returned.
 *
 * "Count unpainted" is deliberately not part of it, nor is its threshold. Both decide which of two
 * lists to hand back, not what goes in them, so neither is a reason to look at a tile again.
 */
const progressSignature = (template: PlacedTemplate): string =>
  `${template.originX},${template.originY},${template.wrapX === true ? 1 : 0}|${template.moved}`

const signature = (template: PlacedTemplate): string =>
  `${progressSignature(template)}|${assertedHidden(template).join(',')}`

/**
 * Cold progress must cover the template, not merely the part currently in the viewport.
 *
 * The marker renderer naturally asks only about visible tiles. Reusing that coverage for palette
 * counters made a reload look like all offscreen work had become unfinished: unknown pixels were
 * subtracted from the template total as though they were known failures, and those tiles were never
 * requested until somebody panned over them. Queue every compact local-template tile in idle time;
 * exact capture remains bounded by tile-transform's chase limit and wakes this queue as tiles land.
 */
const queueIncompleteLocalProgress = (template: PlacedTemplate): void => {
  if (template.serverUrl !== undefined || template.opaque <= 0) return
  const key = progressSignature(template)
  const total = progressTotals.get(template.id)
  if (
    total !== undefined &&
    total.templateSource === template.indices &&
    total.key === key &&
    total.asserted >= template.opaque
  )
    return

  let pending = false
  let captureChanged = false
  for (const tileKey of templateTileKeys(template)) {
    const tile = parseTileKey(tileKey)
    if (tile === null) continue
    const cacheKey = `${template.id}|${tile.x}/${tile.y}`
    const held = progressCoverage.get(cacheKey)
    if (
      held !== undefined &&
      held.templateSource === template.indices &&
      held.key === key &&
      !staleProgress.has(cacheKey)
    )
      continue
    staleProgress.add(cacheKey)
    if (!pendingProgressPixels.has(cacheKey)) {
      pendingProgressPixels.add(cacheKey)
      captureChanged = true
    }
    pending = true
  }
  if (pending) {
    scheduleIdleScan()
    if (captureChanged) notifyChanged()
  }
}

/** Progress for scanned tiles; unknown tiles remain outside the three classified counts. */
export const progressFor = (template: PlacedTemplate): TemplateProgress => {
  queueIncompleteLocalProgress(template)
  const total = Math.max(0, template.opaque)
  const held = progressTotals.get(template.id)
  if (
    held === undefined ||
    held.templateSource !== template.indices ||
    held.key !== progressSignature(template)
  ) {
    return { completed: 0, mismatched: 0, unpainted: 0, known: 0, total }
  }
  const known = Math.min(total, held.asserted)
  return {
    completed: Math.min(known, held.completed),
    mismatched: Math.min(known, held.mismatched),
    unpainted: Math.min(known, held.unpainted),
    known,
    total,
  }
}

/** Total requested pixels by palette index, cached by the immutable template pixel buffer. */
const colourTotals = new WeakMap<Uint8Array, Uint32Array>()

const colourTotalsFor = (template: PlacedTemplate): Uint32Array => {
  const cached = colourTotals.get(template.indices)
  if (cached !== undefined) return cached
  const totals = new Uint32Array(PALETTE_SIZE)
  for (const index of template.indices) {
    if (index < PALETTE_SIZE && index !== TRANSPARENT_INDEX)
      totals[index] = (totals[index] ?? 0) + 1
  }
  colourTotals.set(template.indices, totals)
  return totals
}

/** Exact progress for every colour the template contains. */
export const colourProgressFor = (template: PlacedTemplate): readonly TemplateColourProgress[] => {
  queueIncompleteLocalProgress(template)
  const totals = colourTotalsFor(template)
  const held = progressTotals.get(template.id)
  const current =
    held !== undefined &&
    held.templateSource === template.indices &&
    held.key === progressSignature(template)
      ? held.byColour
      : null
  const progress: TemplateColourProgress[] = []
  for (let index = 0; index < totals.length; index++) {
    const total = totals[index] ?? 0
    if (total === 0) continue
    const at = index * 3
    const completed = Math.min(total, current?.[at] ?? 0)
    const mismatched = Math.min(total - completed, current?.[at + 1] ?? 0)
    const unpainted = Math.min(total - completed - mismatched, current?.[at + 2] ?? 0)
    progress.push({
      index,
      completed,
      mismatched,
      unpainted,
      known: completed + mismatched + unpainted,
      total,
    })
  }
  return progress
}

interface NavigationCandidate {
  readonly template: PlacedTemplate
  readonly tile: TileCoord
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  readonly sourceStart: number
  readonly worldStart: number
  readonly minimumDistance: number
}

const distanceToInterval = (value: number, start: number, end: number): number =>
  value < start ? start - value : value >= end ? value - end : 0

/** Lower bound from a reference pixel to a possibly wrapped canvas rectangle. */
const minimumDistanceTo = (
  reference: { readonly x: number; readonly y: number },
  left: number,
  right: number,
  top: number,
  bottom: number,
): number => {
  const width = right - left
  const relativeCentre = wrappedDeltaX(reference.x, left + width / 2)
  const relativeLeft = relativeCentre - width / 2
  const dx = distanceToInterval(0, relativeLeft, relativeLeft + width)
  const dy = distanceToInterval(reference.y, top, bottom)
  return dx * dx + dy * dy
}

const navigationCandidates = (
  reference: {
    readonly x: number
    readonly y: number
  },
  templateId?: string,
): NavigationCandidate[] => {
  const candidates: NavigationCandidate[] = []
  for (const template of displayTemplates()) {
    if (!isTemplateVisible(template)) continue
    if (templateId !== undefined && template.id !== templateId) continue
    const templateTop = template.originY
    const templateBottom = template.originY + template.height
    for (const key of templateTileKeys(template)) {
      const tile = parseTileKey(key)
      if (tile === null) continue
      const tileLeft = tile.x * TILE_SIZE
      const tileTop = tile.y * TILE_SIZE
      const tileRight = tileLeft + TILE_SIZE
      const tileBottom = tileTop + TILE_SIZE
      const top = Math.max(templateTop, tileTop)
      const bottom = Math.min(templateBottom, tileBottom)
      if (bottom <= top) continue
      for (const span of horizontalSpans(template)) {
        const left = Math.max(span.worldStart, tileLeft)
        const right = Math.min(span.worldEnd, tileRight)
        if (right <= left) continue
        candidates.push({
          template,
          tile,
          left,
          right,
          top,
          bottom,
          sourceStart: span.sourceStart,
          worldStart: span.worldStart,
          minimumDistance: minimumDistanceTo(reference, left, right, top, bottom),
        })
      }
    }
  }
  candidates.sort((left, right) => left.minimumDistance - right.minimumDistance)
  return candidates
}

const candidateContainsColour = (candidate: NavigationCandidate, index: number): boolean => {
  for (let y = candidate.top; y < candidate.bottom; y++) {
    const sourceY = y - candidate.template.originY
    let sourceX = candidate.sourceStart + candidate.left - candidate.worldStart
    for (let x = candidate.left; x < candidate.right; x++, sourceX++) {
      if (candidate.template.indices[sourceY * candidate.template.width + sourceX] === index)
        return true
    }
  }
  return false
}

interface CandidateResult {
  readonly target: ColourNavigationTarget | null
  readonly distance: number
  readonly desiredPixels: number
  readonly matchingPixels: number
}

const scanCandidate = (
  candidate: NavigationCandidate,
  pixels: Uint8Array,
  index: number,
  kind: ColourTargetKind,
  reference: { readonly x: number; readonly y: number },
  previousDistance: number,
  exclude?: ColourNavigationExclusion,
): CandidateResult => {
  let target: ColourNavigationTarget | null = null
  let distance = previousDistance
  let desiredPixels = 0
  let matchingPixels = 0
  const draft = draftPixels(candidate.tile)
  const tileLeft = candidate.tile.x * TILE_SIZE
  const tileTop = candidate.tile.y * TILE_SIZE
  for (let y = candidate.top; y < candidate.bottom; y++) {
    const sourceY = y - candidate.template.originY
    let sourceX = candidate.sourceStart + candidate.left - candidate.worldStart
    let tileAt = (y - tileTop) * TILE_SIZE + (candidate.left - tileLeft)
    for (let x = candidate.left; x < candidate.right; x++, sourceX++, tileAt++) {
      const wanted = candidate.template.indices[sourceY * candidate.template.width + sourceX]
      if (wanted !== index) continue
      desiredPixels++
      const drafted = draft?.[tileAt] ?? UNPAINTED
      const placed = drafted === UNPAINTED ? pixels[tileAt] : drafted
      const matches =
        kind === 'unpainted' ? placed === UNPAINTED : placed !== UNPAINTED && placed !== wanted
      if (!matches) continue
      matchingPixels++
      if (
        exclude?.templateId === candidate.template.id &&
        exclude.kind === kind &&
        exclude.x === x &&
        exclude.y === y
      )
        continue
      const dx = wrappedDeltaX(reference.x, x + 0.5)
      const dy = y + 0.5 - reference.y
      const candidateDistance = dx * dx + dy * dy
      if (candidateDistance >= distance) continue
      distance = candidateDistance
      target = { templateId: candidate.template.id, x, y, kind }
    }
  }
  return { target, distance, desiredPixels, matchingPixels }
}

const recordNavigationScan = (rectangles: number, desiredPixels: number, matches: number): void => {
  count('paint:navigation loaded rectangles', rectangles)
  count('paint:navigation desired pixels checked', desiredPixels)
  count('paint:navigation targets found', matches)
}

/** Exact nearest disagreement among Wplace tiles whose pixels this browser already has. */
export const nearestLoadedColourTarget = (
  index: number,
  kind: ColourTargetKind,
  reference: { readonly x: number; readonly y: number },
  templateId?: string,
  exclude?: ColourNavigationExclusion,
): ColourNavigationTarget | null => {
  if (!Number.isInteger(index) || index < 0 || index >= PALETTE_SIZE) return null
  const candidates = navigationCandidates(reference, templateId)

  let best: ColourNavigationTarget | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  let desiredPixels = 0
  let matchingPixels = 0
  let loaded = 0
  for (const candidate of candidates) {
    if (candidate.minimumDistance > bestDistance) break
    const pixels = tilePixels(candidate.tile)
    if (pixels === null) continue
    loaded++
    const scanned = scanCandidate(candidate, pixels, index, kind, reference, bestDistance, exclude)
    desiredPixels += scanned.desiredPixels
    matchingPixels += scanned.matchingPixels
    if (scanned.target !== null) best = scanned.target
    bestDistance = scanned.distance
  }
  recordNavigationScan(loaded, desiredPixels, matchingPixels)
  return best
}

/**
 * Exact nearest disagreement, chasing only the nearest relevant Wplace tiles not already retained.
 *
 * The server aggregate chooses blank work before mismatches. The browser owns navigation because it
 * already has the overlay's coordinates; on a cache miss this loads canvas tiles nearest-first and
 * stops as soon as every remaining tile is farther away than the best exact pixel found.
 */
export const nearestColourTarget = async (
  index: number,
  kind: ColourTargetKind,
  reference: { readonly x: number; readonly y: number },
  templateId?: string,
  exclude?: ColourNavigationExclusion,
): Promise<ColourNavigationTarget | null> => {
  if (!Number.isInteger(index) || index < 0 || index >= PALETTE_SIZE) return null
  const candidates = navigationCandidates(reference, templateId)
  let best: ColourNavigationTarget | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  let desiredPixels = 0
  let matchingPixels = 0
  let loaded = 0
  for (const candidate of candidates) {
    if (candidate.minimumDistance > bestDistance) break
    let pixels = tilePixels(candidate.tile)
    if (pixels === null) {
      if (!candidateContainsColour(candidate, index)) continue
      pixels = await loadTilePixels(candidate.tile)
    }
    if (pixels === null) continue
    loaded++
    const scanned = scanCandidate(candidate, pixels, index, kind, reference, bestDistance, exclude)
    desiredPixels += scanned.desiredPixels
    matchingPixels += scanned.matchingPixels
    if (scanned.target !== null) best = scanned.target
    bestDistance = scanned.distance
  }
  recordNavigationScan(loaded, desiredPixels, matchingPixels)
  return best
}

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
  collectMarkers = true,
  collectWrong = collectMarkers,
  collectUnpainted = collectMarkers,
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
    kind: 'pixels',
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
    transparent: TRANSPARENT_INDEX,
    unpainted: UNPAINTED,
    collectMarkers,
    collectWrong,
    collectUnpainted,
  }
}

/** Build the same scan input from a server's compact two-bit classification mask. */
const buildMaskJob = (
  template: PlacedTemplate,
  tile: TileCoord,
  mask: MismatchMask,
  forWorker: boolean,
  collectMarkers = true,
  collectWrong = collectMarkers,
  collectUnpainted = collectMarkers,
): ScanJob => {
  const tileLeft = tile.x * TILE_SIZE
  const tileTop = tile.y * TILE_SIZE
  const span = horizontalSpans(template).find(
    (candidate) => candidate.worldStart < tileLeft + TILE_SIZE && candidate.worldEnd > tileLeft,
  )
  const top = Math.max(template.originY, tileTop + mask.top)
  const bottom = Math.min(template.originY + template.height, tileTop + mask.top + mask.height)
  const bandTop = forWorker ? Math.max(0, Math.min(TILE_SIZE, top - tileTop)) : 0
  const bandBottom = forWorker
    ? Math.max(bandTop, Math.min(TILE_SIZE, bottom - tileTop))
    : TILE_SIZE
  const draft = draftPixels(tile)
  return {
    kind: 'mask',
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
    draft:
      draft === null
        ? null
        : forWorker
          ? draft.slice(bandTop * TILE_SIZE, bandBottom * TILE_SIZE)
          : draft,
    ignored: [TRANSPARENT_INDEX, UNPAINTED, ...assertedHidden(template)],
    transparent: TRANSPARENT_INDEX,
    unpainted: UNPAINTED,
    collectMarkers,
    collectWrong,
    collectUnpainted,
    maskLeft: mask.left,
    maskTop: mask.top,
    maskWidth: mask.width,
    maskHeight: mask.height,
    maskPacked: forWorker ? mask.packed.slice() : mask.packed,
  }
}

const store = (
  cacheKey: string,
  source: Uint8Array,
  templateSource: Uint8Array,
  key: string,
  progressKey: string,
  outcome: ScanOutcome,
  wrongComplete = true,
  unpaintedComplete = true,
): Cached => {
  const entry: Cached = {
    source,
    templateSource,
    key,
    ...outcome,
    wrongComplete,
    unpaintedComplete,
    both: null,
  }
  staleProgress.delete(cacheKey)
  rememberCoverage(cacheKey, entry)
  rememberProgress(cacheKey, entry, progressKey)
  remember(cacheKey, entry)
  count('mismatch:tiles scanned')
  count('mismatch:pixels marked', outcome.wrong.length)
  count('mismatch:pixels unpainted', outcome.unpainted.length)
  return entry
}

/**
 * Tiles a worker is already looking at, against the tile array they were asked about.
 *
 * Without this, every frame between asking and answering asks again — sixty scans in flight for one
 * tile, each with its own band copied out of it.
 */
interface PendingScan {
  readonly source: Uint8Array
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
  /** A full answer may satisfy progress-only work, but not the other way around. */
  readonly markers: boolean
  readonly wrong: boolean
  readonly unpainted: boolean
}

/** Patches applied per cache key, so a scan can tell whether the ground moved under it. */
const patchCount = new Map<string, number>()

const inFlight = new Map<string, PendingScan>()

/** Server masks superseded by newer exact pixels, until exact-pixel cache eviction. */
const supersededServerSource = new Map<string, string>()

const requestScan = (
  template: PlacedTemplate,
  source: Uint8Array,
  cacheKey: string,
  key: string,
  job: ScanJob,
  markers = true,
): void => {
  const templateSource = template.indices
  const asked = signature(template)
  const patchesAtStart = patchCount.get(cacheKey) ?? 0
  const wrong = job.collectMarkers !== false && job.collectWrong !== false
  const unpainted = job.collectMarkers !== false && job.collectUnpainted !== false
  const pending = inFlight.get(cacheKey)
  const sameSnapshot =
    pending?.source === source &&
    pending.templateSource === templateSource &&
    pending.signature === asked &&
    pending.patches === patchesAtStart
  if (pending !== undefined && sameSnapshot) {
    // Let a narrow answer land before asking the worker for a broader projection. Replacing the
    // owner here discarded the unpainted-only reply, so the selected-colour guide waited for the
    // slower wrong-colour scan whenever both marker styles were enabled. The next render requests
    // only whichever projection the cached narrow answer still lacks.
    if (pending.markers) stale.delete(cacheKey)
    staleProgress.delete(cacheKey)
    return
  }
  // Identity by object, so the reply can tell "the entry is still mine" from "the answer is still
  // good". Those are different questions and folding them together leaked: a scan invalidated by a
  // paint left its entry behind, and `PendingScan.source` is the captured tile — a megabyte, pinned
  // for the session once the tile cache had evicted its own copy.
  const mine: PendingScan = {
    source,
    templateSource,
    signature: asked,
    patches: patchesAtStart,
    markers,
    wrong,
    unpainted,
  }
  inFlight.set(cacheKey, mine)
  if (markers) stale.delete(cacheKey)
  staleProgress.delete(cacheKey)
  void scanInWorker(job, template.indices).then((outcome) => {
    // A later request replaced the entry, so it owns this key now and this reply is nobody's.
    if (inFlight.get(cacheKey) !== mine) return
    inFlight.delete(cacheKey)
    if (outcome === null || (patchCount.get(cacheKey) ?? 0) !== patchesAtStart) {
      // Either no worker to be had, or the ground moved under this scan while it ran. Both mean the
      // answer is not usable and the tile still needs one, so ask again rather than dropping it.
      if (markers) stale.add(cacheKey)
      staleProgress.add(cacheKey)
      scheduleIdleScan()
      return
    }
    if (markers) {
      stale.delete(cacheKey)
      staleProgress.delete(cacheKey)
      const held = cache.get(cacheKey)
      const compatible =
        held?.source === source && held.templateSource === templateSource && held.key === key
          ? held
          : undefined
      store(
        cacheKey,
        source,
        templateSource,
        key,
        progressSignature(template),
        {
          ...outcome,
          wrong: wrong ? outcome.wrong : (compatible?.wrong ?? outcome.wrong),
          unpainted: unpainted ? outcome.unpainted : (compatible?.unpainted ?? outcome.unpainted),
        },
        wrong || compatible?.wrongComplete === true,
        unpainted || compatible?.unpaintedComplete === true,
      )
    } else {
      rememberProgress(cacheKey, { templateSource, ...outcome }, progressSignature(template))
      staleProgress.delete(cacheKey)
      count('mismatch:progress-only tiles scanned')
    }
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
const mismatchAnswer = (
  template: PlacedTemplate,
  tile: TileCoord,
  kind: AnswerKind,
): Mismatches | null => {
  const cacheKey = `${template.id}|${tile.x}/${tile.y}`
  requestedThisFrame?.add(cacheKey)
  const key = signature(template)
  const collection = collectionFor(kind)
  const serverMask = serverMismatchMaskFor(template, tile)
  const superseded = supersededServerSource.get(cacheKey)
  if (superseded !== undefined && superseded !== template.serverUrl) {
    supersededServerSource.delete(cacheKey)
  }
  if (serverMask !== null && superseded !== template.serverUrl) {
    const existing = cache.get(cacheKey)
    if (
      existing !== undefined &&
      existing.source === serverMask.packed &&
      existing.templateSource === template.indices &&
      existing.key === key &&
      satisfies(existing, collection) &&
      !stale.has(cacheKey)
    ) {
      remember(cacheKey, existing)
      return answerFrom(existing, kind, template)
    }
    if (hasWorker()) {
      const compatible =
        existing?.source === serverMask.packed &&
        existing.templateSource === template.indices &&
        existing.key === key &&
        !stale.has(cacheKey)
          ? existing
          : undefined
      requestScan(
        template,
        serverMask.packed,
        cacheKey,
        key,
        buildMaskJob(
          template,
          tile,
          serverMask,
          true,
          true,
          collection.wrong && compatible?.wrongComplete !== true,
          collection.unpainted && compatible?.unpaintedComplete !== true,
        ),
      )
      return existing === undefined || !satisfies(existing, collection)
        ? null
        : answerFrom(existing, kind, template)
    }
    stale.delete(cacheKey)
    const entry = store(
      cacheKey,
      serverMask.packed,
      template.indices,
      key,
      progressSignature(template),
      measureProfile('Server mismatch expansion', () =>
        scanTile(
          buildMaskJob(
            template,
            tile,
            serverMask,
            false,
            true,
            collection.wrong,
            collection.unpainted,
          ),
          template.indices,
        ),
      ),
      collection.wrong,
      collection.unpainted,
    )
    return answerFrom(entry, kind, template)
  }
  const pixels = tilePixels(tile)
  if (pixels === null) {
    // Never decoded while we were watching. Go and get it rather than wait for wplace to.
    stale.add(cacheKey)
    ensureTilePixels(tile)
    return null
  }

  const existing = cache.get(cacheKey)
  if (
    existing !== undefined &&
    existing.source === pixels &&
    existing.templateSource === template.indices &&
    existing.key === key &&
    satisfies(existing, collection) &&
    !stale.has(cacheKey)
  ) {
    stale.delete(cacheKey)
    remember(cacheKey, existing)
    return answerFrom(existing, kind, template)
  }

  if (hasWorker()) {
    const compatible =
      existing?.source === pixels &&
      existing.templateSource === template.indices &&
      existing.key === key &&
      !stale.has(cacheKey)
        ? existing
        : undefined
    requestScan(
      template,
      pixels,
      cacheKey,
      key,
      buildJob(
        template,
        tile,
        pixels,
        true,
        true,
        collection.wrong && compatible?.wrongComplete !== true,
        collection.unpainted && compatible?.unpaintedComplete !== true,
      ),
    )
    return existing === undefined || !satisfies(existing, collection)
      ? null
      : answerFrom(existing, kind, template)
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
    if (existing === undefined || !satisfies(existing, collection)) return null
    count('mismatch:showed the previous answer while busy')
    return answerFrom(existing, kind, template)
  }
  stale.delete(cacheKey)

  const entry = store(
    cacheKey,
    pixels,
    template.indices,
    key,
    progressSignature(template),
    measureProfile('Mismatch scan', () =>
      scanTile(
        buildJob(template, tile, pixels, false, true, collection.wrong, collection.unpainted),
        template.indices,
      ),
    ),
    collection.wrong,
    collection.unpainted,
  )
  changed++
  notifyChanged()
  return answerFrom(entry, kind, template)
}

/** Mismatches shown by the magenta marker, including unpainted only when its appearance allows it. */
export const mismatchesIn = (template: PlacedTemplate, tile: TileCoord): Mismatches | null =>
  mismatchAnswer(template, tile, 'configured')

/** Every wrong or unpainted pixel, used to narrow the selected-colour work list. */
export const disagreementsIn = (template: PlacedTemplate, tile: TileCoord): Mismatches | null =>
  mismatchAnswer(template, tile, 'all')

/** Keep a visible outline answer eligible for reuse without reading or rescanning it. */
export const retainUnpainted = (template: PlacedTemplate, tile: TileCoord): void => {
  requestedForOutlines?.add(`${template.id}|${tile.x}/${tile.y}`)
}

/** Every unpainted pixel, independently of whether mismatch markers include that class. */
export const unpaintedIn = (template: PlacedTemplate, tile: TileCoord): Mismatches | null => {
  retainUnpainted(template, tile)
  return mismatchAnswer(template, tile, 'unpainted')
}

/**
 * Refresh local progress without producing marker coordinates.
 *
 * Marker visibility must not be a hidden prerequisite for the tree and paint-palette totals. This
 * uses the same comparison and worker, but asks it for aggregate counts only; no mismatch list enters
 * the marker cache or the GPU path.
 */
export const progressIn = (template: PlacedTemplate, tile: TileCoord): boolean => {
  const cacheKey = `${template.id}|${tile.x}/${tile.y}`
  requestedThisFrame?.add(cacheKey)
  const progressKey = progressSignature(template)
  const held = progressCoverage.get(cacheKey)
  if (
    held !== undefined &&
    held.templateSource === template.indices &&
    held.key === progressKey &&
    !staleProgress.has(cacheKey)
  ) {
    pendingProgressPixels.delete(cacheKey)
    return true
  }

  const pixels = tilePixels(tile)
  if (pixels === null) {
    const captureChanged = !pendingProgressPixels.has(cacheKey)
    pendingProgressPixels.add(cacheKey)
    ensureTilePixels(tile)
    if (captureChanged) notifyChanged()
    return false
  }
  pendingProgressPixels.delete(cacheKey)
  const key = signature(template)
  if (hasWorker()) {
    requestScan(
      template,
      pixels,
      cacheKey,
      key,
      buildJob(template, tile, pixels, true, false),
      false,
    )
    return true
  }
  if (performance.now() >= scanDeadline) return false

  const outcome = measureProfile('Mismatch progress scan', () =>
    scanTile(buildJob(template, tile, pixels, false, false), template.indices),
  )
  rememberProgress(cacheKey, { templateSource: template.indices, ...outcome }, progressKey)
  staleProgress.delete(cacheKey)
  changed++
  count('mismatch:progress-only tiles scanned')
  notifyChanged()
  return true
}

/**
 * Materialize every array a tile consumer can ask for from one cached classification record.
 *
 * Asking for `all` forces both coordinate lists into the same scan. The four returned projections
 * therefore cannot come from different source pixels, different draft moments, or different worker
 * replies; `both` is memoized on that record and the configured projection is derived from it.
 */
const tileAccountingFor = (
  template: PlacedTemplate,
  tile: TileCoord,
): TilePixelAccounting | null => {
  const disagreements = mismatchAnswer(template, tile, 'all')
  if (disagreements === null) return null
  const entry = cache.get(`${template.id}|${tile.x}/${tile.y}`)
  if (entry === undefined || !entry.wrongComplete || !entry.unpaintedComplete) return null
  return {
    mismatched: entry.wrong,
    unpainted: entry.unpainted,
    disagreements,
    markers: answerFrom(entry, 'configured', template),
  }
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
const patchTile = (tile: TileCoord, x: number, y: number): void => {
  const draft = draftPixels(tile)
  const at = (y - tile.y * TILE_SIZE) * TILE_SIZE + (x - tile.x * TILE_SIZE)
  const drafted = draft === null ? UNPAINTED : (draft[at] as number)
  // Counted whether or not this patch changes anything, so a scan in flight can see that the ground
  // moved under it and drop its result rather than writing a pre-paint answer over it.
  //
  // Over both maps, not just the cache. A template's first scan has no cached answer yet, only an
  // in-flight one, so counting cache keys alone left exactly that scan uncountable: a paint landing
  // during it changed nothing the identity checks look at, and the pre-paint answer was cached and
  // then reused indefinitely.
  // The keys for this tile, collected once. This is both the snapshot the loop below needs and far
  // less than copying every visible answer per pixel.
  //
  // A snapshot rather than a live iteration, because `remember` deletes and re-inserts the key it
  // patches, which would move it behind a live iterator and show it to us twice.
  const suffix = `|${tile.x}/${tile.y}`
  const keys: string[] = []
  for (const key of cache.keys()) {
    if (key.endsWith(suffix)) keys.push(key)
  }
  for (const key of keys) patchCount.set(key, (patchCount.get(key) ?? 0) + 1)
  for (const key of inFlight.keys()) {
    if (key.endsWith(suffix) && !cache.has(key)) patchCount.set(key, (patchCount.get(key) ?? 0) + 1)
  }
  let invalidatedProgressOnly = false
  for (const key of progressCoverage.keys()) {
    if (!key.endsWith(suffix) || cache.has(key)) continue
    staleProgress.add(key)
    invalidatedProgressOnly = true
  }
  if (invalidatedProgressOnly) {
    changed++
    count('mismatch:progress-only tile invalidated')
  }
  // Read once. This runs per announced pixel, and a tile re-read announces every pixel that moved —
  // hundreds to thousands in one go. Reusing one id index keeps the inner loop independent of the
  // number of displayed templates.
  const templatesById = new Map(displayTemplates().map((template) => [template.id, template]))
  for (const cacheKey of keys) {
    const entry = cache.get(cacheKey)
    if (entry === undefined) continue
    const id = templateIdOf(cacheKey)
    const template = templatesById.get(id)
    if (template === undefined || entry.templateSource !== template.indices) continue

    const localX = sourceXAt(template, x)
    const localY = y - template.originY
    if (localX === null || localY < 0 || localY >= template.height) continue
    const wanted = template.indices[localY * template.width + localX]
    if (wanted === undefined) continue

    const hidden = assertedHidden(template)
    const progressAsserted = wanted !== TRANSPARENT_INDEX && wanted !== UNPAINTED
    const hiddenFromMarkers = progressAsserted && hidden.includes(wanted)
    const asserted = progressAsserted && !hiddenFromMarkers

    /**
     * Which list this pixel belongs in now, if any.
     *
     * The same split the scan makes, so a patched answer and a rescanned one agree. Whether the
     * unpainted list is *shown* is not decided here — it is decided when the answer is read, and a
     * pixel that moves in or out of that list can change the ratio it is decided by.
     */
    let belongs: 'wrong' | 'unpainted' | null | undefined
    if (!asserted) belongs = null
    else if (drafted !== UNPAINTED) belongs = drafted === wanted ? null : 'wrong'
    else {
      const serverMask = serverMismatchMaskFor(template, tile)
      const maskIsCurrent =
        serverMask !== null && supersededServerSource.get(cacheKey) !== template.serverUrl
      if (maskIsCurrent) {
        const classification = mismatchClassAt(
          serverMask,
          x - tile.x * TILE_SIZE,
          y - tile.y * TILE_SIZE,
        )
        belongs =
          classification === null
            ? undefined
            : classification === MATCH
              ? null
              : classification === BLANK
                ? 'unpainted'
                : 'wrong'
      } else {
        const server = tilePixels(tile)
        if (server === null) belongs = undefined
        else {
          const placed = server[at] as number
          belongs = placed === wanted ? null : placed === UNPAINTED ? 'unpainted' : 'wrong'
        }
      }
    }

    if (belongs === undefined) {
      stale.add(cacheKey)
      scheduleIdleScan()
      continue
    }

    const mark = packMismatchMark(x - tile.x * TILE_SIZE, y - tile.y * TILE_SIZE, wanted)
    const listed = (marks: Mismatches): number => marks.indexOf(mark)
    const inWrong = listed(entry.wrong)
    const inUnpainted = listed(entry.unpainted)
    const already = inWrong >= 0 ? 'wrong' : inUnpainted >= 0 ? 'unpainted' : null
    // Marker lists deliberately carry no state for filtered colours, so they cannot tell us what
    // this pixel counted as before the patch. Re-scan that tile in idle time instead of guessing and
    // corrupting the progress total.
    if (
      hiddenFromMarkers ||
      (already === null && (!entry.wrongComplete || !entry.unpaintedComplete))
    ) {
      stale.add(cacheKey)
      scheduleIdleScan()
      changed++
      notifyChanged()
      continue
    }
    if (already === belongs) continue

    const minus = (marks: Mismatches, at: number): Mismatches => {
      const next = new Uint32Array(marks.length - 1)
      next.set(marks.subarray(0, at))
      next.set(marks.subarray(at + 1), at)
      return next
    }
    const plus = (marks: Mismatches): Mismatches => {
      const next = new Uint32Array(marks.length + 1)
      const coordinate = markCoordinate(mark)
      let low = 0
      let high = marks.length
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (markCoordinate(marks[middle] as number) < coordinate) low = middle + 1
        else high = middle
      }
      next.set(marks.subarray(0, low))
      next[low] = mark
      next.set(marks.subarray(low), low + 1)
      return next
    }

    let { wrong, unpainted } = entry
    if (inWrong >= 0) wrong = minus(wrong, inWrong)
    if (inUnpainted >= 0) unpainted = minus(unpainted, inUnpainted)
    if (belongs === 'wrong') wrong = plus(wrong)
    if (belongs === 'unpainted') unpainted = plus(unpainted)

    let { completed, mismatched, progressUnpainted } = entry
    let progressByColour = entry.progressByColour
    if (progressAsserted) {
      if (already === 'wrong') mismatched--
      else if (already === 'unpainted') progressUnpainted--
      else completed--
      if (belongs === 'wrong') mismatched++
      else if (belongs === 'unpainted') progressUnpainted++
      else completed++

      let colourAt = -1
      for (let at = 0; at < progressByColour.length; at += 4) {
        if (progressByColour[at] === wanted) {
          colourAt = at
          break
        }
      }
      if (colourAt < 0) {
        const next = new Uint32Array(progressByColour.length + 4)
        next.set(progressByColour)
        colourAt = progressByColour.length
        next[colourAt] = wanted
        progressByColour = next
      } else {
        progressByColour = progressByColour.slice()
      }
      const previousOffset = already === 'wrong' ? 2 : already === 'unpainted' ? 3 : 1
      const nextOffset = belongs === 'wrong' ? 2 : belongs === 'unpainted' ? 3 : 1
      progressByColour[colourAt + previousOffset] = Math.max(
        0,
        (progressByColour[colourAt + previousOffset] ?? 0) - 1,
      )
      progressByColour[colourAt + nextOffset] = (progressByColour[colourAt + nextOffset] ?? 0) + 1
    }

    const patched: Cached = {
      source: entry.source,
      templateSource: entry.templateSource,
      key: entry.key,
      wrongComplete: entry.wrongComplete,
      unpaintedComplete: entry.unpaintedComplete,
      wrong,
      unpainted,
      asserted: entry.asserted,
      completed,
      mismatched,
      progressUnpainted,
      progressAsserted: entry.progressAsserted,
      progressByColour,
      both: null,
    }
    rememberCoverage(cacheKey, patched)
    rememberProgress(cacheKey, patched, progressSignature(template))
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

const MAX_PATCHED_PIXELS = 32

onTilePixels((tile, triples, source) => {
  const before = changed
  if (triples.length / 3 > MAX_PATCHED_PIXELS) {
    const suffix = `|${tile.x}/${tile.y}`
    const pixels = tilePixels(tile)
    const templatesById = new Map(displayTemplates().map((template) => [template.id, template]))
    let invalidated = false
    for (const [cacheKey, entry] of cache) {
      if (!cacheKey.endsWith(suffix)) continue
      const serverUrl = templatesById.get(templateIdOf(cacheKey))?.serverUrl
      if (source === 'server' && entry.source !== pixels && serverUrl !== undefined) {
        supersededServerSource.set(cacheKey, serverUrl)
      }
      stale.add(cacheKey)
      patchCount.set(cacheKey, (patchCount.get(cacheKey) ?? 0) + 1)
      invalidated = true
    }
    for (const [cacheKey, pending] of inFlight) {
      if (!cacheKey.endsWith(suffix) || cache.has(cacheKey)) continue
      const serverUrl = templatesById.get(templateIdOf(cacheKey))?.serverUrl
      if (source === 'server' && pending.source !== pixels && serverUrl !== undefined) {
        supersededServerSource.set(cacheKey, serverUrl)
      }
      patchCount.set(cacheKey, (patchCount.get(cacheKey) ?? 0) + 1)
    }
    for (const cacheKey of progressCoverage.keys()) {
      if (!cacheKey.endsWith(suffix) || cache.has(cacheKey)) continue
      staleProgress.add(cacheKey)
      invalidated = true
    }
    if (invalidated) {
      changed++
    }
  } else {
    for (let i = 0; i < triples.length; i += 3) {
      const localX = triples[i] as number
      const localY = triples[i + 1] as number
      patchTile(tile, tile.x * TILE_SIZE + localX, tile.y * TILE_SIZE + localY)
    }
  }
  const suffix = `|${tile.x}/${tile.y}`
  if (
    [...stale].some((cacheKey) => cacheKey.endsWith(suffix)) ||
    [...staleProgress].some((cacheKey) => cacheKey.endsWith(suffix))
  ) {
    scheduleIdleScan()
  }
  if (changed === before) return
  notifyChanged()
})

onTilePixelsAvailable((tile) => {
  const suffix = `|${tile.x}/${tile.y}`
  if (
    [...stale].some((cacheKey) => cacheKey.endsWith(suffix)) ||
    [...staleProgress].some((cacheKey) => cacheKey.endsWith(suffix))
  ) {
    scheduleIdleScan()
  }
})

onServerMismatchesChanged(() => {
  changed++
  notifyChanged()
})

onTilePixelsEvicted((tile) => {
  const suffix = `|${tile.x}/${tile.y}`
  for (const cacheKey of supersededServerSource.keys()) {
    if (cacheKey.endsWith(suffix)) supersededServerSource.delete(cacheKey)
  }
})

/** Forget everything for a template that has gone, so its tiles are not held alive by the cache. */
export const forgetMismatches = (id: string): void => {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${id}|`)) deleteCachedAnswer(key)
  }
  for (const key of [...coverage.keys()]) {
    if (key.startsWith(`${id}|`)) forgetCoverage(key)
  }
  coverageTotals.delete(id)
  for (const key of [...(progressKeys.get(id) ?? [])]) forgetProgress(key)
  progressTotals.delete(id)
  for (const key of [...inFlight.keys()]) {
    if (key.startsWith(`${id}|`)) inFlight.delete(key)
  }
  for (const key of [...patchCount.keys()]) {
    if (key.startsWith(`${id}|`)) patchCount.delete(key)
  }
  for (const key of [...stale]) {
    if (key.startsWith(`${id}|`)) stale.delete(key)
  }
  for (const key of [...staleProgress]) {
    if (key.startsWith(`${id}|`)) staleProgress.delete(key)
  }
  for (const key of [...pendingProgressPixels]) {
    if (key.startsWith(`${id}|`)) pendingProgressPixels.delete(key)
  }
  for (const key of [...supersededServerSource.keys()]) {
    if (key.startsWith(`${id}|`)) supersededServerSource.delete(key)
  }
  forgetInWorker(id)
}

let knownTemplateIds = new Set<string>()
onLocalChange(() => {
  const current = new Set(displayTemplates().map((template) => template.id))
  for (const id of knownTemplateIds) {
    if (!current.has(id)) forgetMismatches(id)
  }
  knownTemplateIds = current
})

/**
 * The deep module seam for template accounting.
 *
 * Capture, worker scheduling, server-mask selection, draft precedence, cache invalidation and
 * per-pixel patching stay behind this interface. Callers receive only stable typed-array projections
 * and aggregates from the one managed record. A future Wasm implementation can satisfy this same
 * interface while TypeScript keeps MapLibre, WebGL and UI ownership.
 */
export const pixelAccounting = Object.freeze({
  read: (template: PlacedTemplate): TemplatePixelAccounting => ({
    wanted: template.indices,
    get progress() {
      return progressFor(template)
    },
    get colours() {
      return colourProgressFor(template)
    },
    tile: (tile) => tileAccountingFor(template, tile),
    unpainted: (tile) => mismatchAnswer(template, tile, 'unpainted'),
    ensure: (tile) => progressIn(template, tile),
    nearest: (index, kind, reference, exclude) =>
      nearestColourTarget(index, kind, reference, template.id, exclude),
  }),
  frame: <Result>(read: () => Result): Result => {
    beginMismatchFrame()
    try {
      return read()
    } finally {
      endMismatchFrame()
    }
  },
  wantsTilePixels,
  onChange: onMismatchesChanged,
  memoryBytes: mismatchMemoryBytes,
  revision: mismatchRevision,
})
