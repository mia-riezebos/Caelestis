// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  tileFrame: null as ((frame: unknown) => void) | null,
  localListeners: [] as Array<() => void>,
  previewListeners: [] as Array<() => void>,
  stateListeners: [] as Array<() => void>,
  paintListeners: [] as Array<() => void>,
  mismatchListeners: [] as Array<() => void>,
  clearDraftPixels: vi.fn(),
  triggerRepaint: vi.fn(),
  renderOverlayControls: vi.fn(),
  viewportCentreIn: vi.fn(() => ({ x: 12, y: 34 })),
  screenPointForIn: vi.fn(() => ({ x: 56, y: 78 })),
  cssPixelsPerCanvasPixelIn: vi.fn(() => ({ x: 2, y: 3 })),
  canvasPixelAtIn: vi.fn(() => ({ x: 90, y: 12 })),
}))

vi.mock('./coordinates.js', () => ({
  canvasPixelAtIn: harness.canvasPixelAtIn,
  createScreenProjectionCache: () => ({
    project: () => null,
    invalidate: vi.fn(),
    dispose: vi.fn(),
  }),
  cssPixelsPerCanvasPixelIn: harness.cssPixelsPerCanvasPixelIn,
  screenPointForIn: harness.screenPointForIn,
  viewportCentreIn: harness.viewportCentreIn,
}))
vi.mock('./debug.js', () => ({ installDebugApi: vi.fn(), warn: vi.fn() }))
vi.mock('./gl/layer.js', () => ({
  installOverlayLayer: vi.fn(() => true),
  overlayGpuMemoryBytes: vi.fn(() => 0),
  overlayStagingMemoryBytes: vi.fn(() => 0),
  setNudge: vi.fn(),
}))
vi.mock('./gl/markers.js', () => ({
  keepMarkersAboveDrafts: vi.fn(),
  markerBatchMemoryBytes: vi.fn(() => 0),
  markerDensityMemoryBytes: vi.fn(() => 0),
  markerGpuMemoryBytes: vi.fn(() => 0),
}))
vi.mock('./keyboard-shortcuts.js', () => ({ installKeyboardShortcuts: vi.fn() }))
vi.mock('./map-handle.js', () => ({
  getMap: () => ({ triggerRepaint: harness.triggerRepaint }),
  installMapCapture: vi.fn(),
}))
vi.mock('./paint-palette.js', () => ({
  cycleFocusedColour: vi.fn(),
  installPaintPaletteProgress: vi.fn(),
  navigateFocusedSelectedColour: vi.fn(),
  paintPaletteProgress: vi.fn(() => []),
  refreshPaintPaletteFocus: vi.fn(),
}))
vi.mock('./overlay-peek.js', () => ({ setOverlayPeekActive: vi.fn(() => false) }))
vi.mock('./shortcuts.js', () => ({ shortcutFor: vi.fn(() => null) }))
vi.mock('./server-mismatch.js', () => ({ serverMismatchMemoryBytes: vi.fn(() => 0) }))
vi.mock('./state.js', () => ({
  getState: () => ({ appearance: { markMismatch: false }, onlySelectedColour: false }),
  loadState: vi.fn(),
  onStateChange: (listener: () => void) => harness.stateListeners.push(listener),
  setState: vi.fn(),
}))
vi.mock('./templates/local-store.js', () => ({
  appearanceOf: vi.fn(),
  isTemplateVisible: vi.fn(() => true),
  localTemplates: vi.fn(() => []),
  onLocalChange: (listener: () => void) => harness.localListeners.push(listener),
  onLocalPreviewChange: (listener: () => void) => harness.previewListeners.push(listener),
  ownsGroup: vi.fn(() => false),
  restoreLocalTemplates: vi.fn(),
  setAppearance: vi.fn(),
  setLocalVisible: vi.fn(),
  setOwnsGroup: vi.fn(),
  templateIndexMemoryBytes: vi.fn(() => 0),
}))
vi.mock('./templates/mismatch.js', () => ({
  pixelAccounting: {
    memoryBytes: vi.fn(() => 0),
    onChange: (listener: () => void) => harness.mismatchListeners.push(listener),
    wantsTilePixels: vi.fn(() => false),
  },
}))
vi.mock('./templates/mismatch-worker.js', () => ({ mismatchWorkerMemoryBytes: vi.fn(() => 0) }))
vi.mock('./templates/nearest.js', () => ({ focusedTemplate: vi.fn(() => null) }))
vi.mock('./templates/server-sync.js', () => ({ installServerSync: vi.fn() }))
vi.mock('./telemetry.js', () => ({ installTelemetry: vi.fn() }))
vi.mock('./alarms.js', () => ({ installAlarmNotifications: vi.fn() }))
vi.mock('./tile-transform.js', () => ({
  capturedPixelMemoryBytes: vi.fn(() => 0),
  captureTilePixels: vi.fn(),
  clearDraftPixels: harness.clearDraftPixels,
  install: vi.fn(),
  onTileFrame: (listener: (frame: unknown) => void) => {
    harness.tileFrame = listener
  },
  reconcileDrafts: vi.fn(),
}))
vi.mock('./ui/overlay-menu.js', () => ({
  refreshOverlayMenu: vi.fn(),
  renderOverlayControls: harness.renderOverlayControls,
  toggleOverlayMenu: vi.fn(),
}))
vi.mock('./ui/panel.js', () => ({ installPanel: vi.fn(), togglePanel: vi.fn() }))
vi.mock('./wplace-account.js', () => ({ loadAccount: vi.fn() }))
vi.mock('./wplace-paint.js', () => ({
  isPaintOpen: vi.fn(() => false),
  onPaintSelectionChange: (listener: () => void) => harness.paintListeners.push(listener),
  togglePaintMode: vi.fn(),
  watchPaintSelection: vi.fn(),
}))
vi.mock('./wplace-picker.js', () => ({ installColourPicker: vi.fn() }))

type MainModule = typeof import('./main.js')

const load = async (): Promise<MainModule> => {
  const module = await import('./main.js')
  if (harness.tileFrame === null) throw new Error('tile frame listener was not installed')
  return module
}

const frame = (canvas: HTMLCanvasElement, quads: readonly unknown[] = [{}]) => ({ canvas, quads })

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.tileFrame = null
  harness.localListeners = []
  harness.previewListeners = []
  harness.stateListeners = []
  harness.paintListeners = []
  harness.mismatchListeners = []
})

describe('GL frame lifecycle', () => {
  it('drops a stale projection when the current frame has no tiles', async () => {
    const main = await load()
    const first = document.createElement('canvas')
    const current = document.createElement('canvas')
    harness.tileFrame?.(frame(first))
    harness.tileFrame?.(frame(current, []))

    expect(main.viewportCentre()).toEqual({ x: 12, y: 34 })
    expect(harness.viewportCentreIn).toHaveBeenCalledWith(
      expect.objectContaining({ canvas: current, quads: [] }),
    )
  })

  it('hands overlay controls the canvas from the frame being processed', async () => {
    await load()
    const canvas = document.createElement('canvas')
    harness.tileFrame?.(frame(canvas))

    expect(harness.renderOverlayControls).toHaveBeenCalledWith(expect.any(Function), canvas)
  })

  it('defers a synchronous repaint until the current pass and bounds the feedback loop', async () => {
    const main = await load()
    let calls = 0
    main.onFrame(() => {
      calls++
      main.repaint()
    })
    harness.tileFrame?.(frame(document.createElement('canvas')))

    expect(calls).toBe(3)
  })

  it('repaints the GL map and coordinate controls after local state changes', async () => {
    await load()
    const canvas = document.createElement('canvas')
    harness.tileFrame?.(frame(canvas))
    harness.renderOverlayControls.mockClear()
    harness.triggerRepaint.mockClear()

    harness.localListeners.at(-1)?.()

    expect(harness.renderOverlayControls).toHaveBeenCalledWith(expect.any(Function), canvas)
    expect(harness.triggerRepaint).toHaveBeenCalledOnce()
  })

  it('repaints without publishing a durable change for placement previews', async () => {
    await load()
    const canvas = document.createElement('canvas')
    harness.tileFrame?.(frame(canvas))
    harness.renderOverlayControls.mockClear()
    harness.triggerRepaint.mockClear()

    harness.previewListeners.at(-1)?.()

    expect(harness.renderOverlayControls).toHaveBeenCalledWith(expect.any(Function), canvas)
    expect(harness.triggerRepaint).toHaveBeenCalledOnce()
  })

  it('repaints the GL marker layer when Wplace changes the selected paint colour', async () => {
    await load()
    const canvas = document.createElement('canvas')
    harness.tileFrame?.(frame(canvas))
    harness.renderOverlayControls.mockClear()
    harness.triggerRepaint.mockClear()

    harness.paintListeners[0]?.()

    expect(harness.clearDraftPixels).toHaveBeenCalledOnce()
    expect(harness.renderOverlayControls).toHaveBeenCalledWith(expect.any(Function), canvas)
    expect(harness.triggerRepaint).toHaveBeenCalledOnce()
  })

  it('uses the retained frame for coordinate conversion helpers', async () => {
    const main = await load()
    const canvas = document.createElement('canvas')
    harness.tileFrame?.(frame(canvas))

    expect(main.screenPointFor(1, 2)).toEqual({ x: 56, y: 78 })
    expect(main.canvasPixelAt(3, 4)).toEqual({ x: 90, y: 12 })
    expect(main.cssPixelsPerCanvasPixel()).toEqual({ x: 2, y: 3 })
  })
})
