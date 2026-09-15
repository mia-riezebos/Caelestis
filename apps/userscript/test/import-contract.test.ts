import { readFile } from 'node:fs/promises'
import {
  decodePng,
  PALETTE_RGB,
  quantiseToPalette,
  TILE_SIZE,
  TRANSPARENT_INDEX,
} from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'

interface MarbleTemplateFixture {
  readonly name: string
  readonly coords: string
  readonly tiles: Record<string, string>
}

interface MarbleFixture {
  readonly templates: Record<string, MarbleTemplateFixture>
}

interface DecodedBitmap {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
  close(): void
}

const fixturePath =
  '../../fixtures/berrycamp/wplace-templates/quantized/rooms/prologue/a/__prologue-a.json'

const parseCoords = (value: string): readonly [number, number, number, number] => {
  const coords = value.split(',').map((part) => Number(part.trim()))
  if (coords.length !== 4 || coords.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`fixture has invalid coordinates: ${value}`)
  }
  return coords as [number, number, number, number]
}

const base64Bytes = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value.replace(/^data:image\/png;base64,/i, ''), 'base64'))

const decodeMarblePixels = async (
  source: string,
): Promise<{
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
}> => {
  const encoded = await decodePng(base64Bytes(source))
  if (encoded.width % 3 !== 0 || encoded.height % 3 !== 0) {
    throw new Error('fixture tile does not use Blue Marble 3x encoding')
  }
  const width = encoded.width / 3
  const height = encoded.height / 3
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceOffset = ((y * 3 + 1) * encoded.width + x * 3 + 1) * 4
      pixels.set(encoded.pixels.subarray(sourceOffset, sourceOffset + 4), (y * width + x) * 4)
    }
  }
  return { width, height, pixels }
}

const transparentPixels = (indices: Uint8Array): number =>
  indices.reduce((count, index) => count + Number(index === TRANSPARENT_INDEX), 0)

const installImageDecoder = (): void => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const source = typeof input === 'string' ? input : input.toString()
    if (!source.startsWith('data:image/png;base64,')) {
      throw new Error(`unexpected image request: ${source}`)
    }
    const bytes = base64Bytes(source)
    const body = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(body).set(bytes)
    return new Response(body, {
      headers: { 'content-type': 'image/png' },
    })
  })

  vi.stubGlobal('createImageBitmap', async (blob: Blob): Promise<DecodedBitmap> => {
    const image = await decodePng(new Uint8Array(await blob.arrayBuffer()))
    return { ...image, close: () => {} }
  })

  class TestOffscreenCanvas {
    #bitmap: DecodedBitmap | null = null

    constructor(
      readonly width: number,
      readonly height: number,
    ) {}

    getContext(): {
      drawImage: (image: DecodedBitmap) => void
      getImageData: () => ImageData
    } {
      return {
        drawImage: (image) => {
          this.#bitmap = image
        },
        getImageData: () => {
          if (this.#bitmap === null) throw new Error('image decoder did not draw a bitmap')
          return {
            data: new Uint8ClampedArray(this.#bitmap.pixels),
          } as ImageData
        },
      }
    }
  }

  vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas)
}

const expectedTemplate = async (fixture: MarbleFixture) => {
  const [entry] = Object.values(fixture.templates)
  if (entry === undefined) throw new Error('fixture has no templates')
  const [tileX, tileY, pixelX, pixelY] = parseCoords(entry.coords)
  const originX = tileX * TILE_SIZE + pixelX
  const originY = tileY * TILE_SIZE + pixelY
  const pieces = await Promise.all(
    Object.entries(entry.tiles).map(async ([key, source]) => {
      const [x, y, offsetX, offsetY] = parseCoords(key)
      const image = await decodeMarblePixels(source)
      return {
        originX: x * TILE_SIZE + offsetX,
        originY: y * TILE_SIZE + offsetY,
        ...image,
      }
    }),
  )
  const width = Math.max(...pieces.map((piece) => piece.originX + piece.width)) - originX
  const height = Math.max(...pieces.map((piece) => piece.originY + piece.height)) - originY
  const indices = new Uint8Array(width * height).fill(TRANSPARENT_INDEX)
  const movedPixels = new Uint8Array(indices.length)
  let moved = 0
  let opaque = 0

  for (const piece of pieces) {
    const quantised = quantiseToPalette(piece.pixels)
    for (let y = 0; y < piece.height; y++) {
      for (let x = 0; x < piece.width; x++) {
        const source = y * piece.width + x
        const index = quantised.indices[source] ?? TRANSPARENT_INDEX
        if (index === TRANSPARENT_INDEX) continue
        const destination = (piece.originY - originY + y) * width + piece.originX - originX + x
        if (indices[destination] === TRANSPARENT_INDEX) opaque++
        const palette = PALETTE_RGB[index]
        const offset = source * 4
        const movedHere = Number(
          piece.pixels[offset] !== palette?.[0] ||
            piece.pixels[offset + 1] !== palette?.[1] ||
            piece.pixels[offset + 2] !== palette?.[2],
        )
        moved += movedHere - (movedPixels[destination] ?? 0)
        movedPixels[destination] = movedHere
        indices[destination] = index
      }
    }
  }

  return { entry, originX, originY, width, height, indices, opaque, moved }
}

describe('Blue Marble import contract', () => {
  it('imports the embedded prologue image and restores its canonical pixels from IndexedDB', async () => {
    installImageDecoder()
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as MarbleFixture
    const expected = await expectedTemplate(fixture)
    const { importFile } = await import('../src/templates/import.js')
    const localStore = await import('../src/templates/local-store.js')
    const [imported] = await importFile(
      new File([JSON.stringify(fixture)], '__prologue-a.json', { type: 'application/json' }),
      { x: 0, y: 0 },
    )

    expect(imported).toMatchObject({
      name: expected.entry.name,
      source: 'marble',
      originX: expected.originX,
      originY: expected.originY,
      width: expected.width,
      height: expected.height,
      opaque: expected.opaque,
      moved: expected.moved,
    })
    if (imported === undefined) throw new Error('fixture import produced no template')
    expect(Buffer.compare(imported.indices, expected.indices)).toBe(0)
    expect(transparentPixels(imported.indices)).toBe(transparentPixels(expected.indices))

    const admitted = await localStore.addLocalTemplate(imported, undefined, true)
    vi.resetModules()
    const restoredStore = await import('../src/templates/local-store.js')
    try {
      await restoredStore.restoreLocalTemplates()
      const restored = restoredStore.templateById(admitted.id)
      expect(restored).toMatchObject({
        name: expected.entry.name,
        source: 'marble',
        originX: expected.originX,
        originY: expected.originY,
        width: expected.width,
        height: expected.height,
        opaque: expected.opaque,
        moved: expected.moved,
        everPlaced: true,
      })
      if (restored === undefined) throw new Error('Persisted template did not restore')
      expect(Buffer.compare(restored.indices, expected.indices)).toBe(0)
    } finally {
      await restoredStore.removeLocalTemplate(admitted.id)
    }
  })
})
