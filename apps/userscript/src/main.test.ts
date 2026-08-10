import { afterEach, describe, expect, it, vi } from 'vitest'

const tileFrames = vi.hoisted(() => ({
  draw: null as ((frame: unknown) => void) | null,
}))

vi.mock('./debug.js', () => ({
  installDebugApi: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
}))
vi.mock('./map-handle.js', () => ({ installMapCapture: vi.fn() }))
vi.mock('./paint.js', () => ({ paintFrame: vi.fn() }))
vi.mock('./tile-transform.js', () => ({
  install: vi.fn(),
  onTileFrame: vi.fn((draw: (frame: unknown) => void) => {
    tileFrames.draw = draw
  }),
}))

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  tileFrames.draw = null
})

describe('overlay canvas lifecycle', () => {
  it('reuses one overlay while the map canvas is temporarily detached', async () => {
    const created: Array<Record<string, unknown>> = []
    const createElement = vi.fn(() => {
      const canvas = {
        dataset: {},
        style: {},
        width: 0,
        height: 0,
        parentElement: null,
        getContext: () => ({}),
      }
      created.push(canvas)
      return canvas
    })
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
      createElement,
    })

    await import('./main.js')
    const draw = tileFrames.draw
    if (draw === null) throw new Error('main must register its tile-frame listener')
    const frame = {
      canvas: { width: 1_000, height: 1_000, parentElement: null },
      quads: [],
    }

    draw(frame)
    draw(frame)

    expect(createElement).toHaveBeenCalledOnce()
    expect(created).toHaveLength(1)
  })
})
