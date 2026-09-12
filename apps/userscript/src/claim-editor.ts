import {
  flattenPath,
  MAX_PATH_NODES,
  MAX_RASTER_BITS,
  MAX_REGION_ITEMS,
  MAX_REGION_SHAPE_CORNERS,
  MAX_REGION_SHAPE_EXTENT,
  MAX_STROKE_WIDTH,
  MIN_REGION_SHAPE_CORNERS,
  type PathNode,
  type Point,
  type PresenceRect,
  type RegionDocument,
  type RegionItem,
  type RegionShape,
  type RegionShapePixels,
  rasterShapeFrom,
  regionDocumentPixels,
  regionShapeBounds,
  regionShapeCentre,
  regionShapeContainsPixel,
  regionShapeOutline,
  regionShapePixels,
  translateRegionShape,
  WORLD_PIXELS,
} from '@caelestis/shared'
import {
  CLAIM_MODE_TAG,
  type ClaimModeIntent,
  type ClaimModeModel,
  type ClaimTool,
  type ClaimToolEntry,
  type ClaimToolGroupId,
} from '@caelestis/ui/elements'
import {
  cornerAnchor,
  insertAnchor,
  isSmooth,
  nearestOnPath,
  orientToContinue,
  type PathHit,
  removeAnchor,
  rubberBand,
  smoothAnchor,
} from './claim-path.js'
import { eraseFromRaster, mergeRasters, PixelSet, rasterTouches } from './claim-raster.js'
import { splitItem, strokeArea } from './claim-split.js'
import { warn } from './debug.js'
import { canvasPixelAt, isMapInteractionTarget, screenProjection } from './main.js'
import { getMap } from './map-handle.js'
import type { TileFrame } from './tile-transform.js'
import { applyWplaceTheme } from './ui/theme.js'
import { dismissWplacePixelCard } from './wplace-pixel-card.js'

/**
 * Claim mode: a small vector editor over the map.
 *
 * A claim is a document of shapes, each adding to or cutting from the claimed pixels, and every
 * shape stays editable. The drawer on the left holds the tools; the bar at the top holds the
 * options and the cancel or confirm buttons. Nothing sits over the map: pointer events are
 * watched at the window in the capture phase and consumed only when the tool in hand wants
 * them. Outside claim mode nothing here listens at all.
 *
 * Tools and keys follow Illustrator: selection (V: click, Shift-click to add, drag to move, drag
 * empty canvas for a marquee, handles to resize or rotate), direct selection (A: anchors and
 * bezier handles of a path), lasso (Q), pen (P: click for corners, drag for curves, click the
 * first anchor to close), pencil (N) and paintbrush (B), rectangle (M), ellipse (L), polygon and
 * star, and the hand (H, or hold Space) which is the one tool that lets a drag pan the map. The
 * wheel pans, Shift+wheel pans sideways, and Alt/Option or Ctrl/Cmd+wheel zooms. Everything the tools produce is whole pixels once rasterised, because the
 * shared rasteriser decides membership by pixel centre.
 */

const OVERLAY_ID = 'caelestis-claim-overlay'
const MODE_ID = 'caelestis-claim-mode'
const HANDLE_RADIUS_CSS = 5
const HIT_RADIUS_CSS = 9
const CLICK_SLOP_PX = 4
const STROKE_STEP_PX = 2
const DEFAULT_INNER = 50
/** Just outside a bounding-box corner, this far in CSS pixels, the pointer rotates the shape. */
const ROTATE_ZONE_CSS = 28
/** How far the rotate handle floats above the bounding box, in CSS pixels. */
const ROTATE_STEM_CSS = 26
/** Illustrator's Shift while rotating: whole turns of this many degrees. */
const ROTATE_SNAP_DEGREES = 15
/** The bezier control distance that makes four cubic segments a near-perfect ellipse. */
const ELLIPSE_KAPPA = 0.5522847498
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M10 3a7 7 0 1 1-6.3 4" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/><path d="M10 3a7 7 0 1 1-6.3 4" fill="none" stroke="#000" stroke-width="1.5" stroke-linecap="round"/><path d="M3 2v5.5h5.5" fill="none" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/><path d="M3 2v5.5h5.5" fill="none" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>',
)}") 10 10, alias`
const SVG_NS = 'http://www.w3.org/2000/svg'

/** Illustrator's keys where it has them: V, A, Q, P, N, B, M, L. */
export const CLAIM_TOOLS: readonly ClaimToolEntry[] = [
  { tool: 'select', group: 'selection', label: 'Selection', key: 'V', icon: 'toolSelect' },
  { tool: 'direct', group: 'selection', label: 'Direct selection', key: 'A', icon: 'toolDirect' },
  { tool: 'lasso', group: 'selection', label: 'Lasso', key: 'Q', icon: 'toolLasso' },
  { tool: 'pen', group: 'pen', label: 'Pen', key: 'P', icon: 'toolPen' },
  { tool: 'add-anchor', group: 'pen', label: 'Add anchor', key: '+', icon: 'toolAddAnchor' },
  {
    tool: 'delete-anchor',
    group: 'pen',
    label: 'Delete anchor',
    key: '−',
    icon: 'toolDeleteAnchor',
  },
  { tool: 'anchor', group: 'pen', label: 'Anchor point', key: 'Shift+C', icon: 'toolAnchor' },
  { tool: 'pencil', group: 'pencil', label: 'Pencil', key: 'N', icon: 'toolPencil' },
  { tool: 'brush', group: 'pencil', label: 'Paintbrush', key: 'B', icon: 'toolBrush' },
  { tool: 'eraser', group: 'pencil', label: 'Eraser', key: 'E', icon: 'toolEraser' },
  { tool: 'rectangle', group: 'shape', label: 'Rectangle', key: 'M', icon: 'toolRectangle' },
  { tool: 'ellipse', group: 'shape', label: 'Ellipse', key: 'L', icon: 'toolEllipse' },
  { tool: 'polygon', group: 'shape', label: 'Polygon', key: '', icon: 'toolPolygon' },
  { tool: 'star', group: 'shape', label: 'Star', key: '', icon: 'toolStar' },
  { tool: 'hand', group: 'navigate', label: 'Hand', key: 'H', icon: 'toolHand' },
]

const GROUPS: readonly { readonly id: ClaimToolGroupId; readonly label: string }[] = [
  { id: 'selection', label: 'Selection tools' },
  { id: 'pen', label: 'Pen tools' },
  { id: 'pencil', label: 'Drawing tools' },
  { id: 'shape', label: 'Shape tools' },
  { id: 'navigate', label: 'Navigation tools' },
]

const TOOL_KEYS: Record<string, ClaimTool> = {
  v: 'select',
  a: 'direct',
  q: 'lasso',
  p: 'pen',
  n: 'pencil',
  b: 'brush',
  e: 'eraser',
  m: 'rectangle',
  l: 'ellipse',
  h: 'hand',
}

const groupOf = (of: ClaimTool): ClaimToolGroupId =>
  CLAIM_TOOLS.find((entry) => entry.tool === of)?.group ?? 'selection'

const defaultShown = (): Record<ClaimToolGroupId, ClaimTool> => ({
  selection: 'select',
  pen: 'pen',
  pencil: 'pencil',
  shape: 'rectangle',
  navigate: 'hand',
})

type DragKind =
  | 'draw'
  | 'move'
  | 'corner'
  | 'outer'
  | 'inner'
  | 'node'
  | 'stroke'
  | 'pen'
  | 'marquee'
  | 'lasso'
  | 'rotate'
  | 'raster'
  | 'erase'
  | 'scale'
  | 'handle-solo'
  | 'anchor-pull'
  | 'anchor-convert'

interface Drag {
  readonly kind: DragKind
  readonly pointerId: number
  readonly originX: number
  readonly originY: number
  readonly clientX: number
  readonly clientY: number
  /** The item as it was when the gesture began. */
  readonly base: RegionItem | null
  /** For move drags: every selected item as it was, so they travel together. */
  readonly group: readonly RegionItem[]
  /** For corner drags: which corner (0 tl, 1 tr, 2 br, 3 bl). For node drags: node index. */
  readonly index: number
  /** For node drags: which part of the node. */
  readonly part: 'anchor' | 'in' | 'out'
  /** Where the press landed, in canvas coordinates, for angles measured from the origin. */
  readonly press: Point
  moved: boolean
}

export interface ClaimEditorHost {
  /** The template the claim overlaps, by name, or null. Information only; never a gate. */
  readonly templateFor: (document: RegionDocument) => string | null
  /**
   * This painter's saved claims on the server claim mode edits. They all load together: claim
   * mode is where every one of your regions is edited, and Save writes the whole set back.
   */
  readonly myRegions: () => readonly { readonly id: string; readonly document: RegionDocument }[]
  /** Persist the set as one claim, new when `id` is null. Resolves to an error, or null. */
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
/** The pencil's tip and the eraser's, in pixels; each tool keeps its own. */
let pencilWidth = 1
let eraserWidth = 8
let subtract = false
let items: RegionItem[] = []
/** Selected item ids, in selection order. Handles appear only for a selection of one. */
let selectedIds: readonly string[] = []
/** The tool each drawer group shows: the one last used from it. */
let shown: Record<ClaimToolGroupId, ClaimTool> = defaultShown()
/** A marquee being dragged, in canvas pixels, and a lasso being drawn. */
let marquee: { x0: number; y0: number; x1: number; y1: number } | null = null
let lasso: Point[] | null = null
/** What was selected before a Shift-marquee or Shift-lasso began, to add to. */
let baseSelection: readonly string[] = []
/** The tool to return to when the space bar, held for a temporary hand, is released. */
let handHeldFrom: ClaimTool | null = null
/** The saved claims loaded into the editor; Save merges them into the first and releases the rest. */
let editingIds: readonly string[] = []
let drag: Drag | null = null
/** The pen path under construction. */
let pen: PathNode[] | null = null
/** When the pen continues a saved path, the item it came from, restored on commit. */
let penContinued: RegionItem | null = null
/** Where that item sat: add and subtract apply in order, so it must return to the same slot. */
let penContinuedIndex = 0

const restoreContinued = (item: RegionItem): void => {
  const at = Math.min(penContinuedIndex, items.length)
  items = [...items.slice(0, at), item, ...items.slice(at)]
}
/** Where the pointer is over the map, in canvas coordinates, for the pen's rubber band. */
let hover: Point | null = null
/** The stroke under construction, as raw points. */
let stroke: Point[] | null = null
/** The shape under construction with a shape tool. */
let drawing: RegionShape | null = null
/** The pixels the pencil has laid down so far in this stroke. */
let raster: PixelSet | null = null
/** What the eraser has covered so far: the pixels, and the path for cutting vector shapes. */
let erasing: { readonly set: PixelSet; line: Point[] } | null = null
/** The last pixel a pencil or eraser stamped, so a fast move still leaves an unbroken line. */
let lastStamp: Point | null = null
/**
 * A press the editor consumed without starting a drag. Its release and the click that follows
 * are consumed too, or Wplace would still treat the click as a pixel selection.
 */
let consumedPress: number | null = null
let pending = false
/** Counts claim-mode sessions, so a request from an earlier one cannot act on a later one. */
let session = 0
let message: string | undefined
/** Whether the working document differs from what was loaded or saved. */
let dirty = false
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

/** Any change to the items themselves; previews and selection do not count. */
const touch = (): void => {
  dirty = true
  bump()
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

/** The saved claims loaded into the editor, so their stored copies step aside in the layer. */
export const claimEditorEditingIds = (): readonly string[] => (active ? editingIds : [])

/** The shape being drawn right now, as a temporary item, so previews rasterise like the rest. */
const previewItem = (): RegionItem | null => {
  if (drawing !== null) return { id: 'preview', shape: drawing, op: subtract ? 'subtract' : 'add' }
  if (raster !== null) {
    const shape = raster.shape()
    if (shape !== null) return { id: 'preview', shape, op: subtract ? 'subtract' : 'add' }
  }
  if (erasing !== null && erasing.line.length >= 1) {
    // What the eraser will take is shown taken while it moves.
    const line = erasing.line.length === 1 ? [...erasing.line, ...erasing.line] : erasing.line
    return {
      id: 'preview',
      shape: { kind: 'path', closed: false, width: eraserWidth, nodes: line },
      op: 'subtract',
    }
  }
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
      op: subtract ? 'subtract' : 'add',
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
  groups: GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    tools: CLAIM_TOOLS.filter((entry) => entry.group === group.id),
    shown: shown[group.id],
  })),
  options: {
    ...(tool === 'polygon' ? { sides } : {}),
    ...(tool === 'star' ? { points, inner } : {}),
    ...(tool === 'pen' || tool === 'pencil' || tool === 'brush' || tool === 'eraser'
      ? { width: tool === 'pencil' ? pencilWidth : tool === 'eraser' ? eraserWidth : width }
      : {}),
    minCorners: MIN_REGION_SHAPE_CORNERS,
    maxCorners: MAX_REGION_SHAPE_CORNERS,
    maxWidth: MAX_STROKE_WIDTH,
  },
  subtract,
  items: items.length,
  selected: selectedIds.length > 0,
  selectedCount: selectedIds.length,
  dirty,
  template: items.length === 0 ? null : (host?.templateFor({ items }) ?? null),
  pixels: claimEditorPixels()?.count ?? 0,
  pending,
  ...(message === undefined ? {} : { message }),
})

const isSelected = (id: string): boolean => selectedIds.includes(id)

/** The one selected item, when exactly one is: what handles and option edits apply to. */
const selectedItem = (): RegionItem | null =>
  selectedIds.length === 1 ? (items.find((item) => item.id === selectedIds[0]) ?? null) : null

const selectedItems = (): RegionItem[] => items.filter((item) => isSelected(item.id))

const select = (ids: readonly string[]): void => {
  selectedIds = [...new Set(ids)]
}

/** Whether a shape is inside a marquee: its bounding box touches the box, as in Illustrator. */
const inMarquee = (
  shape: RegionShape,
  box: { x0: number; y0: number; x1: number; y1: number },
): boolean => {
  const bounds = regionShapeBounds(shape)
  const left = Math.min(box.x0, box.x1)
  const right = Math.max(box.x0, box.x1)
  const top = Math.min(box.y0, box.y1)
  const bottom = Math.max(box.y0, box.y1)
  return (
    bounds.x <= right &&
    bounds.x + bounds.w >= left &&
    bounds.y <= bottom &&
    bounds.y + bounds.h >= top
  )
}

const insidePolygon = (ring: readonly Point[], x: number, y: number): boolean => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point
    const b = ring[j] as Point
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

const orient = (a: Point, b: Point, c: Point): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

const segmentsCross = (a: Point, b: Point, c: Point, d: Point): boolean =>
  orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0

/**
 * Whether a shape is caught by a lasso: a point of its outline lies inside the loop, the loop
 * lies inside the shape, or an outline edge crosses the loop. The last case is what catches a
 * narrow loop drawn across the middle of an edge.
 */
const inLasso = (shape: RegionShape, ring: readonly Point[]): boolean => {
  if (ring.length < 3) return false
  const outline = regionShapeOutline(shape)
  if (outline.some((point) => insidePolygon(ring, point.x, point.y))) return true
  const closed = shape.kind !== 'path' || shape.closed
  if (closed && ring.some((point) => insidePolygon(outline, point.x, point.y))) return true
  const edges = closed ? outline.length : outline.length - 1
  for (let i = 0; i < edges; i++) {
    const a = outline[i] as Point
    const b = outline[(i + 1) % outline.length] as Point
    for (let j = 0; j < ring.length; j++) {
      if (segmentsCross(a, b, ring[j] as Point, ring[(j + 1) % ring.length] as Point)) return true
    }
  }
  return false
}

const replaceItem = (id: string, shape: RegionShape): void => {
  items = items.map((item) => (item.id === id ? { ...item, shape } : item))
  touch()
}

const addItem = (shape: RegionShape): void => {
  if (items.length >= MAX_REGION_ITEMS) {
    message = `A claim holds at most ${MAX_REGION_ITEMS} shapes.`
    return
  }
  const item: RegionItem = { id: nextItemId(), shape, op: subtract ? 'subtract' : 'add' }
  items = [...items, item]
  select([item.id])
  touch()
}

/** A box from two pixels, inclusive of both, capped at the largest allowed side. */
const box = (
  kind: 'rectangle' | 'ellipse',
  ax: number,
  ay: number,
  bx: number,
  by: number,
): RegionShape => {
  // The moving corner is capped relative to the anchor, so a box dragged too far still
  // contains the pixel the gesture started on.
  const reach = MAX_REGION_SHAPE_EXTENT - 1
  const cx = Math.max(ax - reach, Math.min(ax + reach, bx))
  const cy = Math.max(ay - reach, Math.min(ay + reach, by))
  return {
    kind,
    x: Math.min(ax, cx),
    y: Math.min(ay, cy),
    w: Math.abs(cx - ax) + 1,
    h: Math.abs(cy - ay) + 1,
  }
}

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
  // A star's inner radius must sit strictly inside its outer one, so a star is never smaller
  // than two pixels; a polygon can be one.
  const r = clampInt(Math.hypot(dx, dy), kind === 'star' ? 2 : 1, MAX_REGION_SHAPE_EXTENT / 2)
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
  const continued = penContinued
  pen = null
  penContinued = null
  if (nodes.length < (closed ? 3 : 2)) {
    if (continued !== null) restoreContinued(continued)
    bump()
    notify()
    return
  }
  if (continued !== null && continued.shape.kind === 'path') {
    // The path picks up where it left off, under its own id, width, and place in the order.
    const shape: RegionShape = { ...continued.shape, closed, nodes }
    restoreContinued({ ...continued, shape })
    select([continued.id])
    touch()
    notify()
    return
  }
  const strokeWidth = closed ? width : Math.max(1, width)
  addItem({ kind: 'path', closed, width: strokeWidth, nodes })
  notify()
}

/** Canvas pixels per CSS pixel of hit radius, so hit tests scale with the zoom. */
const hitRadiusCanvas = (): number => {
  const projection = screenProjection()
  const scale = projection?.pixelsPerCanvasPixel.x ?? 1
  return HIT_RADIUS_CSS / Math.max(scale, 1e-6)
}

/** The topmost item whose path passes within reach of a canvas point, as a path. */
const pathNear = (
  point: Point,
): { readonly item: RegionItem; readonly path: PathShape; readonly hit: PathHit } | null => {
  const radius = hitRadiusCanvas()
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index] as RegionItem
    if (item.shape.kind === 'pixels') continue
    const path = toPath(item.shape)
    const hit = nearestOnPath(path.nodes, path.closed, point)
    if (hit !== null && hit.distance <= radius) return { item, path, hit }
  }
  return null
}

/** Make an item a path in place (a no-op for one already), returning the path. */
const ensurePath = (item: RegionItem): PathShape => {
  if (item.shape.kind === 'path') return item.shape
  const path = toPath(item.shape)
  replaceItem(item.id, path)
  return path
}

const addAnchorAt = (point: Point): boolean => {
  const near = pathNear(point)
  if (near === null) return false
  if (near.path.nodes.length >= MAX_PATH_NODES) {
    message = `A path holds at most ${MAX_PATH_NODES} anchors.`
    return true
  }
  ensurePath(near.item)
  replaceItem(near.item.id, {
    ...near.path,
    nodes: insertAnchor(near.path.nodes, near.hit.index, near.hit.t),
  })
  select([near.item.id])
  return true
}

/** Remove one anchor of a path item; a path left too short goes altogether. */
const deleteAnchorOf = (item: RegionItem, index: number): void => {
  const path = ensurePath(item)
  const nodes = removeAnchor(path.nodes, index)
  if (nodes.length < (path.closed ? 3 : 2)) {
    items = items.filter((held) => held.id !== item.id)
    select([])
    touch()
    return
  }
  replaceItem(item.id, { ...path, nodes })
}

/** The pen picks up an open path at one of its ends. */
const continuePathFrom = (item: RegionItem, index: number): boolean => {
  if (item.shape.kind !== 'path' || item.shape.closed) return false
  if (index !== 0 && index !== item.shape.nodes.length - 1) return false
  pen = orientToContinue(item.shape.nodes, index)
  penContinued = item
  penContinuedIndex = items.indexOf(item)
  items = items.filter((held) => held.id !== item.id)
  select([])
  bump()
  return true
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

/** A pencil stroke joins the one selected drawing when there is one; otherwise it is a new one. */
const finishRaster = (): void => {
  if (raster === null) return
  const shape = raster.shape()
  raster = null
  lastStamp = null
  if (shape === null) {
    message = 'That drawing is too large for one raster; draw it in parts.'
    bump()
    notify()
    return
  }
  const op = subtract ? 'subtract' : 'add'
  const selected = selectedItem()
  if (selected !== null && selected.shape.kind === 'pixels' && selected.op === op) {
    const merged = mergeRasters(selected.shape, shape)
    if (merged !== null) {
      replaceItem(selected.id, merged)
      notify()
      return
    }
  }
  addItem(shape)
  notify()
}

/**
 * The eraser is done: pixels it covered leave every raster, and every vector shape it crossed
 * is cut into the pieces it leaves behind, each its own editable path.
 */
const finishErase = (): void => {
  if (erasing === null) return
  const { set, line } = erasing
  erasing = null
  lastStamp = null
  if (set.size === 0) {
    bump()
    notify()
    return
  }
  let area: ReturnType<typeof strokeArea> | null = null
  const next: RegionItem[] = []
  let changed = false
  let overflow = false
  for (const [index, item] of items.entries()) {
    if (item.shape.kind === 'pixels') {
      const left = eraseFromRaster(item.shape, set)
      if (left === item.shape) next.push(item)
      else {
        changed = true
        if (left !== null) next.push({ ...item, shape: left })
      }
      continue
    }
    if (!rasterTouches(item.shape, set)) {
      next.push(item)
      continue
    }
    area ??= strokeArea(line, eraserWidth)
    const pieces = splitItem(item, area, nextItemId)
    // What is kept so far, plus these pieces, plus every item still to come, must fit.
    if (next.length + pieces.length + (items.length - index - 1) > MAX_REGION_ITEMS) {
      overflow = true
      next.push(item)
      continue
    }
    changed = true
    next.push(...pieces)
  }
  if (overflow) message = `A claim holds at most ${MAX_REGION_ITEMS} shapes; a cut was skipped.`
  if (changed) {
    items = next
    select([])
    touch()
  } else bump()
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
  if (event.type === 'pointerdown') consumedPress = (event as PointerEvent).pointerId
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
  tool === 'select' || tool === 'direct'
    ? 'default'
    : tool === 'hand'
      ? 'grab'
      : tool === 'pen'
        ? 'copy'
        : 'crosshair'

const isSelectionTool = (of: ClaimTool): boolean => of === 'select' || of === 'direct'

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
    group: kind === 'move' ? selectedItems() : [],
    index,
    part,
    press: canvasPixelAt(event.clientX, event.clientY) ?? { x: origin.x, y: origin.y },
    moved: false,
  }
}

type PathShape = Extract<RegionShape, { kind: 'path' }>

/**
 * A parametric shape as a closed path with the same pixels, so its anchors can be edited one by
 * one: corners for a rectangle, polygon, or star; four smooth anchors with bezier handles for an
 * ellipse. This is what Illustrator does too: a rectangle is a path with four anchors.
 */
const toPath = (shape: RegionShape): PathShape => {
  if (shape.kind === 'path') return shape
  if (shape.kind === 'ellipse') {
    const cx = shape.x + shape.w / 2
    const cy = shape.y + shape.h / 2
    const rx = shape.w / 2
    const ry = shape.h / 2
    const kx = rx * ELLIPSE_KAPPA
    const ky = ry * ELLIPSE_KAPPA
    return {
      kind: 'path',
      closed: true,
      width: 0,
      nodes: [
        { x: cx, y: cy - ry, in: { x: cx - kx, y: cy - ry }, out: { x: cx + kx, y: cy - ry } },
        { x: cx + rx, y: cy, in: { x: cx + rx, y: cy - ky }, out: { x: cx + rx, y: cy + ky } },
        { x: cx, y: cy + ry, in: { x: cx + kx, y: cy + ry }, out: { x: cx - kx, y: cy + ry } },
        { x: cx - rx, y: cy, in: { x: cx - rx, y: cy + ky }, out: { x: cx - rx, y: cy - ky } },
      ],
    }
  }
  return {
    kind: 'path',
    closed: true,
    width: 0,
    nodes: regionShapeOutline(shape).map((point) => ({ x: point.x, y: point.y })),
  }
}

/** The anchors the direct-selection tool shows for a shape, in canvas coordinates. */
const anchorsOf = (shape: RegionShape): readonly Point[] =>
  shape.kind === 'path' ? shape.nodes : toPath(shape).nodes

const rotatePoint = (point: Point, centre: Point, radians: number): Point => {
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const dx = point.x - centre.x
  const dy = point.y - centre.y
  return { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos }
}

const rotatePath = (path: PathShape, centre: Point, radians: number): PathShape => ({
  ...path,
  nodes: path.nodes.map((node) => ({
    ...rotatePoint(node, centre, radians),
    ...(node.in === undefined ? {} : { in: rotatePoint(node.in, centre, radians) }),
    ...(node.out === undefined ? {} : { out: rotatePoint(node.out, centre, radians) }),
  })),
})

/**
 * A shape turned by `radians` about its centre. Polygons and stars turn in place, in whole
 * degrees; anything else becomes a path first, since a rectangle or ellipse has no angle.
 */
const rotateShape = (shape: RegionShape, centre: Point, radians: number): RegionShape => {
  if (shape.kind === 'polygon' || shape.kind === 'star') {
    const turned = Math.round((radians * 180) / Math.PI)
    return { ...shape, rotation: (((shape.rotation + turned) % 360) + 360) % 360 }
  }
  return rotatePath(toPath(shape), centre, radians)
}

/** The box the selection tool's scale handles sit on: the geometry itself, no stroke padding. */
const scaleBox = (shape: RegionShape): { x0: number; y0: number; x1: number; y1: number } => {
  if (shape.kind === 'path') {
    let x0 = Number.POSITIVE_INFINITY
    let y0 = Number.POSITIVE_INFINITY
    let x1 = Number.NEGATIVE_INFINITY
    let y1 = Number.NEGATIVE_INFINITY
    for (const node of shape.nodes) {
      for (const point of [node, node.in, node.out]) {
        if (point === undefined) continue
        x0 = Math.min(x0, point.x)
        y0 = Math.min(y0, point.y)
        x1 = Math.max(x1, point.x)
        y1 = Math.max(y1, point.y)
      }
    }
    return { x0, y0, x1, y1 }
  }
  const bounds = regionShapeBounds(shape)
  return { x0: bounds.x, y0: bounds.y, x1: bounds.x + bounds.w, y1: bounds.y + bounds.h }
}

const scaleBoxCorners = (shape: RegionShape): Point[] => {
  const { x0, y0, x1, y1 } = scaleBox(shape)
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
}

/**
 * A shape scaled about a fixed point, Illustrator's bounding-box handles. Paths scale their
 * anchors and handles; a raster is resampled nearest-neighbour into its new box, so its pixels
 * stay crisp. Anything else has its own handles and never gets here.
 */
const scaleShape = (
  shape: RegionShape,
  anchor: Point,
  sx: number,
  sy: number,
): RegionShape | null => {
  if (shape.kind === 'path') {
    const move = (point: Point): Point => ({
      x: anchor.x + (point.x - anchor.x) * sx,
      y: anchor.y + (point.y - anchor.y) * sy,
    })
    return {
      ...shape,
      nodes: shape.nodes.map((node) => ({
        ...move(node),
        ...(node.in === undefined ? {} : { in: move(node.in) }),
        ...(node.out === undefined ? {} : { out: move(node.out) }),
      })),
    }
  }
  if (shape.kind !== 'pixels') return null
  const source = regionShapePixels(shape)
  const left = anchor.x + (shape.x - anchor.x) * sx
  const right = anchor.x + (shape.x + shape.w - anchor.x) * sx
  const top = anchor.y + (shape.y - anchor.y) * sy
  const bottom = anchor.y + (shape.y + shape.h - anchor.y) * sy
  const x = Math.max(0, Math.round(Math.min(left, right)))
  const y = Math.max(0, Math.round(Math.min(top, bottom)))
  const w = Math.max(1, Math.round(Math.abs(right - left)))
  const h = Math.max(1, Math.round(Math.abs(bottom - top)))
  if (w * h > MAX_RASTER_BITS) return null
  const mask = new Uint8Array(w * h)
  let count = 0
  for (let row = 0; row < h; row++) {
    const sy0 = Math.min(shape.h - 1, Math.floor(((row + 0.5) / h) * shape.h))
    const srcRow = sy < 0 ? shape.h - 1 - sy0 : sy0
    for (let column = 0; column < w; column++) {
      const sx0 = Math.min(shape.w - 1, Math.floor(((column + 0.5) / w) * shape.w))
      const srcColumn = sx < 0 ? shape.w - 1 - sx0 : sx0
      if (source.mask[srcRow * shape.w + srcColumn] === 1) {
        mask[row * w + column] = 1
        count++
      }
    }
  }
  return rasterShapeFrom({ rect: { x, y, w, h }, mask, count })
}

/** The bounding-box corners of a shape, projected to client pixels. */
const cornersOnScreen = (
  shape: RegionShape,
): { readonly corners: readonly Point[]; readonly box: PresenceRect } | null => {
  const projection = screenProjection()
  if (projection === null) return null
  const box = regionShapeBounds(shape)
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map((corner) => projection.pointFor(corner.x, corner.y))
  return { corners, box }
}

/**
 * Whether a client point sits in a rotate zone: just outside a bounding-box corner of the one
 * selected shape, past the corner's own handle, as Illustrator's cursor does near a corner.
 */
const inRotateZone = (clientX: number, clientY: number): boolean => {
  const item = selectedItem()
  if (item === null || tool !== 'select') return false
  const screen = cornersOnScreen(item.shape)
  if (screen === null) return false
  const [a, , c] = screen.corners
  if (a === undefined || c === undefined) return false
  const insideBox =
    clientX >= Math.min(a.x, c.x) - HIT_RADIUS_CSS &&
    clientX <= Math.max(a.x, c.x) + HIT_RADIUS_CSS &&
    clientY >= Math.min(a.y, c.y) - HIT_RADIUS_CSS &&
    clientY <= Math.max(a.y, c.y) + HIT_RADIUS_CSS
  if (insideBox) return false
  return screen.corners.some(
    (corner) => Math.hypot(clientX - corner.x, clientY - corner.y) <= ROTATE_ZONE_CSS,
  )
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
  } else if (kind === 'node' && shape.kind === 'path' && tool === 'pen') {
    // The pen on a selected path: continue from an end, otherwise delete the anchor.
    if (!continuePathFrom(item, index)) deleteAnchorOf(item, index)
  } else if (kind === 'node' && shape.kind === 'path' && tool === 'delete-anchor') {
    if (part === 'anchor') deleteAnchorOf(item, index)
  } else if (kind === 'node' && shape.kind === 'path' && tool === 'add-anchor') {
    // Nothing to add on an anchor itself; segments are hit on the map.
  } else if (kind === 'node' && shape.kind === 'path' && tool === 'anchor') {
    if (part === 'anchor') startDrag('anchor-pull', event, { x: 0, y: 0 }, item, index, 'anchor')
    else startDrag('handle-solo', event, { x: 0, y: 0 }, item, index, part as Drag['part'])
  } else if (kind === 'node' && shape.kind === 'path') {
    startDrag('node', event, { x: 0, y: 0 }, item, index, (part as Drag['part']) ?? 'anchor')
  } else if (kind === 'anchor' && shape.kind !== 'path' && tool === 'delete-anchor') {
    deleteAnchorOf(item, index)
  } else if (kind === 'anchor' && shape.kind !== 'path' && tool === 'anchor') {
    const converted: RegionItem = { ...item, shape: toPath(shape) }
    replaceItem(item.id, converted.shape)
    startDrag('anchor-pull', event, { x: 0, y: 0 }, converted, index, 'anchor')
  } else if (kind === 'anchor' && shape.kind !== 'path') {
    // Editing one anchor of a rectangle, ellipse, polygon, or star turns it into a path, but
    // only once the anchor moves: a mere click must leave the claim as it was.
    startDrag('anchor-convert', event, { x: 0, y: 0 }, item, index, 'anchor')
  } else if (kind === 'rotate') {
    startDrag('rotate', event, regionShapeCentre(shape), item)
  } else if (kind === 'scale' && (shape.kind === 'path' || shape.kind === 'pixels')) {
    // The opposite corner of the bounding box stays put.
    const corners = scaleBoxCorners(shape)
    const opposite = corners[(index + 2) % 4] as Point
    startDrag('scale', event, opposite, item, index)
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
  if (inRotateZone(event.clientX, event.clientY)) {
    const item = selectedItem() as RegionItem
    consume(event)
    startDrag('rotate', event, regionShapeCentre(item.shape), item)
    notify()
    return
  }
  switch (tool) {
    case 'select':
    case 'direct': {
      const hit = itemAt(px, py)
      if (hit === null) {
        // Empty canvas: drag out a marquee. Shift adds to what is selected, as in Illustrator.
        consume(event)
        baseSelection = event.shiftKey ? selectedIds : []
        select(baseSelection)
        marquee = { x0: point.x, y0: point.y, x1: point.x, y1: point.y }
        startDrag('marquee', event, { x: px, y: py }, null)
        notify()
        return
      }
      consume(event)
      // Shift toggles membership; a press on an already selected shape keeps the whole selection
      // so the drag moves all of it; anything else selects just this shape.
      if (event.shiftKey)
        select(
          isSelected(hit.id) ? selectedIds.filter((id) => id !== hit.id) : [...selectedIds, hit.id],
        )
      else if (!isSelected(hit.id) || tool === 'direct') select([hit.id])
      if (tool === 'select' && isSelected(hit.id)) startDrag('move', event, { x: px, y: py }, hit)
      notify()
      return
    }
    case 'lasso': {
      // The lasso owns the press: the map does not pan under it.
      consume(event)
      baseSelection = event.shiftKey ? selectedIds : []
      select(baseSelection)
      lasso = [{ x: point.x, y: point.y }]
      startDrag('lasso', event, { x: px, y: py }, null)
      notify()
      return
    }
    case 'hand':
      // The one tool that leaves the press to the map, so dragging pans.
      return
    case 'add-anchor': {
      consume(event)
      if (!addAnchorAt(point)) select([])
      notify()
      return
    }
    case 'delete-anchor':
    case 'anchor': {
      // Anchors are SVG handles and arrive through onHandlePress; the map itself just selects.
      consume(event)
      const near = pathNear(point)
      select(near === null ? [] : [near.item.id])
      notify()
      return
    }
    case 'pen': {
      consume(event)
      if (pen === null) {
        // Not drawing: a click on a selected path's segment adds an anchor there instead.
        const near = pathNear(point)
        if (near !== null && isSelected(near.item.id)) {
          addAnchorAt(point)
          notify()
          return
        }
      }
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
      // Anchors sit wherever the pointer is; the grid only matters once the path is rasterised.
      pen = [...pen, { x: point.x, y: point.y }]
      startDrag('pen', event, { x: point.x, y: point.y }, null, pen.length - 1)
      bump()
      notify()
      return
    }
    case 'pencil': {
      consume(event)
      raster = new PixelSet()
      raster.stamp(px, py, pencilWidth)
      lastStamp = { x: px, y: py }
      startDrag('raster', event, { x: px, y: py }, null)
      bump()
      notify()
      return
    }
    case 'eraser': {
      consume(event)
      const set = new PixelSet()
      set.stamp(px, py, eraserWidth)
      // The cut through vector shapes follows the same pixel centres the raster stamps.
      erasing = { set, line: [{ x: px + 0.5, y: py + 0.5 }] }
      lastStamp = { x: px, y: py }
      startDrag('erase', event, { x: px, y: py }, null)
      bump()
      notify()
      return
    }
    case 'brush':
      consume(event)
      select([])
      stroke = [{ x: px + 0.5, y: py + 0.5 }]
      startDrag('stroke', event, { x: px, y: py }, null)
      bump()
      notify()
      return
    default:
      consume(event)
      select([])
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
    if (tool === 'pen' && pen !== null) {
      hover = canvasPixelAt(event.clientX, event.clientY)
      syncOverlay()
    }
    if (isSelectionTool(tool)) {
      const point = canvasPixelAt(event.clientX, event.clientY)
      const px = point === null ? -1 : pixel(point.x)
      const py = point === null ? -1 : pixel(point.y)
      const overItem = point !== null && itemAt(px, py) !== null
      setCursor(
        inRotateZone(event.clientX, event.clientY) ? ROTATE_CURSOR : overItem ? 'move' : 'default',
      )
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
    case 'move': {
      if (base === null || !drag.moved) return
      // Every selected shape travels by the same whole-pixel offset.
      const dx = px - drag.originX
      const dy = py - drag.originY
      const moved = new Map(drag.group.map((item) => [item.id, item] as const))
      items = items.map((item) => {
        const was = moved.get(item.id)
        return was === undefined
          ? item
          : { ...item, shape: translateRegionShape(was.shape, dx, dy) }
      })
      touch()
      setCursor('grabbing')
      break
    }
    case 'marquee': {
      if (marquee === null) return
      marquee = { ...marquee, x1: point.x, y1: point.y }
      const caught = items.filter((item) =>
        inMarquee(item.shape, marquee as NonNullable<typeof marquee>),
      )
      select([...baseSelection, ...caught.map((item) => item.id)])
      break
    }
    case 'lasso': {
      if (lasso === null) return
      const last = lasso[lasso.length - 1] as Point
      if (Math.hypot(point.x - last.x, point.y - last.y) >= 1)
        lasso = [...lasso, { x: point.x, y: point.y }]
      const ring = lasso
      const caught = items.filter((item) => inLasso(item.shape, ring))
      select([...baseSelection, ...caught.map((item) => item.id)])
      break
    }
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
      replaceItem(
        base.id,
        moveNode(current.shape, drag.index, drag.part, point.x, point.y, base.shape),
      )
      break
    }
    case 'scale': {
      if (base === null) return
      const anchor = { x: drag.originX, y: drag.originY }
      const from = scaleBoxCorners(base.shape)[drag.index] as Point
      const spanX = from.x - anchor.x
      const spanY = from.y - anchor.y
      // A box cannot collapse to nothing: the dragged corner keeps at least half a pixel away.
      const keep = (value: number, span: number): number =>
        Math.abs(value) < 0.5 ? (span < 0 ? -0.5 : 0.5) : value
      let sx = spanX === 0 ? 1 : keep(point.x - anchor.x, spanX) / spanX
      let sy = spanY === 0 ? 1 : keep(point.y - anchor.y, spanY) / spanY
      if (event.shiftKey) {
        // Shift keeps the proportions, following whichever axis was pulled further.
        const uniform = Math.abs(sx) >= Math.abs(sy) ? Math.abs(sx) : Math.abs(sy)
        sx = Math.sign(sx) * uniform
        sy = Math.sign(sy) * uniform
      }
      const scaled = scaleShape(base.shape, anchor, sx, sy)
      if (scaled === null) {
        message = 'That is too large for one drawing.'
        break
      }
      replaceItem(base.id, scaled)
      break
    }
    case 'rotate': {
      if (base === null) return
      const centre = { x: drag.originX, y: drag.originY }
      let radians =
        Math.atan2(point.y - centre.y, point.x - centre.x) -
        Math.atan2(drag.press.y - centre.y, drag.press.x - centre.x)
      if (event.shiftKey) {
        const step = (ROTATE_SNAP_DEGREES * Math.PI) / 180
        radians = Math.round(radians / step) * step
      }
      replaceItem(base.id, rotateShape(base.shape, centre, radians))
      setCursor(ROTATE_CURSOR)
      break
    }
    case 'raster': {
      if (raster === null) return
      raster.line(lastStamp ?? { x: px, y: py }, { x: px, y: py }, pencilWidth)
      lastStamp = { x: px, y: py }
      bump()
      break
    }
    case 'erase': {
      if (erasing === null) return
      erasing.set.line(lastStamp ?? { x: px, y: py }, { x: px, y: py }, eraserWidth)
      lastStamp = { x: px, y: py }
      const last = erasing.line[erasing.line.length - 1] as Point
      const centre = { x: px + 0.5, y: py + 0.5 }
      if (Math.hypot(centre.x - last.x, centre.y - last.y) >= 1)
        erasing.line = [...erasing.line, centre]
      bump()
      break
    }
    case 'anchor-convert': {
      if (base === null || !drag.moved) return
      const converted: RegionItem = { ...base, shape: toPath(base.shape) }
      const path = converted.shape as PathShape
      drag = { ...drag, kind: 'node', base: converted }
      replaceItem(base.id, moveNode(path, drag.index, 'anchor', point.x, point.y, path))
      break
    }
    case 'anchor-pull': {
      if (base?.shape.kind !== 'path' || !drag.moved) return
      // Dragging out of an anchor gives it a pair of handles pointing along the drag.
      const current = selectedItem()
      if (current?.shape.kind !== 'path') return
      const index = drag.index
      const node = current.shape.nodes[index] as PathNode
      const nodes = current.shape.nodes.map((held, at) =>
        at === index ? smoothAnchor(node, { x: point.x, y: point.y }) : held,
      )
      replaceItem(base.id, { ...current.shape, nodes })
      break
    }
    case 'handle-solo': {
      if (base?.shape.kind !== 'path') return
      // One handle on its own: the other stays, which breaks the smooth pair into a cusp.
      const current = selectedItem()
      if (current?.shape.kind !== 'path') return
      const index = drag.index
      const part = drag.part
      const nodes = current.shape.nodes.map((held, at) =>
        at === index ? { ...held, [part]: { x: point.x, y: point.y } } : held,
      )
      replaceItem(base.id, { ...current.shape, nodes })
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
  if (drag === null) {
    if (consumedPress === event.pointerId) {
      // A click the editor answered (a selection, an anchor) never reaches Wplace.
      consumedPress = null
      consume(event)
      swallowNextClick()
    }
    return
  }
  if (event.pointerId !== drag.pointerId) return
  consumedPress = null
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
    case 'anchor-pull': {
      const base = ended.base
      if (!ended.moved && base?.shape.kind === 'path') {
        const current = selectedItem()
        if (current?.shape.kind === 'path') {
          const node = current.shape.nodes[ended.index] as PathNode
          if (isSmooth(node))
            replaceItem(base.id, {
              ...current.shape,
              nodes: current.shape.nodes.map((held, at) =>
                at === ended.index ? cornerAnchor(held) : held,
              ),
            })
        }
      }
      break
    }
    case 'raster':
      finishRaster()
      return
    case 'erase':
      finishErase()
      return
    case 'marquee':
    case 'lasso':
      // A click with no drag on empty canvas clears the selection, like Illustrator.
      if (!ended.moved && !event.shiftKey) select([])
      marquee = null
      lasso = null
      break
    default:
      break
  }
  bump()
  setCursor(toolCursor())
  notify()
}

/**
 * A cancelled pointer (the browser took it: a gesture, a lost capture) is not a release. What a
 * drag changed goes back, what it was drawing is dropped, and no click is expected after it.
 */
const onPointerCancel = (event: PointerEvent): void => {
  if (drag === null) {
    if (consumedPress === event.pointerId) consumedPress = null
    return
  }
  if (event.pointerId !== drag.pointerId) return
  const ended = drag
  drag = null
  consumedPress = null
  switch (ended.kind) {
    case 'move':
      items = items.map((item) => ended.group.find((was) => was.id === item.id) ?? item)
      break
    case 'corner':
    case 'outer':
    case 'inner':
    case 'node':
    case 'rotate':
    case 'scale':
    case 'anchor-pull':
    case 'handle-solo':
    case 'anchor-convert':
      if (ended.base !== null)
        items = items.map((item) =>
          item.id === ended.base?.id ? (ended.base as RegionItem) : item,
        )
      break
    case 'pen':
      if (pen !== null) pen = pen.filter((_, at) => at !== ended.index)
      if (pen !== null && pen.length === 0) pen = null
      break
    default:
      break
  }
  drawing = null
  stroke = null
  raster = null
  erasing = null
  lastStamp = null
  marquee = null
  lasso = null
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
  if (pending) {
    // A save is in flight with a snapshot of the document; an edit now would be lost with it.
    consume(event)
    return
  }
  const key = event.key.toLowerCase()
  if (key === ' ') {
    // Holding space is a temporary hand, as in Illustrator; the tool comes back on release.
    consume(event)
    if (handHeldFrom === null && tool !== 'hand' && drag === null) {
      handHeldFrom = tool
      setTool('hand')
      notify()
    }
    return
  }
  if (key === 'escape') {
    // An open tool flyout closes on Escape by itself; the editor stays out of it.
    if (mode?.shadowRoot?.querySelector('[role="menu"]') != null) return
    consume(event)
    if (pen !== null) {
      // Dropping the pen gives a continued path back as it was.
      pen = null
      if (penContinued !== null) restoreContinued(penContinued)
      penContinued = null
      bump()
      notify()
    } else if (selectedIds.length > 0) {
      select([])
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
  if (key === '+' || key === '=') {
    consume(event)
    setTool('add-anchor')
    return
  }
  if (key === '-' || key === '_') {
    consume(event)
    setTool('delete-anchor')
    return
  }
  if (key === 'c' && event.shiftKey) {
    consume(event)
    setTool('anchor')
    return
  }
  const next = TOOL_KEYS[key]
  if (next !== undefined) {
    consume(event)
    setTool(next)
  }
}

const onKeyup = (event: KeyboardEvent): void => {
  if (!active || event.key !== ' ' || handHeldFrom === null) return
  const back = handHeldFrom
  handHeldFrom = null
  setTool(back)
  notify()
}

/**
 * The wheel in claim mode, Illustrator-style: scroll pans, Shift+scroll pans sideways, and a
 * zoom needs Alt/Option or Ctrl/Cmd. Plain wheels are consumed and turned into a pan so the map
 * never zooms under a stray scroll; modified ones pass through to the map's own zoom.
 */
const onWheel = (event: WheelEvent): void => {
  if (!active || event.altKey || event.ctrlKey || event.metaKey) return
  const target = event.target
  if (!(target instanceof Element) || !isMapInteractionTarget(target)) return
  const map = getMap() as {
    panBy?: (offset: [number, number], options?: unknown) => unknown
  } | null
  if (map?.panBy === undefined) return
  consume(event)
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1
  let dx = event.deltaX * scale
  let dy = event.deltaY * scale
  if (event.shiftKey && dx === 0) {
    dx = dy
    dy = 0
  }
  if (dx === 0 && dy === 0) return
  map.panBy([dx, dy], { animate: false })
}

const deleteSelected = (): void => {
  if (selectedIds.length === 0) return
  items = items.filter((item) => !isSelected(item.id))
  select([])
  touch()
  notify()
}

const setTool = (next: ClaimTool): void => {
  if (pen !== null && next !== 'pen') commitPen(false)
  // Hand-tool clicks reach Wplace and can open its pixel card; it is stale again from here.
  if (tool === 'hand' && next !== 'hand') dismissWplacePixelCard()
  tool = next
  shown = { ...shown, [groupOf(next)]: next }
  if (next !== 'hand') handHeldFrom = null
  marquee = null
  lasso = null
  setCursor(toolCursor())
  notify()
}

/**
 * Save writes your whole set of regions back: everything on screen becomes one claim, saved
 * under the first loaded id (or a new one), and any other loaded claims are released since
 * their shapes now live in that one. An empty set releases everything. Removed shapes are
 * simply absent from what is written.
 */
const confirm = async (): Promise<void> => {
  if (!active || pending || host === null) return
  if (pen !== null) commitPen(false)
  if (!dirty) {
    stopClaimMode()
    return
  }
  if (items.length > MAX_REGION_ITEMS) {
    message = `A claim holds at most ${MAX_REGION_ITEMS} shapes; remove ${items.length - MAX_REGION_ITEMS} before saving.`
    notify()
    return
  }
  const document: RegionDocument = { items }
  const [primary, ...others] = editingIds
  const mine = session
  pending = true
  message = undefined
  notify()
  let error: string | null = null
  if (items.length > 0) error = await host.save(primary ?? null, document)
  else if (primary !== undefined) error = await host.remove(primary)
  const written = error === null
  const unreleased: string[] = []
  if (written) {
    // The primary now holds every shape. A source that fails to release is a duplicate of
    // part of it, so it stays in the set and the next Save tries again.
    for (const id of others) {
      const failure = await host.remove(id)
      if (failure !== null) {
        error ??= failure
        unreleased.push(id)
      }
    }
  }
  // Escape during the wait ends this session; whatever opened since is not this request's.
  if (session !== mine) return
  pending = false
  if (!isClaimModeActive()) return
  if (error === null) stopClaimMode()
  else {
    if (written && primary !== undefined) {
      editingIds = [primary, ...unreleased]
      dirty = true
      message = `${error} Save again to release the remaining ${unreleased.length === 1 ? 'claim' : 'claims'}.`
    } else message = error
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
      if (intent.option === 'width') {
        if (tool === 'pencil') pencilWidth = clampInt(value, 1, MAX_STROKE_WIDTH)
        else if (tool === 'eraser') eraserWidth = clampInt(value, 1, MAX_STROKE_WIDTH)
        else width = clampInt(value, 0, MAX_STROKE_WIDTH)
      }
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
      if (selectedIds.length > 0) {
        items = items.map((item) =>
          isSelected(item.id) ? { ...item, op: subtract ? 'subtract' : 'add' } : item,
        )
        touch()
      }
      break
    }
    case 'delete-item':
      deleteSelected()
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
  const single = selectedIds.length === 1
  for (const item of items) {
    const selected = isSelected(item.id)
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
    if (!selected || !single) continue
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
      } else {
        // A path or a drawing: Illustrator's bounding box, with a scale handle on each corner.
        const corners = scaleBoxCorners(shape).map(project)
        root.appendChild(
          svg('path', {
            d: pathData(corners, true),
            fill: 'none',
            stroke: accent,
            'stroke-width': 1,
            'stroke-dasharray': '3 3',
            'data-gesture': 'bounds',
          }),
        )
        for (const [index, corner] of corners.entries()) handle(corner, `scale:${index}`, accent)
      }
    }
    if (tool === 'select') {
      // A rotate handle floats above the box; the zones just outside its corners rotate too.
      const box = regionShapeBounds(shape)
      const top = project({ x: box.x + box.w / 2, y: box.y })
      const grip = { x: top.x, y: top.y - ROTATE_STEM_CSS }
      root.appendChild(
        svg('line', {
          x1: top.x,
          y1: top.y,
          x2: grip.x,
          y2: grip.y,
          stroke: accent,
          'stroke-width': 1,
        }),
      )
      handle(grip, 'rotate:0', 'rgb(120 200 90)')
      const rotateGrip = root.lastElementChild as SVGElement | null
      if (rotateGrip !== null) rotateGrip.style.cursor = ROTATE_CURSOR
    }
    const anchorTool =
      tool === 'direct' ||
      tool === 'anchor' ||
      tool === 'add-anchor' ||
      tool === 'delete-anchor' ||
      (tool === 'pen' && pen === null)
    if (anchorTool && shape.kind !== 'path') {
      // Every shape has anchors under direct selection; dragging one makes it a path.
      for (const [index, anchor] of anchorsOf(shape).entries())
        handle(project(anchor), `anchor:${index}`, accent)
    }
    if (anchorTool && shape.kind === 'path') {
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
  // Selection gestures show what they cover: a dashed box or loop, with the caught shapes lit.
  if (marquee !== null) {
    const a = project({ x: Math.min(marquee.x0, marquee.x1), y: Math.min(marquee.y0, marquee.y1) })
    const b = project({ x: Math.max(marquee.x0, marquee.x1), y: Math.max(marquee.y0, marquee.y1) })
    root.appendChild(
      svg('rect', {
        x: a.x,
        y: a.y,
        width: Math.max(0, b.x - a.x),
        height: Math.max(0, b.y - a.y),
        fill: 'rgb(30 144 255 / 0.12)',
        stroke: accent,
        'stroke-width': 1,
        'stroke-dasharray': '4 3',
        'data-gesture': 'marquee',
      }),
    )
  }
  if (lasso !== null && lasso.length > 1) {
    root.appendChild(
      svg('path', {
        d: pathData(lasso.map(project), true),
        fill: 'rgb(30 144 255 / 0.12)',
        stroke: accent,
        'stroke-width': 1,
        'stroke-dasharray': '4 3',
        'data-gesture': 'lasso',
      }),
    )
  }
  // What is mid-gesture gets an outline too, so a shape is visible while it is being dragged out.
  if (drawing !== null) {
    root.appendChild(
      svg('path', {
        d: pathData(regionShapeOutline(drawing).map(project), true),
        fill: 'none',
        stroke: accent,
        'stroke-width': 1.5,
        'stroke-dasharray': subtract ? '4 3' : '0',
      }),
    )
  }
  if (erasing !== null && erasing.line.length > 1) {
    root.appendChild(
      svg('path', {
        d: pathData(erasing.line.map(project), false),
        fill: 'none',
        stroke: 'rgb(255 90 90)',
        'stroke-width': 1.5,
        'stroke-dasharray': '4 3',
        'stroke-linecap': 'round',
        'data-gesture': 'erase',
      }),
    )
  }
  if (stroke !== null && stroke.length > 1) {
    root.appendChild(
      svg('path', {
        d: pathData(stroke.map(project), false),
        fill: 'none',
        stroke: accent,
        'stroke-width': 1.5,
        'stroke-linecap': 'round',
      }),
    )
  }
  if (pen !== null && pen.length > 0) {
    // The path so far as the curve it is, with every anchor and handle, as any vector editor.
    const curve = flattenPath(pen, false).map(project)
    root.appendChild(
      svg('path', { d: pathData(curve, false), fill: 'none', stroke: accent, 'stroke-width': 1.5 }),
    )
    const last = pen[pen.length - 1] as PathNode
    if (hover !== null && drag === null) {
      // The rubber band: where the next segment would go from the last anchor.
      root.appendChild(
        svg('path', {
          d: pathData(rubberBand(last, hover).map(project), false),
          fill: 'none',
          stroke: accent,
          'stroke-width': 1,
          'stroke-dasharray': '3 3',
          'data-gesture': 'rubber-band',
        }),
      )
    }
    const drawn = pen
    drawn.forEach((node, index) => {
      const anchor = project(node)
      for (const part of ['in', 'out'] as const) {
        const control = node[part]
        if (control === undefined) continue
        const at = project(control)
        root.appendChild(
          svg('line', { x1: anchor.x, y1: anchor.y, x2: at.x, y2: at.y, stroke: accent }),
        )
        root.appendChild(svg('circle', { cx: at.x, cy: at.y, r: 3, fill: '#fff', stroke: accent }))
      }
      const size = 7
      root.appendChild(
        svg('rect', {
          x: anchor.x - size / 2,
          y: anchor.y - size / 2,
          width: size,
          height: size,
          fill: index === drawn.length - 1 ? accent : '#fff',
          stroke: accent,
          'stroke-width': 1.5,
          'data-pen-anchor': index,
        }),
      )
    })
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
  window.addEventListener('pointercancel', onPointerCancel, true)
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('keyup', onKeyup, true)
  window.addEventListener('wheel', onWheel, { capture: true, passive: false })
}

/** Enter claim mode with a tool in hand. Every one of your saved regions loads for editing. */
export const startClaimMode = (initialTool?: ClaimTool): void => {
  if (host === null) return
  if (active) {
    if (initialTool !== undefined) setTool(initialTool)
    return
  }
  active = true
  session++
  tool = initialTool ?? 'select'
  shown = { ...defaultShown(), [groupOf(tool)]: tool }
  // Whatever pixel Wplace had selected is stale now that clicks belong to the editor.
  dismissWplacePixelCard()
  const saved = host.myRegions()
  // Claims saved separately may reuse item ids; every item needs its own here, or a later
  // edit could address the wrong one and the merged document would be refused.
  const seen = new Set<string>()
  items = saved
    .flatMap((region) => region.document.items)
    .map((item) => {
      if (!seen.has(item.id)) {
        seen.add(item.id)
        return item
      }
      const fresh = { ...item, id: nextItemId() }
      seen.add(fresh.id)
      return fresh
    })
  editingIds = saved.map((region) => region.id)
  select([])
  marquee = null
  lasso = null
  raster = null
  erasing = null
  lastStamp = null
  penContinued = null
  hover = null
  dirty = false
  drag = null
  pen = null
  stroke = null
  drawing = null
  pending = false
  message = undefined
  if (items.length > MAX_REGION_ITEMS)
    message = `Your claims hold ${items.length} shapes together; a claim holds at most ${MAX_REGION_ITEMS}. Remove some before saving.`
  bump()
  setCursor(toolCursor())
  notify()
}

/** Leave claim mode. Nothing unsaved survives this. */
export const stopClaimMode = (): void => {
  if (!active) return
  active = false
  items = []
  select([])
  marquee = null
  lasso = null
  raster = null
  erasing = null
  lastStamp = null
  penContinued = null
  hover = null
  consumedPress = null
  handHeldFrom = null
  editingIds = []
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
    window.removeEventListener('pointercancel', onPointerCancel, true)
    window.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('keyup', onKeyup, true)
    window.removeEventListener('wheel', onWheel, true)
    installed = false
  }
  host = null
  listeners.length = 0
  tool = 'select'
  shown = defaultShown()
  sides = 6
  points = 5
  inner = DEFAULT_INNER
  width = 8
  pencilWidth = 1
  eraserWidth = 8
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
