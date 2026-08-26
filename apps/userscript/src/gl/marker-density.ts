import { TILE_SIZE } from '@caelestis/shared'
import { DEFAULT_MARKER_BUDGET } from '../marker-budget.js'
import { type MismatchMarks, markLocalX, markLocalY } from '../templates/mismatch-marks.js'

/** Default dense-point target for one marker kind across the whole viewport. */
export const MARKER_VIEWPORT_BUDGET = DEFAULT_MARKER_BUDGET

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
  readonly marks: MismatchMarks
  /** A subarray shares the source buffer; only filtered x-ranges own another allocation. */
  readonly ownsBuffer: boolean
}

const EMPTY = new Uint32Array(0)
const COORDINATE_MASK = 0xfffff
const DENSITY_CELL_DEVICE_PX = 12
const SPARSE_NEIGHBOUR_LIMIT = 4
const CLIP_VARIANTS_PER_SOURCE = 4
const DENSITY_ANALYSIS_VARIANTS = 8
const clipped = new Map<MismatchMarks, Map<string, Clipped>>()
const usedClips = new Set<MismatchMarks>()

interface DensityAnalysis {
  readonly sparse: MismatchMarks
  readonly dense: MismatchMarks
}

interface DensityBatchSnapshot {
  readonly marks: MismatchMarks
  /** Tile offsets in tile-width units, so a uniform pan or zoom does not invalidate the sample. */
  readonly relativeX: number
  readonly relativeY: number
  /** Screen scale changes only when crossing a density-relevant zoom bucket. */
  readonly scaleX: number
  readonly scaleY: number
  readonly padding: number
}

interface ViewportDensityAnalysis {
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly cellSize: number
  readonly batches: readonly DensityBatchSnapshot[]
  readonly analyses: readonly DensityAnalysis[]
  readonly selections: Map<number, readonly MismatchMarks[]>
}

let densityAnalyses: ViewportDensityAnalysis[] = []
const usedDensityAnalyses = new Set<ViewportDensityAnalysis>()

/** Eight density decisions per map zoom level; fractional animation frames reuse one selection. */
const DENSITY_ZOOM_STEPS = 8

const densityScale = (size: number): number =>
  Math.round(Math.log2(Math.max(Number.MIN_VALUE, size)) * DENSITY_ZOOM_STEPS)

const stableRatio = (distance: number, size: number): number =>
  Math.round((distance / size) * 1_000_000) / 1_000_000

export const beginMarkerDensityFrame = (): void => {
  usedClips.clear()
  usedDensityAnalyses.clear()
}

export const endMarkerDensityFrame = (): void => {
  for (const source of clipped.keys()) if (!usedClips.has(source)) clipped.delete(source)
  if (usedDensityAnalyses.size === 0) densityAnalyses = []
}

export const markerDensityMemoryBytes = (): number => {
  const buffers = new Set<ArrayBufferLike>()
  for (const variants of clipped.values()) {
    for (const entry of variants.values()) {
      if (entry.ownsBuffer) buffers.add(entry.marks.buffer)
    }
  }
  for (const viewportAnalysis of densityAnalyses) {
    for (const analysis of viewportAnalysis.analyses) {
      buffers.add(analysis.sparse.buffer)
      buffers.add(analysis.dense.buffer)
    }
    for (const selection of viewportAnalysis.selections.values()) {
      for (const marks of selection) buffers.add(marks.buffer)
    }
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
  const screenStep = Math.max(DENSITY_CELL_DEVICE_PX, padding * 2)
  const stepX = Math.max(1, Math.ceil(screenStep / scaleX))
  const stepY = Math.max(1, Math.ceil(screenStep / scaleY))
  const rawLeft = Math.ceil((-padding - tile.x) / scaleX - 0.5)
  const rawRight = Math.floor((viewport.width + padding - tile.x) / scaleX - 0.5) + 1
  const rawTop = Math.ceil((-padding - tile.y) / scaleY - 0.5)
  const rawBottom = Math.floor((viewport.height + padding - tile.y) / scaleY - 0.5) + 1
  // Round outwards: edge buffers change once per density cell instead of once per source pixel,
  // while the overscan guarantees that a marker entering the viewport is already present.
  const left = clamp(Math.floor(rawLeft / stepX) * stepX)
  const right = clamp(Math.ceil(rawRight / stepX) * stepX)
  const top = clamp(Math.floor(rawTop / stepY) * stepY)
  const bottom = clamp(Math.ceil(rawBottom / stepY) * stepY)
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
  let variants = clipped.get(marks)
  const held = variants?.get(key)
  if (held !== undefined && variants !== undefined) {
    // Refresh insertion order: the small variant map is an LRU for back-and-forth panning.
    variants.delete(key)
    variants.set(key, held)
    return held.marks
  }

  const remember = (entry: Clipped): MismatchMarks => {
    variants ??= new Map()
    variants.set(key, entry)
    while (variants.size > CLIP_VARIANTS_PER_SOURCE) {
      const oldest = variants.keys().next().value
      if (oldest === undefined) break
      variants.delete(oldest)
    }
    clipped.set(marks, variants)
    return entry.marks
  }

  const first = lowerBound(marks, top << 10)
  const last = lowerBound(marks, bottom << 10)
  if (first === last) {
    return remember({ marks: EMPTY, ownsBuffer: false })
  }
  if (left === 0 && right === TILE_SIZE) {
    const visible = marks.subarray(first, last)
    return remember({ marks: visible, ownsBuffer: false })
  }

  let length = 0
  for (let at = first; at < last; at++) {
    const x = markLocalX(marks[at] as number)
    if (x >= left && x < right) length++
  }
  if (length === 0) {
    return remember({ marks: EMPTY, ownsBuffer: false })
  }
  const visible = new Uint32Array(length)
  let write = 0
  for (let at = first; at < last; at++) {
    const mark = marks[at] as number
    const x = markLocalX(mark)
    if (x >= left && x < right) visible[write++] = mark
  }
  return remember({ marks: visible, ownsBuffer: true })
}

const evenlySample = (marks: MismatchMarks, limit: number): MismatchMarks => {
  if (marks.length <= limit) return marks
  if (limit <= 0) return EMPTY
  const sampled = new Uint32Array(limit)
  for (let point = 0; point < limit; point++) {
    sampled[point] = marks[Math.floor(((point + 0.5) * marks.length) / limit)] as number
  }
  return sampled
}

/**
 * Split every batch by aggregate screen-space density.
 *
 * A marker is sparse while at most four points across all templates occupy its cell and the eight
 * cells around it. Neighbouring cells keep isolated points stable across grid boundaries, while a
 * common viewport grid prevents coincident templates from each claiming their own sparse exemption.
 */
const analyseDensity = (
  batches: readonly ViewportMarkerBatch[],
  viewport: Viewport,
): ViewportDensityAnalysis => {
  const padding = batches.reduce((largest, batch) => Math.max(largest, batch.padding), 0)
  const cellSize = Math.max(DENSITY_CELL_DEVICE_PX, padding * 2)
  const anchor = batches[0] as ViewportMarkerBatch
  const snapshots = batches.map((batch) => ({
    marks: batch.marks,
    relativeX: stableRatio(batch.tile.x - anchor.tile.x, anchor.tile.width),
    relativeY: stableRatio(batch.tile.y - anchor.tile.y, anchor.tile.height),
    scaleX: densityScale(batch.tile.width),
    scaleY: densityScale(batch.tile.height),
    padding: batch.padding,
  }))
  const heldAt = densityAnalyses.findIndex(
    (analysis) =>
      analysis.viewportWidth === viewport.width &&
      analysis.viewportHeight === viewport.height &&
      analysis.cellSize === cellSize &&
      analysis.batches.length === snapshots.length &&
      analysis.batches.every((batch, at) => {
        const current = snapshots[at]
        return (
          current !== undefined &&
          batch.marks === current.marks &&
          batch.relativeX === current.relativeX &&
          batch.relativeY === current.relativeY &&
          batch.scaleX === current.scaleX &&
          batch.scaleY === current.scaleY &&
          batch.padding === current.padding
        )
      }),
  )
  if (heldAt >= 0) {
    const held = densityAnalyses[heldAt] as ViewportDensityAnalysis
    densityAnalyses.splice(heldAt, 1)
    densityAnalyses.push(held)
    usedDensityAnalyses.add(held)
    return held
  }

  const minCellX = Math.floor(-padding / cellSize)
  const minCellY = Math.floor(-padding / cellSize)
  const maxCellX = Math.floor((viewport.width + padding) / cellSize)
  const maxCellY = Math.floor((viewport.height + padding) / cellSize)
  const cellsAcross = Math.max(1, maxCellX - minCellX + 1)
  const cellsDown = Math.max(1, maxCellY - minCellY + 1)
  const cellOf = (mark: number, batch: ViewportMarkerBatch): number => {
    const screenX = batch.tile.x + ((markLocalX(mark) + 0.5) * batch.tile.width) / TILE_SIZE
    const screenY = batch.tile.y + ((markLocalY(mark) + 0.5) * batch.tile.height) / TILE_SIZE
    const x = Math.max(0, Math.min(cellsAcross - 1, Math.floor(screenX / cellSize) - minCellX))
    const y = Math.max(0, Math.min(cellsDown - 1, Math.floor(screenY / cellSize) - minCellY))
    return y * cellsAcross + x
  }
  const counts = new Map<number, number>()
  const markCells = batches.map((batch) => {
    const cells = new Uint32Array(batch.marks.length)
    for (let at = 0; at < batch.marks.length; at++) {
      const cell = cellOf(batch.marks[at] as number, batch)
      cells[at] = cell
      counts.set(cell, (counts.get(cell) ?? 0) + 1)
    }
    return cells
  })

  // Neighbourhood density belongs to a screen cell, not to an individual marker. Computing the
  // same nine Map lookups once for every marker was especially expensive for the dense regions this
  // sampler exists to reduce. Classify each occupied cell once, then markers only need one Set lookup.
  const sparseCells = new Set<number>()
  for (const cell of counts.keys()) {
    const x = cell % cellsAcross
    const y = Math.floor(cell / cellsAcross)
    let neighbours = 0
    for (let cellY = Math.max(0, y - 1); cellY <= Math.min(cellsDown - 1, y + 1); cellY++) {
      for (let cellX = Math.max(0, x - 1); cellX <= Math.min(cellsAcross - 1, x + 1); cellX++) {
        neighbours += counts.get(cellY * cellsAcross + cellX) ?? 0
        if (neighbours > SPARSE_NEIGHBOUR_LIMIT) break
      }
      if (neighbours > SPARSE_NEIGHBOUR_LIMIT) break
    }
    if (neighbours <= SPARSE_NEIGHBOUR_LIMIT) sparseCells.add(cell)
  }

  const analyses = batches.map((batch, batchAt): DensityAnalysis => {
    const cells = markCells[batchAt] as Uint32Array
    let sparseLength = 0
    for (const cell of cells) if (sparseCells.has(cell)) sparseLength++
    const sparse = new Uint32Array(sparseLength)
    const dense = new Uint32Array(batch.marks.length - sparseLength)
    let sparseAt = 0
    let denseAt = 0
    for (let at = 0; at < batch.marks.length; at++) {
      const mark = batch.marks[at] as number
      if (sparseCells.has(cells[at] as number)) sparse[sparseAt++] = mark
      else dense[denseAt++] = mark
    }
    return { sparse, dense }
  })
  const analysis = {
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    cellSize,
    batches: snapshots,
    analyses,
    selections: new Map<number, readonly MismatchMarks[]>(),
  }
  densityAnalyses.push(analysis)
  while (densityAnalyses.length > DENSITY_ANALYSIS_VARIANTS) densityAnalyses.shift()
  usedDensityAnalyses.add(analysis)
  return analysis
}

/** Merge two row-major lists while retaining packed colour data. */
const mergeMarks = (
  source: MismatchMarks,
  analysis: DensityAnalysis,
  sampledDense: MismatchMarks,
): MismatchMarks => {
  if (analysis.sparse.length === 0) return sampledDense
  if (sampledDense.length === 0) return analysis.sparse
  if (sampledDense === analysis.dense) return source

  const merged = new Uint32Array(analysis.sparse.length + sampledDense.length)
  let sparseAt = 0
  let denseAt = 0
  let write = 0
  while (sparseAt < analysis.sparse.length || denseAt < sampledDense.length) {
    const sparse = analysis.sparse[sparseAt]
    const dense = sampledDense[denseAt]
    if (
      dense === undefined ||
      (sparse !== undefined && (sparse & COORDINATE_MASK) <= (dense & COORDINATE_MASK))
    ) {
      merged[write++] = sparse as number
      sparseAt++
    } else {
      merged[write++] = dense
      denseAt++
    }
  }
  return merged
}

/** Build each budget's completed marker buffers once; drawing only substitutes current tile data. */
const selectionFor = (
  density: ViewportDensityAnalysis,
  batches: readonly ViewportMarkerBatch[],
  limit: number,
): readonly MismatchMarks[] => {
  const held = density.selections.get(limit)
  if (held !== undefined) return held

  const sparseTotal = density.analyses.reduce((sum, analysis) => sum + analysis.sparse.length, 0)
  const denseLimit = Math.max(0, limit - sparseTotal)
  const quotas = new Uint32Array(density.analyses.length)
  const denseBatches = density.analyses.flatMap((analysis, at) =>
    analysis.dense.length === 0 ? [] : [{ at, length: analysis.dense.length }],
  )
  const denseTotal = denseBatches.reduce((sum, item) => sum + item.length, 0)
  if (denseTotal <= denseLimit) {
    for (const item of denseBatches) quotas[item.at] = item.length
  } else if (denseBatches.length > denseLimit) {
    for (let point = 0; point < denseLimit; point++) {
      const item = denseBatches[Math.floor(((point + 0.5) * denseBatches.length) / denseLimit)]
      if (item !== undefined) quotas[item.at] = 1
    }
  } else {
    for (const item of denseBatches) quotas[item.at] = 1
    let remaining = denseLimit - denseBatches.length
    const population = denseTotal - denseBatches.length
    const remainders: Array<{ readonly at: number; readonly remainder: number }> = []
    for (const item of denseBatches) {
      const weight = item.length - 1
      const exact = population === 0 ? 0 : (weight * remaining) / population
      const extra = Math.floor(exact)
      quotas[item.at] = (quotas[item.at] ?? 0) + extra
      remainders.push({ at: item.at, remainder: exact - extra })
    }
    remaining = denseLimit - quotas.reduce((sum, quota) => sum + quota, 0)
    remainders.sort((left, right) => right.remainder - left.remainder)
    for (let at = 0; at < remaining; at++) {
      const batch = remainders[at] as { readonly at: number }
      quotas[batch.at] = (quotas[batch.at] ?? 0) + 1
    }
  }

  const selected = density.analyses.map((analysis, at) =>
    mergeMarks(
      (batches[at] as ViewportMarkerBatch).marks,
      analysis,
      evenlySample(analysis.dense, quotas[at] ?? 0),
    ),
  )
  density.selections.set(limit, selected)
  return selected
}

/**
 * Clip first, preserve spatially isolated points, then share the remaining target across dense
 * visible regions.
 *
 * Each non-empty template/tile batch receives one point before the remainder is allocated in
 * proportion to its visible population. That keeps sparse regions represented instead of letting a
 * dense batch encountered earlier consume the budget. Within a row-major batch, even sampling keeps
 * the result distributed rather than chopping off the tail. The target is deliberately soft: lone
 * markers are the most useful ones on screen and are never discarded merely to hit an exact count.
 */
export const viewportMarkerBatches = <Batch extends ViewportMarkerBatch>(
  batches: readonly Batch[],
  viewport: Viewport,
  budget = MARKER_VIEWPORT_BUDGET,
): Batch[] => {
  const limit = Math.max(0, Math.floor(budget))
  const sourceTotal = batches.reduce((sum, batch) => sum + batch.marks.length, 0)
  // Current tile work already belongs to the viewport. If it fits, the vertex shader can clip its
  // edge points for less CPU than rebuilding typed arrays that contain the same visible result.
  if (sourceTotal <= limit) return batches.filter((batch) => batch.marks.length > 0) as Batch[]
  const visible = batches.flatMap((batch) => {
    const marks = visibleMarks(batch.marks, batch.tile, viewport, batch.padding)
    return marks.length === 0 ? [] : [{ ...batch, marks }]
  }) as Batch[]
  const total = visible.reduce((sum, batch) => sum + batch.marks.length, 0)
  if (total <= limit) return visible
  const density = analyseDensity(visible, viewport)
  const selection = selectionFor(density, visible, limit)
  return visible.flatMap((batch, at) => {
    const marks = selection[at] as MismatchMarks
    return marks.length === 0 ? [] : [{ ...batch, marks }]
  }) as Batch[]
}
