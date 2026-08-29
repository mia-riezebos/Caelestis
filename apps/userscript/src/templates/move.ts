import { TILE_SIZE, WORLD_PIXELS } from '@caelestis/shared'
import { log, warn } from '../debug.js'
import { canvasPixelAt, cssPixelsPerCanvasPixel, isMapInteractionTarget, repaint } from '../main.js'
import {
  clearLocalPreview,
  isDeletingLocal,
  isServerTemplate,
  onLocalReconciliation,
  placeLocalTemplate,
  previewLocalTemplate,
  removeLocalTemplate,
  templateById,
} from './local-store.js'
import { horizontalSpans } from './placement.js'

/**
 * Placing a template on the map.
 *
 * The map has to keep working — pan, zoom and paint are what someone is here to do — and the
 * template's own outline is what separates the two. Over it, a drag moves the template and the
 * cursor says so by becoming a hand; anywhere else, every gesture falls through to wplace
 * untouched.
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
  /** Server drafts persist their new origin remotely before the local preview is accepted. */
  readonly persistRemote?: (originX: number, originY: number) => Promise<boolean>
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
/** A commit or revert is already under way, so `commit`/`abort` are no-ops until it settles. */
export const isFinishing = (): boolean => finishing

/**
 * Which placement this is, counted rather than named.
 *
 * A template's id is not an identity for the session placing it: the same template can be placed
 * twice, and anything remembered about the first placement matches the second by name alone.
 */
let placements = 0
export const placementSeq = (): number | null => (session === null ? null : placements)

/** The keydown this placement has already answered, so no other listener answers it a second time. */
let answered: KeyboardEvent | null = null
export const alreadyAnswered = (event: KeyboardEvent): boolean => answered === event

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
  const template = session === null ? undefined : templateById(session.id)
  if (template === undefined) return false
  return (
    horizontalSpans({ ...template, originX: session.x }).some(
      (span) => point.x >= span.worldStart && point.x < span.worldEnd,
    ) &&
    point.y >= session.y &&
    point.y < session.y + template.height
  )
}

const boundedOrigin = (
  template: { width: number; height: number; wrapX?: boolean },
  x: number,
  y: number,
): { x: number; y: number } => {
  const roundedX = Math.round(x)
  return {
    x:
      template.wrapX === true
        ? ((roundedX % WORLD_PIXELS) + WORLD_PIXELS) % WORLD_PIXELS
        : Math.min(Math.max(0, roundedX), WORLD_PIXELS - template.width),
    y: Math.min(Math.max(0, Math.round(y)), WORLD_PIXELS - template.height),
  }
}

/** Borrow the map's own cursor for as long as placement owns the pointer. */
const setCursor = (shape: string): void => {
  const canvas = document.querySelector<HTMLElement>('canvas.maplibregl-canvas')
  if (canvas !== null) canvas.style.cursor = shape
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
    const template = session === null ? undefined : templateById(session.id)
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
  // The template's own outline is the boundary. Starting elsewhere remains a map pan.
  if (!isOverTemplate(event.clientX, event.clientY)) return
  event.preventDefault()
  event.stopPropagation()
  setCursor('grabbing')
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
  if (session === null || finishing) return
  if (session.dragging === null) {
    setCursor(isOverTemplate(event.clientX, event.clientY) ? 'grab' : '')
    return
  }
  if (event.pointerId !== session.dragging.pointerId) return
  event.preventDefault()
  event.stopPropagation()
  // Screen delta to canvas delta: one canvas pixel is many screen pixels when zoomed in.
  const template = session === null ? undefined : templateById(session.id)
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
  if (session?.dragging?.pointerId === event.pointerId) {
    session.dragging = null
    setCursor(isOverTemplate(event.clientX, event.clientY) ? 'grab' : '')
    event.preventDefault()
    event.stopPropagation()
    swallowNextClick()
  }
  if (suppressMiddleAuxClickFor === event.pointerId) {
    const pointerId = event.pointerId
    setTimeout(() => {
      if (suppressMiddleAuxClickFor === pointerId) suppressMiddleAuxClickFor = null
    }, 0)
  }
}

const swallowNextClick = (): void => {
  const clickTarget = window
  const swallow = (event: Event): void => {
    clickTarget.removeEventListener('click', swallow, true)
    clearTimeout(timer)
    if (isPageControl(event.target)) return
    event.preventDefault()
    event.stopPropagation()
  }
  const timer = setTimeout(() => clickTarget.removeEventListener('click', swallow, true), 400)
  clickTarget.addEventListener('click', swallow, true)
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
      'a,button,input,select,textarea,[contenteditable="true"],dialog,[role="dialog"],[role="button"],[role="link"],#caelestis-panel',
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
    const template = session === null ? undefined : templateById(session.id)
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
    answered = event
    event.preventDefault()
    void abort()
  }
  if (event.key === 'Enter') {
    answered = event
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
): boolean => begin(id, finished, restoredOrigin)

/**
 * Place a server-owned draft with the same canvas interaction as a Local template.
 *
 * The caller owns the remote write because it also owns server authorization and publication
 * policy. The placement engine owns only previewing and accepting/reverting the local visual.
 */
export const beginServerMove = (
  id: string,
  finished: () => void,
  persistRemote: (originX: number, originY: number) => Promise<boolean>,
): boolean => begin(id, finished, undefined, persistRemote)

const begin = (
  id: string,
  finished: () => void,
  restoredOrigin?: { readonly x: number; readonly y: number },
  persistRemote?: (originX: number, originY: number) => Promise<boolean>,
): boolean => {
  if (session !== null || finishing || moveReservation !== null) return false
  // A condemned template is still in the store for the whole of its delete, so every surface that
  // has not re-rendered still offers Move for it. Refusing here covers all of them at once, rather
  // than each caller having to remember.
  if (isDeletingLocal(id)) return false
  const template = templateById(id)
  if (
    template === undefined ||
    (isServerTemplate(template) ? persistRemote === undefined : persistRemote !== undefined)
  )
    return false
  placements += 1
  const nextSession: MoveSession = {
    id,
    ...(persistRemote === undefined ? {} : { persistRemote }),
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
  listen(true)
  // Starting announces itself, as finishing and resuming do. Every surface that has to react to a
  // live placement — the overlay controls' own keyboard rule among them — reacts on a frame, and a
  // placement begun from the panel over a still map would otherwise wait for one that never comes.
  try {
    repaint()
  } catch (error) {
    warn('install', 'repaint after starting placement failed', error)
  }
  log('install', `move started for ${template.name}`)
  return true
}

const finish = (reserveNext = false): MoveReservation | null => {
  listen(false)
  setCursor('')
  session = null
  // The placement ending is state other surfaces render from — the overlay menu retires its
  // "finish the placement first" refusal off `isMoving()`. A move started from the panel only calls
  // back into the panel, so without this the refusal outlives the placement on a static map.
  //
  // Caught, like the completion callback below: a throw from page-owned canvas work would otherwise
  // reach `commit()`'s handler and be treated as a failed placement, re-arming capture listeners
  // for a session that has already been cleared and saved.
  try {
    repaint()
  } catch (error) {
    warn('install', 'repaint after placement failed', error)
  }
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
  // Resuming is a state change like any other, and `finish` announces its own. Without this a
  // failed save leaves a live placement over a map that may never paint again — nobody watching it
  // is told the session came back, and on a still map nothing else will say so.
  try {
    repaint()
  } catch (error) {
    warn('install', 'repaint after resuming placement failed', error)
  }
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
    if (current.persistRemote !== undefined) {
      if (!(await current.persistRemote(current.x, current.y))) {
        resumeAfterFailure('server placement')
        return
      }
    }
    if (!(await placeLocalTemplate(current.id, current.x, current.y))) {
      const durable = templateById(current.id)
      // The server already accepted this position. Do not reopen a placement whose next Apply
      // would create another version; discard the stale preview and let the manifest refresh land.
      if (current.persistRemote !== undefined) {
        clearLocalPreview(current.id)
        finish()
        return
      }
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
    const template = templateById(current.id)
    const saved =
      template !== undefined && template.source === 'image' && !template.everPlaced
        ? await removeLocalTemplate(current.id)
        : clearLocalPreview(current.id)
    if (!saved) {
      const durable = templateById(current.id)
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
  const template = templateById(session.id)
  if (template === undefined) return null
  return { x: session.x, y: session.y, w: template.width, h: template.height }
}

export const TILE = TILE_SIZE
