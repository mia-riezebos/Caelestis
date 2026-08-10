import { TRANSPARENT_INDEX } from '@wts/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rgba = (...pixels: Array<[number, number, number, number]>): Uint8ClampedArray =>
  new Uint8ClampedArray(pixels.flat())

const file = (name: string, text: string, type = 'application/json', size = text.length): File =>
  ({ name, type, size, text: async () => text }) as File

const readbacks: Uint8ClampedArray[] = []

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
  vi.stubGlobal('OffscreenCanvas', TestCanvas)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ blob: async () => new Blob(['png']) })),
  )
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('template import', () => {
  it('decodes without browser colour conversion or alpha premultiplication', async () => {
    readbacks.push(rgba([0, 0, 0, 255]))
    const { importFile } = await import('./import.js')

    await importFile(file('pixel.png', '', 'image/png'), { x: 10, y: 20 })

    expect(createImageBitmap).toHaveBeenCalledWith(expect.anything(), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    })
  })

  it('preserves Marble declared-origin space before its first decoded tile', async () => {
    readbacks.push(rgba([0, 0, 0, 255]))
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
