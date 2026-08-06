import { TILE_SIZE } from '@wts/shared'
import { log } from '../debug.js'
import { canvasPixelAt, pixelsPerCanvasPixel } from '../main.js'
import { icon } from '../ui/icons.js'
import {
  localTemplates,
  markPlaced,
  moveLocalTemplate,
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
  readonly originalX: number
  readonly originalY: number
  x: number
  y: number
  dragging: { pointerX: number; pointerY: number; startX: number; startY: number } | null
}

let session: MoveSession | null = null
let onFinish: (() => void) | null = null

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
  hint.textContent = `${MODIFIER_HINT}+drag to move · middle-click to centre here`

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
  if (session === null) return
  // Middle click: jump, do not drag. A long move should not require dragging the whole way.
  if (event.button === 1) {
    const point = canvasPixelAt(event.clientX, event.clientY)
    const template = localTemplates().find((candidate) => candidate.id === session?.id)
    if (point === null || template === undefined) return
    event.preventDefault()
    session.x = Math.round(point.x - template.width / 2)
    session.y = Math.round(point.y - template.height / 2)
    void moveLocalTemplate(session.id, session.x, session.y)
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
  session.dragging = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    startX: session.x,
    startY: session.y,
  }
}

const onPointerMove = (event: PointerEvent): void => {
  if (session?.dragging == null) return
  event.preventDefault()
  event.stopPropagation()
  // Screen delta to canvas delta: one canvas pixel is many screen pixels when zoomed in.
  const scale = pixelsPerCanvasPixel()
  session.x = Math.round(
    session.dragging.startX + (event.clientX - session.dragging.pointerX) / scale,
  )
  session.y = Math.round(
    session.dragging.startY + (event.clientY - session.dragging.pointerY) / scale,
  )
  void moveLocalTemplate(session.id, session.x, session.y)
}

const onPointerUp = (): void => {
  if (session !== null) session.dragging = null
}

const onKeyDown = (event: KeyboardEvent): void => {
  if (session === null) return
  if (event.key === 'Escape') void abort()
  if (event.key === 'Enter') void commit()
}

const listen = (on: boolean): void => {
  const method = on ? 'addEventListener' : 'removeEventListener'
  // Capture phase: MapLibre's own handlers sit on the canvas container and would otherwise pan the
  // map out from under a drag that was meant for the template.
  window[method]('pointerdown', onPointerDown as EventListener, true)
  window[method]('pointermove', onPointerMove as EventListener, true)
  window[method]('pointerup', onPointerUp as EventListener, true)
  window[method]('keydown', onKeyDown as EventListener, true)
  // Middle click also opens autoscroll on some platforms.
  window[method]('auxclick', ((event: Event) => event.preventDefault()) as EventListener, true)
}

export const beginMove = (id: string, finished: () => void): void => {
  const template = localTemplates().find((candidate) => candidate.id === id)
  if (template === undefined) return
  session = {
    id,
    originalX: template.originX,
    originalY: template.originY,
    x: template.originX,
    y: template.originY,
    dragging: null,
  }
  onFinish = finished
  renderBar(template.name)
  listen(true)
  log('install', `move started for ${template.name}`)
}

const finish = (): void => {
  listen(false)
  document.querySelector('[data-wts-movebar]')?.remove()
  session = null
  onFinish?.()
  onFinish = null
}

export const commit = async (): Promise<void> => {
  if (session === null) return
  await moveLocalTemplate(session.id, session.x, session.y)
  markPlaced(session.id)
  log('install', 'placement applied', { x: session.x, y: session.y })
  finish()
}

/**
 * Cancel: put it back where it started.
 *
 * An image imported in this session has no "back" — it was never anywhere — so cancelling that
 * removes it. Leaving a template stranded somewhere nobody chose is worse than losing an import
 * that takes one click to repeat.
 */
export const abort = async (): Promise<void> => {
  if (session === null) return
  const template = localTemplates().find((candidate) => candidate.id === session?.id)
  if (template !== undefined && template.source === 'image' && !template.everPlaced) {
    removeLocalTemplate(session.id)
  } else {
    await moveLocalTemplate(session.id, session.originalX, session.originalY)
  }
  finish()
}

/** Tile-aligned bounds of the template being moved, for drawing its outline. */
export const moveOutline = (): { x: number; y: number; w: number; h: number } | null => {
  if (session === null) return null
  const template = localTemplates().find((candidate) => candidate.id === session?.id)
  if (template === undefined) return null
  return { x: session.x, y: session.y, w: template.width, h: template.height }
}

export const TILE = TILE_SIZE
