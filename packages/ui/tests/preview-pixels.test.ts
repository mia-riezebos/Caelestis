import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { previewPixels } from '../src/tree/preview-pixels.js'

describe('template preview pixels', () => {
  it('preserves palette colours and transparent pixels', () => {
    const result = previewPixels(new Uint8Array([1, TRANSPARENT_INDEX, 2, 3]), 2, 2)
    expect(result).toMatchObject({ width: 2, height: 2 })
    expect([...result.data]).toEqual([
      60, 60, 60, 255, 0, 0, 0, 0, 120, 120, 120, 255, 210, 210, 210, 255,
    ])
  })

  it('bounds memory and preserves aspect ratio for large and narrow artwork', () => {
    const source = new Uint8Array(1024 * 512).fill(1)
    const landscape = previewPixels(source, 1024, 512)
    expect(landscape).toMatchObject({ width: 256, height: 128 })
    expect(landscape.data.byteLength).toBe(256 * 128 * 4)
    expect(previewPixels(source, 1, 1024)).toMatchObject({ width: 1, height: 256 })
  })
})
