import { TILE_SIZE } from '@caelestis/shared'
import { DEFAULT_MARKER_BUDGET } from '../marker-budget.js'

/** Default approximate point target for one marker kind across the viewport. */
export const MARKER_VIEWPORT_BUDGET = DEFAULT_MARKER_BUDGET

/**
 * Fraction of source marker vertices the GPU should keep.
 *
 * The vertex shader applies an evenly distributed sequence and rejects the rest before
 * rasterisation. This is an approximate budget by design: avoiding an exact CPU selection means
 * changing the limit is O(1), creates no typed arrays, and leaves reusable source buffers untouched.
 */
export const markerSampleRate = (sourcePoints: number, budget = MARKER_VIEWPORT_BUDGET): number => {
  const source = Math.max(0, Math.floor(sourcePoints))
  const limit = Math.max(0, Math.floor(budget))
  if (source === 0 || limit === 0) return 0
  return Math.min(1, limit / source)
}

/** Exact uint hash used by the marker vertex shader, exposed for sequence regression tests. */
export const markerHash = (ordinal: number, seed = 0): number => {
  let value = (ordinal ^ seed) >>> 0
  value = Math.imul(value ^ (value >>> 16), 0x7feb_352d) >>> 0
  value = Math.imul(value ^ (value >>> 15), 0x846c_a68b) >>> 0
  return (value ^ (value >>> 16)) >>> 0
}

/** Population retained by the shader's 24-bit threshold for a focused test-sized source. */
export const sampledMarkerPopulation = (
  sourcePoints: number,
  sampleRate: number,
  seed = 0,
): number => {
  const threshold = Math.max(0, Math.min(0x1_000000, Math.floor(sampleRate * 0x1_000000)))
  let retained = 0
  for (let ordinal = 0; ordinal < sourcePoints; ordinal++) {
    if (markerHash(ordinal, seed) >>> 8 < threshold) retained++
  }
  return retained
}

interface MarkerViewport {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface MarkerVisibilityBudget {
  remainingComparisons: number
}

/** Shared per-frame ceiling for every clipped marker count. */
export const markerVisibilityBudget = (): MarkerVisibilityBudget => ({
  remainingComparisons: 64_000,
})

/**
 * Count visible packed marker coordinates without source-sized work or allocations.
 *
 * Mismatch marks are ordered by tile-local y then x. A clipped rectangle is therefore a pair of
 * binary searches per visible row, capped by the fixed 1,000-row tile size. Fully visible and fully
 * clipped tiles return without searching. A shared frame allowance falls back to the conservative
 * full source count before aggregate search work can become a stall.
 */
export const visibleMarkerPoints = (
  marks: Uint32Array,
  tile: MarkerViewport,
  bufferWidth: number,
  bufferHeight: number,
  budget: MarkerVisibilityBudget,
): number => {
  if (marks.length === 0 || bufferWidth <= 0 || bufferHeight <= 0) return 0
  if (tile.width <= 0 || tile.height <= 0) return 0
  if (
    tile.x >= bufferWidth ||
    tile.y >= bufferHeight ||
    tile.x + tile.width <= 0 ||
    tile.y + tile.height <= 0
  )
    return 0
  if (
    tile.x >= 0 &&
    tile.y >= 0 &&
    tile.x + tile.width <= bufferWidth &&
    tile.y + tile.height <= bufferHeight
  )
    return marks.length

  const clampPixel = (value: number): number => Math.max(0, Math.min(TILE_SIZE, value))
  const startX = clampPixel(Math.ceil((-tile.x * TILE_SIZE) / tile.width - 0.5))
  const endX = clampPixel(Math.ceil(((bufferWidth - tile.x) * TILE_SIZE) / tile.width - 0.5))
  const startY = clampPixel(Math.ceil((-tile.y * TILE_SIZE) / tile.height - 0.5))
  const endY = clampPixel(Math.ceil(((bufferHeight - tile.y) * TILE_SIZE) / tile.height - 0.5))
  if (startX >= endX || startY >= endY) return 0

  const comparisonsPerSearch = Math.ceil(Math.log2(marks.length + 1))
  const requiredComparisons = (endY - startY) * 2 * comparisonsPerSearch
  // Counting the whole source is conservative: the shader may retain fewer visible points, but it
  // cannot exceed the configured target because uncounted offscreen points remain in the divisor.
  if (requiredComparisons > budget.remainingComparisons) return marks.length
  budget.remainingComparisons -= requiredComparisons

  const lowerBound = (coordinate: number): number => {
    let low = 0
    let high = marks.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (((marks[middle] as number) & 0x0f_ffff) < coordinate) low = middle + 1
      else high = middle
    }
    return low
  }
  let visible = 0
  for (let y = startY; y < endY; y++) {
    visible += lowerBound((y << 10) | endX) - lowerBound((y << 10) | startX)
  }
  return visible
}

/** GPU sampling retains no density-analysis or sampled-marker CPU buffers. */
export const markerDensityMemoryBytes = (): number => 0
