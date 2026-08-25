// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  localProgress: [{ index: 0, completed: 1, mismatched: 0, unpainted: 1, known: 2, total: 2 }],
  serverProgress: [{ index: 0, completed: 2, mismatched: 1, unpainted: 0, known: 3, total: 3 }],
  stateListeners: [] as Array<() => void>,
  localListeners: [] as Array<() => void>,
  mismatchListeners: [] as Array<() => void>,
  statusListeners: [] as Array<() => void>,
  navigateTo: vi.fn(),
  nearestColourTarget: vi.fn(async (_index: number, kind: 'unpainted' | 'mismatched') => ({
    templateId: 'local',
    x: kind === 'unpainted' ? 12 : 34,
    y: kind === 'unpainted' ? 56 : 78,
    kind,
  })),
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
}
vi.mock('./debug.js', () => ({ count: vi.fn(), warn: vi.fn() }))
vi.mock('./map-handle.js', () => ({
  getMap: () => ({ getCenter: () => ({ lat: 0, lng: 0 }) }),
}))
vi.mock('./state.js', () => ({
  getState: () => ({ servers: [server] }),
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
  colourProgressFor: () => harness.localProgress,
  nearestColourTarget: harness.nearestColourTarget,
  onMismatchesChanged: (listener: () => void) => harness.mismatchListeners.push(listener),
}))
vi.mock('./templates/navigate.js', () => ({ navigateTo: harness.navigateTo }))
vi.mock('./wplace-paint.js', () => ({ onPaintSelectionChange: vi.fn() }))

beforeEach(() => {
  document.body.replaceChildren()
  vi.clearAllMocks()
  harness.localProgress = [
    { index: 0, completed: 1, mismatched: 0, unpainted: 1, known: 2, total: 2 },
  ]
  harness.serverProgress = [
    { index: 0, completed: 2, mismatched: 1, unpainted: 0, known: 3, total: 3 },
  ]
})

describe('Wplace paint palette progress', () => {
  it('renders an aggregate counter and middle-clicks blank work before mismatches', async () => {
    const swatch = document.createElement('button')
    swatch.id = 'color-1'
    swatch.setAttribute('aria-label', 'Black')
    document.body.appendChild(swatch)
    const { installPaintPaletteProgress, paintPaletteProgress } = await import('./paint-palette.js')

    installPaintPaletteProgress()

    expect(paintPaletteProgress()).toEqual([
      { index: 0, completed: 3, mismatched: 1, unpainted: 1, known: 5, total: 5 },
    ])
    expect(swatch.querySelector('.caelestis-palette-progress')?.textContent).toBe('60%')
    expect(swatch.getAttribute('aria-label')).toContain('60% complete')

    swatch.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(harness.nearestColourTarget).toHaveBeenLastCalledWith(0, 'unpainted', expect.any(Object))
    expect(harness.navigateTo).toHaveBeenLastCalledWith({
      x: 12.5,
      y: 56.5,
      width: 1,
      height: 1,
    })

    harness.localProgress = [
      { index: 0, completed: 2, mismatched: 0, unpainted: 0, known: 2, total: 2 },
    ]
    harness.statusListeners.at(-1)?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(swatch.querySelector('.caelestis-palette-progress')?.textContent).toBe('80%')
    swatch.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(harness.nearestColourTarget).toHaveBeenLastCalledWith(
      0,
      'mismatched',
      expect.any(Object),
    )
    expect(harness.navigateTo).toHaveBeenLastCalledWith({
      x: 34.5,
      y: 78.5,
      width: 1,
      height: 1,
    })
  })
})
