import { TILE_SIZE } from '@caelestis/shared'
import { expect, it, vi } from 'vitest'

vi.mock('@caelestis/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@caelestis/shared')>()),
  decodePng: async () => ({
    width: TILE_SIZE,
    height: TILE_SIZE,
    pixels: new Uint8Array(TILE_SIZE * TILE_SIZE * 4),
  }),
}))
vi.mock('gifenc/dist/gifenc.js', () => ({
  default: {
    quantize: () => [],
    applyPalette: () => new Uint8Array(),
    GIFEncoder: () => ({ writeFrame: () => {}, finish: () => {}, bytes: () => new Uint8Array() }),
  },
}))

import { captureSamples, renderTimelapse } from './social-render.js'

it('bounds source image reads for an accepted dense 720-tile capture', async () => {
  const template = { bbox: { minX: 0, minY: 0, maxX: 20000, maxY: 20000 }, finished: false }
  const tiles = [...captureSamples(template.bbox).keys()]
  expect(tiles).toHaveLength(720)
  const history = Array.from({ length: 300 }, (_, i) => ({ bucketStart: i, hash: `past-${i}` }))
  let reads = 0
  await renderTimelapse({
    template,
    histories: new Map(tiles.map((key) => [key, history])),
    canvas: new Map(tiles.map((key) => [key, 'live'])),
    readTile: async () => {
      reads++
      if (reads > 4096) throw new Error('Source image read budget exceeded')
      return new Uint8Array()
    },
  })
  expect(reads).toBeLessThanOrEqual(4096)
})
