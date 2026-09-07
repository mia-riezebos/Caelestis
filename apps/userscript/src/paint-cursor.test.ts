// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MapLike } from './map-handle.js'
import {
  installPaintCursorTracking,
  refreshPaintCursor,
  syncPaintCursorMap,
} from './paint-cursor.js'

const state = vi.hoisted(() => ({ paintOpen: true }))
vi.mock('./wplace-paint.js', () => ({ isPaintOpen: () => state.paintOpen }))
vi.mock('./alliance-surface.js', () => ({ activeAllianceSurface: () => null }))

let stop: () => void
let canvas: HTMLCanvasElement
let hit: ReturnType<typeof vi.spyOn>
const mouse = (target: Element, buttons = 0): void => {
  target.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      pointerType: 'mouse',
      pointerId: 1,
      clientX: 42,
      clientY: 73,
      buttons,
    }),
  )
}
const mapAt = (element: HTMLCanvasElement) => {
  const events = new EventTarget()
  const map = {
    flyTo: vi.fn(),
    easeTo: vi.fn(),
    jumpTo: vi.fn(),
    getZoom: () => 20,
    getCenter: () => ({ lng: 0, lat: 0 }),
    getCanvas: () => element,
    unproject: () => ({ lng: 0, lat: 0 }),
    on: (type, listener) => events.addEventListener(type, listener),
    off: (type, listener) => events.removeEventListener(type, listener),
  } satisfies MapLike
  return { map, finish: () => events.dispatchEvent(new Event('moveend')) }
}

beforeEach(() => {
  state.paintOpen = true
  canvas = document.createElement('canvas')
  document.body.append(canvas)
  hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(canvas)
  stop = installPaintCursorTracking()
})
afterEach(() => {
  stop()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

it('updates native hover and the window paint target after a flight without another mouse movement', () => {
  const { map, finish } = mapAt(canvas)
  syncPaintCursorMap(map)
  mouse(canvas)
  const hover = vi.fn()
  const paintTarget = vi.fn()
  const start = vi.fn()
  canvas.addEventListener('mousemove', hover)
  window.addEventListener('mousemove', paintTarget)
  canvas.addEventListener('mousedown', start)
  canvas.addEventListener('click', start)

  finish()

  expect(hover).toHaveBeenCalledTimes(1)
  expect(paintTarget).toHaveBeenCalledTimes(1)
  expect(hover.mock.calls[0]?.[0]).toMatchObject({ clientX: 42, clientY: 73, buttons: 0 })
  expect(start).not.toHaveBeenCalled()
  window.removeEventListener('mousemove', paintTarget)
})

it('uses the current hit target and skips controls, closed painting, and detached canvases', () => {
  const hover = vi.fn()
  canvas.addEventListener('mousemove', hover)
  mouse(canvas)
  hit.mockReturnValue(document.body)
  refreshPaintCursor(canvas, 'mousemove')
  hit.mockReturnValue(canvas)
  state.paintOpen = false
  refreshPaintCursor(canvas, 'mousemove')
  state.paintOpen = true
  canvas.remove()
  refreshPaintCursor(canvas, 'mousemove')
  expect(hover).not.toHaveBeenCalled()
})

it.each(['blur', 'pointerout', 'pointercancel'])('forgets stale coordinates after %s', (type) => {
  const hover = vi.fn()
  canvas.addEventListener('mousemove', hover)
  mouse(canvas)
  window.dispatchEvent(new PointerEvent(type))
  refreshPaintCursor(canvas, 'mousemove')
  expect(hover).not.toHaveBeenCalled()
})

it('removes the previous map listener when Wplace replaces its map', () => {
  const old = mapAt(canvas)
  const current = mapAt(canvas)
  const hover = vi.fn()
  canvas.addEventListener('mousemove', hover)
  mouse(canvas)
  syncPaintCursorMap(old.map)
  syncPaintCursorMap(current.map)
  syncPaintCursorMap(current.map)
  old.finish()
  expect(hover).not.toHaveBeenCalled()
  current.finish()
  expect(hover).toHaveBeenCalledTimes(1)
})

it('refreshes alliance hover through its pointer listener and remembers released mouse buttons', () => {
  const hover = vi.fn()
  mouse(canvas, 4)
  canvas.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      pointerType: 'mouse',
      pointerId: 1,
      clientX: 42,
      clientY: 73,
      buttons: 0,
    }),
  )
  canvas.addEventListener('pointermove', hover)
  refreshPaintCursor(canvas, 'pointermove')
  expect(hover).toHaveBeenCalledTimes(1)
  expect(hover.mock.calls[0]?.[0]).toMatchObject({ clientX: 42, clientY: 73, buttons: 0 })
})
