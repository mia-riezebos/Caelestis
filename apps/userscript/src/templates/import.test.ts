import { TRANSPARENT_INDEX } from '@wts/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rgba = (...pixels: Array<[number, number, number, number]>): Uint8ClampedArray =>
  new Uint8ClampedArray(pixels.flat())

const readbacks: Uint8ClampedArray[] = []
const bitmapSizes: Array<{ width: number; height: number }> = []

const pngHeader = (width: number, height: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(new ArrayBuffer(24))
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  bytes.set([73, 72, 68, 82], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

const file = (
  name: string,
  text: string,
  type = 'application/json',
  size = text.length,
  header?: { width: number; height: number },
): File =>
  ({
    name,
    type,
    size,
    text: async () => text,
    slice: () => {
      const dimensions = header ?? bitmapSizes[0] ?? { width: 1, height: 1 }
      return new Blob([pngHeader(dimensions.width, dimensions.height)], { type: 'image/png' })
    },
  }) as File

class TestCanvas {
  readonly width: number
  readonly height: number

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  getContext(_kind: string, options?: unknown): object {
    return {
      options,
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: readbacks.shift() ?? new Uint8ClampedArray(this.width * this.height * 4),
      })),
    }
  }
}

beforeEach(() => {
  readbacks.length = 0
  bitmapSizes.length = 0
  vi.stubGlobal('OffscreenCanvas', TestCanvas)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      blob: async () => {
        const dimensions = bitmapSizes[0] ?? { width: 1, height: 1 }
        return new Blob([pngHeader(dimensions.width, dimensions.height)], { type: 'image/png' })
      },
    })),
  )
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ ...(bitmapSizes.shift() ?? { width: 1, height: 1 }), close: vi.fn() })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('template import', () => {
  it('decodes Blue Marble 3x stamped chunks back to fixed native pixels', async () => {
    bitmapSizes.push({ width: 6, height: 3 })
    const stamped = new Uint8ClampedArray(6 * 3 * 4)
    stamped.set([0, 0, 0, 255], (1 * 6 + 1) * 4)
    stamped.set([255, 255, 255, 255], (1 * 6 + 4) * 4)
    readbacks.push(stamped)
    const { importFile } = await import('./import.js')
    const marble = JSON.stringify({
      templates: {
        '7 author': {
          coords: '10,20,500,600',
          tiles: { '10,20,500,600': 'AAAA' },
        },
      },
    })

    const [template] = await importFile(file('template.json', marble), { x: 0, y: 0 })

    expect(template).toMatchObject({
      originX: 10_500,
      originY: 20_600,
      width: 2,
      height: 1,
      opaque: 2,
      sortOrder: 7,
    })
    expect(template?.indices).toHaveLength(2)
    expect(template?.indices[0]).not.toBe(TRANSPARENT_INDEX)
    expect(template?.indices[1]).not.toBe(TRANSPARENT_INDEX)
  })

  it('imports a valid wplace image contract without fetching arbitrary URLs', async () => {
    readbacks.push(rgba([0, 0, 0, 255]))
    const { importFile } = await import('./import.js')
    const contents = JSON.stringify({
      name: 'Placed',
      order: 12,
      image: { dataUrl: 'data:image/png;base64,AAAA' },
      bounds: { north: 0, west: 0 },
    })

    const [template] = await importFile(file('placed.wplace', contents), { x: 0, y: 0 })

    expect(template).toMatchObject({
      name: 'Placed',
      source: 'wplace',
      originX: 1_024_000,
      originY: 1_024_000,
      width: 1,
      height: 1,
      opaque: 1,
      sortOrder: 12,
    })
    expect(fetch).toHaveBeenCalledWith('data:image/png;base64,AAAA')
  })

  it('rejects a wplace image URL outside the embedded PNG trust boundary', async () => {
    const { importFile } = await import('./import.js')
    const contents = JSON.stringify({
      image: { dataUrl: 'https://attacker.example/huge.png' },
      bounds: { north: 0, west: 0 },
    })

    await expect(importFile(file('bad.wplace', contents), { x: 0, y: 0 })).rejects.toThrow(
      /embedded PNG/i,
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects duplicate Marble coordinates before decoding duplicate payloads', async () => {
    bitmapSizes.push({ width: 3, height: 3 })
    readbacks.push(new Uint8ClampedArray(3 * 3 * 4))
    const { importFile } = await import('./import.js')
    const marble = JSON.stringify({
      templates: {
        example: {
          coords: '10,20,0,0',
          tiles: { '10,20,0,0': 'AAAA', '0010,0020,000,000': 'BBBB' },
        },
      },
    })

    await expect(importFile(file('template.json', marble), { x: 0, y: 0 })).resolves.toEqual([])
    expect(createImageBitmap).toHaveBeenCalledTimes(1)
  })

  it('skips a malformed stamped Marble template without rejecting the whole import', async () => {
    bitmapSizes.push({ width: 2, height: 3 }, { width: 3, height: 3 })
    const validStamp = new Uint8ClampedArray(3 * 3 * 4)
    validStamp.set([0, 0, 0, 255], (1 * 3 + 1) * 4)
    readbacks.push(new Uint8ClampedArray(2 * 3 * 4), validStamp)
    const { importFile } = await import('./import.js')
    const marble = JSON.stringify({
      templates: {
        malformed: { coords: '10,20,0,0', tiles: { '10,20,0,0': 'AAAA' } },
        valid: { coords: '11,21,0,0', tiles: { '11,21,0,0': 'BBBB' } },
      },
    })

    const imported = await importFile(file('template.json', marble), { x: 0, y: 0 })

    expect(imported).toHaveLength(1)
    expect(imported[0]).toMatchObject({ name: 'valid', width: 1, height: 1 })
    expect(createImageBitmap).toHaveBeenCalledTimes(2)
  })

  it('bounds cumulative decoded Marble pixels across individually valid chunks', async () => {
    const tiles = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`${index},0,0,0`, 'AAAA']),
    )
    bitmapSizes.push(...Array.from({ length: 64 }, () => ({ width: 1_620, height: 1_620 })))
    readbacks.push(...Array.from({ length: 64 }, () => new Uint8ClampedArray(0)))
    const { importFile } = await import('./import.js')
    const marble = JSON.stringify({ templates: { example: { coords: '0,0,0,0', tiles } } })

    await expect(importFile(file('template.json', marble), { x: 0, y: 0 })).resolves.toEqual([])
    expect(createImageBitmap).toHaveBeenCalledTimes(58)
  })

  it('bounds retained pixels across all templates in one Marble file', async () => {
    bitmapSizes.push({ width: 3, height: 3 }, { width: 3, height: 3 })
    const stamp = new Uint8ClampedArray(3 * 3 * 4)
    stamp.set([0, 0, 0, 255], (1 * 3 + 1) * 4)
    readbacks.push(stamp, stamp)
    const { importFile } = await import('./import.js')
    const marble = JSON.stringify({
      templates: {
        first: { coords: '0,0,0,0', tiles: { '3,3,0,0': 'AAAA' } },
        second: { coords: '0,0,0,0', tiles: { '3,3,0,0': 'BBBB' } },
      },
    })

    const imported = await importFile(file('template.json', marble), { x: 0, y: 0 })

    expect(imported).toHaveLength(1)
    expect(imported[0]).toMatchObject({ name: 'first', width: 3_001, height: 3_001 })
  })

  it('skips structurally malformed Marble records and keeps later valid records', async () => {
    bitmapSizes.push({ width: 3, height: 3 })
    const stamp = new Uint8ClampedArray(3 * 3 * 4)
    stamp.set([0, 0, 0, 255], (1 * 3 + 1) * 4)
    readbacks.push(stamp)
    const { importFile } = await import('./import.js')
    const marble = JSON.stringify({
      templates: {
        nullRecord: null,
        numericTile: { coords: '10,20,0,0', tiles: { '10,20,0,0': 42 } },
        valid: { coords: '11,21,0,0', tiles: { '11,21,0,0': 'AAAA' } },
      },
    })

    const imported = await importFile(file('template.json', marble), { x: 0, y: 0 })

    expect(imported.map(({ name }) => name)).toEqual(['valid'])
  })

  it('assigns collision-resistant IDs to records imported together', async () => {
    bitmapSizes.push({ width: 3, height: 3 }, { width: 3, height: 3 })
    const stamp = new Uint8ClampedArray(3 * 3 * 4)
    stamp.set([0, 0, 0, 255], (1 * 3 + 1) * 4)
    readbacks.push(stamp, stamp)
    const { importFile } = await import('./import.js')
    const marble = JSON.stringify({
      templates: {
        first: { coords: '10,20,0,0', tiles: { '10,20,0,0': 'AAAA' } },
        second: { coords: '11,21,0,0', tiles: { '11,21,0,0': 'BBBB' } },
      },
    })

    const imported = await importFile(file('template.json', marble), { x: 0, y: 0 })

    expect(new Set(imported.map(({ id }) => id)).size).toBe(2)
    expect(imported.every(({ id }) => /^local-[0-9a-f-]{36}$/.test(id))).toBe(true)
  })

  it('rejects oversized PNG dimensions before browser decoding', async () => {
    const { importFile } = await import('./import.js')
    const bomb = file('bomb.png', '', 'image/png', 24, { width: 100_000, height: 100_000 })

    await expect(importFile(bomb, { x: 0, y: 0 })).rejects.toThrow(/too large/i)
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('bounds high-cardinality quantisation and yields during the work', async () => {
    const width = 257
    const height = 256
    bitmapSizes.push({ width, height })
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let index = 0; index < width * height; index++) {
      pixels[index * 4] = (index >> 16) & 0xff
      pixels[index * 4 + 1] = (index >> 8) & 0xff
      pixels[index * 4 + 2] = index & 0xff
      pixels[index * 4 + 3] = 255
    }
    readbacks.push(pixels)
    const schedulerYield = vi.fn(async () => {})
    vi.stubGlobal('scheduler', { yield: schedulerYield })
    const { importFile } = await import('./import.js')

    const [template] = await importFile(file('noise.png', '', 'image/png'), {
      x: 1_000,
      y: 1_000,
    })

    expect(template?.indices).toHaveLength(width * height)
    expect(schedulerYield).toHaveBeenCalled()
  })

  it('decodes without browser colour conversion or alpha premultiplication', async () => {
    readbacks.push(rgba([0, 0, 0, 255]))
    const { importFile } = await import('./import.js')

    const [template] = await importFile(file('pixel.png', '', 'image/png'), { x: 10, y: 20 })

    expect(createImageBitmap).toHaveBeenCalledWith(expect.anything(), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    })
    expect(template).toMatchObject({
      name: 'pixel',
      source: 'image',
      originX: 10,
      originY: 20,
      width: 1,
      height: 1,
      opaque: 1,
      moved: 0,
      sortOrder: 0,
    })
    expect(template?.indices).toHaveLength(1)
  })

  it('preserves Marble declared-origin space before its first decoded tile', async () => {
    bitmapSizes.push({ width: 3, height: 3 })
    const stamped = new Uint8ClampedArray(3 * 3 * 4)
    stamped.set([0, 0, 0, 255], (1 * 3 + 1) * 4)
    readbacks.push(stamped)
    const { importFile } = await import('./import.js')
    const marble = JSON.stringify({
      templates: {
        example: {
          coords: '10,20,500,600',
          tiles: { '11,21,0,0': 'AAAA' },
        },
      },
    })

    const [template] = await importFile(file('template.json', marble), { x: 0, y: 0 })

    expect(template).toMatchObject({
      originX: 10_500,
      originY: 20_600,
      width: 501,
      height: 401,
      opaque: 1,
    })
    expect(template?.indices[400 * 501 + 500]).not.toBe(TRANSPARENT_INDEX)
  })

  it('rejects an import before reading a file outside the supported size class', async () => {
    const oversized = file('huge.png', '', 'image/png', 100 * 1024 * 1024)
    const text = vi.spyOn(oversized, 'text')
    const { importFile } = await import('./import.js')

    await expect(importFile(oversized, { x: 0, y: 0 })).rejects.toThrow(/too large/i)
    expect(text).not.toHaveBeenCalled()
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('rejects non-finite geographic placement without decoding image data', async () => {
    const contents =
      '{"name":"bad","image":{"dataUrl":"data:image/png;base64,AAAA"},"bounds":{"north":0,"west":1e309}}'
    const { importFile } = await import('./import.js')

    await expect(importFile(file('bad.wplace', contents), { x: 0, y: 0 })).resolves.toEqual([])
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('does not return a persistent template for a fully transparent image', async () => {
    readbacks.push(rgba([255, 0, 0, 0]))
    const { importFile } = await import('./import.js')

    await expect(importFile(file('empty.png', '', 'image/png'), { x: 10, y: 20 })).resolves.toEqual(
      [],
    )
  })

  it('rejects malformed Marble tile coordinates before decoding them', async () => {
    const marble = JSON.stringify({
      templates: {
        example: {
          coords: '10,20,0,0',
          tiles: { '11,wat,0,0': 'AAAA' },
        },
      },
    })
    const { importFile } = await import('./import.js')

    await expect(importFile(file('template.json', marble), { x: 0, y: 0 })).resolves.toEqual([])
    expect(createImageBitmap).not.toHaveBeenCalled()
  })
})
