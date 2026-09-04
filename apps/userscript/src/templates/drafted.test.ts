import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ map: null as unknown }))
vi.mock('../map-handle.js', () => ({ getMap: () => fixture.map }))

import { draftedPixelsIn } from './drafted.js'

afterEach(() => vi.restoreAllMocks())

it('reuses occupancy until a native mutation, with bounded recovery for missed notifications', () => {
  const time = vi.spyOn(performance, 'now').mockReturnValue(0)
  const pixels = new Uint8Array(40_000)
  pixels[3] = 255
  let reads = 0
  const annotations = new Proxy(pixels, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++
      return Reflect.get(target, key, target)
    },
  })
  const renderer = {
    tiles: new Map([['paint-crosshair-0,0', { annotations }]]),
    markDirty: vi.fn((_key: string) => 42),
  }
  fixture.map = {
    style: { _layers: { 'paint-crosshair-annotations': { implementation: renderer } } },
  }
  expect(draftedPixelsIn({ x: 0, y: 0 }, 1_000)).toEqual([3])
  expect(reads).toBe(40_000)
  expect(draftedPixelsIn({ x: 0, y: 0 }, 1_000)).toEqual([3])
  expect(reads).toBe(40_000)
  pixels[3] = 0
  pixels[7] = 255
  expect(renderer.markDirty('paint-crosshair-0,0')).toBe(42)
  expect(draftedPixelsIn({ x: 0, y: 0 }, 1_000)).toEqual([7])
  expect(reads).toBe(80_000)
  pixels[7] = 0
  time.mockReturnValue(1_000)
  expect(draftedPixelsIn({ x: 0, y: 0 }, 1_000)).toEqual([])
})

it('scans an unsupported renderer instead of trusting stale array identity', () => {
  const annotations = new Uint8Array(40_000)
  const renderer = { tiles: new Map([['paint-crosshair-0,0', { annotations }]]) }
  fixture.map = {
    style: { _layers: { 'paint-crosshair-annotations': { implementation: renderer } } },
  }
  expect(draftedPixelsIn({ x: 0, y: 0 }, 1_000)).toEqual([])
  annotations[5] = 255
  expect(draftedPixelsIn({ x: 0, y: 0 }, 1_000)).toEqual([5])
})
