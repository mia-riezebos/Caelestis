import {
  MAX_PATH_NODES,
  MAX_REGION_ITEMS,
  MAX_REGION_SHAPE_CORNERS,
  MAX_REGION_SHAPE_EXTENT,
  MAX_STROKE_WIDTH,
  MIN_REGION_SHAPE_CORNERS,
  type PathNode,
  type Point,
  type RegionDocument,
  type RegionItem,
  type RegionShape,
  type RegionShapePixels,
  regionDocumentPixels,
  regionShapeBounds,
  regionShapeContainsPixel,
  regionShapeOutline,
  translateRegionShape,
  WORLD_PIXELS,
} from '@caelestis/shared'
import {
  CLAIM_MODE_TAG,
  type ClaimModeIntent,
  type ClaimModeModel,
  type ClaimTool,
  type ClaimToolEntry,
} from '@caelestis/ui/elements'
import { warn } from './debug.js'
import { canvasPixelAt, isMapInteractionTarget, screenProjection } from './main.js'
import type { TileFrame } from './tile-transform.js'
import { applyWplaceTheme } from './ui/theme.js'

/**
 * Claim mode: a small vector editor over the map.
 *
 * A claim is a document of shapes, each adding to or cutting from the claimed pixels, and every
 * shape stays editable. The drawer on the left holds the tools; the bar at the top holds the
 * options and the cancel or confirm buttons. Nothing sits over the map: pointer events are
 * watched at the window in the capture phase and consumed only when the tool in hand wants
 * them, so the wheel zooms and empty canvas pans throughout. Outside claim mode nothing here
 * listens at all.
 *
 * Tools, Illustrator-style: selection (click, drag to move, handles to resize or rotate), direct
 * selection (anchors and bezier handles of a path), pen (click for corners, drag for curves, click
 * the first anchor to close), pencil and brush (freehand strokes), and rectangle, ellipse,
 * polygon, and star. Everything the tools produce is whole pixels once rasterised, because the
 * shared rasteriser decides membership by pixel centre.
 */

const OVERLAY_ID = 'caelestis-claim-overlay'
const MODE_ID = 'caelestis-claim-mode'
const HANDLE_RADIUS_CSS = 5
const HIT_RADIUS_CSS = 9
const CLICK_SLOP_PX = 4
const STROKE_STEP_PX = 2
const DEFAULT_INNER = 50
const SVG_NS = 'http://www.w3.org/2000/svg'

export const CLAIM_TOOLS: readonly ClaimToolEntry[] = [
  { tool: 'select', label: 'Selection', key: 'V', icon: 'toolSelect' },
  { tool: 'direct', label: 'Direct selection', key: 'A', icon: 'toolDirect' },
  { tool: 'pen', label: 'Pen', key: 'P', icon: 'toolPen' },
  { tool: 'pencil', label: 'Pencil', key: 'N', icon: 'toolPencil' },
  { tool: 'brush', label: 'Brush', key: 'B', icon: 'toolBrush' },
  { tool: 'rectangle', label: 'Rectangle', key: 'M', icon: 'toolRectangle' },
  { tool: 'ellipse', label: 'Ellipse', key: 'L', icon: 'toolEllipse' },
  { tool: 'polygon', label: 'Polygon', key: '', icon: 'toolPolygon' },
  { tool: 'star', label: 'Star', key: '', icon: 'toolStar' },
]

const TOOL_KEYS: Record<string, ClaimTool> = {
  v: 'select',
  a: 'direct',
  p: 'pen',
  n: 'pencil',
  b: 'brush',
  m: 'rectangle',
  l: 'ellipse',
}

type DragKind = 'draw' | 'move' | 'corner' | 'outer' | 'inner' | 'node' | 'stroke' | 'pen'

interface Drag {
  readonly kind: DragKind
  readonly pointerId: number
  readonly originX: number
  readonly originY: number
  readonly clientX: number
  readonly clientY: number
  /** The item as it was when the gesture began. */
  readonly base: RegionItem | null
  /** For corner drags: which corner (0 tl, 1 tr, 2 br, 3 bl). For node drags: node index. */
  readonly index: number
  /** For node drags: which part of the node. */
  readonly part: 'anchor' | 'in' | 'out'
  moved: boolean
}

export interface ClaimEditorHost {
  /** The template the claim overlaps, by name, or null. Information only; never a gate. */
  readonly templateFor: (document: RegionDocument) => string | null
  /** Persist a new or edited claim. Resolves to an error message, or null on success. */
  readonly save: (id: string | null, document: RegionDocument) => Promise<string | null>
  /** Remove a saved claim. Resolves to an error message, or null on success. */
  readonly remove: (id: string) => Promise<string | null>
  readonly changed: () => void
}

let host: ClaimEditorHost | null = null
let installed = false
let active = false
let tool: ClaimTool = 'select'
let sides = 6
let points = 5
let inner = DEFAULT_INNER
let width = 8
let subtract = false
let items: RegionItem[] = []
let selectedId: string | null = null
/** The saved claim being edited, or null for a new one. */
let editingId: string | null = null
let drag: Drag | null = null
/** The pen path under construction. */
let pen: PathNode[] | null = null
/** The stroke under construction, as raw points. */
let stroke: Point[] | null = null
/** The shape under construction with a shape tool. */
let drawing: RegionShape | null = null
let pending = false
let message: string | undefined
let cursor = ''
let overlay: SVGSVGElement | null = null
let mode: (HTMLElement & { model: ClaimModeModel }) | null = null
let version = 0
let pixelCache: { version: number; pixels: RegionShapePixels | null } | null = null
let itemSeq = 0
const listeners: (() => void)[] = []

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)))

const pixel = (value: number): number => Math.min(WORLD_PIXELS - 1, Math.max(0, Math.floor(value)))

const degrees = (dx: number, dy: number): number =>
  ((Math.round((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360

const nextItemId = (): string => `i${Date.now().toString(36)}${(itemSeq++).toString(36)}`

const bump = (): void => {
  version++
}

const notify = (): void => {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      warn('install', 'claim editor listener failed', String(error))
    }
  }
  host?.changed()
  syncMode()
  syncOverlay()
}

export const onClaimEditorChange = (listener: () => void): void => {
  listeners.push(listener)
}

export const isClaimModeActive = (): boolean => active

export const claimEditorTool = (): ClaimTool => tool

/** The saved claim loaded into the editor, so its stored copy can step aside in the layer. */
export const claimEditorEditingId = (): string | null => (active ? editingId : null)

/** The shape being drawn right now, as a temporary item, so previews rasterise like the rest. */
const previewItem = (): RegionItem | null => {
  if (drawing !== null) return { id: 'preview', shape: drawing, op: subtract ? 'subtract' : 'add' }
  if (stroke !== null && stroke.length >= 2)
    return {
      id: 'preview',
      shape: { kind: 'path', closed: false, width: Math.max(1, width), nodes: stroke },
      op: subtract ? 'subtract' : 'add',
    }
  if (pen !== null && pen.length >= 2)
    return {
      id: 'preview',
      shape: { kind: 'path', closed: false, width: Math.max(1, width), nodes: pen },
      op: 'add',
    }
  return null
}

const workingDocument = (): RegionDocument => {
  const preview = previewItem()
  return { items: preview === null ? items : [...items, preview] }
}

/** The claim as pixels, including whatever is mid-gesture. Cached per change. */
export const claimEditorPixels = (): RegionShapePixels | null => {
  if (!active) return null
  if (pixelCache?.version !== version) {
    const document = workingDocument()
    pixelCache = {
      version,
      pixels: document.items.length === 0 ? null : regionDocumentPixels(document),
    }
  }
  return pixelCache.pixels
}

export const claimModeModel = (): ClaimModeModel => ({
  tool,
  tools: CLAIM_TOOLS,
  options: {
    ...(tool === 'polygon' ? { sides } : {}),
    ...(tool === 'star' ? { points, inner } : {}),
    ...(tool === 'pen' || tool === 'pencil' || tool === 'brush'
      ? { width: tool === 'pencil' ? 1 : width }
      : {}),
    minCorners: MIN_REGION_SHAPE_CORNERS,
    maxCorners: MAX_REGION_SHAPE_CORNERS,
    maxWidth: MAX_STROKE_WIDTH,
  },
  subtract,
  items: items.length,
  selected: selectedId !== null,
  editing: editingId !== null,
  template: items.length === 0 ? null : (host?.templateFor({ items }) ?? null),
  pixels: claimEditorPixels()?.count ?? 0,
  pending,
  ...(message === undefined ? {} : { message }),
})

const selectedItem = (): RegionItem | null => items.find((item) => item.id === selectedId) ?? null

const replaceItem = (id: string, shape: RegionShape): void => {
  items = items.map((item) => (item.id === id ? { ...item, shape } : item))
  bump()
}

const addItem = (shape: RegionShape): void => {
  if (items.length >= MAX_REGION_ITEMS) {
    message = `A claim holds at most ${MAX_REGION_ITEMS} shapes.`
    return
  }
  const item: RegionItem = { id: nextItemId(), shape, op: subtract ? 'subtract' : 'add' }
  items = [...items, item]
  selectedId = item.id
  bump()
}

/** A box from two pixels, inclusive of both, capped at the largest allowed side. */
const box = (
  kind: 'rectangle' | 'ellipse',
  ax: number,
  ay: number,
  bx: number,
  by: number,
): RegionShape => ({
  kind,
  x: Math.min(ax, bx),
  y: Math.min(ay, by),
  w: clampInt(Math.abs(bx - ax) + 1, 1, MAX_REGION_SHAPE_EXTENT),
  h: clampInt(Math.abs(by - ay) + 1, 1, MAX_REGION_SHAPE_EXTENT),
})

const round = (
  kind: 'polygon' | 'star',
  cx: number,
  cy: number,
  x: number,
  y: number,
  base?: RegionShape,
): RegionShape => {
  const dx = x - cx
  const dy = y - cy
  const r = clampInt(Math.hypot(dx, dy), 1, MAX_REGION_SHAPE_EXTENT / 2)
  const rotation = degrees(dx, dy)
  if (kind === 'polygon')
    return { kind, cx, cy, r, sides: base?.kind === 'polygon' ? base.sides : sides, rotation }
  const ratio = base?.kind === 'star' ? base.inner / base.r : inner / 100
  return {
    kind,
    cx,
    cy,
    r,
    inner: clampInt(r * ratio, 1, Math.max(1, r - 1)),
    points: base?.kind === 'star' ? base.points : points,
    rotation,
  }
}

/** Build the shape-tool shape from the press pixel and the pointer pixel. */
const shapeFrom = (originX: number, originY: number, x: number, y: number): RegionShape | null => {
  switch (tool) {
    case 'rectangle':
    case 'ellipse':
      return box(tool, originX, originY, x, y)
    case 'polygon':
    case 'star':
      return round(tool, originX, originY, x, y)
    default:
      return null
  }
}

/** Topmost item whose pixels contain the canvas pixel. */
const itemAt = (px: number, py: number): RegionItem | null => {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index] as RegionItem
    if (regionShapeContainsPixel(item.shape, px, py)) return item
  }
  return null
}

/** The pen's first anchor in client pixels, for the click-to-close test. */
const penStartClient = (): Point | null => {
  const first = pen?.[0]
  const projection = screenProjection()
  return first === undefined || projection === null ? null : projection.pointFor(first.x, first.y)
}

const commitPen = (closed: boolean): void => {
  if (pen === null) return
  const nodes = pen
  pen = null
  if (nodes.length < (closed ? 3 : 2)) {
    bump()
    notify()
    return
  }
  const strokeWidth = closed ? width : Math.max(1, width)
  addItem({ kind: 'path', closed, width: closed ? strokeWidth : strokeWidth, nodes })
  notify()
}

const finishStroke = (): void => {
  if (stroke === null) return
  const nodes = stroke
  stroke = null
  if (nodes.length >= 2)
    addItem({
      kind: 'path',
      closed: false,
      width: tool === 'pencil' ? 1 : Math.max(1, width),
      nodes,
    })
  else bump()
  notify()
}

/** A press outside the panel, dialogs, and our own chrome, on the map itself. */
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

const setCursor = (value: string): void => {
  if (cursor === value) return
  cursor = value
  const canvas = document.querySelector<HTMLElement>('canvas.maplibregl-canvas')
  if (canvas !== null) canvas.style.cursor = value
}

const toolCursor = (): string =>
  tool === 'select' || tool === 'direct' ? '' : tool === 'pen' ? 'copy' : 'crosshair'

const startDrag = (
  kind: DragKind,
  event: PointerEvent,
  origin: Point,
  base: RegionItem | null,
  index = 0,
  part: Drag['part'] = 'anchor',
): void => {
  drag = {
    kind,
    pointerId: event.pointerId,
    originX: origin.x,
    originY: origin.y,
    clientX: event.clientX,
    clientY: event.clientY,
    base,
    index,
    part,
    moved: false,
  }
}

const onHandlePress = (event: PointerEvent, target: Element): boolean => {
  const handle = (target as HTMLElement).dataset.handle
  const item = selectedItem()
  if (handle === undefined || item === null) return false
  consume(event)
  try {
    target.setPointerCapture(event.pointerId)
  } catch {
    // Window listeners still see the moves.
  }
  const [kind, indexText, part] = handle.split(':')
  const index = Number(indexText ?? 0)
  const shape = item.shape
  if (kind === 'corner' && (shape.kind === 'rectangle' || shape.kind === 'ellipse')) {
    // The opposite corner stays put.
    const anchorX = index === 1 || index === 2 ? shape.x : shape.x + shape.w - 1
    const anchorY = index === 2 || index === 3 ? shape.y : shape.y + shape.h - 1
    startDrag('corner', event, { x: anchorX, y: anchorY }, item, index)
  } else if (
    (kind === 'outer' || kind === 'inner') &&
    (shape.kind === 'polygon' || shape.kind === 'star')
  ) {
    startDrag(kind, event, { x: shape.cx, y: shape.cy }, item)
  } else if (kind === 'node' && shape.kind === 'path') {
    startDrag('node', event, { x: 0, y: 0 }, item, index, (part as Drag['part']) ?? 'anchor')
  } else return false
  message = undefined
  notify()
  return true
}

const onPointerDown = (event: PointerEvent): void => {
  if (!active || host === null || pending || drag !== null || event.button !== 0) return
  const target = event.target
  if (target instanceof Element && (target as HTMLElement).dataset.handle !== undefined) {
    onHandlePress(event, target)
    return
  }
  if (!isMapPress(event)) return
  const point = canvasPixelAt(event.clientX, event.clientY)
  if (point === null) return
  const px = pixel(point.x)
  const py = pixel(point.y)
  message = undefined
  switch (tool) {
    case 'select':
    case 'direct': {
      const hit = itemAt(px, py)
      if (hit === null) {
        // Empty canvas: deselect and let the map pan.
        if (selectedId !== null) {
          selectedId = null
          notify()
        }
        return
      }
      consume(event)
      selectedId = hit.id
      if (tool === 'select') startDrag('move', event, { x: px, y: py }, hit)
      notify()
      return
    }
    case 'pen': {
      consume(event)
      const start = penStartClient()
      if (
        pen !== null &&
        pen.length >= 3 &&
        start !== null &&
        Math.hypot(event.clientX - start.x, event.clientY - start.y) <= HIT_RADIUS_CSS
      ) {
        commitPen(true)
        return
      }
      if (pen === null) pen = []
      if (pen.length >= MAX_PATH_NODES) {
        message = `A path holds at most ${MAX_PATH_NODES} anchors.`
        notify()
        return
      }
      pen = [...pen, { x: px, y: py }]
      startDrag('pen', event, { x: px, y: py }, null, pen.length - 1)
      bump()
      notify()
      return
    }
    case 'pencil':
    case 'brush':
      consume(event)
      selectedId = null
      stroke = [{ x: px + 0.5, y: py + 0.5 }]
      startDrag('stroke', event, { x: px, y: py }, null)
      bump()
      notify()
      return
    default:
      consume(event)
      selectedId = null
      drawing = shapeFrom(px, py, px, py)
      startDrag('draw', event, { x: px, y: py }, null)
      bump()
      notify()
  }
}

const moveNode = (
  shape: Extract<RegionShape, { kind: 'path' }>,
  index: number,
  part: Drag['part'],
  x: number,
  y: number,
  base: Extract<RegionShape, { kind: 'path' }>,
): RegionShape => {
  const nodes = shape.nodes.map((node, at) => {
    if (at !== index) return node
    const original = base.nodes[index] as PathNode
    if (part === 'anchor') {
      const dx = x - original.x
      const dy = y - original.y
      return {
        x,
        y,
        ...(original.in === undefined
          ? {}
          : { in: { x: original.in.x + dx, y: original.in.y + dy } }),
        ...(original.out === undefined
          ? {}
          : { out: { x: original.out.x + dx, y: original.out.y + dy } }),
      }
    }
    // Dragging one handle mirrors the other, Illustrator's smooth anchor.
    const mirror = { x: 2 * node.x - x, y: 2 * node.y - y }
    return part === 'in'
      ? { ...node, in: { x, y }, out: mirror }
      : { ...node, out: { x, y }, in: mirror }
  })
  return { ...shape, nodes }
}

const onPointerMove = (event: PointerEvent): void => {
  if (!active || host === null) return
  if (drag === null) {
    if (!isMapPress(event)) {
      setCursor('')
      return
    }
    if (tool === 'select' || tool === 'direct') {
      const point = canvasPixelAt(event.clientX, event.clientY)
      const over = point !== null && itemAt(pixel(point.x), pixel(point.y)) !== null
      setCursor(over ? 'move' : '')
    } else setCursor(toolCursor())
    return
  }
  if (event.pointerId !== drag.pointerId) return
  consume(event)
  const point = canvasPixelAt(event.clientX, event.clientY)
  if (point === null) return
  const px = pixel(point.x)
  const py = pixel(point.y)
  const travelled =
    Math.abs(event.clientX - drag.clientX) > CLICK_SLOP_PX ||
    Math.abs(event.clientY - drag.clientY) > CLICK_SLOP_PX
  if (travelled) drag.moved = true
  const base = drag.base
  switch (drag.kind) {
    case 'draw':
      drawing = shapeFrom(drag.originX, drag.originY, px, py)
      bump()
      break
    case 'move':
      if (base === null || !drag.moved) return
      replaceItem(base.id, translateRegionShape(base.shape, px - drag.originX, py - drag.originY))
      setCursor('grabbing')
      break
    case 'corner': {
      if (base === null || (base.shape.kind !== 'rectangle' && base.shape.kind !== 'ellipse'))
        return
      replaceItem(base.id, box(base.shape.kind, drag.originX, drag.originY, px, py))
      break
    }
    case 'outer': {
      if (base === null || (base.shape.kind !== 'polygon' && base.shape.kind !== 'star')) return
      replaceItem(base.id, round(base.shape.kind, drag.originX, drag.originY, px, py, base.shape))
      break
    }
    case 'inner': {
      if (base?.shape.kind !== 'star') return
      const innerRadius = clampInt(
        Math.hypot(px - base.shape.cx, py - base.shape.cy),
        1,
        Math.max(1, base.shape.r - 1),
      )
      inner = Math.round((innerRadius / base.shape.r) * 100)
      replaceItem(base.id, { ...base.shape, inner: innerRadius })
      break
    }
    case 'node': {
      if (base?.shape.kind !== 'path') return
      const current = selectedItem()
      if (current?.shape.kind !== 'path') return
      const target = drag.part === 'anchor' ? { x: px, y: py } : { x: point.x, y: point.y }
      replaceItem(
        base.id,
        moveNode(current.shape, drag.index, drag.part, target.x, target.y, base.shape),
      )
      break
    }
    case 'stroke': {
      if (stroke === null) return
      const last = stroke[stroke.length - 1] as Point
      const next = { x: px + 0.5, y: py + 0.5 }
      if (Math.hypot(next.x - last.x, next.y - last.y) < STROKE_STEP_PX) return
      if (stroke.length >= MAX_PATH_NODES) return
      stroke = [...stroke, next]
      bump()
      break
    }
    case 'pen': {
      if (pen === null || !drag.moved) return
      // Dragging out of a fresh anchor pulls its out handle and mirrors the in handle.
      const index = drag.index
      const anchor = pen[index] as PathNode
      const out = { x: point.x, y: point.y }
      pen = pen.map((node, at) =>
        at === index
          ? {
              x: anchor.x,
              y: anchor.y,
              out,
              in: { x: 2 * anchor.x - out.x, y: 2 * anchor.y - out.y },
            }
          : node,
      )
      bump()
      break
    }
  }
  notify()
}

const onPointerEnd = (event: PointerEvent): void => {
  if (drag === null || event.pointerId !== drag.pointerId) return
  consume(event)
  swallowNextClick()
  const ended = drag
  drag = null
  switch (ended.kind) {
    case 'draw':
      if (drawing !== null) addItem(drawing)
      drawing = null
      break
    case 'stroke':
      finishStroke()
      return
    default:
      break
  }
  bump()
  setCursor(toolCursor())
  notify()
}

const isTyping = (target: EventTarget | null): boolean => {
  let node = target as (Element & { shadowRoot?: ShadowRoot | null }) | null
  while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement as typeof node
  const tag = node?.tagName?.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

const onKeydown = (event: KeyboardEvent): void => {
  if (!active || isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return
  const key = event.key.toLowerCase()
  if (key === 'escape') {
    consume(event)
    if (pen !== null) {
      pen = null
      bump()
      notify()
    } else if (selectedId !== null) {
      selectedId = null
      notify()
    } else stopClaimMode()
    return
  }
  if (key === 'enter') {
    consume(event)
    if (pen !== null) commitPen(false)
    else void confirm()
    return
  }
  if (key === 'delete' || key === 'backspace') {
    consume(event)
    deleteSelected()
    return
  }
  const next = TOOL_KEYS[key]
  if (next !== undefined) {
    consume(event)
    setTool(next)
  }
}

const deleteSelected = (): void => {
  if (selectedId === null) return
  items = items.filter((item) => item.id !== selectedId)
  selectedId = null
  bump()
  notify()
}

const setTool = (next: ClaimTool): void => {
  if (pen !== null && next !== 'pen') commitPen(false)
  tool = next
  setCursor(toolCursor())
  notify()
}

const confirm = async (): Promise<void> => {
  if (!active || pending || host === null || items.length === 0) return
  if (pen !== null) commitPen(false)
  const document: RegionDocument = { items }
  const id = editingId
  pending = true
  message = undefined
  notify()
  const error = await host.save(id, document)
  pending = false
  if (!isClaimModeActive()) return
  if (error === null) stopClaimMode()
  else {
    message = error
    notify()
  }
}

const deleteClaim = async (): Promise<void> => {
  if (!active || pending || host === null || editingId === null) return
  pending = true
  message = undefined
  notify()
  const error = await host.remove(editingId)
  pending = false
  if (!isClaimModeActive()) return
  if (error === null) stopClaimMode()
  else {
    message = error
    notify()
  }
}

export const handleClaimModeIntent = (intent: ClaimModeIntent): void => {
  if (!active) return
  switch (intent.type) {
    case 'set-tool':
      setTool(intent.tool)
      return
    case 'set-option': {
      const value = intent.value
      if (intent.option === 'sides')
        sides = clampInt(value, MIN_REGION_SHAPE_CORNERS, MAX_REGION_SHAPE_CORNERS)
      if (intent.option === 'points')
        points = clampInt(value, MIN_REGION_SHAPE_CORNERS, MAX_REGION_SHAPE_CORNERS)
      if (intent.option === 'inner') inner = clampInt(value, 5, 95)
      if (intent.option === 'width') width = clampInt(value, 0, MAX_STROKE_WIDTH)
      // The selected shape follows the option, so a count or width is also an edit.
      const selected = selectedItem()
      if (selected !== null) {
        const shape = selected.shape
        if (intent.option === 'sides' && shape.kind === 'polygon')
          replaceItem(selected.id, { ...shape, sides })
        if (intent.option === 'points' && shape.kind === 'star')
          replaceItem(selected.id, { ...shape, points })
        if (intent.option === 'inner' && shape.kind === 'star')
          replaceItem(selected.id, {
            ...shape,
            inner: clampInt((shape.r * inner) / 100, 1, Math.max(1, shape.r - 1)),
          })
        if (intent.option === 'width' && shape.kind === 'path' && (shape.closed || width > 0))
          replaceItem(selected.id, { ...shape, width })
      }
      break
    }
    case 'set-subtract': {
      subtract = intent.subtract
      const selected = selectedItem()
      if (selected !== null) {
        items = items.map((item) =>
          item.id === selected.id ? { ...item, op: subtract ? 'subtract' : 'add' } : item,
        )
        bump()
      }
      break
    }
    case 'delete-item':
      deleteSelected()
      return
    case 'delete-claim':
      void deleteClaim()
      return
    case 'confirm':
      void confirm()
      return
    case 'cancel':
      stopClaimMode()
      return
  }
  message = undefined
  notify()
}

/* Chrome: the mode element and the SVG overlay. */

const ensureMode = (): void => {
  if (mode?.isConnected) return
  const element = document.createElement(CLAIM_MODE_TAG) as HTMLElement & { model: ClaimModeModel }
  element.id = MODE_ID
  Object.assign(element.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '26',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  applyWplaceTheme(element)
  element.addEventListener('caelestis-claim-mode-intent', (event) => {
    handleClaimModeIntent((event as CustomEvent<ClaimModeIntent>).detail)
  })
  element.model = claimModeModel()
  document.body.appendChild(element)
  mode = element
}

const syncMode = (): void => {
  if (!active) {
    mode?.remove()
    mode = null
    return
  }
  ensureMode()
  if (mode !== null) mode.model = claimModeModel()
}

const ensureOverlay = (): SVGSVGElement => {
  if (overlay?.isConnected) return overlay
  overlay = document.createElementNS(SVG_NS, 'svg')
  overlay.id = OVERLAY_ID
  overlay.setAttribute('aria-hidden', 'true')
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    zIndex: '18',
    pointerEvents: 'none',
    overflow: 'visible',
  } satisfies Partial<CSSStyleDeclaration>)
  document.body.appendChild(overlay)
  return overlay
}

const svg = (name: string, attributes: Record<string, string | number>): SVGElement => {
  const element = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value))
  return element
}

const pathData = (points: readonly Point[], closed: boolean): string =>
  points.length === 0
    ? ''
    : `M${points.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join('L')}${closed ? 'Z' : ''}`

/** Redraw outlines and handles for the current document at the current projection. */
const syncOverlay = (): void => {
  if (!active) {
    overlay?.remove()
    overlay = null
    return
  }
  const root = ensureOverlay()
  const projection = screenProjection()
  root.replaceChildren()
  if (projection === null) return
  const project = (point: Point): Point => projection.pointFor(point.x, point.y)
  const accent = 'rgb(30 144 255)'
  const faint = 'rgb(255 255 255 / 0.55)'
  const handle = (at: Point, name: string, fill: string, radius = HANDLE_RADIUS_CSS): void => {
    const circle = svg('circle', {
      cx: at.x,
      cy: at.y,
      r: radius,
      fill,
      stroke: '#fff',
      'stroke-width': 1.5,
      'data-handle': name,
    })
    ;(circle as SVGElement).style.pointerEvents = 'auto'
    ;(circle as SVGElement).style.cursor = 'grab'
    root.appendChild(circle)
  }
  for (const item of items) {
    const selected = item.id === selectedId
    const outline = regionShapeOutline(item.shape).map(project)
    const closed = item.shape.kind !== 'path' || item.shape.closed
    root.appendChild(
      svg('path', {
        d: pathData(outline, closed),
        fill: 'none',
        stroke: selected ? accent : faint,
        'stroke-width': selected ? 1.5 : 1,
        'stroke-dasharray': item.op === 'subtract' ? '4 3' : '0',
      }),
    )
    if (!selected) continue
    const shape = item.shape
    if (tool === 'select') {
      if (shape.kind === 'rectangle' || shape.kind === 'ellipse') {
        const corners = [
          { x: shape.x, y: shape.y },
          { x: shape.x + shape.w, y: shape.y },
          { x: shape.x + shape.w, y: shape.y + shape.h },
          { x: shape.x, y: shape.y + shape.h },
        ]
        for (const [index, corner] of corners.entries())
          handle(project(corner), `corner:${index}`, accent)
      } else if (shape.kind === 'polygon' || shape.kind === 'star') {
        const ring = regionShapeOutline(shape)
        const outer = ring[0]
        if (outer !== undefined) handle(project(outer), 'outer:0', accent)
        if (shape.kind === 'star' && ring[1] !== undefined)
          handle(project(ring[1]), 'inner:0', 'rgb(255 160 40)')
      }
    }
    if (tool === 'direct' && shape.kind === 'path') {
      shape.nodes.forEach((node, index) => {
        const anchor = project(node)
        for (const part of ['in', 'out'] as const) {
          const control = node[part]
          if (control === undefined) continue
          const at = project(control)
          root.appendChild(
            svg('line', {
              x1: anchor.x,
              y1: anchor.y,
              x2: at.x,
              y2: at.y,
              stroke: accent,
              'stroke-width': 1,
            }),
          )
          handle(at, `node:${index}:${part}`, '#fff', HANDLE_RADIUS_CSS - 1)
        }
        handle(anchor, `node:${index}:anchor`, accent)
      })
    }
  }
  if (pen !== null && pen.length > 0) {
    const flat = pen.map(project)
    root.appendChild(
      svg('path', { d: pathData(flat, false), fill: 'none', stroke: accent, 'stroke-width': 1.5 }),
    )
    for (const node of pen) {
      const anchor = project(node)
      root.appendChild(
        svg('circle', { cx: anchor.x, cy: anchor.y, r: 3.5, fill: accent, stroke: '#fff' }),
      )
      if (node.out !== undefined) {
        const out = project(node.out)
        root.appendChild(
          svg('line', { x1: anchor.x, y1: anchor.y, x2: out.x, y2: out.y, stroke: accent }),
        )
      }
    }
  }
}

/* Lifecycle. */

export const installClaimEditor = (editorHost: ClaimEditorHost): void => {
  host = editorHost
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerEnd, true)
  window.addEventListener('pointercancel', onPointerEnd, true)
  window.addEventListener('keydown', onKeydown, true)
}

/** Enter claim mode with a tool in hand, optionally editing a saved claim. */
export const startClaimMode = (
  initialTool?: ClaimTool,
  existing?: { readonly id: string; readonly document: RegionDocument },
): void => {
  if (host === null) return
  if (active) {
    if (initialTool !== undefined) setTool(initialTool)
    return
  }
  active = true
  tool = initialTool ?? 'select'
  items = existing === undefined ? [] : [...existing.document.items]
  editingId = existing?.id ?? null
  selectedId = null
  drag = null
  pen = null
  stroke = null
  drawing = null
  pending = false
  message = undefined
  bump()
  setCursor(toolCursor())
  notify()
}

/** Leave claim mode. Nothing unsaved survives this. */
export const stopClaimMode = (): void => {
  if (!active) return
  active = false
  items = []
  selectedId = null
  editingId = null
  drag = null
  pen = null
  stroke = null
  drawing = null
  pending = false
  message = undefined
  bump()
  setCursor('')
  syncMode()
  syncOverlay()
  for (const listener of listeners) listener()
  host?.changed()
}

/** Follow the map: outlines and handles move with the canvas. */
export const syncClaimEditorFrame = (_frame: TileFrame): void => {
  if (active) syncOverlay()
}

/** Test seam. */
export const resetClaimEditor = (): void => {
  stopClaimMode()
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
  tool = 'select'
  sides = 6
  points = 5
  inner = DEFAULT_INNER
  width = 8
  subtract = false
  pixelCache = null
  overlay?.remove()
  overlay = null
}

/** Exported for the layer: the bounding box of what is being edited, when anything is. */
export const claimEditorBounds = () => {
  const pixels = claimEditorPixels()
  return pixels === null ? null : pixels.rect
}

export { regionShapeBounds }
