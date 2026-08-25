import { describe, expect, it } from 'vitest'
import { tilePixelCacheLimit } from './tile-pixel-cache.js'

describe('captured tile cache sizing', () => {
  it('retains a wide pan history on high-memory or unreported devices', () => {
    expect(tilePixelCacheLimit(undefined)).toBe(64)
    expect(tilePixelCacheLimit(16)).toBe(64)
  })

  it('uses a smaller history where memory pressure is more likely', () => {
    expect(tilePixelCacheLimit(8)).toBe(48)
    expect(tilePixelCacheLimit(4)).toBe(32)
    expect(tilePixelCacheLimit(2)).toBe(24)
  })
})
