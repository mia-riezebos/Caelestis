import { describe, expect, it } from 'vitest'
import { wplaceRasterRole } from './tile-transform.js'

describe('wplaceRasterRole', () => {
  it('separates the real pixel tiles from named draft and picker layers', () => {
    expect(wplaceRasterRole('pixel-art-layer')).toBe('tile')
    expect(wplaceRasterRole('paint-preview-0.9268-325,1783')).toBe('draft')
    expect(wplaceRasterRole('pixel-hover')).toBe('other')
    expect(wplaceRasterRole(null)).toBe('other')
  })
})
