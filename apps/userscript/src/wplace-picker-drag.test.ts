// @vitest-environment happy-dom
import { TRANSPARENT_INDEX, WORLD_PIXELS } from '@caelestis/shared'
import { afterEach, beforeEach, expect, it, type MockInstance, vi } from 'vitest'
import type { ActiveAllianceSurface } from './alliance-surface.js'

interface SourceTemplate {
  originX: number
  originY: number
  width: number
  height: number
  indices: Uint8Array
  wrapX?: boolean
  visible: boolean
  hiddenColours: number[]
}

const harness = vi.hoisted(() => ({
  alliance: null as ActiveAllianceSurface | null,
  templates: [] as SourceTemplate[],
  paintOpen: true,
  moving: false,
  onlySelected: false,
  selected: 12,
  select: vi.fn((index: number) => {
    if (index === 60) return false
    harness.selected = index
    return true
  }),
}))

vi.mock('./alliance-surface.js', () => ({ activeAllianceSurface: () => harness.alliance }))
vi.mock('./debug.js', () => ({ log: vi.fn() }))
vi.mock('./main.js', () => ({ canvasPixelAt: (x: number, y: number) => ({ x, y }) }))
vi.mock('./state.js', () => ({
  getState: () => ({ hiddenColours: [] }),
  onlySelectedColourFor: () => harness.onlySelected,
}))
vi.mock('./templates/local-store.js', () => ({
  appearanceOf: (template: SourceTemplate) => template,
  displayTemplatesForSurface: () => harness.templates,
  isTemplateVisible: (template: SourceTemplate) => template.visible,
}))
vi.mock('./templates/move.js', () => ({ isMoving: () => harness.moving }))
vi.mock('./tile-transform.js', () => ({ ensureTilePixels: vi.fn() }))
vi.mock('./world-native-pixels.js', () => ({ worldNativePixels: vi.fn() }))
vi.mock('./gl/artboard-pixels.js', () => ({ readArtboardPixels: vi.fn() }))
vi.mock('./wplace-paint.js', () => ({
  isPaintOpen: () => harness.paintOpen,
  selectedColour: () => harness.selected,
  selectPaintColour: harness.select,
}))

const source = (indices = [12, 23, 23, TRANSPARENT_INDEX, 60, 7]): SourceTemplate => ({
  originX: 0,
  originY: 0,
  width: indices.length,
  height: 1,
  indices: new Uint8Array(indices),
  visible: true,
  hiddenColours: [],
})

let map: HTMLCanvasElement
let hit: Element | null
let capture: number | null
let listeners: MockInstance<typeof window.addEventListener>

beforeEach(async () => {
  harness.alliance = null
  harness.templates = [source()]
  harness.paintOpen = true
  harness.moving = false
  harness.onlySelected = false
  harness.selected = 12
  harness.select.mockClear()
  map = document.createElement('canvas')
  map.className = 'maplibregl-canvas'
  document.body.append(map)
  hit = map
  capture = null
  map.setPointerCapture = vi.fn((id) => {
    capture = id
  })
  map.hasPointerCapture = (id) => capture === id
  map.releasePointerCapture = vi.fn(() => {
    capture = null
  })
  vi.spyOn(document, 'elementFromPoint').mockImplementation(() => hit)
  listeners = vi.spyOn(window, 'addEventListener')
  const { installColourPicker } = await import('./wplace-picker.js')
  installColourPicker()
})

afterEach(() => {
  window.dispatchEvent(new Event('blur'))
  for (const [type, listener, options] of listeners.mock.calls) {
    window.removeEventListener(type, listener, options)
  }
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const pointer = (type: string, x = 0, options: PointerEventInit = {}, target: Element = map) => {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 7,
    button: 1,
    buttons: 4,
    clientX: x + 0.1,
    clientY: 0.5,
    ...options,
  })
  target.dispatchEvent(event)
  return event
}

it('selects immediately, changes colour while held, and skips repeated logical colours', () => {
  expect(pointer('pointerdown').defaultPrevented).toBe(true)
  expect(harness.select.mock.calls).toEqual([[12]])
  expect(capture).toBe(7)
  pointer('pointermove', 0.5)
  pointer('pointermove', 1)
  pointer('pointermove', 2)
  pointer('pointermove', 0)
  expect(harness.select.mock.calls).toEqual([[12], [23], [12]])
})

it('keeps the selected colour across gaps, unsupported colours, controls and off-map positions', () => {
  pointer('pointerdown')
  for (const x of [3, 4, 4.5, 20]) pointer('pointermove', x)
  expect(harness.selected).toBe(12)
  expect(harness.select.mock.calls).toEqual([[12], [60]])
  hit = document.createElement('button')
  pointer('pointermove', 1)
  hit = null
  pointer('pointermove', 1)
  expect(harness.selected).toBe(12)
  hit = map
  pointer('pointermove', 5)
  expect(harness.selected).toBe(7)
})

it('resolves overlaps, transparent cells and hidden colours in the existing drawing order', () => {
  const top = source([23, TRANSPARENT_INDEX, 7, 23])
  top.hiddenColours = [7]
  const invisible = source([60, 60, 60, 60])
  invisible.visible = false
  harness.templates = [source([12, 12, 12, 12]), top, invisible]
  pointer('pointerdown')
  pointer('pointermove', 1)
  pointer('pointermove', 2)
  pointer('pointermove', 3)
  expect(harness.select.mock.calls).toEqual([[23], [12], [23]])
})

it('reads through selected-colour filtering and transformed stamp gutters', () => {
  harness.onlySelected = true
  harness.templates = [
    Object.assign(source(), { size: 0.2, rotation: 45, translateX: 0.4, translateY: 0.4 }),
  ]
  pointer('pointerdown')
  pointer('pointermove', 1)
  expect(harness.selected).toBe(23)
})

it('resolves source columns across wrapped world templates', () => {
  harness.templates = [{ ...source([12, 23]), originX: WORLD_PIXELS - 1, wrapX: true }]
  pointer('pointerdown', WORLD_PIXELS - 1)
  pointer('pointermove', 0)
  expect(harness.select.mock.calls).toEqual([[12], [23]])
})

it.each([
  'pointerup',
  'pointercancel',
  'lostpointercapture',
  'blur',
  'buttons',
  'drawer',
  'placement',
])('ends sampling on %s', (stop) => {
  pointer('pointerdown')
  if (stop === 'blur') window.dispatchEvent(new Event('blur'))
  else if (stop === 'buttons') pointer('pointermove', 1, { buttons: 0 })
  else if (stop === 'drawer') {
    harness.paintOpen = false
    pointer('pointermove', 1)
    harness.paintOpen = true
  } else if (stop === 'placement') {
    harness.moving = true
    pointer('pointermove', 1)
    harness.moving = false
  } else pointer(stop, 0, { buttons: 0 })
  pointer('pointermove', 1)
  expect(harness.select.mock.calls).toEqual([[12]])
  expect(capture).toBeNull()
})

it('ignores other pointers while one owns the gesture', () => {
  pointer('pointerdown')
  pointer('pointerdown', 1, { pointerId: 8 })
  pointer('pointermove', 1, { pointerId: 8 })
  pointer('pointerup', 1, { pointerId: 8 })
  pointer('pointercancel', 1, { pointerId: 8 })
  pointer('lostpointercapture', 1, { pointerId: 8 })
  pointer('pointermove', 5)
  expect(harness.select.mock.calls).toEqual([[12], [7]])
})

it.each(['closed drawer', 'placement', 'gap', 'unsupported', 'outside', 'swatch', 'prevented'])(
  'leaves a failed initial pick untouched: %s',
  (reason) => {
    if (reason === 'closed drawer') harness.paintOpen = false
    if (reason === 'placement') harness.moving = true
    const x = reason === 'gap' ? 3 : reason === 'unsupported' ? 4 : reason === 'outside' ? 10 : 0
    const target = reason === 'swatch' ? document.createElement('button') : map
    if (target !== map) document.body.append(target)
    const event = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      button: 1,
      buttons: 4,
      clientX: x,
      clientY: 0.5,
    })
    if (reason === 'prevented') event.preventDefault()
    const nativeDown = vi.fn()
    target.addEventListener('pointerdown', nativeDown)
    target.dispatchEvent(event)
    expect(nativeDown).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(reason === 'prevented')
    for (const type of ['mousedown', 'mouseup', 'auxclick']) {
      const mouse = new MouseEvent(type, { bubbles: true, cancelable: true, button: 1 })
      target.dispatchEvent(mouse)
      expect(mouse.defaultPrevented).toBe(false)
    }
    pointer('pointermove', 1)
    expect(capture).toBeNull()
    expect(harness.selected).toBe(12)
  },
)

it('blocks native pointer and compatibility mouse gestures only for the claimed sequence', async () => {
  const native = vi.fn()
  for (const type of [
    'pointerdown',
    'pointermove',
    'pointerup',
    'mousedown',
    'mousemove',
    'mouseup',
    'auxclick',
  ]) {
    map.addEventListener(type, native)
  }
  pointer('pointerdown')
  for (const type of ['mousedown', 'mousemove']) {
    map.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, button: 1, buttons: 4 }),
    )
  }
  pointer('pointermove', 1)
  pointer('pointerup', 1, { buttons: 0 })
  pointer('lostpointercapture', 1, { buttons: 0 })
  for (const type of ['mouseup', 'auxclick']) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 1 })
    map.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  }
  expect(native).not.toHaveBeenCalled()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const unrelated = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
  map.dispatchEvent(unrelated)
  expect(unrelated.defaultPrevented).toBe(false)
})

it.each(['alliance-headquarters', 'alliance-picture', 'alliance-banner'] as const)(
  'scrubs the transformed %s frame',
  (kind) => {
    const stage = document.createElement('div')
    const frame = document.createElement('div')
    map.className = ''
    frame.append(map)
    stage.append(frame)
    document.body.append(stage)
    frame.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 200,
        right: 300,
        bottom: 400,
        width: 200,
        height: 200,
      }) as DOMRect
    harness.alliance = {
      surface: { kind, allianceId: 1 },
      stage,
      frame,
      draftId: null,
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    }
    // A wide pair of colour regions works across the native dimensions of all three editors.
    harness.templates = [source(Array.from({ length: 2000 }, (_, i) => (i < 2 ? 12 : 23)))]
    pointer('pointerdown', 100, { clientY: 200.01 })
    pointer('pointermove', 150, { clientY: 200.01 })
    pointer('pointermove', 350, { clientY: 200.01 })
    expect(harness.select.mock.calls).toEqual([[12], [23]])
  },
)
