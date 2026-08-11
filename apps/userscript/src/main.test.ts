import { afterEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  draw: null as ((frame: unknown) => void) | null,
  debugApi: null as Record<string, unknown> | null,
  levelFor: vi.fn(),
  localChange: null as (() => void) | null,
  localTemplates: vi.fn(() => [] as unknown[]),
  paintFrame: vi.fn(),
  previewOriginFor: vi.fn(() => null as { x: number; y: number } | null),
  restoreLocalTemplates: vi.fn(async () => {}),
  stampTile: vi.fn(),
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
  levelFor: harness.levelFor,
  localTemplates: harness.localTemplates,
  onLocalChange: vi.fn((listener: () => void) => {
    harness.localChange = listener
  }),
  previewOriginFor: harness.previewOriginFor,
  restoreLocalTemplates: harness.restoreLocalTemplates,
  stampTile: harness.stampTile,
}))
vi.mock('./tile-transform.js', () => ({
  install: vi.fn(),
  onTileFrame: vi.fn((draw: (frame: unknown) => void) => {
    harness.draw = draw
  }),
}))
vi.mock('./ui/panel.js', () => ({ installPanel: vi.fn() }))

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  harness.draw = null
  harness.debugApi = null
  harness.localChange = null
  harness.localTemplates.mockReturnValue([])
  harness.previewOriginFor.mockReturnValue(null)
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

  it('draws visible templates on MapLibre fractional quads without distorting their pixel grid', async () => {
    const bitmap = { width: 1_000, height: 1_000 }
    const levels = { levels: [bitmap] }
    harness.localTemplates.mockReturnValue([
      {
        id: 'template',
        visible: true,
        appearance: { shape: 'full', size: 1 / 3, anchor: 'c', opacity: 0.8, hiddenColours: [] },
      },
    ])
    harness.stampTile.mockReturnValue(levels)
    harness.levelFor.mockReturnValue(bitmap)
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
    const frame = {
      canvas: { width: 1_200, height: 700, parentElement: null },
      quads: [{ tile: { x: 1, y: 2 }, x: 0.49, y: 0.25, width: 1_000.49, height: 999.6 }],
    }
    const draw = harness.draw
    if (draw === null) throw new Error('main must register its tile-frame listener')
    draw(frame)
    const painters = harness.paintFrame.mock.calls[0]?.[2] as
      | Array<(context: unknown, frame: unknown) => void>
      | undefined
    if (painters?.[0] === undefined) throw new Error('main must register its template painter')
    const context = {
      drawImage: vi.fn(),
      globalAlpha: 1,
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
    }

    painters[0](context, frame)

    expect(harness.stampTile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'template' }),
      '1/2',
      expect.objectContaining({ opacity: 0.8 }),
      1_000.49,
    )
    expect(harness.levelFor).toHaveBeenCalledWith(levels, 1_000.49)
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0.49, 0.25, 1_000.49, 999.6)
  })

  it('draws a transient move by translating existing source tiles', async () => {
    const bitmap = { width: 1_000, height: 1_000 }
    const levels = { levels: [bitmap] }
    harness.localTemplates.mockReturnValue([
      {
        id: 'template',
        originX: 1_000,
        originY: 2_000,
        visible: true,
        appearance: { shape: 'full', size: 1, anchor: 'c', opacity: 1, hiddenColours: [] },
      },
    ])
    harness.previewOriginFor.mockReturnValue({ x: 1_100, y: 2_000 })
    harness.stampTile.mockImplementation((_template, key) => (key === '1/2' ? levels : undefined))
    harness.levelFor.mockReturnValue(bitmap)
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
    const frame = {
      canvas: { width: 1_000, height: 1_000, parentElement: null },
      quads: [{ tile: { x: 1, y: 2 }, x: 0, y: 0, width: 1_000, height: 1_000 }],
    }
    const draw = harness.draw
    if (draw === null) throw new Error('main must register its tile-frame listener')
    draw(frame)
    const painters = harness.paintFrame.mock.calls[0]?.[2] as
      | Array<(context: unknown, frame: unknown) => void>
      | undefined
    if (painters?.[0] === undefined) throw new Error('main must register its template painter')
    const context = {
      drawImage: vi.fn(),
      globalAlpha: 1,
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
    }

    painters[0](context, frame)

    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 900, 1_000, 100, 0, 900, 1_000)
  })

  it('filters hidden templates and applies opacity and smoothing per visible quad', async () => {
    const bitmap = { width: 1_000, height: 1_000 }
    const levels = { levels: [bitmap] }
    harness.localTemplates.mockReturnValue([
      { id: 'hidden', visible: false },
      {
        id: 'visible',
        visible: true,
        appearance: { shape: 'full', size: 1, anchor: 'c', opacity: 0.4, hiddenColours: [] },
      },
    ])
    harness.stampTile.mockReturnValue(levels)
    harness.levelFor.mockReturnValue(bitmap)
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
    const frame = {
      canvas: { width: 1_500, height: 1_000, parentElement: null },
      quads: [
        { tile: { x: 1, y: 2 }, x: 0, y: 0, width: 500, height: 500 },
        { tile: { x: 2, y: 2 }, x: 500, y: 0, width: 1_000, height: 1_000 },
      ],
    }
    const draw = harness.draw
    if (draw === null) throw new Error('main must register its tile-frame listener')
    draw(frame)
    const painters = harness.paintFrame.mock.calls[0]?.[2] as
      | Array<(context: unknown, frame: unknown) => void>
      | undefined
    if (painters?.[0] === undefined) throw new Error('main must register its template painter')
    const states: Array<{ alpha: number; smoothing: boolean }> = []
    const context = {
      globalAlpha: 1,
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      drawImage: vi.fn(() =>
        states.push({
          alpha: context.globalAlpha,
          smoothing: context.imageSmoothingEnabled,
        }),
      ),
    }

    painters[0](context, frame)

    expect(harness.stampTile).toHaveBeenCalledTimes(2)
    expect(harness.stampTile).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'hidden' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
    expect(states).toEqual([
      { alpha: 0.4, smoothing: true },
      { alpha: 0.4, smoothing: false },
    ])
    expect(context.globalAlpha).toBe(1)
  })

  it('filters against the selected stamp bitmap rather than the native tile width', async () => {
    const bitmap = { width: 1_182, height: 1_182 }
    harness.localTemplates.mockReturnValue([
      {
        id: 'shaped',
        visible: true,
        appearance: { shape: 'circle', size: 1 / 3, anchor: 'c', opacity: 1, hiddenColours: [] },
      },
    ])
    harness.stampTile.mockReturnValue({ levels: [bitmap] })
    harness.levelFor.mockReturnValue(bitmap)
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
    const draw = harness.draw
    if (draw === null) throw new Error('main must register its tile-frame listener')
    draw({
      canvas: { width: 1_000, height: 1_000, parentElement: null },
      quads: [{ tile: { x: 0, y: 0 }, x: 0, y: 0, width: 1_000, height: 1_000 }],
    })
    const painters = harness.paintFrame.mock.calls[0]?.[2] as
      | Array<(context: unknown, frame: unknown) => void>
      | undefined
    if (painters?.[0] === undefined) throw new Error('main must register its template painter')
    const context = {
      drawImage: vi.fn(),
      globalAlpha: 1,
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
    }

    painters[0](context, {
      canvas: { width: 1_000, height: 1_000, parentElement: null },
      quads: [{ tile: { x: 0, y: 0 }, x: 0, y: 0, width: 1_000, height: 1_000 }],
    })

    expect(context.imageSmoothingEnabled).toBe(true)
    expect(context.imageSmoothingQuality).toBe('high')
  })

  it('repaints the idle map when local template state changes', async () => {
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
    const draw = harness.draw
    if (draw === null || harness.localChange === null) throw new Error('expected repaint wiring')
    draw({ canvas: { width: 100, height: 100, parentElement: null }, quads: [] })
    harness.paintFrame.mockClear()

    harness.localChange()

    expect(harness.paintFrame).toHaveBeenCalledOnce()
  })
})
