import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PALETTE_SIZE, TRANSPARENT_INDEX } from './palette.js'
import { decodePng, encodeIndexedPng, PngError } from './png.js'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (const [index, character] of [...type].entries()) out[4 + index] = character.charCodeAt(0)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let cursor = 0
  for (const part of parts) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out
}

/**
 * Build a PNG independently of the encoder under test.
 *
 * Round-tripping our own encoder would pass even if both halves shared a wrong assumption — the
 * decoder has to be checked against bytes it did not produce. `node:zlib` supplies the deflate so
 * this fixture does not depend on the same platform stream the codec uses either.
 */
const buildPng = (options: {
  width: number
  height: number
  colourType: number
  channels: number
  data: number[][]
  palette?: number[]
  alphas?: number[]
  depth?: number
  interlace?: number
  filters?: number[]
}): Uint8Array => {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, options.width)
  view.setUint32(4, options.height)
  ihdr[8] = options.depth ?? 8
  ihdr[9] = options.colourType
  ihdr[12] = options.interlace ?? 0

  const stride = options.width * options.channels
  const raw = new Uint8Array((stride + 1) * options.height)
  for (let row = 0; row < options.height; row += 1) {
    raw[row * (stride + 1)] = options.filters?.[row] ?? 0
    raw.set(options.data[row] ?? [], row * (stride + 1) + 1)
  }

  return concat([
    new Uint8Array(SIGNATURE),
    chunk('IHDR', ihdr),
    ...(options.palette ? [chunk('PLTE', new Uint8Array(options.palette))] : []),
    ...(options.alphas ? [chunk('tRNS', new Uint8Array(options.alphas))] : []),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ])
}

describe('decoding', () => {
  it('decodes RGBA', async () => {
    const png = buildPng({
      width: 2,
      height: 1,
      colourType: 6,
      channels: 4,
      data: [[255, 0, 0, 255, 0, 255, 0, 128]],
    })
    await expect(decodePng(png)).resolves.toEqual({
      width: 2,
      height: 1,
      pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]),
    })
  })

  it('decodes RGB as fully opaque', async () => {
    const png = buildPng({ width: 1, height: 1, colourType: 2, channels: 3, data: [[10, 20, 30]] })
    const { pixels } = await decodePng(png)
    expect([...pixels]).toEqual([10, 20, 30, 255])
  })

  it.each([
    ['greyscale', 0, 1, [7], [7, 7, 7, 255]],
    ['greyscale with alpha', 4, 2, [7, 64], [7, 7, 7, 64]],
  ])('decodes %s by replicating the channel', async (_label, colourType, channels, data, want) => {
    const png = buildPng({ width: 1, height: 1, colourType, channels, data: [data] })
    const { pixels } = await decodePng(png)
    expect([...pixels]).toEqual(want)
  })

  it('decodes indexed with a per-entry alpha table', async () => {
    // tRNS is shorter than the palette, so entries past its end default to opaque — the case a
    // decoder that reads tRNS as a fixed-length array gets wrong.
    const png = buildPng({
      width: 3,
      height: 1,
      colourType: 3,
      channels: 1,
      data: [[0, 1, 2]],
      palette: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      alphas: [0, 128],
    })
    const { pixels } = await decodePng(png)
    expect([...pixels]).toEqual([1, 2, 3, 0, 4, 5, 6, 128, 7, 8, 9, 255])
  })

  it.each([
    ['none', 0],
    ['sub', 1],
    ['up', 2],
    ['average', 3],
    ['paeth', 4],
  ])('reconstructs the %s scanline filter', async (_label, filter) => {
    // Each filter is applied to the second row over a known first row, so a wrong predictor shows up
    // as wrong pixels rather than an error.
    const first = [10, 20, 30, 40, 50, 60]
    const second = [70, 80, 90, 100, 110, 120]
    const encoded = second.map((value, index) => {
      const left = index >= 3 ? (second[index - 3] as number) : 0
      const up = first[index] as number
      const upLeft = index >= 3 ? (first[index - 3] as number) : 0
      switch (filter) {
        case 1:
          return (value - left) & 0xff
        case 2:
          return (value - up) & 0xff
        case 3:
          return (value - ((left + up) >> 1)) & 0xff
        case 4: {
          const estimate = left + up - upLeft
          const dLeft = Math.abs(estimate - left)
          const dUp = Math.abs(estimate - up)
          const dUpLeft = Math.abs(estimate - upLeft)
          const predictor = dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft
          return (value - predictor) & 0xff
        }
        default:
          return value
      }
    })
    const png = buildPng({
      width: 2,
      height: 2,
      colourType: 2,
      channels: 3,
      data: [first, encoded],
      filters: [0, filter],
    })

    const { pixels } = await decodePng(png)

    expect([...pixels.subarray(8)]).toEqual([70, 80, 90, 255, 100, 110, 120, 255])
  })

  it.each([
    ['16-bit', { depth: 16 }],
    ['interlaced', { interlace: 1 }],
    ['an unsupported colour type', { colourType: 7 }],
  ])('rejects %s', async (_label, overrides) => {
    const png = buildPng({
      width: 1,
      height: 1,
      colourType: 2,
      channels: 3,
      data: [[1, 2, 3]],
      ...overrides,
    })
    await expect(decodePng(png)).rejects.toThrow(PngError)
  })

  it('rejects bytes that are not a PNG', async () => {
    await expect(decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toThrow(/not a PNG/)
  })

  it('rejects an indexed image with no palette', async () => {
    const png = buildPng({ width: 1, height: 1, colourType: 3, channels: 1, data: [[0]] })
    await expect(decodePng(png)).rejects.toThrow(/PLTE/)
  })

  it('joins split IDAT chunks', async () => {
    // Real encoders split IDAT at arbitrary boundaries, and the split falls mid-deflate-stream —
    // decoding each chunk separately fails, so this pins that they are concatenated first.
    const raw = new Uint8Array([0, 1, 2, 3, 0, 4, 5, 6])
    const compressed = new Uint8Array(deflateSync(raw))
    const half = Math.floor(compressed.length / 2)
    const ihdr = new Uint8Array(13)
    const view = new DataView(ihdr.buffer)
    view.setUint32(0, 1)
    view.setUint32(4, 2)
    ihdr[8] = 8
    ihdr[9] = 2
    const png = concat([
      new Uint8Array(SIGNATURE),
      chunk('IHDR', ihdr),
      chunk('IDAT', compressed.subarray(0, half)),
      chunk('IDAT', compressed.subarray(half)),
      chunk('IEND', new Uint8Array(0)),
    ])

    const { pixels } = await decodePng(png)

    expect([...pixels]).toEqual([1, 2, 3, 255, 4, 5, 6, 255])
  })
})

it.each([
  ['greyscale', 0, 1, [7], [0, 7], [7, 7, 7, 0]],
  ['RGB', 2, 3, [10, 20, 30], [0, 10, 0, 20, 0, 30], [10, 20, 30, 0]],
])(
  'honours a tRNS transparent sample on %s',
  async (_label, colourType, channels, data, alphas, want) => {
    // tRNS names one sample as fully transparent. Ignoring it forced every pixel opaque, so a
    // template with a transparent background was quantised and stored as painted pixels — from a
    // file that was never malformed. The chunk is 16-bit big-endian per sample even at depth 8.
    const png = buildPng({ width: 1, height: 1, colourType, channels, data: [data], alphas })
    const decoded = await decodePng(png)
    expect([...decoded.pixels]).toEqual(want)
  },
)

it.each([
  ['greyscale', 0, 1, [9], [0, 7]],
  ['RGB', 2, 3, [10, 20, 31], [0, 10, 0, 20, 0, 30]],
])(
  'leaves a %s sample that does not match tRNS opaque',
  async (_label, colourType, channels, data, alphas) => {
    const png = buildPng({ width: 1, height: 1, colourType, channels, data: [data], alphas })
    const decoded = await decodePng(png)
    expect(decoded.pixels[3]).toBe(255)
  },
)

it('refuses an image with more pixels than it may allocate', async () => {
  // The buffers are sized from the header, so a few hundred bytes on the wire can ask for over a
  // gigabyte. Rejected before anything is allocated from those numbers.
  const png = buildPng({ width: 20_000, height: 20_000, colourType: 2, channels: 3, data: [] })
  await expect(decodePng(png)).rejects.toThrow(/more than \d+ pixels/)
})

it('reports a corrupt deflate stream as a PNG error', async () => {
  // Not a PngError, and the upload route answers 500 instead of its documented 400 for a
  // malformed image.
  const png = concat([
    new Uint8Array(SIGNATURE),
    chunk(
      'IHDR',
      (() => {
        const ihdr = new Uint8Array(13)
        new DataView(ihdr.buffer).setUint32(0, 1)
        new DataView(ihdr.buffer).setUint32(4, 1)
        ihdr[8] = 8
        ihdr[9] = 2
        return ihdr
      })(),
    ),
    chunk('IDAT', new Uint8Array([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff])),
    chunk('IEND', new Uint8Array(0)),
  ])
  await expect(decodePng(png)).rejects.toThrow(PngError)
})

it('refuses an out-of-range indexed palette entry', async () => {
  // One three-byte entry and pixel index 1: the bound was off by an entry, so the decoder
  // substituted black and stored it rather than rejecting the image.
  const png = buildPng({
    width: 1,
    height: 1,
    colourType: 3,
    channels: 1,
    data: [[1]],
    palette: [255, 0, 0],
  })
  await expect(decodePng(png)).rejects.toThrow(/palette index out of range/)
})

describe('encoding', () => {
  it('round-trips wplace indices through its own decoder', async () => {
    // Index 0 is Black and index 4 is White in wplace's order, so this also pins that the encoder
    // writes the palette at wplace's positions rather than packing it.
    const png = await encodeIndexedPng(3, 1, new Uint8Array([0, 4, TRANSPARENT_INDEX]))

    const { width, height, pixels } = await decodePng(png)

    expect({ width, height }).toEqual({ width: 3, height: 1 })
    expect([...pixels]).toEqual([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0])
  })

  it('makes index 63 transparent and every real colour opaque', async () => {
    const indices = new Uint8Array(PALETTE_SIZE).map((_, index) => index)
    const png = await encodeIndexedPng(PALETTE_SIZE, 1, indices)

    const { pixels } = await decodePng(png)

    for (let index = 0; index < TRANSPARENT_INDEX; index += 1) {
      expect(pixels[index * 4 + 3]).toBe(255)
    }
    expect(pixels[TRANSPARENT_INDEX * 4 + 3]).toBe(0)
  })

  it('writes the whole palette even for a one-colour image', async () => {
    // A subset palette would make the same byte mean different colours in different chunks. 64
    // entries at 3 bytes each.
    const png = await encodeIndexedPng(1, 1, new Uint8Array([0]))
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
    let offset = 8
    const lengths = new Map<string, number>()
    while (offset + 8 <= png.length) {
      const length = view.getUint32(offset)
      lengths.set(String.fromCharCode(...png.subarray(offset + 4, offset + 8)), length)
      offset += 12 + length
    }
    expect(lengths.get('PLTE')).toBe(PALETTE_SIZE * 3)
    expect(lengths.get('tRNS')).toBe(PALETTE_SIZE)
  })

  it('produces a real PNG signature and an IEND terminator', async () => {
    // Cheap, but it is what makes the output openable by anything other than us.
    const png = await encodeIndexedPng(1, 1, new Uint8Array([1]))
    expect([...png.subarray(0, 8)]).toEqual(SIGNATURE)
    expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe('IEND')
  })

  it('writes chunk CRCs that validate', async () => {
    // A wrong CRC still decodes here, because this decoder does not check them — but every other
    // PNG reader in the world does, so nothing else would open our chunks.
    const png = await encodeIndexedPng(2, 2, new Uint8Array([0, 1, 2, TRANSPARENT_INDEX]))
    let offset = 8
    let checked = 0
    while (offset + 8 <= png.length) {
      const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
      const length = view.getUint32(offset)
      const declared = view.getUint32(offset + 8 + length)
      expect(crc32(png.subarray(offset + 4, offset + 8 + length))).toBe(declared)
      checked += 1
      offset += 12 + length
    }
    expect(checked).toBe(5)
  })

  it('rejects an index buffer that does not match the dimensions', async () => {
    await expect(encodeIndexedPng(2, 2, new Uint8Array([0, 1]))).rejects.toThrow(
      /expected 4 indices/,
    )
  })

  it('rejects a palette that leaves no room for the transparent entry', async () => {
    const oversized = Array.from({ length: PALETTE_SIZE }, () => [0, 0, 0] as const)
    await expect(encodeIndexedPng(1, 1, new Uint8Array([0]), oversized)).rejects.toThrow(/63/)
  })
})
