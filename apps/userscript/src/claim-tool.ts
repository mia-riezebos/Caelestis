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
import { canvasPixelAt, screenProjection } from './main.js'
import type { TileFrame } from './tile-transform.js'
import { applyWplaceTheme } from './ui/theme.js'

/**
 * The region claim tool: a mode in which the map is a drawing surface.
 *
 * While it is open a transparent capture layer sits over the map, so a drag draws a shape instead
 * of panning. Everything else on the page keeps working: the paint drawer, the panel, the rail.
 * That is what lets the tool run in explore and in draft alike; it never asks Wplace to change
 * state, it only borrows the pointer above the canvas.
 *
 * One shape at a time, either new or one of the painter's saved claims. A drag on empty canvas
 * draws a new shape of the chosen kind. A click on one of your claims selects it for editing;
 * holding the command key (control elsewhere) and dragging moves it. The outer handle drags the
 * radius and rotation of a round shape, or the far corner of a box; the inner handle, stars only,
 * drags the inner radius. Enter saves, Delete removes, Escape leaves the tool.
 *
 * Every shape is whole pixels. Pointer positions are floored to the pixel under them, and the
 * shape model has no fractional field, so nothing here can produce a half-pixel claim.
 */

const CAPTURE_ID = 'caelestis-claim-capture'
const TOOLBAR_ID = 'caelestis-claim-toolbar'
const HANDLE_RADIUS_CSS = 7
const DEFAULT_INNER_RATIO = 0.5

type DragMode = 'draw' | 'outer' | 'inner' | 'move'

interface Drag {
  readonly mode: DragMode
  readonly pointerId: number
  /** Canvas pixel where the gesture started: the anchor corner, the centre, or the grab point. */
  readonly originX: number
  readonly originY: number
  /** The shape as it was when a move began. */
  readonly base: RegionShape | null
}

export interface ClaimToolRegion {
  readonly id: string
  readonly shape: RegionShape
}

export interface ClaimToolHost {
  /** The template a shape lands on, by name, or null. */
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
let active = false
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
let hovering = false
let capture: HTMLDivElement | null = null
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

const isCommand = (event: PointerEvent | KeyboardEvent): boolean => event.metaKey || event.ctrlKey

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

export const isClaimToolActive = (): boolean => active

/** The shape being drawn or edited, for the presence layer to preview. */
export const claimToolShape = (): RegionShape | null => (active ? shape : null)

/** The saved claim currently loaded into the tool, so its stored copy can be drawn dimmed. */
export const claimToolEditingId = (): string | null => (active ? editingId : null)

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
    const round = shape as Extract<RegionShape, { readonly r: number }>
    shape = box(
      kind,
      round.cx - round.r,
      round.cy - round.r,
      round.cx + round.r - 1,
      round.cy + round.r - 1,
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

const ensureCapture = (): HTMLDivElement => {
  if (capture?.isConnected) return capture
  capture = document.createElement('div')
  capture.id = CAPTURE_ID
  Object.assign(capture.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '18',
    cursor: 'crosshair',
    touchAction: 'none',
    userSelect: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  capture.addEventListener('pointerdown', onPointerDown)
  capture.addEventListener('pointermove', onPointerMove)
  capture.addEventListener('pointerup', onPointerEnd)
  capture.addEventListener('pointercancel', onPointerEnd)
  capture.addEventListener('contextmenu', (event) => event.preventDefault())
  outerHandle = handle('Resize', 'outer')
  innerHandle = handle('Inner radius', 'inner')
  capture.append(outerHandle, innerHandle)
  document.body.appendChild(capture)
  return capture
}

const handle = (label: string, mode: 'outer' | 'inner'): HTMLDivElement => {
  const element = document.createElement('div')
  element.setAttribute('role', 'slider')
  element.setAttribute('aria-label', label)
  element.dataset.mode = mode
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
    background: mode === 'outer' ? 'rgb(30 144 255 / 0.9)' : 'rgb(255 160 40 / 0.9)',
    boxShadow: '0 1px 3px rgb(0 0 0 / 0.5)',
    cursor: mode === 'outer' ? 'nwse-resize' : 'ew-resize',
    display: 'none',
    touchAction: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  return element
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

const syncToolbar = (): void => {
  if (toolbar !== null && active) toolbar.model = claimToolModel()
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
  if (outerHandle === null || innerHandle === null) return
  const shown = active && drag === null && shape !== null && !pending
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

const setCursor = (value: string): void => {
  if (capture !== null && capture.style.cursor !== value) capture.style.cursor = value
}

/** Whichever of your saved claims sits under a canvas pixel, or the current shape. */
const shapeUnder = (
  x: number,
  y: number,
): { readonly id: string | null; readonly shape: RegionShape } | null => {
  if (shape !== null && regionShapeContainsPixel(shape, x, y)) return { id: editingId, shape }
  for (const region of host?.myRegions() ?? []) {
    if (region.id !== editingId && regionShapeContainsPixel(region.shape, x, y)) return region
  }
  return null
}

const onPointerDown = (event: PointerEvent): void => {
  if (!active || pending || drag !== null || event.button !== 0) return
  const target = event.target as HTMLElement | null
  const handleMode = target?.dataset.mode as 'outer' | 'inner' | undefined
  const point = canvasPixelAt(event.clientX, event.clientY)
  if (point === null) return
  const px = pixel(point.x)
  const py = pixel(point.y)
  event.preventDefault()
  event.stopPropagation()
  ensureCapture().setPointerCapture(event.pointerId)
  message = undefined
  if (handleMode !== undefined && shape !== null) {
    const origin =
      shape.kind === 'rectangle' || shape.kind === 'ellipse'
        ? { x: shape.x, y: shape.y }
        : { x: shape.cx, y: shape.cy }
    drag = {
      mode: handleMode,
      pointerId: event.pointerId,
      originX: origin.x,
      originY: origin.y,
      base: shape,
    }
    notify()
    return
  }
  const under = shapeUnder(px, py)
  if (under !== null) {
    // A click selects; a command-drag moves. Both load the claim into the tool for editing.
    editingId = under.id
    shape = under.shape
    kind = under.shape.kind
    if (under.shape.kind === 'polygon') sides = under.shape.sides
    if (under.shape.kind === 'star') {
      points = under.shape.points
      innerRatio = under.shape.inner / under.shape.r
    }
    drag = isCommand(event)
      ? { mode: 'move', pointerId: event.pointerId, originX: px, originY: py, base: under.shape }
      : null
    if (drag === null) {
      try {
        capture?.releasePointerCapture(event.pointerId)
      } catch {
        // Already released.
      }
    }
    notify()
    return
  }
  editingId = null
  drag = { mode: 'draw', pointerId: event.pointerId, originX: px, originY: py, base: null }
  shape = shapeFrom(kind, px, py, px, py)
  notify()
}

const onPointerMove = (event: PointerEvent): void => {
  if (!active) return
  const point = canvasPixelAt(event.clientX, event.clientY)
  if (point === null) return
  const px = pixel(point.x)
  const py = pixel(point.y)
  if (drag === null) {
    const over = shapeUnder(px, py) !== null
    if (over !== hovering) {
      hovering = over
      setCursor(over ? (isCommand(event) ? 'move' : 'pointer') : 'crosshair')
    } else if (over) setCursor(isCommand(event) ? 'move' : 'pointer')
    return
  }
  if (event.pointerId !== drag.pointerId) return
  event.preventDefault()
  switch (drag.mode) {
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
      if (drag.base === null) return
      shape = translateRegionShape(drag.base, px - drag.originX, py - drag.originY)
      break
  }
  notify()
}

const onPointerEnd = (event: PointerEvent): void => {
  if (drag === null || event.pointerId !== drag.pointerId) return
  try {
    capture?.releasePointerCapture(event.pointerId)
  } catch {
    // Already released.
  }
  drag = null
  notify()
}

const isTyping = (target: EventTarget | null): boolean => {
  let node = target as (Element & { shadowRoot?: ShadowRoot | null }) | null
  while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement as typeof node
  const tag = node?.tagName?.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

const onKeydown = (event: KeyboardEvent): void => {
  if (!active || isTyping(event.target)) return
  const key = event.key.toLowerCase()
  const claimIt = (): void => {
    event.preventDefault()
    event.stopPropagation()
  }
  if (key === 'escape') {
    claimIt()
    stopClaimTool()
  } else if (key === 'enter') {
    claimIt()
    void commitClaim()
  } else if (key === 'delete' || key === 'backspace') {
    claimIt()
    void deleteCurrent()
  } else if (key === 'm' && !isCommand(event) && !event.altKey) {
    claimIt()
    handleClaimToolIntent({ type: 'set-kind', kind: 'rectangle' })
  } else if (key === 'l' && !isCommand(event) && !event.altKey) {
    claimIt()
    handleClaimToolIntent({ type: 'set-kind', kind: 'ellipse' })
  }
}

const commitClaim = async (): Promise<void> => {
  if (!active || pending || shape === null || host === null) return
  const held = shape
  const id = editingId
  if (host.templateFor(held) === null) {
    message = 'The shape does not touch a server template.'
    notify()
    return
  }
  pending = true
  message = undefined
  notify()
  const error = await host.save(id, held)
  pending = false
  if (!active) return
  if (error === null) {
    // Saved: the claim now lives in the presence list, so the tool lets go of it.
    shape = null
    editingId = null
    notify()
  } else {
    message = error
    notify()
  }
}

const deleteCurrent = async (): Promise<void> => {
  if (!active || pending || shape === null || host === null) return
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
  if (!active) return
  if (error === null) {
    shape = null
    editingId = null
  } else message = error
  notify()
}

export const handleClaimToolIntent = (intent: ClaimToolIntent): void => {
  if (!active) return
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
      if (editingId !== null) {
        // Done editing: drop the local copy and show the saved one again.
        shape = null
        editingId = null
        break
      }
      stopClaimTool()
      return
  }
  message = undefined
  notify()
}

/** Open the tool, optionally with a shape kind already chosen. The host owns persistence. */
export const startClaimTool = (toolHost: ClaimToolHost, initialKind?: RegionShapeKind): void => {
  if (initialKind !== undefined) kind = initialKind
  if (active) {
    if (initialKind !== undefined) {
      reshape()
      notify()
    }
    return
  }
  host = toolHost
  active = true
  shape = null
  editingId = null
  drag = null
  pending = false
  message = undefined
  hovering = false
  ensureCapture().style.display = 'block'
  setCursor('crosshair')
  ensureToolbar()
  document.addEventListener('keydown', onKeydown, true)
  notify()
}

export const stopClaimTool = (): void => {
  if (!active) return
  active = false
  drag = null
  shape = null
  editingId = null
  pending = false
  message = undefined
  hovering = false
  document.removeEventListener('keydown', onKeydown, true)
  if (capture !== null) capture.style.display = 'none'
  toolbar?.remove()
  toolbar = null
  const finished = host
  host = null
  for (const listener of listeners) listener()
  finished?.changed()
  syncHandles()
}

/** Follow the map: handles move with the canvas, and the shape preview repaints with it. */
export const syncClaimToolFrame = (_frame: TileFrame): void => {
  if (active) syncHandles()
}

/** Test seam. */
export const resetClaimTool = (): void => {
  stopClaimTool()
  listeners.length = 0
  kind = 'rectangle'
  sides = 6
  points = 5
  innerRatio = DEFAULT_INNER_RATIO
  pixelCache = null
  capture?.remove()
  capture = null
  outerHandle = null
  innerHandle = null
}
