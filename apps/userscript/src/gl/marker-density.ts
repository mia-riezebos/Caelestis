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

/** GPU sampling retains no density-analysis or sampled-marker CPU buffers. */
export const markerDensityMemoryBytes = (): number => 0
