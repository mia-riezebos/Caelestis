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
  acceptedPaintListeners: [] as Array<
    (paint: { painted: number; tiles: Array<{ pixels: { x: number[] } }> }) => void
  >,
  focused: null as {
    id: string
    serverUrl?: string
    serverTemplateId?: string
    opaque?: number
  } | null,
  colourNavigationOrder: 'unpainted-first' as 'unpainted-first' | 'mismatched-first',
  paintOpen: true,
  selectedColour: 0 as number | null,
  draftPixelDeltas: [] as Array<{
    key: string
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
vi.mock('./map-handle.js', () => ({
  getMap: () => ({ getCenter: () => ({ lat: 0, lng: 0 }) }),
}))
vi.mock('./state.js', () => ({
  getState: () => ({
    servers: [server],
    colourNavigationOrder: harness.colourNavigationOrder,
  }),
  onStateChange: (listener: () => void) => harness.stateListeners.push(listener),
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
    listener: (paint: { painted: number; tiles: Array<{ pixels: { x: number[] } }> }) => void,
  ) => {
    harness.acceptedPaintListeners.push(listener)
    return vi.fn()
  },
}))
vi.mock('./templates/navigate.js', () => ({ navigateTo: harness.navigateTo }))
vi.mock('./templates/nearest.js', () => ({ focusedTemplate: () => harness.focused }))
vi.mock('./wplace-paint.js', () => ({
  isPaintOpen: () => harness.paintOpen,
  onPaintSelectionChange: (listener: () => void) => harness.paintListeners.push(listener),
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
  harness.draftPixelDeltas = []
  harness.navigationTargets.unpainted = {
    templateId: 'local',
    x: 12,
    y: 56,
    kind: 'unpainted',
  }
  harness.navigationTargets.mismatched = null
})

describe('Wplace paint palette progress', () => {
  it('shows pixels left for only the focused template and hides a completed colour', async () => {
    harness.localProgress = [
      { index: 0, completed: 0, mismatched: 0, unpainted: 0, known: 0, total: 112 },
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
    ).toBe('…')
    expect(swatch.getAttribute('aria-label')).toContain('Checking progress')
    expect(swatch.getAttribute('aria-label')).not.toContain('112 pixels left')

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
      { key: '0/0/0', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
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
      { key: '0/0/0', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
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
      { key: '0/0/0', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
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
      { key: '0/0/1', index: 0, completed: 1, mismatched: 0, unpainted: -1 },
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
      { key: '0/0/0', index: 0, completed: 1, mismatched: -1, unpainted: 0 },
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
      { key: '0/0/0', index: 0, completed: 0, mismatched: 0, unpainted: 0 },
    ]
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('8')

    harness.acceptedPaintListeners.at(-1)?.({ painted: 1, tiles: [{ pixels: { x: [0] } }] })
    harness.draftPixelDeltas = []
    harness.draftListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(badge()).toBe('8')
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
})
