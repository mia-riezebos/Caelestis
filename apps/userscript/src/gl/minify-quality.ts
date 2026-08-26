export const MEDIUM_MINIFY_FOOTPRINT = 2
export const FULL_MINIFY_FOOTPRINT = 3

/** CPU mirror of the shader's sample-grid policy, kept here so its quality tiers are testable. */
export const minifyTapGrid = (maximumFootprint: number): 1 | 2 | 3 | 4 => {
  if (maximumFootprint <= 1) return 1
  if (maximumFootprint <= MEDIUM_MINIFY_FOOTPRINT) return 2
  if (maximumFootprint <= FULL_MINIFY_FOOTPRINT) return 3
  return 4
}

/** Motion keeps the same distributed minification path but caps its most expensive tier. */
export const movingMinifyTapGrid = (maximumFootprint: number): 1 | 2 | 3 =>
  Math.min(3, minifyTapGrid(maximumFootprint)) as 1 | 2 | 3
