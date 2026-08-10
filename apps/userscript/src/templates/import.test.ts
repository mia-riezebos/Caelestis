import { TRANSPARENT_INDEX } from '@wts/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rgba = (...pixels: Array<[number, number, number, number]>): Uint8ClampedArray =>
  new Uint8ClampedArray(pixels.flat())

const file = (name: string, text: string, type = 'application/json', size = text.length): File =>
  ({ name, type, size, text: async () => text }) as File

const readbacks: Uint8ClampedArray[] = []
const bitmapSizes: Array<{ width: number; height: number }> = []

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
    vi.fn(async () => ({ blob: async () => new Blob(['png']) })),
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
