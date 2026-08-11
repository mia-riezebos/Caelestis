import { TILE_SIZE, WORLD_PIXELS } from '@wts/shared'
import { log, warn } from '../debug.js'
import { canvasPixelAt, cssPixelsPerCanvasPixel, isMapInteractionTarget } from '../main.js'
import { icon } from '../ui/icons.js'
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
 * The map has to keep working. Pan, zoom and paint are what someone is here to do, and a placement
 * mode that swallows them would be worse than no placement mode — so dragging requires a modifier
 * *and* the cursor to be over the template. Everything else falls through to wplace untouched.
 *
 * Middle-click centres the template on the cursor. Without it, moving a template across the world
 * while zoomed in means dragging it the whole way; with it, the long move is one click and the drag
 * is only ever for the last few pixels.
 *
 * No resizing. A template's size is decided by its source image, and a scaled one no longer
 * corresponds to pixels anybody can paint.
 */

const MODIFIER_HINT = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'

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
    scaleX: number
    scaleY: number
  } | null
}

let session: MoveSession | null = null
let onFinish: (() => void) | null = null
let finishing = false
let suppressMiddleAuxClickFor: number | null = null
let moveReservation: symbol | null = null

export const isMoving = (): boolean => session !== null || moveReservation !== null
export const movingId = (): string | null => session?.id ?? null

export interface MoveReservation {
  /** Consume this reservation by starting the move synchronously. */
  readonly start: (
    id: string,
    finished: () => void,
    restoredOrigin?: { readonly x: number; readonly y: number },
  ) => boolean
  /** Release an unconsumed reservation. Safe to call after `start`. */
  readonly release: () => void
}

const holdMoveSlot = (): MoveReservation => {
  const token = Symbol('move reservation')
  moveReservation = token
  const release = (): void => {
    if (moveReservation === token) moveReservation = null
  }
  return {
    start: (id, finished, restoredOrigin) => {
      if (moveReservation !== token) return false
      moveReservation = null
      return beginMove(id, finished, restoredOrigin)
    },
    release,
  }
}

/**
 * Hold the single placement slot across asynchronous preparation.
 *
 * Image imports must be sliced and admitted before `beginMove` can see them. Without a reservation,
 * another row can start moving during that await and strand the new image in volatile local state.
 */
export const reserveMove = (): MoveReservation | null => {
  if (session !== null || finishing || moveReservation !== null) return null
  return holdMoveSlot()
}

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

const bar = (): HTMLElement => {
  const existing = document.querySelector<HTMLElement>('[data-wts-movebar]')
  if (existing !== null) return existing
  const el = document.createElement('div')
  el.setAttribute('data-wts-movebar', '')
  el.className = 'bg-base-100 shadow-2xl flex items-center gap-2'
  Object.assign(el.style, {
    position: 'fixed',
    left: '50%',
    transform: 'translateX(-50%)',
    top: '1rem',
    zIndex: '35',
    borderRadius: '0.5rem',
    padding: '0.375rem 0.5rem',
    color: 'var(--color-base-content, inherit)',
  })
  document.body.appendChild(el)
  return el
}

const renderBar = (name: string): void => {
  const el = bar()
  el.replaceChildren()

  const label = document.createElement('span')
  label.className = 'text-sm'
  label.style.padding = '0 0.25rem'
  label.textContent = `Placing “${name}”`
  const hint = document.createElement('span')
  hint.className = 'text-xs opacity-60'
  hint.textContent = `${MODIFIER_HINT}+drag or arrow keys to move · Shift for 10 px · middle-click to centre here`

  const apply = document.createElement('button')
  apply.className = 'btn btn-sm btn-primary btn-circle'
  apply.title = 'Apply placement'
  apply.setAttribute('aria-label', 'Apply placement')
  apply.appendChild(icon('check', 'size-4'))
  apply.addEventListener('click', () => void commit())

  const cancel = document.createElement('button')
  cancel.className = 'btn btn-sm btn-ghost btn-circle'
  cancel.title = 'Cancel'
  cancel.setAttribute('aria-label', 'Cancel placement')
  cancel.appendChild(icon('close', 'size-4'))
  cancel.addEventListener('click', () => void abort())

  el.append(label, hint, apply, cancel)
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
  // Both conditions, deliberately: the modifier alone would steal every drag on the map, and
  // hovering alone would steal every pan that happens to start over the template.
  if (!(event.metaKey || event.ctrlKey)) return
  if (!isOverTemplate(event.clientX, event.clientY)) return
  event.preventDefault()
  event.stopPropagation()
  const scale = cssPixelsPerCanvasPixel()
  session.dragging = {
    pointerId: event.pointerId,
    pointerX: event.clientX,
    pointerY: event.clientY,
    startX: session.x,
    startY: session.y,
    scaleX: scale.x,
    scaleY: scale.y,
  }
}

const onPointerMove = (event: PointerEvent): void => {
  if (session?.dragging == null || finishing) return
  if (event.pointerId !== session.dragging.pointerId) return
  event.preventDefault()
  event.stopPropagation()
  // Screen delta to canvas delta: one canvas pixel is many screen pixels when zoomed in.
  const template = localTemplates().find((candidate) => candidate.id === session?.id)
  if (template === undefined) return
  const next = boundedOrigin(
    template,
    session.dragging.startX + (event.clientX - session.dragging.pointerX) / session.dragging.scaleX,
    session.dragging.startY + (event.clientY - session.dragging.pointerY) / session.dragging.scaleY,
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
  if (session?.dragging?.pointerId === event.pointerId) session.dragging = null
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
      'a,button,input,select,textarea,[contenteditable="true"],dialog,[role="dialog"],[role="button"],[role="link"],#wts-panel,[data-wts-movebar]',
    ) ?? null) !== null
  )
}

const onKeyDown = (event: KeyboardEvent): void => {
  if (session === null || finishing) return
  if (isPageControl(event.target)) return
  const delta =
    event.key === 'ArrowLeft'
      ? { x: -1, y: 0 }
      : event.key === 'ArrowRight'
        ? { x: 1, y: 0 }
        : event.key === 'ArrowUp'
          ? { x: 0, y: -1 }
          : event.key === 'ArrowDown'
            ? { x: 0, y: 1 }
            : null
  if (delta !== null) {
    const template = localTemplates().find((candidate) => candidate.id === session?.id)
    if (template === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const step = event.shiftKey ? 10 : 1
    const next = boundedOrigin(template, session.x + delta.x * step, session.y + delta.y * step)
    session.x = next.x
    session.y = next.y
    previewMove(session.id, session.x, session.y)
    return
  }
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

export const beginMove = (
  id: string,
  finished: () => void,
  restoredOrigin?: { readonly x: number; readonly y: number },
): boolean => {
  if (session !== null || finishing || moveReservation !== null) return false
  const template = localTemplates().find((candidate) => candidate.id === id)
  if (template === undefined) return false
  const nextSession: MoveSession = {
    id,
    x: restoredOrigin?.x ?? template.originX,
    y: restoredOrigin?.y ?? template.originY,
    dragging: null,
  }
  session = nextSession
  if (restoredOrigin !== undefined) {
    try {
      if (!previewLocalTemplate(id, nextSession.x, nextSession.y)) {
        session = null
        return false
      }
    } catch (error) {
      session = null
      warn('install', 'template placement could not be restored', String(error))
      return false
    }
  }
  onFinish = finished
  finishing = false
  suppressMiddleAuxClickFor = null
  renderBar(template.name)
  listen(true)
  log('install', `move started for ${template.name}`)
  return true
}

const finish = (reserveNext = false): MoveReservation | null => {
  listen(false)
  document.querySelector('[data-wts-movebar]')?.remove()
  session = null
  finishing = false
  suppressMiddleAuxClickFor = null
  const finished = onFinish
  onFinish = null
  // Reserve before notifying observers. A completion callback may synchronously start another
  // placement, which would otherwise steal the slot while deletion is still awaiting storage.
  const reservation = reserveNext ? holdMoveSlot() : null
  try {
    finished?.()
  } catch (error) {
    // Completion is an observer notification, not part of the durable placement transaction.
    // Never let it reopen capture-phase listeners after teardown.
    try {
      warn('install', 'placement completion callback failed', String(error))
    } catch {}
  }
  return reservation
}

/** Tear down placement ownership before its template is deleted through another surface. */
export const stopMoveForDeletion = (
  id: string,
): {
  readonly origin: { readonly x: number; readonly y: number }
  readonly reservation: MoveReservation
} | null => {
  if (session?.id !== id) return null
  const origin = { x: session.x, y: session.y }
  clearLocalPreview(id)
  const reservation = finish(true)
  if (reservation === null) return null
  return { origin, reservation }
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
