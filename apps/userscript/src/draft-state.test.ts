import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const occupancy = vi.hoisted(() => ({ offsets: [] as number[] }))
vi.mock('./templates/drafted.js', () => ({ draftedPixelsIn: () => occupancy.offsets }))

beforeEach(() => {
  vi.resetModules()
  occupancy.offsets = []
})

afterEach(() => vi.restoreAllMocks())

it('does not announce removal and replacement of unchanged transparent drafts', async () => {
  const api = await import('./tile-transform.js')
  const tile = { x: 8, y: 9 }
  occupancy.offsets = [5, 8]
  const changed = vi.fn()
  api.onTilePixels(changed)
  api.captureDraftPixels(tile, new Uint8Array(1_000_000).fill(api.UNPAINTED))
  expect(api.draftPixels(tile)?.[5]).toBe(TRANSPARENT_INDEX)
  changed.mockClear()
  api.captureDraftPixels(tile, new Uint8Array(1_000_000).fill(api.UNPAINTED))
  expect(changed).not.toHaveBeenCalled()
  occupancy.offsets = []
  api.captureDraftPixels(tile, new Uint8Array(1_000_000).fill(api.UNPAINTED))
  expect(changed).toHaveBeenCalledExactlyOnceWith(
    tile,
    [5, 0, api.UNPAINTED, 8, 0, api.UNPAINTED],
    'draft',
  )
})

it('retains all active draft pixels beyond the dense cache limit and cancels them together', async () => {
  const api = await import('./tile-transform.js')
  for (let x = 0; x < 65; x++) {
    const pixels = new Uint8Array(1_000_000).fill(api.UNPAINTED)
    pixels[2] = 1
    api.captureDraftPixels({ x, y: 1 }, pixels)
  }
  expect([...api.draftedPixelOffsets({ x: 0, y: 1 })]).toEqual([2])
  expect(api.draftPixels({ x: 0, y: 1 })?.[2]).toBe(1)
  const changed = vi.fn()
  api.onTilePixels(changed)
  api.clearDraftPixels()
  expect(changed).toHaveBeenCalledTimes(65)
  expect(api.draftPixels({ x: 0, y: 1 })).toBeNull()
})

it('reconciles transparent drafts after native preview removal without rebuilding evicted arrays', async () => {
  const api = await import('./tile-transform.js')
  occupancy.offsets = [5]
  for (let x = 0; x < 65; x++) {
    api.captureDraftPixels({ x, y: 1 }, new Uint8Array(1_000_000).fill(api.UNPAINTED))
  }
  const retained = api.draftPixels({ x: 1, y: 1 })
  const changed = vi.fn()
  api.onTilePixels(changed)

  // Wplace's keep-painting submission removes preview sources and crosshair patches,
  // without clearing their canvases or closing the drawer.
  occupancy.offsets = []
  vi.spyOn(performance, 'now').mockReturnValue(10_000)
  api.reconcileDrafts()

  expect(changed).toHaveBeenCalledTimes(65)
  expect(changed).toHaveBeenCalledWith({ x: 0, y: 1 }, [5, 0, api.UNPAINTED], 'draft')
  expect(api.draftPixels({ x: 0, y: 1 })).toBeNull()
  expect(api.draftPixels({ x: 1, y: 1 })).toBe(retained)
})
