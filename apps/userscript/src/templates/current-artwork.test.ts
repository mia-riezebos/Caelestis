import { TILE_SIZE, TRANSPARENT_INDEX, WORLD_PIXELS } from '@caelestis/shared'
import { beforeEach, expect, it, vi } from 'vitest'
import type { PlacedTemplate } from './local-store.js'

const pixels = vi.hoisted(() => ({
  load: vi.fn(),
  active: vi.fn(() => null),
  bounds: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('../tile-transform.js', () => ({ loadTilePixels: pixels.load, UNPAINTED: 255 }))
vi.mock('../alliance-surface.js', () => ({ activeAllianceSurface: pixels.active }))
vi.mock('../alliance-coordinates.js', () => ({ allianceBounds: pixels.bounds }))
vi.mock('../gl/artboard-pixels.js', () => ({
  readArtboardPixels: pixels.read,
  refreshArtboardPixels: pixels.refresh,
}))

import { captureCurrentArtwork, compositeCommittedArtwork } from './current-artwork.js'

const template = (patch: Partial<PlacedTemplate> = {}): PlacedTemplate => ({
  id: 'test',
  name: 'Test',
  source: 'wplace',
  originX: 999,
  originY: 999,
  width: 2,
  height: 2,
  indices: new Uint8Array([1, 2, TRANSPARENT_INDEX, 4]),
  moved: 0,
  opaque: 3,
  tiles: new Set(),
  visible: true,
  everPlaced: true,
  appearance: null,
  revision: 1,
  owns: [],
  folderId: null,
  ...patch,
})
beforeEach(() => vi.resetAllMocks())

it('composites opaque art over every target pixel, preserves transparent art and excludes drafts', () => {
  const base = template()
  const committed = [
    {
      x: 999,
      y: 999,
      width: 2,
      height: 2,
      pixels: new Uint8Array([5, 255, 6, 255]),
      emptyIndex: 255,
    },
  ]
  const region = committed[0]
  if (region === undefined) throw new Error('Missing test region')
  const result = compositeCommittedArtwork(base, {
    committed,
    draft: [{ ...region, pixels: new Uint8Array([9, 9, 9, 9]) }],
  })
  expect(result).toEqual(new Uint8Array([5, 2, 6, 4]))
  expect(base.indices).toEqual(new Uint8Array([1, 2, TRANSPARENT_INDEX, 4]))
})

it('rejects missing art even when the corresponding target is transparent', () => {
  expect(() => compositeCommittedArtwork(template(), { committed: [], draft: [] })).toThrow(
    'unavailable at 999, 999',
  )
})

it('loads and composites all four tiles at a corner in template coordinates', async () => {
  pixels.load.mockImplementation(async ({ x, y }: { x: number; y: number }) =>
    new Uint8Array(TILE_SIZE * TILE_SIZE).fill(5 + y * 2 + x),
  )
  expect(await captureCurrentArtwork(template())).toEqual(new Uint8Array([5, 6, 7, 8]))
  expect(pixels.load.mock.calls.map(([tile]) => tile)).toEqual([
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ])
})

it('wraps east-edge server artwork into the first world tile', async () => {
  pixels.load.mockImplementation(async ({ x }: { x: number }) =>
    new Uint8Array(TILE_SIZE * TILE_SIZE).fill(x === 0 ? 6 : 5),
  )
  expect(
    await captureCurrentArtwork(
      template({
        originX: WORLD_PIXELS - 1,
        originY: 0,
        height: 1,
        indices: new Uint8Array([1, 2]),
        wrapX: true,
      }),
    ),
  ).toEqual(new Uint8Array([5, 6]))
  expect(pixels.load).toHaveBeenLastCalledWith({ x: 0, y: 0 })
})

it('rejects a partially loaded world capture', async () => {
  pixels.load
    .mockResolvedValueOnce(new Uint8Array(TILE_SIZE * TILE_SIZE).fill(5))
    .mockResolvedValueOnce(null)
  await expect(captureCurrentArtwork(template())).rejects.toThrow('tile 1/0')
})

it('requires the matching alliance canvas', async () => {
  await expect(
    captureCurrentArtwork(template({ surface: { kind: 'alliance-headquarters', allianceId: 1 } })),
  ).rejects.toThrow('Open this template')
})

it('captures signed alliance coordinates and discards its drafts', async () => {
  const surface = { kind: 'alliance-headquarters', allianceId: 1 } as const
  const active = { surface }
  pixels.active.mockReturnValue(active as never)
  pixels.bounds.mockReturnValue({ minX: -10, minY: -20, maxX: 10, maxY: 20 })
  const region = {
    x: -2,
    y: -3,
    width: 2,
    height: 2,
    emptyIndex: TRANSPARENT_INDEX,
    pixels: new Uint8Array([5, 6, 7, 8]),
  }
  pixels.read.mockReturnValue({
    committed: [region],
    draft: [{ ...region, pixels: new Uint8Array([9, 9, 9, 9]) }],
  })
  expect(await captureCurrentArtwork(template({ surface, originX: -2, originY: -3 }))).toEqual(
    new Uint8Array([5, 6, 7, 8]),
  )
  expect(pixels.refresh).toHaveBeenCalledWith(active, {
    originX: -10,
    originY: -20,
    width: 20,
    height: 40,
  })
})
