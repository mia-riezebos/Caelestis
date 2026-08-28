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

/** GPU sampling retains no density-analysis or sampled-marker CPU buffers. */
export const markerDensityMemoryBytes = (): number => 0
