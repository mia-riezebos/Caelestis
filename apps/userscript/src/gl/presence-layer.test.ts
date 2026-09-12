import { afterEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ map: null as object | null }))

vi.mock('../map-handle.js', () => ({ getMap: () => harness.map }))
vi.mock('../claim-editor.js', () => ({
  claimEditorPixels: () => null,
  claimEditorEditingId: () => null,
}))
vi.mock('../debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../presence-client.js', () => ({
  presenceView: () => ({ peers: [], regions: [], online: 0, connected: false, me: null }),
}))
vi.mock('../state.js', () => ({ getState: () => ({ showPresence: true }) }))
vi.mock('../tile-transform.js', () => ({ currentQuads: () => [], isDrawingTiles: () => false }))

const orderedMap = (order: string[]) => {
  const moveLayer = vi.fn((id: string, before?: string) => {
    const from = order.indexOf(id)
    if (from >= 0) order.splice(from, 1)
    const target = before === undefined ? order.length : order.indexOf(before)
    order.splice(target < 0 ? order.length : target, 0, id)
  })
  const addLayer = vi.fn((layer: { id: string }, before?: string) => {
    const target = before === undefined ? order.length : order.indexOf(before)
    order.splice(target < 0 ? order.length : target, 0, layer.id)
  })
  return {
    moveLayer,
    map: {
      style: { _order: order },
      addLayer,
      getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
      moveLayer,
    },
  }
}

afterEach(() => {
  harness.map = null
  vi.resetModules()
})

describe('installPresenceLayer', () => {
  it('puts presence over the art and markers, under the crosshair', async () => {
    const order = [
      'background',
      'caelestis-outline',
      'pixel-art-layer',
      'caelestis-overlay',
      'caelestis-markers',
      'pixel-hover',
    ]
    harness.map = orderedMap(order).map
    const { installPresenceLayer } = await import('./presence-layer.js')

    expect(installPresenceLayer()).toBe(true)
    expect(order).toEqual([
      'background',
      'caelestis-outline',
      'pixel-art-layer',
      'caelestis-overlay',
      'caelestis-markers',
      'caelestis-presence',
      'pixel-hover',
    ])
  })

  it('waits until the crosshair exists', async () => {
    harness.map = orderedMap(['background', 'pixel-art-layer']).map
    const { installPresenceLayer } = await import('./presence-layer.js')

    expect(installPresenceLayer()).toBe(false)
  })

  it('restores the layer after a style change displaces it', async () => {
    const order = [
      'background',
      'caelestis-presence',
      'pixel-art-layer',
      'caelestis-markers',
      'pixel-hover',
    ]
    const { map, moveLayer } = orderedMap(order)
    harness.map = map
    const { installPresenceLayer } = await import('./presence-layer.js')

    expect(installPresenceLayer()).toBe(true)
    expect(moveLayer).toHaveBeenCalledOnce()
    expect(order).toEqual([
      'background',
      'pixel-art-layer',
      'caelestis-markers',
      'caelestis-presence',
      'pixel-hover',
    ])
  })

  it('leaves a correctly ordered layer alone', async () => {
    const order = ['pixel-art-layer', 'caelestis-markers', 'caelestis-presence', 'pixel-hover']
    const { map, moveLayer } = orderedMap(order)
    harness.map = map
    const { installPresenceLayer } = await import('./presence-layer.js')

    expect(installPresenceLayer()).toBe(true)
    expect(moveLayer).not.toHaveBeenCalled()
  })
})
