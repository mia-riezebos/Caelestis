import { WORLD_PIXELS } from '@wts/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { centreOf, navigateTo } from './navigate.js'

const map = vi.hoisted(() => ({ current: null as { flyTo: ReturnType<typeof vi.fn> } | null }))

vi.mock('../map-handle.js', () => ({ getMap: () => map.current }))
vi.mock('../debug.js', () => ({ log: vi.fn() }))

beforeEach(() => {
  map.current = null
  vi.stubGlobal('window', {
    innerWidth: 1_000,
    innerHeight: 800,
    location: { href: 'https://wplace.live/?foo=bar' },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('template navigation', () => {
  it('centres a fixed-size template without changing its dimensions', () => {
    expect(centreOf({ originX: 100, originY: 200, width: 30, height: 50 })).toEqual({
      x: 115,
      y: 225,
      width: 30,
      height: 50,
    })
  })

  it('flies in-page and respects the zoom floor for a world-scale target', () => {
    const flyTo = vi.fn()
    map.current = { flyTo }

    navigateTo({
      x: WORLD_PIXELS / 2,
      y: WORLD_PIXELS / 2,
      width: WORLD_PIXELS,
      height: WORLD_PIXELS,
    })

    expect(flyTo).toHaveBeenCalledWith(expect.objectContaining({ center: [0, 0], zoom: 11 }))
  })

  it('falls back to a same-origin URL with projected coordinates when no map was captured', () => {
    navigateTo({ x: WORLD_PIXELS / 2, y: WORLD_PIXELS / 2 })

    expect(window.location.href).toContain('https://wplace.live/')
    expect(window.location.href).toContain('lat=0.0000000')
    expect(window.location.href).toContain('lng=0.0000000')
    expect(window.location.href).toContain('zoom=13.00')
  })
})
