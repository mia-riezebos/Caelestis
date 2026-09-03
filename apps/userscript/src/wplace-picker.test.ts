// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  activeAlliance: null as null | {
    surface: { kind: 'alliance-headquarters'; allianceId: number }
    stage: HTMLElement
    frame: HTMLElement
    draftId: null
    bounds: { minX: number; minY: number; maxX: number; maxY: number }
  },
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
    surface: { kind: 'world', allianceId: null } as
      | { kind: 'world'; allianceId: null }
      | { kind: 'alliance-headquarters'; allianceId: number },
  },
  basePixels: new Uint8Array(1_000_000).fill(7),
  selectPaintColour: vi.fn(() => true),
}))

vi.mock('./alliance-surface.js', () => ({ activeAllianceSurface: () => harness.activeAlliance }))
vi.mock('./debug.js', () => ({ log: vi.fn() }))
vi.mock('./main.js', () => ({ canvasPixelAt: harness.canvasPixelAt }))
vi.mock('./templates/colour-filter.js', () => ({ claimedHiddenFor: () => [] }))
vi.mock('./templates/local-store.js', () => ({
  appearanceOf: () => harness.appearance,
  displayTemplatesForSurface: () => [harness.template],
  isTemplateVisible: () => true,
}))
vi.mock('./templates/placement.js', () => ({
  sourceXAt: (template: { originX: number }, x: number) => x - template.originX,
}))
vi.mock('./tile-transform.js', () => ({
  ensureTilePixels: vi.fn(),
  tilePixels: () => harness.basePixels,
}))
vi.mock('./wplace-paint.js', () => ({
  isPaintOpen: () => true,
  selectPaintColour: harness.selectPaintColour,
}))

afterEach(() => {
  harness.activeAlliance = null
  harness.template.surface = { kind: 'world', allianceId: null }
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  harness.selectPaintColour.mockClear()
  vi.resetModules()
})

const pickerDom = (
  target: HTMLElement,
): { pickerButton: HTMLButtonElement; eraserButton: HTMLButtonElement } => {
  const picker = document.createElement('div')
  picker.className = 'tooltip'
  const pickerLabel = document.createElement('div')
  pickerLabel.className = 'tooltip-content'
  pickerLabel.textContent = 'Color Picker'
  const pickerButton = document.createElement('button')
  pickerButton.className = 'btn-primary'
  pickerButton.setAttribute('aria-label', 'Color Picker')
  pickerButton.setAttribute('aria-pressed', 'true')
  const eraserButton = document.createElement('button')
  eraserButton.setAttribute('aria-label', 'Eraser')
  eraserButton.setAttribute('aria-pressed', 'false')
  eraserButton.addEventListener('click', () => {
    const active = eraserButton.getAttribute('aria-pressed') !== 'true'
    eraserButton.setAttribute('aria-pressed', String(active))
    if (active) {
      pickerButton.classList.remove('btn-primary')
      pickerButton.setAttribute('aria-pressed', 'false')
    }
  })
  picker.append(pickerLabel, pickerButton, eraserButton)

  document.body.append(target, picker)
  return { pickerButton, eraserButton }
}

it('picks the overlay source cell from the transparent gutter around a 60% stamp', async () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn())

  const map = document.createElement('canvas')
  map.className = 'maplibregl-canvas'
  pickerDom(map)

  const { installColourPicker } = await import('./wplace-picker.js')
  installColourPicker()
  map.dispatchEvent(
    new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    }),
  )

  expect(harness.selectPaintColour).toHaveBeenCalledWith(12)
})

it('picks the visible overlay source cell inside an alliance artboard', async () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn())
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  const art = document.createElement('canvas')
  frame.append(art)
  stage.append(frame)
  frame.getBoundingClientRect = () =>
    ({ left: 100, top: 200, right: 350, bottom: 450, width: 250, height: 250 }) as DOMRect
  harness.activeAlliance = {
    surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
    stage,
    frame,
    draftId: null,
    bounds: { minX: -125, minY: -125, maxX: 125, maxY: 125 },
  }
  harness.template.surface = harness.activeAlliance.surface
  harness.template.originX = -125
  harness.template.originY = -125
  pickerDom(stage)

  const { installColourPicker } = await import('./wplace-picker.js')
  installColourPicker()
  art.dispatchEvent(
    new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 100.5,
      clientY: 200.5,
    }),
  )

  expect(harness.selectPaintColour).toHaveBeenCalledWith(12)
})

it("swallows Wplace's matching click after an alliance source pick", async () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn())
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  const art = document.createElement('canvas')
  frame.append(art)
  stage.append(frame)
  frame.getBoundingClientRect = () =>
    ({ left: 100, top: 200, right: 350, bottom: 450, width: 250, height: 250 }) as DOMRect
  harness.activeAlliance = {
    surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
    stage,
    frame,
    draftId: null,
    bounds: { minX: -125, minY: -125, maxX: 125, maxY: 125 },
  }
  harness.template.surface = harness.activeAlliance.surface
  harness.template.originX = -125
  harness.template.originY = -125
  pickerDom(stage)
  const nativePick = vi.fn()
  art.addEventListener('click', nativePick)

  const { installColourPicker } = await import('./wplace-picker.js')
  installColourPicker()
  art.dispatchEvent(
    new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 100.5,
      clientY: 200.5,
    }),
  )
  art.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 100.5,
      clientY: 200.5,
    }),
  )

  expect(harness.selectPaintColour).toHaveBeenCalledWith(12)
  expect(nativePick).not.toHaveBeenCalled()
})

it('does not swallow a click after the intercepted pointer is cancelled', async () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn())
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  const art = document.createElement('canvas')
  frame.append(art)
  stage.append(frame)
  frame.getBoundingClientRect = () =>
    ({ left: 100, top: 200, right: 350, bottom: 450, width: 250, height: 250 }) as DOMRect
  harness.activeAlliance = {
    surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
    stage,
    frame,
    draftId: null,
    bounds: { minX: -125, minY: -125, maxX: 125, maxY: 125 },
  }
  harness.template.surface = harness.activeAlliance.surface
  harness.template.originX = -125
  harness.template.originY = -125
  pickerDom(stage)
  const nativePick = vi.fn()
  art.addEventListener('click', nativePick)

  const { installColourPicker } = await import('./wplace-picker.js')
  installColourPicker()
  art.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 7,
      clientX: 100.5,
      clientY: 200.5,
    }),
  )
  art.dispatchEvent(
    new PointerEvent('pointercancel', { bubbles: true, cancelable: true, pointerId: 7 }),
  )
  art.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 100.5,
      clientY: 200.5,
    }),
  )

  expect(nativePick).toHaveBeenCalledOnce()
})

it('returns an alliance source pick to the neutral brush tool', async () => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    }),
  )
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  const art = document.createElement('canvas')
  frame.append(art)
  stage.append(frame)
  frame.getBoundingClientRect = () =>
    ({ left: 100, top: 200, right: 350, bottom: 450, width: 250, height: 250 }) as DOMRect
  harness.activeAlliance = {
    surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
    stage,
    frame,
    draftId: null,
    bounds: { minX: -125, minY: -125, maxX: 125, maxY: 125 },
  }
  harness.template.surface = harness.activeAlliance.surface
  harness.template.originX = -125
  harness.template.originY = -125
  const { pickerButton, eraserButton } = pickerDom(stage)

  const { installColourPicker } = await import('./wplace-picker.js')
  installColourPicker()
  art.dispatchEvent(
    new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 100.5,
      clientY: 200.5,
    }),
  )

  expect(pickerButton.getAttribute('aria-pressed')).toBe('false')
  expect(eraserButton.getAttribute('aria-pressed')).toBe('false')
})
