import { activeAllianceSurface } from './alliance-surface.js'
import type { MapLike } from './map-handle.js'
import { isPaintOpen } from './wplace-paint.js'

const forwardedMoves = new WeakSet<Event>()
type PaintCursor = Pick<
  MouseEvent,
  'clientX' | 'clientY' | 'buttons' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>

/** Whether this is movement forwarded by Caelestis rather than a compatibility mouse event. */
export const isForwardedPaintMove = (event: Event): boolean => forwardedMoves.has(event)

/** Feed Wplace its native mouse-move path without starting a mouse gesture. */
export const forwardPaintMove = (target: Element, position: PaintCursor): void => {
  const event = new MouseEvent('mousemove', {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: position.clientX,
    clientY: position.clientY,
    buttons: position.buttons,
    altKey: position.altKey,
    ctrlKey: position.ctrlKey,
    metaKey: position.metaKey,
    shiftKey: position.shiftKey,
  })
  forwardedMoves.add(event)
  target.dispatchEvent(event)
}

let cursor: PointerEvent | null = null
let observedMap: MapLike | null = null

/** Refresh the native paint target after its canvas moves under a stationary mouse. */
export const refreshPaintCursor = (root: Element, type: 'mousemove' | 'pointermove'): void => {
  if (cursor === null || !isPaintOpen() || !root.isConnected) return
  const target = document.elementFromPoint(cursor.clientX, cursor.clientY)
  if (target === null || !root.contains(target)) return
  if (type === 'mousemove') {
    forwardPaintMove(target, cursor)
    return
  }
  target.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: cursor.pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: -1,
      buttons: cursor.buttons,
      clientX: cursor.clientX,
      clientY: cursor.clientY,
      altKey: cursor.altKey,
      ctrlKey: cursor.ctrlKey,
      metaKey: cursor.metaKey,
      shiftKey: cursor.shiftKey,
    }),
  )
}

const refreshWorldCursor = (): void => {
  if (observedMap !== null && activeAllianceSurface() === null)
    refreshPaintCursor(observedMap.getCanvas(), 'mousemove')
}

/** Follow the current map across SPA replacements without retaining old map listeners. */
export const syncPaintCursorMap = (map: MapLike | null): void => {
  if (map === observedMap) return
  observedMap?.off('moveend', refreshWorldCursor)
  observedMap = map
  observedMap?.on('moveend', refreshWorldCursor)
}

/** Remember mouse position while it belongs to this window; return its teardown. */
export const installPaintCursorTracking = (): (() => void) => {
  const remember = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse') cursor = event
  }
  const clear = (): void => {
    cursor = null
  }
  const leave = (event: PointerEvent): void => {
    if (event.relatedTarget === null) clear()
  }
  const visibility = (): void => {
    if (document.hidden) clear()
  }
  const movements = ['pointerdown', 'pointermove', 'pointerup'] as const
  for (const type of movements) window.addEventListener(type, remember, true)
  window.addEventListener('pointerout', leave, true)
  window.addEventListener('pointercancel', clear, true)
  window.addEventListener('blur', clear)
  document.addEventListener('visibilitychange', visibility)
  return () => {
    for (const type of movements) window.removeEventListener(type, remember, true)
    window.removeEventListener('pointerout', leave, true)
    window.removeEventListener('pointercancel', clear, true)
    window.removeEventListener('blur', clear)
    document.removeEventListener('visibilitychange', visibility)
    syncPaintCursorMap(null)
    clear()
  }
}
