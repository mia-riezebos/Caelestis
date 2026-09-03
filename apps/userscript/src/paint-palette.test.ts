// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  localProgress: [{ index: 0, completed: 1, mismatched: 0, unpainted: 1, known: 2, total: 2 }],
  serverProgress: [{ index: 0, completed: 2, mismatched: 1, unpainted: 0, known: 3, total: 3 }],
  stateListeners: [] as Array<() => void>,
  localListeners: [] as Array<() => void>,
  mismatchListeners: [] as Array<() => void>,
  draftListeners: [] as Array<() => void>,
  statusListeners: [] as Array<() => void>,
  paintListeners: [] as Array<() => void>,
  canvasWriteListeners: [] as Array<(canvas: object) => void>,
  acceptedPaintListeners: [] as Array<
    (paint: {
      submission?: { identity: object }
      painted: number
      tiles: Array<{ pixels: { x: number[] } }>
    }) => void
  >,
  paintSubmissionListeners: [] as Array<(submission: { identity: object }) => void>,
  tilePixelListeners: [] as Array<
    (tile: { x: number; y: number }, triples: readonly number[], source: 'server' | 'draft') => void
  >,
  tilePixelEvictionListeners: [] as Array<(tile: { x: number; y: number }) => void>,
  focused: null as {
    id: string
    serverUrl?: string
    serverTemplateId?: string
    serverVersion?: string
    opaque?: number
    originX?: number
    originY?: number
    width?: number
    height?: number
    indices?: Uint8Array
    surface?:
      | { kind: 'world' }
      | { kind: 'alliance-headquarters'; allianceId: number }
      | { kind: 'alliance-picture'; allianceId: number }
      | { kind: 'alliance-banner'; allianceId: number }
  } | null,
  serverIdentity: {} as object,
  colourNavigationOrder: 'unpainted-first' as 'unpainted-first' | 'mismatched-first',
  paintOpen: true,
  selectedColour: 0 as number | null,
  activeAlliance: null as null | {
    surface: { kind: 'alliance-headquarters'; allianceId: number }
    bounds: { minX: number; minY: number; maxX: number; maxY: number }
    stage: HTMLElement
    frame: HTMLElement
  },
  artboardPixels: {
    committed: [] as Array<{
      x: number
      y: number
      width: number
      height: number
      pixels: Uint8Array
      emptyIndex: number
    }>,
    draft: [] as Array<{
      x: number
      y: number
      width: number
      height: number
      pixels: Uint8Array
      emptyIndex: number
    }>,
  },
  draftPixelDeltas: [] as Array<{
    key: string
    basis: string
    index: number
    completed: number
    mismatched: number
    unpainted: number
  }>,
  selectPaintColour: vi.fn(() => true),
  navigationTargets: {
    unpainted: {
      templateId: 'local',
      x: 12,
      y: 56,
      kind: 'unpainted' as const,
    } as { templateId: string; x: number; y: number; kind: 'unpainted' } | null,
    mismatched: null as { templateId: string; x: number; y: number; kind: 'mismatched' } | null,
  },
  navigateTo: vi.fn(),
  navigateAlliance: vi.fn(() => true),
  nearestColourTarget: vi.fn(
    async (
      _index: number,
      kind: 'unpainted' | 'mismatched',
      _reference: { x: number; y: number },
      _templateId?: string,
      _exclude?: { templateId: string; x: number; y: number; kind: string },
    ) => harness.navigationTargets[kind],
  ),
}))

const server = {
  url: 'https://templates.test',
  info: { id: 'server', name: 'Server', auth: 'none' as const },
  token: null,
  status: 'connected' as const,
  isAdmin: false,
  season: 0,
}
const local = { id: 'local' }
const remote = {
  id: 'remote-drawn',
  serverUrl: server.url,
  serverTemplateId: 'remote',
  opaque: 3,
}
vi.mock('./debug.js', () => ({ count: vi.fn(), warn: vi.fn() }))
vi.mock('./alliance-surface.js', () => ({
  activeAllianceSurface: () => harness.activeAlliance,
}))
vi.mock('./alliance-navigation.js', () => ({
  navigateAllianceArtboardTo: harness.navigateAlliance,
}))
vi.mock('./canvas-write.js', () => ({
  onCanvasWrite: (listener: (canvas: object) => void) => {
    harness.canvasWriteListeners.push(listener)
    return vi.fn()
  },
}))
vi.mock('./gl/artboard-pixels.js', () => ({
  readArtboardPixels: () => harness.artboardPixels,
}))
vi.mock('./map-handle.js', () => ({
  getMap: () => ({ getCenter: () => ({ lat: 0, lng: 0 }) }),
}))
vi.mock('./state.js', () => ({
  getState: () => ({
    servers: [server],
    colourNavigationOrder: harness.colourNavigationOrder,
  }),
  onStateChange: (listener: () => void) => harness.stateListeners.push(listener),
  serverConnectionIdentity: () => harness.serverIdentity,
}))
vi.mock('./telemetry.js', () => ({
  onServerStatusChange: (listener: () => void) => {
    harness.statusListeners.push(listener)
    return vi.fn()
  },
  serverColourProgressFor: () => harness.serverProgress,
}))
vi.mock('./templates/local-store.js', () => ({
  displayTemplates: () => [local, remote],
  isTemplateVisible: () => true,
  onLocalChange: (listener: () => void) => harness.localListeners.push(listener),
  templateById: (id: string) => (harness.focused?.id === id ? harness.focused : undefined),
}))
vi.mock('./templates/mismatch.js', () => ({
  pixelAccounting: {
    read: (template: { id: string }) => ({
      colours: harness.localProgress,
      draftPixelDeltas: harness.draftPixelDeltas,
      nearest: (
        index: number,
        kind: 'unpainted' | 'mismatched',
        reference: { x: number; y: number },
        exclude?: { templateId: string; x: number; y: number; kind: string },
      ) => harness.nearestColourTarget(index, kind, reference, template.id, exclude),
    }),
    onChange: (listener: () => void) => harness.mismatchListeners.push(listener),
    onDraftChange: (listener: () => void) => harness.draftListeners.push(listener),
  },
}))
vi.mock('./tile-transform.js', () => ({
  onAcceptedPaint: (
    listener: (paint: {
      submission?: { identity: object }
      painted: number
      tiles: Array<{ pixels: { x: number[] } }>
    }) => void,
  ) => {
    harness.acceptedPaintListeners.push(listener)
    return vi.fn()
  },
  onPaintSubmission: (listener: (submission: { identity: object }) => void) => {
    harness.paintSubmissionListeners.push(listener)
    return vi.fn()
  },
  onTilePixels: (
    listener: (
      tile: { x: number; y: number },
      triples: readonly number[],
      source: 'server' | 'draft',
    ) => void,
  ) => {
    harness.tilePixelListeners.push(listener)
    return vi.fn()
  },
  onTilePixelsEvicted: (listener: (tile: { x: number; y: number }) => void) => {
    harness.tilePixelEvictionListeners.push(listener)
    return vi.fn()
  },
}))
vi.mock('./templates/navigate.js', () => ({ navigateTo: harness.navigateTo }))
vi.mock('./templates/nearest.js', () => ({ focusedTemplate: () => harness.focused }))
vi.mock('./wplace-paint.js', () => ({
  isPaintOpen: () => harness.paintOpen,
  onPaintSelectionChange: (listener: () => void) => harness.paintListeners.push(listener),
  paintPaletteIndexOf: (element: Element) => {
    const raw = Number(element.id.slice('color-'.length))
    if (Number.isInteger(raw) && raw > 0) return raw - 1
    const names = ['Black', 'Dark Gray', 'Gray', 'Light Gray', 'White', 'Deep Red']
    const index = names.indexOf(element.getAttribute('aria-label')?.split('. ', 1)[0] ?? '')
    return index < 0 ? null : index
  },
  paintPaletteSwatches: (root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>('[id^="color-"]'),
    ...root.querySelectorAll<HTMLElement>('button[aria-label][aria-pressed]'),
  ],
  selectPaintColour: harness.selectPaintColour,
  selectedColour: () => harness.selectedColour,
}))

beforeEach(() => {
  document.body.replaceChildren()
  vi.clearAllMocks()
  harness.localProgress = [
    { index: 0, completed: 1, mismatched: 0, unpainted: 1, known: 2, total: 2 },
  ]
  harness.serverProgress = [
    { index: 0, completed: 2, mismatched: 1, unpainted: 0, known: 3, total: 3 },
  ]
  harness.focused = local
  harness.colourNavigationOrder = 'unpainted-first'
  harness.paintOpen = true
  harness.selectedColour = 0
  harness.activeAlliance = null
  harness.artboardPixels = { committed: [], draft: [] }
  harness.draftPixelDeltas = []
  harness.serverIdentity = {}
  harness.navigationTargets.unpainted = {
    templateId: 'local',
    x: 12,
    y: 56,
    kind: 'unpainted',
  }
  harness.navigationTargets.mismatched = null
})

describe('Wplace paint palette progress', () => {
  it('shows pixels left for only the focused template while progress is still loading', async () => {
    harness.localProgress = [
      { index: 0, completed: 12, mismatched: 0, unpainted: 0, known: 12, total: 112 },
    ]
    const swatch = document.createElement('button')
    swatch.id = 'color-1'
    swatch.setAttribute('aria-label', 'Black')
    document.body.appendChild(swatch)
    const { installPaintPaletteProgress, paintPaletteProgress, refreshPaintPaletteFocus } =
      await import('./paint-palette.js')

    installPaintPaletteProgress()

    expect(
      swatch.querySelector<HTMLElement & { model?: { value: string } }>(
        'caelestis-palette-progress',
      )?.model?.value,
    ).toBe('100')
    expect(swatch.getAttribute('aria-label')).toContain('100 pixels left')

    harness.localProgress = [
      { index: 0, completed: 1, mismatched: 0, unpainted: 1, known: 2, total: 2 },
    ]
    harness.mismatchListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(paintPaletteProgress()).toEqual([
      { index: 0, completed: 1, mismatched: 0, unpainted: 1, known: 2, total: 2 },
    ])
    expect(
      swatch.querySelector<HTMLElement & { model?: { value: string } }>(
        'caelestis-palette-progress',
      )?.model?.value,
    ).toBe('1')
    expect(swatch.getAttribute('aria-label')).toContain('1 pixel left in the focused template')
    expect(swatch.getAttribute('aria-label')).not.toContain('%')

    swatch.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(harness.nearestColourTarget).toHaveBeenLastCalledWith(
      0,
      'unpainted',
      expect.any(Object),
      'local',
      undefined,
    )
    expect(harness.navigateTo).toHaveBeenLastCalledWith({
      x: 12.5,
      y: 56.5,
      width: 1,
      height: 1,
    })

    harness.colourNavigationOrder = 'mismatched-first'
    harness.nearestColourTarget.mockClear()
    harness.navigateTo.mockClear()
    swatch.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(harness.nearestColourTarget.mock.calls.map((call) => [call[1], call[3]])).toEqual([
      ['mismatched', 'local'],
      ['unpainted', 'local'],
    ])
    expect(harness.navigateTo).toHaveBeenCalledOnce()

    harness.focused = remote
    refreshPaintPaletteFocus()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(paintPaletteProgress()).toEqual(harness.serverProgress)
    expect(
      swatch.querySelector<HTMLElement & { model?: { value: string } }>(
        'caelestis-palette-progress',
      )?.model?.value,
    ).toBe('1')

    // A native draft correction updates immediately even if local accounting is still partial.
    harness.localProgress = [
      { index: 0, completed: 0, mismatched: 0, unpainted: 0, known: 0, total: 3 },
    ]
    harness.draftPixelDeltas = [
      { key: '0/0/0', basis: 'tile-1', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
    ]
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(swatch.querySelector('caelestis-palette-progress')).toBeNull()

    // An unrelated same-colour server advance wins over the projected baseline, and a response that
    // includes this paint therefore cannot count it twice.
    harness.serverProgress = [
      { index: 0, completed: 3, mismatched: 0, unpainted: 0, known: 3, total: 3 },
    ]
    harness.statusListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(swatch.querySelector('caelestis-palette-progress')).toBeNull()

    harness.draftPixelDeltas = []
    harness.localProgress = [
      { index: 0, completed: 2, mismatched: 1, unpainted: 0, known: 3, total: 3 },
    ]
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(swatch.querySelector('caelestis-palette-progress')).toBeNull()
    expect(swatch.getAttribute('aria-label')).toBe('Black')

    swatch.remove()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const remounted = document.createElement('button')
    remounted.id = 'color-1'
    remounted.setAttribute('aria-label', 'Black')
    document.body.appendChild(remounted)
    harness.paintListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(remounted.querySelector('caelestis-palette-progress')).toBeNull()
  })

  it("cycles unfinished colours in Wplace's rendered palette order", async () => {
    harness.localProgress = [
      { index: 0, completed: 2, mismatched: 0, unpainted: 0, known: 2, total: 2 },
      { index: 2, completed: 1, mismatched: 0, unpainted: 2, known: 3, total: 3 },
      { index: 5, completed: 0, mismatched: 0, unpainted: 4, known: 4, total: 4 },
      { index: 7, completed: 1, mismatched: 1, unpainted: 0, known: 2, total: 2 },
    ]
    for (const index of [5, 0, 2, 7]) {
      const swatch = document.createElement('button')
      swatch.id = `color-${index + 1}`
      document.body.appendChild(swatch)
    }
    const { cycleFocusedColour } = await import('./paint-palette.js')

    harness.selectedColour = 5
    expect(cycleFocusedColour(1)).toBe(true)
    expect(harness.selectPaintColour).toHaveBeenLastCalledWith(2)

    harness.selectedColour = 2
    expect(cycleFocusedColour(-1)).toBe(true)
    expect(harness.selectPaintColour).toHaveBeenLastCalledWith(5)
    expect(cycleFocusedColour(1)).toBe(true)
    expect(harness.selectPaintColour).toHaveBeenLastCalledWith(7)

    harness.selectedColour = 0
    expect(cycleFocusedColour(1)).toBe(true)
    expect(harness.selectPaintColour).toHaveBeenLastCalledWith(2)
    expect(cycleFocusedColour(-1)).toBe(true)
    expect(harness.selectPaintColour).toHaveBeenLastCalledWith(5)
  })

  it("cycles Wplace's alliance palette in rendered order without reading progress", async () => {
    harness.focused = null
    harness.activeAlliance = {
      surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
      bounds: { minX: -125, minY: -125, maxX: 125, maxY: 125 },
      stage: document.createElement('div'),
      frame: document.createElement('div'),
    }
    for (const name of ['Black', 'Gray', 'Deep Red']) {
      const swatch = document.createElement('button')
      swatch.setAttribute('aria-label', name)
      swatch.setAttribute('aria-pressed', 'false')
      document.body.appendChild(swatch)
    }
    const { cycleFocusedColour } = await import('./paint-palette.js')

    harness.selectedColour = 2
    expect(cycleFocusedColour(1)).toBe(true)
    expect(harness.selectPaintColour).toHaveBeenLastCalledWith(5)

    harness.selectedColour = 5
    expect(cycleFocusedColour(1)).toBe(true)
    expect(harness.selectPaintColour).toHaveBeenLastCalledWith(0)

    harness.selectedColour = 0
    expect(cycleFocusedColour(-1)).toBe(true)
    expect(harness.selectPaintColour).toHaveBeenLastCalledWith(5)
  })

  it('refreshes alliance palette progress when Wplace writes a transparent-draft crosshair', async () => {
    const stage = document.createElement('div')
    const frame = document.createElement('div')
    const crosshairLayer = document.createElement('div')
    crosshairLayer.className = 'paint-crosshair-layer'
    const canvas = document.createElement('canvas')
    canvas.className = 'paint-crosshair-tile'
    crosshairLayer.append(canvas)
    stage.append(frame, crosshairLayer)
    harness.focused = {
      id: 'alliance-progress',
      surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
      originX: 0,
      originY: 0,
      width: 1,
      height: 1,
      indices: new Uint8Array([0]),
    }
    harness.activeAlliance = {
      surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
      bounds: { minX: -125, minY: -125, maxX: 125, maxY: 125 },
      stage,
      frame,
    }
    harness.artboardPixels = {
      committed: [
        { x: 0, y: 0, width: 1, height: 1, pixels: new Uint8Array([63]), emptyIndex: 63 },
      ],
      draft: [],
    }
    const swatch = document.createElement('button')
    swatch.setAttribute('aria-label', 'Black')
    swatch.setAttribute('aria-pressed', 'true')
    document.body.appendChild(swatch)
    const { installPaintPaletteProgress } = await import('./paint-palette.js')
    installPaintPaletteProgress()
    harness.paintListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(swatch.querySelector('caelestis-palette-progress')).not.toBeNull()

    harness.artboardPixels = {
      committed: [{ x: 0, y: 0, width: 1, height: 1, pixels: new Uint8Array([0]), emptyIndex: 63 }],
      draft: [],
    }
    harness.canvasWriteListeners.at(-1)?.(canvas)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(swatch.querySelector('caelestis-palette-progress')).toBeNull()
  })

  it('keeps an accepted draft correction until stale server status catches up', async () => {
    harness.focused = {
      id: 'remote-pending-draft',
      serverUrl: server.url,
      serverTemplateId: 'remote',
      opaque: 10,
    }
    harness.serverProgress = [
      { index: 0, completed: 2, mismatched: 1, unpainted: 7, known: 10, total: 10 },
    ]
    const swatch = document.createElement('button')
    swatch.id = 'color-1'
    document.body.appendChild(swatch)
    const { installPaintPaletteProgress } = await import('./paint-palette.js')
    installPaintPaletteProgress()
    harness.statusListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    const badge = (): string | undefined =>
      swatch.querySelector<HTMLElement & { model?: { value: string } }>(
        'caelestis-palette-progress',
      )?.model?.value
    expect(badge()).toBe('8')

    harness.draftPixelDeltas = [
      { key: '0/0/0', basis: 'tile-1', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
    ]
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('7')

    // Undo/cancel has no accepted-paint event and therefore returns to the server baseline.
    harness.draftPixelDeltas = []
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('8')

    harness.draftPixelDeltas = [
      { key: '0/0/0', basis: 'tile-1', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
    ]
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('7')

    harness.acceptedPaintListeners.at(-1)?.({ painted: 1, tiles: [{ pixels: { x: [0] } }] })
    harness.draftPixelDeltas = []
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('7')

    // A second disjoint batch composes with the still-pending accepted paint.
    harness.draftPixelDeltas = [
      { key: '0/0/1', basis: 'tile-1', index: 0, completed: 1, mismatched: 0, unpainted: -1 },
    ]
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('6')

    // Newer same-colour server progress remains authoritative instead of being replaced by the
    // older local snapshot. It retires the accepted contribution while keeping the active one.
    harness.serverProgress = [
      { index: 0, completed: 5, mismatched: 0, unpainted: 5, known: 10, total: 10 },
    ]
    harness.statusListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('4')
  })

  it('lets an overlapping accepted repaint cancel a pending correction', async () => {
    harness.focused = {
      id: 'remote-overlapping-draft',
      serverUrl: server.url,
      serverTemplateId: 'remote',
      opaque: 10,
    }
    harness.serverProgress = [
      { index: 0, completed: 2, mismatched: 1, unpainted: 7, known: 10, total: 10 },
    ]
    const swatch = document.createElement('button')
    swatch.id = 'color-1'
    document.body.appendChild(swatch)
    const { installPaintPaletteProgress } = await import('./paint-palette.js')
    installPaintPaletteProgress()
    harness.statusListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    const badge = (): string | undefined =>
      swatch.querySelector<HTMLElement & { model?: { value: string } }>(
        'caelestis-palette-progress',
      )?.model?.value
    harness.draftPixelDeltas = [
      { key: '0/0/0', basis: 'tile-1', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
    ]
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('7')

    harness.acceptedPaintListeners.at(-1)?.({ painted: 1, tiles: [{ pixels: { x: [0] } }] })
    harness.draftPixelDeltas = []
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('7')

    // The same coordinate is drafted back to its retained server category. Its explicit zero delta
    // replaces, then cancels, the pending correction instead of being mistaken for no active draft.
    harness.draftPixelDeltas = [
      { key: '0/0/0', basis: 'tile-1', index: 0, completed: 0, mismatched: 0, unpainted: 0 },
    ]
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('8')

    // Status now includes the first accepted correction. The active inverse repaint remains a
    // one-pixel decrement relative to that newer baseline.
    harness.serverProgress = [
      { index: 0, completed: 3, mismatched: 0, unpainted: 7, known: 10, total: 10 },
    ]
    harness.statusListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('8')

    harness.acceptedPaintListeners.at(-1)?.({ painted: 1, tiles: [{ pixels: { x: [0] } }] })
    harness.draftPixelDeltas = []
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('8')
  })

  it('retains the submitted correction when Wplace clears the draft before acceptance arrives', async () => {
    harness.focused = {
      id: 'remote-delayed-acceptance',
      serverUrl: server.url,
      serverTemplateId: 'remote',
      serverVersion: 'version-1',
      opaque: 10,
    }
    harness.serverProgress = [
      { index: 0, completed: 2, mismatched: 1, unpainted: 7, known: 10, total: 10 },
    ]
    const { installPaintPaletteProgress, paintPaletteProgress } = await import('./paint-palette.js')
    installPaintPaletteProgress()
    harness.draftPixelDeltas = [
      { key: '0/0/0', basis: 'tile-1', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
    ]
    harness.draftListeners.at(-1)?.()
    const submission = { identity: {} }
    harness.paintSubmissionListeners.at(-1)?.(submission)

    harness.draftPixelDeltas = []
    harness.draftListeners.at(-1)?.()
    harness.acceptedPaintListeners.at(-1)?.({
      submission,
      painted: 1,
      tiles: [{ pixels: { x: [0] } }],
    })

    expect(paintPaletteProgress()).toEqual([
      { index: 0, completed: 3, mismatched: 0, unpainted: 7, known: 10, total: 10 },
    ])
  })

  it('drops pending corrections when the same placed template receives a new version', async () => {
    harness.focused = {
      id: 'remote-same-id-replacement',
      serverUrl: server.url,
      serverTemplateId: 'remote',
      serverVersion: 'version-1',
      opaque: 10,
    }
    harness.serverProgress = [
      { index: 0, completed: 2, mismatched: 1, unpainted: 7, known: 10, total: 10 },
    ]
    const { installPaintPaletteProgress, paintPaletteProgress } = await import('./paint-palette.js')
    installPaintPaletteProgress()
    harness.draftPixelDeltas = [
      { key: '0/0/0', basis: 'tile-1', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
    ]
    harness.draftListeners.at(-1)?.()
    const submission = { identity: {} }
    harness.paintSubmissionListeners.at(-1)?.(submission)
    harness.acceptedPaintListeners.at(-1)?.({
      submission,
      painted: 1,
      tiles: [{ pixels: { x: [0] } }],
    })
    harness.draftPixelDeltas = []
    expect(paintPaletteProgress()[0]?.completed).toBe(3)

    harness.focused = { ...harness.focused, serverVersion: 'version-2' }

    expect(paintPaletteProgress()).toEqual(harness.serverProgress)
  })

  it('keeps a cleared accepted correction rebased until its source tile refreshes', async () => {
    harness.focused = {
      id: 'remote-cleared-draft',
      serverUrl: server.url,
      serverTemplateId: 'remote',
      opaque: 10,
    }
    harness.serverProgress = [
      { index: 0, completed: 2, mismatched: 1, unpainted: 7, known: 10, total: 10 },
    ]
    const swatch = document.createElement('button')
    swatch.id = 'color-1'
    document.body.appendChild(swatch)
    const { installPaintPaletteProgress } = await import('./paint-palette.js')
    installPaintPaletteProgress()
    harness.statusListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    const badge = (): string | undefined =>
      swatch.querySelector<HTMLElement & { model?: { value: string } }>(
        'caelestis-palette-progress',
      )?.model?.value
    harness.draftPixelDeltas = [
      { key: '0/0/0', basis: 'tile-1', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
    ]
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    harness.acceptedPaintListeners.at(-1)?.({ painted: 1, tiles: [{ pixels: { x: [0] } }] })
    harness.draftPixelDeltas = []
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('7')

    harness.serverProgress = [
      { index: 0, completed: 3, mismatched: 0, unpainted: 7, known: 10, total: 10 },
    ]
    harness.statusListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('7')

    // Wplace still compares the later repaint with its stale captured tile. The retained correction
    // makes the zero raw delta an inverse paint against the newer status baseline.
    harness.draftPixelDeltas = [
      { key: '0/0/0', basis: 'tile-1', index: 0, completed: 0, mismatched: 0, unpainted: 0 },
    ]
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('8')

    // Once the captured tile refreshes, its raw delta already includes the inverse paint. A changed
    // basis retires the retained correction instead of subtracting it twice.
    harness.draftPixelDeltas = [
      { key: '0/0/0', basis: 'tile-2', index: 0, completed: -1, mismatched: 1, unpainted: 0 },
    ]
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('8')
  })

  it('forgets cleared coordinate rebases when their source tile refreshes', async () => {
    harness.focused = {
      id: 'remote-refreshed-source',
      serverUrl: server.url,
      serverTemplateId: 'remote',
      opaque: 10,
    }
    harness.serverProgress = [
      { index: 0, completed: 2, mismatched: 1, unpainted: 7, known: 10, total: 10 },
    ]
    const { installPaintPaletteProgress, paintPaletteProgress } = await import('./paint-palette.js')
    installPaintPaletteProgress()
    harness.draftPixelDeltas = [
      { key: '3/4/0', basis: 'tile-1', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
    ]
    harness.draftListeners.at(-1)?.()
    harness.acceptedPaintListeners.at(-1)?.({ painted: 1, tiles: [{ pixels: { x: [0] } }] })
    harness.draftPixelDeltas = []
    harness.draftListeners.at(-1)?.()
    harness.serverProgress = [
      { index: 0, completed: 3, mismatched: 0, unpainted: 7, known: 10, total: 10 },
    ]
    harness.statusListeners.at(-1)?.()
    paintPaletteProgress()

    harness.tilePixelListeners.at(-1)?.({ x: 3, y: 4 }, [0, 0, 0], 'server')
    harness.draftPixelDeltas = [
      { key: '3/4/0', basis: 'tile-1', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
    ]

    expect(paintPaletteProgress()[0]).toMatchObject({ completed: 4, mismatched: 0 })
  })

  it('forgets cleared coordinate rebases when their source tile is evicted', async () => {
    harness.focused = {
      id: 'remote-evicted-source',
      serverUrl: server.url,
      serverTemplateId: 'remote',
      opaque: 10,
    }
    harness.serverProgress = [
      { index: 0, completed: 2, mismatched: 1, unpainted: 7, known: 10, total: 10 },
    ]
    const { installPaintPaletteProgress, paintPaletteProgress } = await import('./paint-palette.js')
    installPaintPaletteProgress()
    harness.draftPixelDeltas = [
      { key: '3/4/0', basis: 'tile-1', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
    ]
    harness.acceptedPaintListeners.at(-1)?.({ painted: 1, tiles: [{ pixels: { x: [0] } }] })
    harness.draftPixelDeltas = []
    harness.serverProgress = [
      { index: 0, completed: 3, mismatched: 0, unpainted: 7, known: 10, total: 10 },
    ]
    paintPaletteProgress()

    harness.tilePixelEvictionListeners.at(-1)?.({ x: 3, y: 4 })
    harness.draftPixelDeltas = [
      { key: '3/4/0', basis: 'tile-1', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
    ]

    expect(paintPaletteProgress()[0]).toMatchObject({ completed: 4, mismatched: 0 })
  })

  it('drops a cleared rebase when a template version changes the desired colour', async () => {
    harness.focused = {
      id: 'remote-replaced-version',
      serverUrl: server.url,
      serverTemplateId: 'remote',
      opaque: 10,
    }
    harness.serverProgress = [
      { index: 0, completed: 2, mismatched: 1, unpainted: 0, known: 3, total: 3 },
      { index: 1, completed: 5, mismatched: 0, unpainted: 2, known: 7, total: 7 },
    ]
    const { installPaintPaletteProgress, paintPaletteProgress } = await import('./paint-palette.js')
    installPaintPaletteProgress()
    harness.draftPixelDeltas = [
      { key: '0/0/0', basis: 'tile-1', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
    ]
    harness.draftListeners.at(-1)?.()
    harness.acceptedPaintListeners.at(-1)?.({ painted: 1, tiles: [{ pixels: { x: [0] } }] })
    harness.draftPixelDeltas = []
    harness.draftListeners.at(-1)?.()

    harness.serverProgress = [
      { index: 0, completed: 3, mismatched: 0, unpainted: 0, known: 3, total: 3 },
      { index: 1, completed: 5, mismatched: 0, unpainted: 2, known: 7, total: 7 },
    ]
    harness.statusListeners.at(-1)?.()

    // The replacement keeps the placed template ID and captured tile basis, but wants colour 1 at
    // this coordinate. Its draft must not inherit colour 0's retained category transfer.
    harness.draftPixelDeltas = [
      { key: '0/0/0', basis: 'tile-1', index: 1, completed: 1, mismatched: 0, unpainted: -1 },
    ]
    harness.draftListeners.at(-1)?.()
    expect(paintPaletteProgress()).toEqual([
      { index: 0, completed: 3, mismatched: 0, unpainted: 0, known: 3, total: 3 },
      { index: 1, completed: 6, mismatched: 0, unpainted: 1, known: 7, total: 7 },
    ])
  })

  it('cycles repeated F navigation past its previous focused-template target', async () => {
    const { navigateFocusedSelectedColour } = await import('./paint-palette.js')

    await expect(navigateFocusedSelectedColour()).resolves.toBe(true)
    const first = harness.navigationTargets.unpainted
    await expect(navigateFocusedSelectedColour()).resolves.toBe(true)

    expect(harness.nearestColourTarget).toHaveBeenLastCalledWith(
      0,
      'unpainted',
      expect.any(Object),
      'local',
      first,
    )
  })

  it('routes alliance colour navigation through the active artboard', async () => {
    const { navigateFocusedSelectedColour } = await import('./paint-palette.js')
    const stage = document.createElement('div')
    const frame = document.createElement('div')
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 250, bottom: 250, width: 250, height: 250 }) as DOMRect
    frame.getBoundingClientRect = stage.getBoundingClientRect
    harness.focused = {
      id: 'alliance',
      surface: { kind: 'alliance-headquarters', allianceId: 535245 },
      originX: -1,
      originY: -1,
      width: 1,
      height: 1,
      indices: new Uint8Array([0]),
    }
    harness.activeAlliance = {
      surface: { kind: 'alliance-headquarters', allianceId: 535245 },
      bounds: { minX: -125, minY: -125, maxX: 125, maxY: 125 },
      stage,
      frame,
    }
    harness.artboardPixels = {
      committed: [
        { x: -1, y: -1, width: 1, height: 1, pixels: new Uint8Array([63]), emptyIndex: 63 },
      ],
      draft: [],
    }

    await expect(navigateFocusedSelectedColour()).resolves.toBe(true)
    expect(harness.nearestColourTarget).not.toHaveBeenCalled()
    expect(harness.navigateTo).not.toHaveBeenCalled()
    expect(harness.navigateAlliance).toHaveBeenCalledWith(harness.activeAlliance, {
      x: -0.5,
      y: -0.5,
    })
  })
})
