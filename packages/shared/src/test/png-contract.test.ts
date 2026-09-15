import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  decodePng,
  decodeWplaceIndexedPng,
  encodeIndexedPng,
  PngError,
  TRANSPARENT_INDEX,
} from '../index.js'

const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(
    [...type].map((character) => character.charCodeAt(0)),
    4,
  )
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}
const png = (
  colourType: number,
  scanline: readonly number[],
  extra: readonly Uint8Array[] = [],
  width = 1,
  height = 1,
): Uint8Array => {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = colourType
  const parts = [
    signature,
    chunk('IHDR', ihdr),
    ...extra,
    chunk('IDAT', deflateSync(new Uint8Array(scanline))),
    chunk('IEND', new Uint8Array()),
  ]
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

describe('PNG ingest contract', () => {
  it.each([
    ['greyscale', 0, [0, 9], [], [9, 9, 9, 255]],
    ['RGB', 2, [0, 1, 2, 3], [], [1, 2, 3, 255]],
    [
      'indexed',
      3,
      [0, 0],
      [chunk('PLTE', new Uint8Array([1, 2, 3])), chunk('tRNS', new Uint8Array([7]))],
      [1, 2, 3, 7],
    ],
    ['grey and alpha', 4, [0, 9, 7], [], [9, 9, 9, 7]],
    ['RGBA', 6, [0, 1, 2, 3, 4], [], [1, 2, 3, 4]],
  ] as const)(
    'decodes supported 8-bit %s PNG data',
    async (_name, colourType, scanline, extra, expected) => {
      expect((await decodePng(png(colourType, scanline, extra))).pixels).toEqual(
        new Uint8Array(expected),
      )
    },
  )

  it.each([
    ['none', [0, 10, 20, 0, 30, 50]],
    ['sub', [1, 10, 10, 1, 30, 20]],
    ['up', [2, 10, 20, 2, 20, 30]],
    ['average', [3, 10, 15, 3, 25, 25]],
    ['Paeth', [4, 10, 10, 4, 20, 20]],
  ] as const)('reconstructs both rows with the %s filter', async (_filter, scanline) => {
    expect((await decodePng(png(0, scanline, [], 2, 2))).pixels).toEqual(
      new Uint8Array([10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255, 50, 50, 50, 255]),
    )
  })

  it('rejects inflated data shorter or longer than its declared dimensions', async () => {
    await expect(decodePng(png(0, [0, 1], [], 2, 1))).rejects.toThrow('expected 3')
    await expect(decodePng(png(0, [0, 1, 2]))).rejects.toThrow('more than its dimensions allow')
    await expect(decodePng(png(0, [0, 1], [], 0xffffffff, 0xffffffff))).rejects.toBeInstanceOf(
      PngError,
    )
  })

  it('honours encoding cancellation without returning a partial file', async () => {
    const controller = new AbortController()
    controller.abort(new Error('import cancelled'))
    await expect(encodeIndexedPng(1, 1, new Uint8Array([0]), controller.signal)).rejects.toThrow(
      'import cancelled',
    )
  })

  it('honours greyscale and RGB transparent samples', async () => {
    expect(
      (await decodePng(png(0, [0, 9], [chunk('tRNS', new Uint8Array([0, 9]))]))).pixels[3],
    ).toBe(0)
    expect(
      (await decodePng(png(2, [0, 1, 2, 3], [chunk('tRNS', new Uint8Array([0, 1, 0, 2, 0, 3]))])))
        .pixels[3],
    ).toBe(0)
  })

  it('round-trips canonical palette bytes and returns null for a noncanonical indexed palette', async () => {
    const canonical = await encodeIndexedPng(2, 1, new Uint8Array([0, TRANSPARENT_INDEX]))
    expect(await decodeWplaceIndexedPng(canonical)).toEqual({
      width: 2,
      height: 1,
      indices: new Uint8Array([0, TRANSPARENT_INDEX]),
    })
    expect(
      await decodeWplaceIndexedPng(
        png(
          3,
          [0, 0],
          [chunk('PLTE', new Uint8Array([1, 2, 3])), chunk('tRNS', new Uint8Array([255]))],
        ),
      ),
    ).toBeNull()
  })

  it('rejects absent chunks, unsupported format features, invalid palette indices, and zlib corruption', async () => {
    await expect(decodePng(signature)).rejects.toBeInstanceOf(PngError)
    const interlaced = png(0, [0, 1])
    interlaced[28] = 1
    await expect(decodePng(interlaced)).rejects.toBeInstanceOf(PngError)
    await expect(
      decodePng(png(3, [0, 1], [chunk('PLTE', new Uint8Array([1, 2, 3]))])),
    ).rejects.toBeInstanceOf(PngError)
    const corrupt = png(0, [0, 1])
    corrupt[42] = (corrupt[42] ?? 0) ^ 0xff
    await expect(decodePng(corrupt)).rejects.toBeInstanceOf(PngError)
  })

  it('rejects truncated chunks through both decode entrypoints', async () => {
    const canonical = await encodeIndexedPng(1, 1, new Uint8Array([0]))
    const truncated = canonical.subarray(0, -3)
    await expect(decodePng(truncated)).rejects.toBeInstanceOf(PngError)
    await expect(decodeWplaceIndexedPng(truncated)).rejects.toBeInstanceOf(PngError)
  })

  it('rejects a short IHDR before reading its fields', async () => {
    const shortHeader = new Uint8Array([...signature, ...chunk('IHDR', new Uint8Array(12))])
    await expect(decodePng(shortHeader)).rejects.toBeInstanceOf(PngError)
  })
})
