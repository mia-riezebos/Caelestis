import { TILE_SIZE, WORLD_PIXELS } from '@wts/shared'
import { log, warn } from '../debug.js'
import { canvasPixelAt, cssPixelsPerCanvasPixel, isMapInteractionTarget } from '../main.js'
import {
  clearLocalPreview,
  localTemplates,
  onLocalReconciliation,
  placeLocalTemplate,
  previewLocalTemplate,
  removeLocalTemplate,
} from './local-store.js'

/**
 * Placing a template on the map.
 *
 * The map has to keep working — pan, zoom and paint are what someone is here to do — and the
 * template's own outline is what separates the two. Over it, a drag moves the template and the
 * cursor says so by becoming a hand; anywhere else, every gesture falls through to wplace
 * untouched. A modifier used to be required as well, which made the one mode you deliberately
 * entered feel like it had not started.
 *
 * Middle-click centres the template on the cursor. Without it, moving a template across the world
 * while zoomed in means dragging it the whole way; with it, the long move is one click and the drag
 * is only ever for the last few pixels.
 *
 * No resizing. A template's size is decided by its source image, and a scaled one no longer
 * corresponds to pixels anybody can paint.
 */

interface MoveSession {
  readonly id: string
  x: number
  y: number
  dragging: {
    pointerId: number
    pointerX: number
    pointerY: number
    startX: number
    startY: number
  } | null
}

let session: MoveSession | null = null
let onFinish: (() => void) | null = null
let finishing = false
let suppressMiddleAuxClickFor: number | null = null

export const isMoving = (): boolean => session !== null
export const movingId = (): string | null => session?.id ?? null

/** Where the template currently sits during a move, so the renderer can draw it there. */
export const movePreviewOrigin = (id: string): { x: number; y: number } | null =>
  session !== null && session.id === id ? { x: session.x, y: session.y } : null

const isOverTemplate = (clientX: number, clientY: number): boolean => {
  if (session === null) return false
  const point = canvasPixelAt(clientX, clientY)
  if (point === null) return false
  const template = localTemplates().find((candidate) => candidate.id === session?.id)
  if (template === undefined) return false
  return (
    point.x >= session.x &&
    point.x < session.x + template.width &&
    point.y >= session.y &&
    point.y < session.y + template.height
  )
}

const boundedOrigin = (
  template: { width: number; height: number },
  x: number,
  y: number,
): { x: number; y: number } => ({
  x: Math.min(Math.max(0, Math.round(x)), WORLD_PIXELS - template.width),
  y: Math.min(Math.max(0, Math.round(y)), WORLD_PIXELS - template.height),
})

/**
 * The map's own cursor, borrowed for as long as the placement lasts.
 *
 * The cursor is the only thing on screen that can say "this is draggable" at the moment it becomes
 * true, which is while hovering — a label somewhere else cannot. Set inline so it beats whatever
 * MapLibre is setting for its own state, and cleared on the way out so the map gets it back.
 */
const setCursor = (shape: string): void => {
  const canvas = document.querySelector<HTMLElement>('canvas.maplibregl-canvas')
  if (canvas === null) return
  canvas.style.cursor = shape
}

const onPointerDown = (event: PointerEvent): void => {
  if (session === null || finishing) return
  // One pointer owns a drag until it ends. A second touch, pen, or mouse button must not replace
  // its origin or recenter the template underneath it.
  if (session.dragging !== null) return
  if (isPageControl(event.target) || !isMapInteractionTarget(event.target)) return
  suppressMiddleAuxClickFor = null
  // Middle click: jump, do not drag. A long move should not require dragging the whole way.
  if (event.button === 1) {
    const point = canvasPixelAt(event.clientX, event.clientY)
    const template = localTemplates().find((candidate) => candidate.id === session?.id)
    if (point === null || template === undefined) return
    event.preventDefault()
    suppressMiddleAuxClickFor = event.pointerId
    const next = boundedOrigin(
      template,
      point.x - template.width / 2,
      point.y - template.height / 2,
    )
    session.x = next.x
    session.y = next.y
    previewMove(session.id, session.x, session.y)
    log('draw', 'template centred on cursor', { x: session.x, y: session.y })
    return
  }
  if (event.button !== 0) return
  // The template's own outline is the boundary. Starting a drag anywhere else is a pan, which is
  // what makes this mode livable — the map underneath keeps working the whole time.
  if (!isOverTemplate(event.clientX, event.clientY)) return
  event.preventDefault()
  event.stopPropagation()
  setCursor('grabbing')
  session.dragging = {
    pointerId: event.pointerId,
    pointerX: event.clientX,
    pointerY: event.clientY,
    startX: session.x,
    startY: session.y,
  }
}

const onPointerMove = (event: PointerEvent): void => {
  if (session === null || finishing) return
  if (session.dragging === null) {
    setCursor(isOverTemplate(event.clientX, event.clientY) ? 'grab' : '')
    return
  }
  if (event.pointerId !== session.dragging.pointerId) return
  event.preventDefault()
  event.stopPropagation()
  // Screen delta to canvas delta: one canvas pixel is many screen pixels when zoomed in.
  const scale = cssPixelsPerCanvasPixel()
  const template = localTemplates().find((candidate) => candidate.id === session?.id)
  if (template === undefined) return
  const next = boundedOrigin(
    template,
    session.dragging.startX + (event.clientX - session.dragging.pointerX) / scale.x,
    session.dragging.startY + (event.clientY - session.dragging.pointerY) / scale.y,
  )
  session.x = next.x
  session.y = next.y
  previewMove(session.id, session.x, session.y)
}

const previewMove = (id: string, x: number, y: number): void => {
  try {
    if (!previewLocalTemplate(id, x, y)) warn('install', 'template move could not be previewed')
  } catch (error) {
    warn('install', 'template move failed', String(error))
  }
}

const onPointerUp = (event: PointerEvent): void => {
  if (session?.dragging?.pointerId === event.pointerId) {
    session.dragging = null
    setCursor(isOverTemplate(event.clientX, event.clientY) ? 'grab' : '')
  }
  if (suppressMiddleAuxClickFor === event.pointerId) {
    const pointerId = event.pointerId
    setTimeout(() => {
      if (suppressMiddleAuxClickFor === pointerId) suppressMiddleAuxClickFor = null
    }, 0)
  }
}

const onPointerCancel = (event: PointerEvent): void => {
  onPointerUp(event)
  if (suppressMiddleAuxClickFor === event.pointerId) suppressMiddleAuxClickFor = null
}

const onBlur = (): void => {
  if (session !== null) session.dragging = null
  suppressMiddleAuxClickFor = null
}

const isPageControl = (target: EventTarget | null): boolean => {
  if (target === null || typeof target !== 'object') return false
  const element = target as {
    isContentEditable?: boolean
    tagName?: string
    closest?: (selector: string) => Element | null
  }
  return (
    element.isContentEditable === true ||
    ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName?.toUpperCase() ?? '') ||
    (element.closest?.(
      'a,button,input,select,textarea,[contenteditable="true"],dialog,[role="dialog"],[role="button"],[role="link"]',
    ) ?? null) !== null
  )
}

const onKeyDown = (event: KeyboardEvent): void => {
  if (session === null || finishing) return
  if (isPageControl(event.target)) return
  if (event.key === 'Escape') {
    event.preventDefault()
    void abort()
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    void commit()
  }
}

const onAuxClick = (event: MouseEvent): void => {
  if (event.button !== 1 || suppressMiddleAuxClickFor === null) return
  suppressMiddleAuxClickFor = null
  event.preventDefault()
}

const listen = (on: boolean): void => {
  const method = on ? 'addEventListener' : 'removeEventListener'
  // Capture phase: MapLibre's own handlers sit on the canvas container and would otherwise pan the
  // map out from under a drag that was meant for the template.
  window[method]('pointerdown', onPointerDown as EventListener, true)
  window[method]('pointermove', onPointerMove as EventListener, true)
  window[method]('pointerup', onPointerUp as EventListener, true)
  window[method]('pointercancel', onPointerCancel as EventListener, true)
  window[method]('blur', onBlur as EventListener, true)
  window[method]('keydown', onKeyDown as EventListener, true)
  // Middle click also opens autoscroll on some platforms.
  window[method]('auxclick', onAuxClick as EventListener, true)
}

export const beginMove = (id: string, finished: () => void): void => {
  if (session !== null) return
  const template = localTemplates().find((candidate) => candidate.id === id)
  if (template === undefined) return
  session = {
    id,
    x: template.originX,
    y: template.originY,
    dragging: null,
  }
  onFinish = finished
  finishing = false
  suppressMiddleAuxClickFor = null
  listen(true)
  // Apply and cancel are drawn where the template's own menu button was, by `renderOverlayControls`
  // — the controls for this template stay in the one place they have always been.
  finished()
  log('install', `move started for ${template.name}`)
}

const finish = (): void => {
  listen(false)
  setCursor('')
  session = null
  finishing = false
  suppressMiddleAuxClickFor = null
  const finished = onFinish
  onFinish = null
  try {
    finished?.()
  } catch (error) {
    // Completion is an observer notification, not part of the durable placement transaction.
    // Never let it reopen capture-phase listeners after teardown.
    try {
      warn('install', 'placement completion callback failed', String(error))
    } catch {}
  }
}

const resumeAfterFailure = (action: string, error?: unknown): void => {
  warn('install', `${action} could not be saved; placement is still open`, String(error ?? ''))
  finishing = false
  listen(true)
}

export const commit = async (): Promise<void> => {
  if (session === null || finishing) return
  const current = session
  finishing = true
  listen(false)
  let reconciled = false
  const stopObserving = onLocalReconciliation(current.id, () => {
    reconciled = true
  })
  try {
    if (!(await placeLocalTemplate(current.id, current.x, current.y))) {
      const durable = localTemplates().find((template) => template.id === current.id)
      if (durable === undefined || reconciled) {
        finish()
        return
      }
      resumeAfterFailure('placement')
      return
    }
    log('install', 'placement applied', { x: current.x, y: current.y })
    finish()
  } catch (error) {
    resumeAfterFailure('placement', error)
  } finally {
    stopObserving()
  }
}

/**
 * Cancel: put it back where it started.
 *
 * An image imported in this session has no "back" — it was never anywhere — so cancelling that
 * removes it. Leaving a template stranded somewhere nobody chose is worse than losing an import
 * that takes one click to repeat.
 */
export const abort = async (): Promise<void> => {
  if (session === null || finishing) return
  const current = session
  finishing = true
  listen(false)
  let reconciled = false
  const stopObserving = onLocalReconciliation(current.id, () => {
    reconciled = true
  })
  try {
    const template = localTemplates().find((candidate) => candidate.id === current.id)
    const saved =
      template !== undefined && template.source === 'image' && !template.everPlaced
        ? await removeLocalTemplate(current.id)
        : clearLocalPreview(current.id)
    if (!saved) {
      const durable = localTemplates().find((candidate) => candidate.id === current.id)
      if (durable === undefined || reconciled) {
        finish()
        return
      }
      resumeAfterFailure('revert')
      return
    }
    finish()
  } catch (error) {
    resumeAfterFailure('revert', error)
  } finally {
    stopObserving()
  }
}

/** Tile-aligned bounds of the template being moved, for drawing its outline. */
export const moveOutline = (): { x: number; y: number; w: number; h: number } | null => {
  if (session === null) return null
  const template = localTemplates().find((candidate) => candidate.id === session?.id)
  if (template === undefined) return null
  return { x: session.x, y: session.y, w: template.width, h: template.height }
}

export const TILE = TILE_SIZE
