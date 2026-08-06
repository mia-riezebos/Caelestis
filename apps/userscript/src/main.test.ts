import { afterEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  draw: null as ((frame: unknown) => void) | null,
  debugApi: null as Record<string, unknown> | null,
  localChange: null as (() => void) | null,
  paintFrame: vi.fn(),
  restoreLocalTemplates: vi.fn(async () => {}),
}))

vi.mock('./debug.js', () => ({
  installDebugApi: vi.fn((extra: Record<string, unknown>) => {
    harness.debugApi = extra
  }),
  log: vi.fn(),
  warn: vi.fn(),
}))
vi.mock('./map-handle.js', () => ({ installMapCapture: vi.fn() }))
vi.mock('./paint.js', () => ({ paintFrame: harness.paintFrame }))
vi.mock('./templates/local-store.js', () => ({
  levelFor: vi.fn(),
  localTemplates: vi.fn(() => []),
  onLocalChange: vi.fn((listener: () => void) => {
    harness.localChange = listener
  }),
  restoreLocalTemplates: harness.restoreLocalTemplates,
  stampTile: vi.fn(),
}))
vi.mock('./tile-transform.js', () => ({
  install: vi.fn(),
  onTileFrame: vi.fn((draw: (frame: unknown) => void) => {
    harness.draw = draw
  }),
}))

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  harness.draw = null
  harness.debugApi = null
  harness.localChange = null
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
    const draw = harness.draw
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

  it('attaches the overlay to the map container and follows a non-square backing size', async () => {
    const overlay = {
      dataset: {},
      style: {},
      width: 0,
      height: 0,
      parentElement: null as object | null,
      getContext: vi.fn(() => ({})),
    }
    const mapParent = {
      appendChild: vi.fn((child: typeof overlay) => {
        child.parentElement = mapParent
      }),
    }
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => overlay),
    })

    await import('./main.js')
    const draw = harness.draw
    if (draw === null) throw new Error('main must register its tile-frame listener')
    const frame = {
      canvas: { width: 1_200, height: 700, parentElement: mapParent },
      quads: [],
    }

    draw(frame)

    expect(mapParent.appendChild).toHaveBeenCalledWith(overlay)
    expect(overlay).toMatchObject({ width: 1_200, height: 700, parentElement: mapParent })
    expect(harness.paintFrame).toHaveBeenCalledOnce()
  })

  it('does not paint when the overlay cannot provide a 2D context', async () => {
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => ({
        dataset: {},
        style: {},
        width: 0,
        height: 0,
        parentElement: null,
        getContext: () => null,
      })),
    })

    await import('./main.js')
    const draw = harness.draw
    if (draw === null) throw new Error('main must register its tile-frame listener')
    draw({ canvas: { width: 1_000, height: 500, parentElement: null }, quads: [] })

    expect(harness.paintFrame).not.toHaveBeenCalled()
  })

  it('registers a mark painter that fills only the requested tile quad', async () => {
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => ({
        dataset: {},
        style: {},
        width: 0,
        height: 0,
        parentElement: null,
        getContext: () => ({}),
      })),
    })

    await import('./main.js')
    const mark = harness.debugApi?.mark
    if (typeof mark !== 'function') throw new Error('main must install its mark debug command')
    Reflect.apply(mark, harness.debugApi, [8, 9])

    const context = { fillStyle: '', fillRect: vi.fn() }
    const frame = {
      canvas: { width: 1_000, height: 500, parentElement: null },
      quads: [
        { tile: { x: 9, y: 8 }, x: 1, y: 2, width: 3, height: 4 },
        { tile: { x: 8, y: 9 }, x: 10, y: 20, width: 30, height: 40 },
      ],
    }
    const draw = harness.draw
    if (draw === null) throw new Error('main must register its tile-frame listener')
    draw(frame)
    const painters = harness.paintFrame.mock.calls[0]?.[2] as
      | Array<(context: unknown, frame: unknown) => void>
      | undefined
    if (painters?.[1] === undefined) throw new Error('main must register its mark painter')

    painters[1](context, frame)

    expect(context.fillStyle).toBe('rgba(0, 0, 0, 0.6)')
    expect(context.fillRect).toHaveBeenCalledOnce()
    expect(context.fillRect).toHaveBeenCalledWith(10, 20, 30, 40)
  })
})
