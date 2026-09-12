import {
  MAX_REGION_SHAPE_CORNERS,
  MAX_REGION_SHAPE_EXTENT,
  MIN_REGION_SHAPE_CORNERS,
  type RegionShape,
  type RegionShapeKind,
  regionShapeContainsPixel,
  regionShapeOutline,
  regionShapePixels,
  translateRegionShape,
  WORLD_PIXELS,
} from '@caelestis/shared'
import { CLAIM_TOOL_TAG, type ClaimToolIntent, type ClaimToolModel } from '@caelestis/ui/elements'
import { warn } from './debug.js'
import { canvasPixelAt, isMapInteractionTarget, screenProjection } from './main.js'
import { isMoving } from './templates/move.js'
import type { TileFrame } from './tile-transform.js'
import { applyWplaceTheme } from './ui/theme.js'
import { isPaintOpen } from './wplace-paint.js'

/**
 * Region claims on the map: drawing new ones, and editing the ones you own.
 *
 * Nothing sits over the map. Pointer events are watched at the window in the capture phase, the
 * same way template placement does it, and a pointer is claimed only when it lands on the map and
 * means something here: a drag while a shape tool is selected, or a press on one of your claims.
 * Everything else, including the wheel, reaches Wplace untouched, so the map zooms and pans as
 * usual with a tool selected.
 *
 * Three modes:
 *
 * - `off`: the default. In explore mode (no paint drawer, no template placement) a press on one of
 *   your own claims takes the pointer: a click selects it, a drag moves it. Anywhere else the map
 *   pans as usual. While painting or placing a template, claims are not interactive at all.
 * - `draw`: a shape kind is selected, from the rail, M, or L. A drag anywhere draws it, claims
 *   underneath included. Saving the claim switches the tool off again.
 * - `edit`: one of your saved claims is selected. Handles resize, rotate, or set the inner radius;
 *   dragging the shape moves it; Enter saves; Delete removes; Escape deselects. A press on empty
 *   canvas deselects and still pans.
 *
 * Every shape is whole pixels. Pointer positions are floored to the pixel under them, and the
 * shape model has no fractional field, so nothing here can produce a half-pixel claim.
 */

const HANDLES_ID = 'caelestis-claim-handles'
const TOOLBAR_ID = 'caelestis-claim-toolbar'
const HANDLE_RADIUS_CSS = 7
const DEFAULT_INNER_RATIO = 0.5
/** How far, in CSS pixels, a press may travel and still count as a click. */
const CLICK_SLOP_PX = 4

export type ClaimToolMode = 'off' | 'draw' | 'edit'
type DragMode = 'draw' | 'outer' | 'inner' | 'move' | 'press'

interface Drag {
  readonly mode: DragMode
  readonly pointerId: number
  /** Canvas pixel where the gesture started: the anchor corner, the centre, or the grab point. */
  readonly originX: number
  readonly originY: number
  readonly clientX: number
  readonly clientY: number
  /** The shape as it was when a move began. */
  readonly base: RegionShape | null
}

export interface ClaimToolRegion {
  readonly id: string
  readonly shape: RegionShape
}

export interface ClaimToolHost {
  /** The template a shape happens to overlap, by name, or null. Information only; never a gate. */
  readonly templateFor: (shape: RegionShape) => string | null
  /** This painter's saved claims, selectable for editing. */
  readonly myRegions: () => readonly ClaimToolRegion[]
  /** Persist a new or edited claim. Resolves to an error message, or null on success. */
  readonly save: (id: string | null, shape: RegionShape) => Promise<string | null>
  /** Remove a saved claim. Resolves to an error message, or null on success. */
  readonly remove: (id: string) => Promise<string | null>
  readonly changed: () => void
}

let host: ClaimToolHost | null = null
let installed = false
let mode: ClaimToolMode = 'off'
let kind: RegionShapeKind = 'rectangle'
let sides = 6
let points = 5
let innerRatio = DEFAULT_INNER_RATIO
let shape: RegionShape | null = null
/** The saved claim `shape` came from, when editing rather than drawing. */
let editingId: string | null = null
let drag: Drag | null = null
let pending = false
let message: string | undefined
let cursor = ''
let handles: HTMLDivElement | null = null
let outerHandle: HTMLDivElement | null = null
let innerHandle: HTMLDivElement | null = null
let toolbar: (HTMLElement & { model: ClaimToolModel }) | null = null
let pixelCache: { shape: RegionShape; count: number } | null = null
const listeners: (() => void)[] = []

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)))

const pixel = (value: number): number => Math.min(WORLD_PIXELS - 1, Math.max(0, Math.floor(value)))

const degrees = (dx: number, dy: number): number =>
  ((Math.round((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360

const isCommand = (event: PointerEvent | KeyboardEvent | MouseEvent): boolean =>
  event.metaKey || event.ctrlKey

const pixelCount = (): number => {
  if (shape === null) return 0
  if (pixelCache?.shape !== shape) pixelCache = { shape, count: regionShapePixels(shape).count }
  return pixelCache.count
}

const notify = (): void => {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      warn('install', 'claim tool listener failed', String(error))
    }
  }
  host?.changed()
  syncToolbar()
  syncHandles()
}

export const onClaimToolChange = (listener: () => void): void => {
  listeners.push(listener)
}

export const claimToolMode = (): ClaimToolMode => mode

/** Whether the tool has anything on screen: a shape being drawn or a claim being edited. */
export const isClaimToolActive = (): boolean => mode !== 'off'

/** The shape being drawn or edited, for the presence layer to preview. */
export const claimToolShape = (): RegionShape | null => (mode === 'off' ? null : shape)

/** The saved claim currently loaded into the tool, so its stored copy can be drawn dimmed. */
export const claimToolEditingId = (): string | null => (mode === 'off' ? null : editingId)

export const claimToolModel = (): ClaimToolModel => ({
  kind,
  sides,
  points,
  minCorners: MIN_REGION_SHAPE_CORNERS,
  maxCorners: MAX_REGION_SHAPE_CORNERS,
  drawn: shape !== null,
  editing: editingId !== null,
  template: shape === null ? null : (host?.templateFor(shape) ?? null),
  pixels: pixelCount(),
  pending,
  ...(message === undefined ? {} : { message }),
})

/** A box from two pixels, inclusive of both, capped at the largest allowed side. */
const box = (
  boxKind: 'rectangle' | 'ellipse',
  ax: number,
  ay: number,
  bx: number,
  by: number,
): RegionShape => {
  const left = Math.min(ax, bx)
  const top = Math.min(ay, by)
  const w = clampInt(Math.abs(bx - ax) + 1, 1, MAX_REGION_SHAPE_EXTENT)
  const h = clampInt(Math.abs(by - ay) + 1, 1, MAX_REGION_SHAPE_EXTENT)
  return { kind: boxKind, x: left, y: top, w, h }
}

/** The shape of the current kind from an anchor pixel and the pointer pixel. */
const shapeFrom = (
  shapeKind: RegionShapeKind,
  originX: number,
  originY: number,
  x: number,
  y: number,
): RegionShape => {
  if (shapeKind === 'rectangle' || shapeKind === 'ellipse')
    return box(shapeKind, originX, originY, x, y)
  const dx = x - originX
  const dy = y - originY
  const r = clampInt(Math.hypot(dx, dy), 1, MAX_REGION_SHAPE_EXTENT / 2)
  const rotation = degrees(dx, dy)
  if (shapeKind === 'polygon')
    return { kind: shapeKind, cx: originX, cy: originY, r, sides, rotation }
  const inner = clampInt(r * innerRatio, 1, Math.max(1, r - 1))
  return { kind: shapeKind, cx: originX, cy: originY, r, inner, points, rotation }
}

/** Reshape after a kind or count change, keeping what was drawn where it was. */
const reshape = (): void => {
  if (shape === null) return
  if (kind === 'rectangle' || kind === 'ellipse') {
    if (shape.kind === 'rectangle' || shape.kind === 'ellipse') {
      shape = { kind, x: shape.x, y: shape.y, w: shape.w, h: shape.h }
      return
    }
    shape = box(
      kind,
      shape.cx - shape.r,
      shape.cy - shape.r,
      shape.cx + shape.r - 1,
      shape.cy + shape.r - 1,
    )
    return
  }
  const centre =
    shape.kind === 'rectangle' || shape.kind === 'ellipse'
      ? { x: shape.x + Math.floor(shape.w / 2), y: shape.y + Math.floor(shape.h / 2) }
      : { x: shape.cx, y: shape.cy }
  const r =
    shape.kind === 'rectangle' || shape.kind === 'ellipse'
      ? Math.max(1, Math.floor(Math.min(shape.w, shape.h) / 2))
      : shape.r
  const rotation = shape.kind === 'polygon' || shape.kind === 'star' ? shape.rotation : 0
  const angle = (rotation * Math.PI) / 180
  shape = shapeFrom(
    kind,
    centre.x,
    centre.y,
    centre.x + Math.cos(angle) * r,
    centre.y + Math.sin(angle) * r,
  )
}

const handle = (label: string, handleMode: 'outer' | 'inner'): HTMLDivElement => {
  const element = document.createElement('div')
  element.setAttribute('role', 'slider')
  element.setAttribute('aria-label', label)
  element.dataset.mode = handleMode
  Object.assign(element.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    inlineSize: `${HANDLE_RADIUS_CSS * 2}px`,
    blockSize: `${HANDLE_RADIUS_CSS * 2}px`,
    marginLeft: `-${HANDLE_RADIUS_CSS}px`,
    marginTop: `-${HANDLE_RADIUS_CSS}px`,
    borderRadius: '50%',
    border: '2px solid #fff',
    background: handleMode === 'outer' ? 'rgb(30 144 255 / 0.9)' : 'rgb(255 160 40 / 0.9)',
    boxShadow: '0 1px 3px rgb(0 0 0 / 0.5)',
    cursor: handleMode === 'outer' ? 'nwse-resize' : 'ew-resize',
    display: 'none',
    pointerEvents: 'auto',
    touchAction: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  return element
}

/** The handle overlay lets everything through except the handles themselves. */
const ensureHandles = (): HTMLDivElement => {
  if (handles?.isConnected) return handles
  handles = document.createElement('div')
  handles.id = HANDLES_ID
  Object.assign(handles.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '18',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  outerHandle = handle('Resize', 'outer')
  innerHandle = handle('Inner radius', 'inner')
  handles.append(outerHandle, innerHandle)
  document.body.appendChild(handles)
  return handles
}

const ensureToolbar = (): void => {
  if (toolbar?.isConnected) return
  const element = document.createElement(CLAIM_TOOL_TAG) as HTMLElement & { model: ClaimToolModel }
  element.id = TOOLBAR_ID
  Object.assign(element.style, {
    position: 'fixed',
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '26',
  } satisfies Partial<CSSStyleDeclaration>)
  applyWplaceTheme(element)
  element.addEventListener('caelestis-claim-tool-intent', (event) => {
    handleClaimToolIntent((event as CustomEvent<ClaimToolIntent>).detail)
  })
  element.model = claimToolModel()
  document.body.appendChild(element)
  toolbar = element
}

const removeToolbar = (): void => {
  toolbar?.remove()
  toolbar = null
}

const syncToolbar = (): void => {
  if (mode === 'off') removeToolbar()
  else {
    ensureToolbar()
    if (toolbar !== null) toolbar.model = claimToolModel()
  }
}

/** Where the two handles sit for the current shape, in client CSS pixels. */
const handlePositions = (): {
  readonly outer: { x: number; y: number } | null
  readonly inner: { x: number; y: number } | null
} => {
  if (shape === null) return { outer: null, inner: null }
  const projection = screenProjection()
  if (projection === null) return { outer: null, inner: null }
  const ring = regionShapeOutline(shape)
  const outerPoint =
    shape.kind === 'rectangle' || shape.kind === 'ellipse'
      ? { x: shape.x + shape.w, y: shape.y + shape.h }
      : ring[0]
  const innerPoint = shape.kind === 'star' ? ring[1] : undefined
  return {
    outer: outerPoint === undefined ? null : projection.pointFor(outerPoint.x, outerPoint.y),
    inner: innerPoint === undefined ? null : projection.pointFor(innerPoint.x, innerPoint.y),
  }
}

const syncHandles = (): void => {
  if (mode === 'off' && handles === null) return
  ensureHandles()
  if (outerHandle === null || innerHandle === null) return
  const shown =
    mode !== 'off' && (drag === null || drag.mode === 'press') && shape !== null && !pending
  const { outer, inner } = shown ? handlePositions() : { outer: null, inner: null }
  for (const [element, position] of [
    [outerHandle, outer],
    [innerHandle, inner],
  ] as const) {
    if (position === null) {
      element.style.display = 'none'
      continue
    }
    element.style.display = 'block'
    element.style.transform = `translate(${Math.round(position.x)}px, ${Math.round(position.y)}px)`
  }
}

/** Borrow the map's own cursor, like placement does, and give it back when done. */
const setCursor = (value: string): void => {
  if (cursor === value) return
  cursor = value
  const canvas = document.querySelector<HTMLElement>('canvas.maplibregl-canvas')
  if (canvas !== null) canvas.style.cursor = value
}

/** Whichever of your saved claims sits under a canvas pixel, or the current shape. */
const shapeUnder = (
  x: number,
  y: number,
): { readonly id: string | null; readonly shape: RegionShape } | null => {
  if (mode !== 'off' && shape !== null && regionShapeContainsPixel(shape, x, y))
    return { id: editingId, shape }
  for (const region of host?.myRegions() ?? []) {
    if (region.id !== editingId && regionShapeContainsPixel(region.shape, x, y)) return region
  }
  return null
}

/** Load a saved claim into the tool for editing. */
const select = (region: { readonly id: string | null; readonly shape: RegionShape }): void => {
  editingId = region.id
  shape = region.shape
  kind = region.shape.kind
  if (region.shape.kind === 'polygon') sides = region.shape.sides
  if (region.shape.kind === 'star') {
    points = region.shape.points
    innerRatio = region.shape.inner / region.shape.r
  }
  if (mode === 'off') mode = 'edit'
  if (region.id !== null) mode = 'edit'
}

const deselect = (): void => {
  shape = null
  editingId = null
  drag = null
  pending = false
  message = undefined
  if (mode === 'edit') mode = 'off'
}

/** Explore mode: no paint drawer and no template being placed, so the pointer is free. */
const exploring = (): boolean => !isPaintOpen() && !isMoving()

/** A press outside the panel and dialogs, on the map itself. */
const isMapPress = (event: PointerEvent): boolean => {
  const target = event.target
  if (target === null || !(target instanceof Element)) return false
  if (target.closest('dialog,[role="dialog"],button,input,select,textarea,a,[role="button"]'))
    return false
  return isMapInteractionTarget(target)
}

const consume = (event: Event): void => {
  event.preventDefault()
  event.stopPropagation()
}

/** Eat the click that follows a consumed press, so Wplace never sees it as a pixel placement. */
const swallowNextClick = (): void => {
  const swallow = (event: Event): void => {
    window.removeEventListener('click', swallow, true)
    clearTimeout(timer)
    consume(event)
  }
  const timer = setTimeout(() => window.removeEventListener('click', swallow, true), 400)
  window.addEventListener('click', swallow, true)
}

const onPointerDown = (event: PointerEvent): void => {
  if (host === null || pending || drag !== null || event.button !== 0) return
  const target = event.target as HTMLElement | null
  const handleMode = target?.dataset.mode as 'outer' | 'inner' | undefined
  if (handleMode !== undefined && target !== null && mode !== 'off' && shape !== null) {
    consume(event)
    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      // Not every target can capture; window listeners still see the moves.
    }
    const origin =
      shape.kind === 'rectangle' || shape.kind === 'ellipse'
        ? { x: shape.x, y: shape.y }
        : { x: shape.cx, y: shape.cy }
    drag = {
      mode: handleMode,
      pointerId: event.pointerId,
      originX: origin.x,
      originY: origin.y,
      clientX: event.clientX,
      clientY: event.clientY,
      base: shape,
    }
    message = undefined
    notify()
    return
  }
  if (!isMapPress(event)) return
  const point = canvasPixelAt(event.clientX, event.clientY)
  if (point === null) return
  const px = pixel(point.x)
  const py = pixel(point.y)
  if (mode === 'draw') {
    consume(event)
    editingId = null
    drag = {
      mode: 'draw',
      pointerId: event.pointerId,
      originX: px,
      originY: py,
      clientX: event.clientX,
      clientY: event.clientY,
      base: null,
    }
    shape = shapeFrom(kind, px, py, px, py)
    message = undefined
    notify()
    return
  }
  // Explore mode only: painting and template placement own the pointer for their own reasons.
  if (!exploring()) return
  const under = shapeUnder(px, py)
  if (under !== null) {
    consume(event)
    select(under)
    // A press that stays put is a click and selects; one that travels becomes a move.
    drag = {
      mode: 'press',
      pointerId: event.pointerId,
      originX: px,
      originY: py,
      clientX: event.clientX,
      clientY: event.clientY,
      base: under.shape,
    }
    message = undefined
    notify()
    return
  }
  if (mode === 'edit') {
    // Empty canvas ends the edit and the press goes on to pan the map as usual.
    deselect()
    notify()
  }
}

const onPointerMove = (event: PointerEvent): void => {
  if (host === null) return
  if (drag === null) {
    // Hover feedback only; the map keeps the event.
    if (!isMapPress(event)) {
      if (mode === 'off') setCursor('')
      return
    }
    if (mode === 'draw') {
      setCursor('crosshair')
      return
    }
    const point = canvasPixelAt(event.clientX, event.clientY)
    const over =
      exploring() && point !== null && shapeUnder(pixel(point.x), pixel(point.y)) !== null
    setCursor(over ? 'grab' : '')
    return
  }
  if (event.pointerId !== drag.pointerId) return
  consume(event)
  const point = canvasPixelAt(event.clientX, event.clientY)
  if (point === null) return
  const px = pixel(point.x)
  const py = pixel(point.y)
  switch (drag.mode) {
    case 'press': {
      // A press that travels past the click slop becomes a move.
      const moved =
        Math.abs(event.clientX - drag.clientX) > CLICK_SLOP_PX ||
        Math.abs(event.clientY - drag.clientY) > CLICK_SLOP_PX
      if (!moved) return
      drag = { ...drag, mode: 'move' }
      setCursor('grabbing')
      break
    }
    case 'draw':
      shape = shapeFrom(kind, drag.originX, drag.originY, px, py)
      break
    case 'outer':
      if (shape === null) return
      shape =
        shape.kind === 'rectangle' || shape.kind === 'ellipse'
          ? box(
              shape.kind,
              drag.originX,
              drag.originY,
              Math.max(drag.originX, px),
              Math.max(drag.originY, py),
            )
          : shapeFrom(shape.kind, drag.originX, drag.originY, px, py)
      break
    case 'inner': {
      if (shape?.kind !== 'star') return
      const inner = clampInt(Math.hypot(px - shape.cx, py - shape.cy), 1, Math.max(1, shape.r - 1))
      innerRatio = inner / shape.r
      shape = { ...shape, inner }
      break
    }
    case 'move':
      break
  }
  if (drag.mode === 'move' && drag.base !== null)
    shape = translateRegionShape(drag.base, px - drag.originX, py - drag.originY)
  notify()
}

const onPointerEnd = (event: PointerEvent): void => {
  if (drag === null || event.pointerId !== drag.pointerId) return
  consume(event)
  swallowNextClick()
  drag = null
  if (mode !== 'draw') setCursor('grab')
  notify()
}

const isTyping = (target: EventTarget | null): boolean => {
  let node = target as (Element & { shadowRoot?: ShadowRoot | null }) | null
  while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement as typeof node
  const tag = node?.tagName?.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

const onKeydown = (event: KeyboardEvent): void => {
  if (mode === 'off' || isTyping(event.target)) return
  const key = event.key.toLowerCase()
  const take = (): void => consume(event)
  if (key === 'escape') {
    take()
    if (mode === 'edit') {
      deselect()
      notify()
    } else stopClaimTool()
  } else if (key === 'enter') {
    take()
    void commitClaim()
  } else if (key === 'delete' || key === 'backspace') {
    take()
    void deleteCurrent()
  } else if (key === 'm' && !isCommand(event) && !event.altKey) {
    take()
    handleClaimToolIntent({ type: 'set-kind', kind: 'rectangle' })
  } else if (key === 'l' && !isCommand(event) && !event.altKey) {
    take()
    handleClaimToolIntent({ type: 'set-kind', kind: 'ellipse' })
  }
}

const commitClaim = async (): Promise<void> => {
  if (mode === 'off' || pending || shape === null || host === null) return
  const held = shape
  const id = editingId
  pending = true
  message = undefined
  notify()
  const error = await host.save(id, held)
  pending = false
  // Read through the accessor: the tool may have been switched off during the await.
  if (claimToolMode() === 'off') return
  if (error === null) {
    // Saved: the claim now lives in the presence list, and the tool is done.
    stopClaimTool()
  } else {
    message = error
    notify()
  }
}

const deleteCurrent = async (): Promise<void> => {
  if (mode === 'off' || pending || shape === null || host === null) return
  if (editingId === null) {
    shape = null
    notify()
    return
  }
  pending = true
  message = undefined
  notify()
  const error = await host.remove(editingId)
  pending = false
  // Read through the accessor: the tool may have been switched off during the await.
  if (claimToolMode() === 'off') return
  if (error === null) stopClaimTool()
  else {
    message = error
    notify()
  }
}

export const handleClaimToolIntent = (intent: ClaimToolIntent): void => {
  if (mode === 'off') return
  switch (intent.type) {
    case 'set-kind':
      kind = intent.kind
      reshape()
      break
    case 'set-sides':
      sides = clampInt(intent.sides, MIN_REGION_SHAPE_CORNERS, MAX_REGION_SHAPE_CORNERS)
      reshape()
      break
    case 'set-points':
      points = clampInt(intent.points, MIN_REGION_SHAPE_CORNERS, MAX_REGION_SHAPE_CORNERS)
      reshape()
      break
    case 'claim':
      void commitClaim()
      return
    case 'delete':
      void deleteCurrent()
      return
    case 'cancel':
      if (mode === 'edit') {
        deselect()
        break
      }
      stopClaimTool()
      return
  }
  message = undefined
  notify()
}

/**
 * Wire the tool to its host once. Listeners stay installed for the life of the page, since your
 * claims are editable with no tool selected; they cost a hit test per pointer event on the map.
 */
export const installClaimTool = (toolHost: ClaimToolHost): void => {
  host = toolHost
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerEnd, true)
  window.addEventListener('pointercancel', onPointerEnd, true)
  window.addEventListener('keydown', onKeydown, true)
}

/** Select a shape kind to draw. Also switches an edit back to drawing that kind. */
export const startClaimTool = (initialKind?: RegionShapeKind): void => {
  if (host === null) return
  if (initialKind !== undefined) kind = initialKind
  if (mode === 'draw') {
    reshape()
    notify()
    return
  }
  mode = 'draw'
  if (editingId !== null) {
    // A selected claim stays selected; the new kind reshapes it.
    reshape()
  } else {
    shape = null
  }
  drag = null
  pending = false
  message = undefined
  setCursor('crosshair')
  notify()
}

/** Leave both drawing and editing. Nothing unsaved survives this. */
export const stopClaimTool = (): void => {
  if (mode === 'off') return
  mode = 'off'
  drag = null
  shape = null
  editingId = null
  pending = false
  message = undefined
  setCursor('')
  removeToolbar()
  syncHandles()
  for (const listener of listeners) listener()
  host?.changed()
}

/** Follow the map: handles move with the canvas, and the shape preview repaints with it. */
export const syncClaimToolFrame = (_frame: TileFrame): void => {
  if (mode !== 'off') syncHandles()
}

/** Test seam. */
export const resetClaimTool = (): void => {
  stopClaimTool()
  if (installed) {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', onPointerEnd, true)
    window.removeEventListener('pointercancel', onPointerEnd, true)
    window.removeEventListener('keydown', onKeydown, true)
    installed = false
  }
  host = null
  listeners.length = 0
  kind = 'rectangle'
  sides = 6
  points = 5
  innerRatio = DEFAULT_INNER_RATIO
  pixelCache = null
  handles?.remove()
  handles = null
  outerHandle = null
  innerHandle = null
}
