import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  base64ToBytes,
  bytesToBase64,
  clientMetricsAccept,
  decodeMismatchMask,
  defaultTemplateSort,
  encodeMismatchMask,
  formatCount,
  formatPixels,
  isPackedBits,
  isTemplateSortField,
  mismatchClassAt,
  nodeSlug,
  PALETTE_RGB,
  packBits,
  parseClientMetricsAccept,
  parseTemplateTags,
  parseTileKey,
  quantiseToPalette,
  sha256Hex,
  sliceTemplate,
  TRANSPARENT_INDEX,
  templateSurface,
  templateSurfaceBounds,
  tileKey,
  unpackBits,
  uuidV7,
  WPLACE_PALETTE,
} from '../index.js'

describe('portable data contracts', () => {
  it('uses canonical base64 and preserves a partial bit mask', () => {
    const bytes = new Uint8Array([0, 255, 4])
    expect(bytesToBase64(bytes)).toBe('AP8E')
    expect(base64ToBytes('AP8E')).toEqual(bytes)
    expect(base64ToBytes('AP8')).toBeNull()

    const mask = new Uint8Array([1, 0, 1, 0, 0, 0, 0, 1, 1])
    const packed = packBits(mask)
    expect(unpackBits(packed, mask.length)).toEqual(mask)
    expect(isPackedBits(packed, mask.length)).toBe(true)
    expect(unpackBits(packed, mask.length - 1)).toBeNull()
  })

  it('keeps public palette indices and transparency stable', () => {
    expect(WPLACE_PALETTE).toHaveLength(63)
    expect(PALETTE_RGB).toHaveLength(63)
    expect(TRANSPARENT_INDEX).toBe(63)
    expect(WPLACE_PALETTE[TRANSPARENT_INDEX]).toBeUndefined()
    expect(PALETTE_RGB[0]).toEqual([0, 0, 0])
  })

  it('quantises opaque colours and reports movement while leaving transparent pixels absent', () => {
    const result = quantiseToPalette(
      new Uint8Array([0, 0, 0, 255, 1, 1, 1, 255, 20, 20, 20, 127]),
      [
        [0, 0, 0],
        [255, 255, 255],
      ],
    )
    expect(result.indices).toEqual(new Uint8Array([0, 0, TRANSPARENT_INDEX]))
    expect(result.report).toEqual({
      opaquePixels: 2,
      movedPixels: 1,
      distinctColours: 2,
      distinctPaletteEntries: 1,
      meanDistance: 0.5,
      maxDistance: 1,
    })
  })

  it('slices painted pixels without advertising transparent tile coverage', () => {
    const pixels = new Uint8Array([TRANSPARENT_INDEX, 1, TRANSPARENT_INDEX, TRANSPARENT_INDEX])
    const slice = sliceTemplate(pixels, 2, 2, 999, 0)
    expect(slice.bbox).toEqual({ minX: 1000, minY: 0, maxX: 1001, maxY: 1 })
    expect(slice.totalPixels).toBe(1)
    expect(slice.chunks).toHaveLength(1)
    expect(slice.chunks[0]).toMatchObject({ tileX: 1, tileY: 0, width: 1, height: 1 })
    expect(() => sliceTemplate(pixels, 2, 2, -1, 0)).toThrow('outside the canvas')
  })

  it('keeps identifiers, tags, slugs, counts, metrics, tiles, and surfaces interoperable', async () => {
    const id = uuidV7()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(await sha256Hex(new TextEncoder().encode('caelestis'))).toBe(
      createHash('sha256').update('caelestis').digest('hex'),
    )
    expect(
      parseTemplateTags([
        { id, name: 'Café' },
        { id: uuidV7(), name: 'cafe\u0301' },
      ]),
    ).toBeNull()
    expect(nodeSlug('  Hello, 🌍 World  ')).toBe('hello-world')
    expect(formatCount(999_500, 'en')).toBe('1M')
    expect(formatPixels(1_200, 'en')).toBe('1,200 pixels')

    const accept = clientMetricsAccept({
      client: 'userscript',
      version: '1.2.3',
      transport: 'live',
      reason: 'connect',
    })
    expect(parseClientMetricsAccept(accept)).toEqual({
      client: 'userscript',
      version: '1.2.3',
      transport: 'live',
      reason: 'connect',
    })
    expect(parseClientMetricsAccept('garbage')).toMatchObject({
      client: 'unknown',
      transport: 'none',
    })
    expect(parseTileKey(tileKey({ x: 0, y: 2047 }))).toEqual({ x: 0, y: 2047 })
    expect(parseTileKey('01/0')).toBeNull()
    const surface = templateSurface('alliance-banner', 42)
    expect(surface).toEqual({ kind: 'alliance-banner', allianceId: 42 })
    expect(templateSurfaceBounds(surface!)).not.toBeNull()
    expect(isTemplateSortField('progress')).toBe(true)
    expect(isTemplateSortField('random')).toBe(false)
    expect(defaultTemplateSort('recent')).toEqual({ field: 'recent', direction: 'desc' })
  })

  it('encodes mismatch classes losslessly and refuses malformed rectangles', () => {
    const encoded = encodeMismatchMask(
      { left: 1, top: 2, width: 3, height: 1 },
      new Uint8Array([0, 1, 2]),
    )
    const decoded = decodeMismatchMask(encoded)
    expect(decoded).toMatchObject({ left: 1, top: 2, width: 3, height: 1 })
    if (decoded === null) throw new Error('Expected decoded mask')
    expect([1, 2, 3].map((x) => mismatchClassAt(decoded, x, 2))).toEqual([0, 1, 2])
    expect(mismatchClassAt(decoded, 0, 2)).toBeNull()
    expect(decodeMismatchMask(encoded.subarray(0, -1))).toBeNull()
    expect(() =>
      encodeMismatchMask({ left: 0, top: 0, width: 1, height: 1 }, new Uint8Array([3])),
    ).toThrow()
  })

  it('keeps UUIDs ordered during same-millisecond writes and clock rollback', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2040, 0, 1))
    try {
      const first = uuidV7()
      const second = uuidV7()
      now.mockReturnValue(Date.UTC(2039, 0, 1))
      const rollback = uuidV7()
      expect(first < second && second < rollback).toBe(true)
      expect(new Set([first, second, rollback]).size).toBe(3)
    } finally {
      now.mockRestore()
    }
  })
})
