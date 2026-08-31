// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  localProgress: [{ index: 0, completed: 1, mismatched: 0, unpainted: 1, known: 2, total: 2 }],
  serverProgress: [{ index: 0, completed: 2, mismatched: 1, unpainted: 0, known: 3, total: 3 }],
  stateListeners: [] as Array<() => void>,
  localListeners: [] as Array<() => void>,
  mismatchListeners: [] as Array<() => void>,
  statusListeners: [] as Array<() => void>,
  paintListeners: [] as Array<() => void>,
  focused: null as {
    id: string
    serverUrl?: string
    serverTemplateId?: string
    opaque?: number
    surface?:
      | { kind: 'world' }
      | { kind: 'alliance-headquarters'; allianceId: number }
      | { kind: 'alliance-picture'; allianceId: number }
      | { kind: 'alliance-banner'; allianceId: number }
  } | null,
  colourNavigationOrder: 'unpainted-first' as 'unpainted-first' | 'mismatched-first',
  paintOpen: true,
  selectedColour: 0 as number | null,
  draftedColours: new Set<number>(),
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
      draftedColours: harness.draftedColours,
      nearest: (
        index: number,
        kind: 'unpainted' | 'mismatched',
        reference: { x: number; y: number },
        exclude?: { templateId: string; x: number; y: number; kind: string },
      ) => harness.nearestColourTarget(index, kind, reference, template.id, exclude),
    }),
    onChange: (listener: () => void) => harness.mismatchListeners.push(listener),
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
  harness.draftedColours = new Set()
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

    harness.draftedColours = new Set([0])
    harness.localProgress = [
      { index: 0, completed: 3, mismatched: 0, unpainted: 0, known: 3, total: 3 },
    ]
    harness.mismatchListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(swatch.querySelector('caelestis-palette-progress')).toBeNull()

    // The response baseline may catch up before Wplace clears its native draft. Selecting the
    // effective local result rather than adding it keeps that paint from counting twice.
    harness.serverProgress = [
      { index: 0, completed: 3, mismatched: 0, unpainted: 0, known: 3, total: 3 },
    ]
    harness.statusListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(swatch.querySelector('caelestis-palette-progress')).toBeNull()

    harness.draftedColours = new Set()
    harness.localProgress = [
      { index: 0, completed: 2, mismatched: 1, unpainted: 0, known: 3, total: 3 },
    ]
    harness.mismatchListeners.at(-1)?.()
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

  it('does not route alliance colour navigation through the world map', async () => {
    const { navigateFocusedSelectedColour } = await import('./paint-palette.js')
    harness.focused = {
      id: 'alliance',
      surface: { kind: 'alliance-headquarters', allianceId: 535245 },
    }

    await expect(navigateFocusedSelectedColour()).resolves.toBe(false)
    expect(harness.nearestColourTarget).not.toHaveBeenCalled()
    expect(harness.navigateTo).not.toHaveBeenCalled()
  })
})
