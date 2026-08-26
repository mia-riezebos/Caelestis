import { TILE_SIZE } from '@caelestis/shared'
import { type MismatchMarks, markLocalX } from '../templates/mismatch-marks.js'

/** Maximum points submitted for one marker kind across the whole viewport. */
export const MARKER_VIEWPORT_BUDGET = 16_384

interface ScreenTile {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ViewportMarkerBatch {
  readonly tile: ScreenTile
  readonly marks: MismatchMarks
  /** Half the marker's device-pixel diameter, so points touching an edge remain visible. */
  readonly padding: number
}

interface Viewport {
  readonly width: number
  readonly height: number
}

interface Clipped {
  readonly key: string
  readonly marks: MismatchMarks
  /** A subarray shares the source buffer; only filtered x-ranges own another allocation. */
  readonly ownsBuffer: boolean
}

const EMPTY = new Uint32Array(0)
const COORDINATE_MASK = 0xfffff
const clipped = new Map<MismatchMarks, Clipped>()
const usedClips = new Set<MismatchMarks>()
const samples = new Map<MismatchMarks, Map<number, MismatchMarks>>()
const usedSamples = new Set<MismatchMarks>()

export const beginMarkerDensityFrame = (): void => {
  usedClips.clear()
  usedSamples.clear()
}

export const endMarkerDensityFrame = (): void => {
  for (const source of clipped.keys()) if (!usedClips.has(source)) clipped.delete(source)
  for (const [source, byLimit] of samples) {
    for (const [limit, marks] of byLimit) if (!usedSamples.has(marks)) byLimit.delete(limit)
    if (byLimit.size === 0) samples.delete(source)
  }
}

export const markerDensityMemoryBytes = (): number => {
  const buffers = new Set<ArrayBufferLike>()
  for (const entry of clipped.values()) if (entry.ownsBuffer) buffers.add(entry.marks.buffer)
  for (const byLimit of samples.values()) {
    for (const marks of byLimit.values()) buffers.add(marks.buffer)
  }
  let bytes = 0
  for (const buffer of buffers) bytes += buffer.byteLength
  return bytes
}

const clamp = (value: number): number => Math.max(0, Math.min(TILE_SIZE, value))

const visibleBounds = (
  tile: ScreenTile,
  viewport: Viewport,
  padding: number,
): readonly [number, number, number, number] | null => {
  if (tile.width <= 0 || tile.height <= 0) return null
  const scaleX = tile.width / TILE_SIZE
  const scaleY = tile.height / TILE_SIZE
  const left = clamp(Math.ceil((-padding - tile.x) / scaleX - 0.5))
  const right = clamp(Math.floor((viewport.width + padding - tile.x) / scaleX - 0.5) + 1)
  const top = clamp(Math.ceil((-padding - tile.y) / scaleY - 0.5))
  const bottom = clamp(Math.floor((viewport.height + padding - tile.y) / scaleY - 0.5) + 1)
  return left >= right || top >= bottom ? null : [left, right, top, bottom]
}

/** First row-major mark whose packed local coordinate is at least `coordinate`. */
const lowerBound = (marks: MismatchMarks, coordinate: number): number => {
  let low = 0
  let high = marks.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (((marks[middle] as number) & COORDINATE_MASK) < coordinate) low = middle + 1
    else high = middle
  }
  return low
}

const visibleMarks = (
  marks: MismatchMarks,
  tile: ScreenTile,
  viewport: Viewport,
  padding: number,
): MismatchMarks => {
  const bounds = visibleBounds(tile, viewport, Math.max(0, padding))
  if (bounds === null || marks.length === 0) return EMPTY
  const [left, right, top, bottom] = bounds
  if (left === 0 && right === TILE_SIZE && top === 0 && bottom === TILE_SIZE) return marks
  usedClips.add(marks)
  const key = `${left}/${right}/${top}/${bottom}`
  const held = clipped.get(marks)
  if (held?.key === key) return held.marks

  const first = lowerBound(marks, top << 10)
  const last = lowerBound(marks, bottom << 10)
  if (first === last) {
    clipped.set(marks, { key, marks: EMPTY, ownsBuffer: false })
    return EMPTY
  }
  if (left === 0 && right === TILE_SIZE) {
    const visible = marks.subarray(first, last)
    clipped.set(marks, { key, marks: visible, ownsBuffer: false })
    return visible
  }

  let length = 0
  for (let at = first; at < last; at++) {
    const x = markLocalX(marks[at] as number)
    if (x >= left && x < right) length++
  }
  if (length === 0) {
    clipped.set(marks, { key, marks: EMPTY, ownsBuffer: false })
    return EMPTY
  }
  const visible = new Uint32Array(length)
  let write = 0
  for (let at = first; at < last; at++) {
    const mark = marks[at] as number
    const x = markLocalX(mark)
    if (x >= left && x < right) visible[write++] = mark
  }
  clipped.set(marks, { key, marks: visible, ownsBuffer: true })
  return visible
}

const evenlySample = (marks: MismatchMarks, limit: number): MismatchMarks => {
  if (marks.length <= limit) return marks
  if (limit <= 0) return EMPTY
  let byLimit = samples.get(marks)
  if (byLimit === undefined) {
    byLimit = new Map()
    samples.set(marks, byLimit)
  }
  const held = byLimit.get(limit)
  if (held !== undefined) {
    usedSamples.add(held)
    return held
  }
  const sampled = new Uint32Array(limit)
  for (let point = 0; point < limit; point++) {
    sampled[point] = marks[Math.floor(((point + 0.5) * marks.length) / limit)] as number
  }
  byLimit.set(limit, sampled)
  usedSamples.add(sampled)
  return sampled
}

/**
 * Clip first, then share one fixed budget across every visible region.
 *
 * Each non-empty template/tile batch receives one point before the remainder is allocated in
 * proportion to its visible population. That keeps sparse regions represented instead of letting a
 * dense batch encountered earlier consume the budget. Within a row-major batch, even sampling keeps
 * the result distributed rather than chopping off the tail.
 */
export const viewportMarkerBatches = <Batch extends ViewportMarkerBatch>(
  batches: readonly Batch[],
  viewport: Viewport,
  budget = MARKER_VIEWPORT_BUDGET,
): Batch[] => {
  const visible = batches.flatMap((batch) => {
    const marks = visibleMarks(batch.marks, batch.tile, viewport, batch.padding)
    return marks.length === 0 ? [] : [{ ...batch, marks }]
  }) as Batch[]
  const total = visible.reduce((sum, batch) => sum + batch.marks.length, 0)
  const limit = Math.max(0, Math.floor(budget))
  if (total <= limit) return visible
  if (limit === 0) return []

  const quotas = new Uint32Array(visible.length)
  if (visible.length > limit) {
    for (let point = 0; point < limit; point++) {
      quotas[Math.floor(((point + 0.5) * visible.length) / limit)] = 1
    }
  } else {
    quotas.fill(1)
    let remaining = limit - visible.length
    const population = total - visible.length
    const remainders: Array<{ readonly at: number; readonly remainder: number }> = []
    for (let at = 0; at < visible.length; at++) {
      const weight = (visible[at]?.marks.length ?? 0) - 1
      const exact = population === 0 ? 0 : (weight * remaining) / population
      const extra = Math.floor(exact)
      quotas[at] = (quotas[at] ?? 0) + extra
      remainders.push({ at, remainder: exact - extra })
    }
    remaining = limit - quotas.reduce((sum, quota) => sum + quota, 0)
    remainders.sort((left, right) => right.remainder - left.remainder)
    for (let at = 0; at < remaining; at++) {
      const batch = remainders[at] as { readonly at: number }
      quotas[batch.at] = (quotas[batch.at] ?? 0) + 1
    }
  }

  return visible.flatMap((batch, at) => {
    const quota = quotas[at] ?? 0
    return quota === 0 ? [] : [{ ...batch, marks: evenlySample(batch.marks, quota) }]
  }) as Batch[]
}
