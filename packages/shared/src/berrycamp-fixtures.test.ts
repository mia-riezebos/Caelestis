import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './hash.js'
import { TRANSPARENT_INDEX } from './palette.js'
import { decodePng } from './png.js'
import { quantiseToPalette } from './quantise.js'

const fixture = (): string =>
  fileURLToPath(
    new URL(
      '../../../fixtures/berrycamp/wplace-templates/quantized/rooms/prologue/a/__prologue-a.json',
      import.meta.url,
    ),
  )

interface BlueMarbleTemplate {
  readonly coords: string
  readonly tiles: Readonly<Record<string, string>>
}

interface BlueMarbleFile {
  readonly templates: Readonly<Record<string, BlueMarbleTemplate>>
}

describe('the real Berrycamp template corpus', () => {
  it('decodes and pins every positioned image blob in a multi-tile template', async () => {
    const metadata = JSON.parse(await readFile(fixture(), 'utf8')) as BlueMarbleFile
    const template = Object.values(metadata.templates)[0]
    if (template === undefined) throw new Error('Berrycamp fixture has no template metadata')

    const tiles = Object.entries(template.tiles).sort(([left], [right]) =>
      left.localeCompare(right),
    )
    const decoded = await Promise.all(
      tiles.map(async ([, base64]) => {
        const bytes = new Uint8Array(Buffer.from(base64, 'base64'))
        const image = await decodePng(bytes)
        const quantised = quantiseToPalette(image.pixels)
        return { bytes, image, quantised }
      }),
    )
    const hashes = await Promise.all(decoded.map(({ bytes }) => sha256Hex(bytes)))

    expect(template.coords).toBe('323, 1784, 809, 148')
    expect(tiles.map(([key]) => key)).toEqual([
      '0323,1784,809,148',
      '0324,1784,000,148',
      '0325,1784,000,148',
      '0326,1784,000,148',
    ])
    expect(decoded.map(({ image }) => [image.width, image.height])).toEqual([
      [573, 1_104],
      [3_000, 1_104],
      [3_000, 1_104],
      [1_059, 1_104],
    ])
    expect(decoded.every(({ quantised }) => quantised.indices.includes(TRANSPARENT_INDEX))).toBe(
      true,
    )
    expect(decoded.every(({ quantised }) => quantised.report.movedPixels === 0)).toBe(true)
    expect(decoded.every(({ quantised }) => quantised.report.maxDistance === 0)).toBe(true)
    expect(hashes).toEqual([
      '82fbdf96fbfa458b5004c13060f428743ab6a7c3762b18fa54ac23fa32fbe6c0',
      'eb6cf625c0233528ad1c3eca7ec4a174ba34118355a97896d6bbca1d8ef1ff2f',
      'ab469cd727d3de076f624e017ffb89ba3bd8fc47217966f3eb4d373ed684b6e3',
      'da1ab03155ae28d090206bd226b1f2d36d1bb0c681740cdcd277b7707d9a1796',
    ])
  })
})
