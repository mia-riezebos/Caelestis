// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  canvasPixelAt: vi.fn(() => ({ x: 0.05, y: 0.5 })),
  appearance: {
    size: 0.6,
    radius: 0,
    translateX: 0,
    translateY: 0,
    rotation: 0,
    opacity: 0.85,
    hiddenColours: [],
    markMismatch: true,
    markUnpainted: false,
    unpaintedLimit: 0.05,
    markerColour: '#ff00ff',
    markerSize: 9,
    markSelectedColour: false,
    selectedMarkerColour: '#00e5ff',
    selectedMarkerSize: 9,
    dimOthers: true,
    otherOpacity: 0.35,
    otherColour: null,
  },
  template: {
    id: 'template',
    originX: 0,
    originY: 0,
    width: 1,
    height: 1,
    indices: new Uint8Array([12]),
  },
  basePixels: new Uint8Array(1_000_000).fill(7),
}))

vi.mock('./debug.js', () => ({ log: vi.fn() }))
vi.mock('./main.js', () => ({ canvasPixelAt: harness.canvasPixelAt }))
vi.mock('./templates/colour-filter.js', () => ({ claimedHiddenFor: () => [] }))
vi.mock('./templates/local-store.js', () => ({
  appearanceOf: () => harness.appearance,
  displayTemplates: () => [harness.template],
  isTemplateVisible: () => true,
}))
vi.mock('./templates/placement.js', () => ({ sourceXAt: (_template: unknown, x: number) => x }))
vi.mock('./tile-transform.js', () => ({
  ensureTilePixels: vi.fn(),
  tilePixels: () => harness.basePixels,
}))
vi.mock('./wplace-paint.js', () => ({ isPaintOpen: () => true }))

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

it('picks the overlay source cell from the transparent gutter around a 60% stamp', async () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn())

  const map = document.createElement('canvas')
  map.className = 'maplibregl-canvas'

  const picker = document.createElement('div')
  picker.className = 'tooltip'
  const pickerLabel = document.createElement('div')
  pickerLabel.className = 'tooltip-content'
  pickerLabel.textContent = 'Color Picker'
  const pickerButton = document.createElement('button')
  pickerButton.className = 'btn-primary'
  picker.append(pickerLabel, pickerButton)

  const overlaySwatch = document.createElement('button')
  overlaySwatch.id = 'color-13'
  const baseSwatch = document.createElement('button')
  baseSwatch.id = 'color-8'
  const overlayClicked = vi.spyOn(overlaySwatch, 'click')
  const baseClicked = vi.spyOn(baseSwatch, 'click')
  document.body.append(map, picker, overlaySwatch, baseSwatch)

  const { installColourPicker } = await import('./wplace-picker.js')
  installColourPicker()
  map.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: 10, clientY: 10 }))

  expect([overlayClicked.mock.calls.length, baseClicked.mock.calls.length]).toEqual([1, 0])
})
