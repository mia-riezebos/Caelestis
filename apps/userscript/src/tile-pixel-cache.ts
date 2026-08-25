/**
 * Size captured-tile history to the browser's coarse device-memory signal.
 * Each retained tile is one MiB, and visible misses can be fetched again, so low-memory machines
 * benefit more from avoiding pressure than from keeping a very long pan history.
 */
export const tilePixelCacheLimit = (deviceMemoryGiB: number | undefined): number => {
  if (deviceMemoryGiB === undefined || deviceMemoryGiB > 8) return 64
  if (deviceMemoryGiB > 4) return 48
  if (deviceMemoryGiB > 2) return 32
  return 24
}
