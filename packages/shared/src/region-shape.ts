import type { PresenceRect } from './presence.js'

/**
 * The vector model behind a region claim.
 *
 * A claim is a small document of shapes, like an Illustrator artboard: rectangles, ellipses,
 * regular polygons, stars, and bezier paths, each added to or subtracted from the claim in order.
 * Every one stays editable: a path keeps its nodes and control handles, a star keeps its point
 * count and inner radius. Nothing is ever flattened on the wire.
 *
 * What is claimed is still whole pixels. `regionDocumentPixels` rasterises the document by
 * pixel-centre membership, so edges land on the grid, curves are aliased, and no claim has a half
 * pixel. It is the one source of truth for membership; every renderer and hit test goes through
 * it. Coordinates are canvas pixels and may be fractional inside a path (a bezier handle needs
 * that); the rasteriser is what makes the result exact.
 */

export interface Point {
  readonly x: number
  readonly y: number
}

/**
 * One anchor of a bezier path. `in` and `out` are absolute control points; a node without them is
 * a corner, and the segment to a neighbour without handles on either side is a straight line.
 */
export interface PathNode {
  readonly x: number
  readonly y: number
  readonly in?: Point
  readonly out?: Point
}

export type RegionShape =
  | {
      readonly kind: 'rectangle'
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
    }
  | {
      readonly kind: 'ellipse'
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
    }
  | {
      readonly kind: 'polygon'
      readonly cx: number
      readonly cy: number
      readonly r: number
      readonly sides: number
      readonly rotation: number
    }
  | {
      readonly kind: 'star'
      readonly cx: number
      readonly cy: number
      readonly r: number
      readonly inner: number
      readonly points: number
      readonly rotation: number
    }
  | {
      readonly kind: 'path'
      readonly nodes: readonly PathNode[]
      /** A closed path is filled; an open one is only ever a stroke. */
      readonly closed: boolean
      /** Stroke width in pixels. Zero means fill only, which needs a closed path. */
      readonly width: number
    }

export type RegionShapeKind = RegionShape['kind']

/** One entry of a document: a shape that adds to or cuts out of the claim. */
export interface RegionItem {
  readonly id: string
  readonly shape: RegionShape
  readonly op: 'add' | 'subtract'
}

export interface RegionDocument {
  readonly items: readonly RegionItem[]
}

export const REGION_SHAPE_KINDS: readonly RegionShapeKind[] = [
  'rectangle',
  'ellipse',
  'polygon',
  'star',
  'path',
]
export const MIN_REGION_SHAPE_CORNERS = 3
export const MAX_REGION_SHAPE_CORNERS = 12
/** Largest radius or box side, in canvas pixels. Keeps the bounding box bounded. */
export const MAX_REGION_SHAPE_EXTENT = 2_000
export const MAX_REGION_ITEMS = 64
export const MAX_PATH_NODES = 256
export const MAX_STROKE_WIDTH = 200
/** Pixels a whole document may span; matches the presence region area limit. */
export const MAX_REGION_DOCUMENT_PIXELS = 4_000_000
/** Widest a canvas coordinate may be; the world is 2,048,000 pixels a side. */
const MAX_COORDINATE = 4_000_000
const MAX_ITEM_ID = 64

export interface RegionShapePixels {
  readonly rect: PresenceRect
  /** `mask[i]` is 1 inside, row-major over `rect`. */
  readonly mask: Uint8Array
  readonly count: number
}

const int = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)

const coordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE

const isPoint = (value: unknown): value is Point =>
  typeof value === 'object' &&
  value !== null &&
  coordinate((value as Point).x) &&
  coordinate((value as Point).y)

const validBox = (shape: Record<string, unknown>): boolean =>
  int(shape.x) &&
  int(shape.y) &&
  int(shape.w) &&
  int(shape.h) &&
  shape.x >= 0 &&
  shape.y >= 0 &&
  shape.w >= 1 &&
  shape.h >= 1 &&
  shape.w <= MAX_REGION_SHAPE_EXTENT &&
  shape.h <= MAX_REGION_SHAPE_EXTENT

const validRadius = (value: unknown): value is number =>
  int(value) && value >= 1 && value <= MAX_REGION_SHAPE_EXTENT / 2

const validRotation = (value: unknown): value is number => int(value) && value >= 0 && value < 360

const validCorners = (value: unknown): value is number =>
  int(value) && value >= MIN_REGION_SHAPE_CORNERS && value <= MAX_REGION_SHAPE_CORNERS

const isPathNode = (value: unknown): value is PathNode => {
  if (!isPoint(value)) return false
  const node = value as PathNode
  return (
    (node.in === undefined || isPoint(node.in)) && (node.out === undefined || isPoint(node.out))
  )
}

/** Structural validation only; surface bounds are the caller's concern. */
export const isRegionShape = (value: unknown): value is RegionShape => {
  if (typeof value !== 'object' || value === null) return false
  const shape = value as Record<string, unknown>
  switch (shape.kind) {
    case 'rectangle':
    case 'ellipse':
      return validBox(shape)
    case 'polygon':
      return (
        int(shape.cx) &&
        int(shape.cy) &&
        shape.cx >= 0 &&
        shape.cy >= 0 &&
        validRadius(shape.r) &&
        validCorners(shape.sides) &&
        validRotation(shape.rotation)
      )
    case 'star':
      return (
        int(shape.cx) &&
        int(shape.cy) &&
        shape.cx >= 0 &&
        shape.cy >= 0 &&
        validRadius(shape.r) &&
        int(shape.inner) &&
        shape.inner >= 1 &&
        shape.inner < Number(shape.r) &&
        validCorners(shape.points) &&
        validRotation(shape.rotation)
      )
    case 'path':
      return (
        typeof shape.closed === 'boolean' &&
        typeof shape.width === 'number' &&
        Number.isFinite(shape.width) &&
        shape.width >= 0 &&
        shape.width <= MAX_STROKE_WIDTH &&
        (shape.closed || shape.width > 0) &&
        Array.isArray(shape.nodes) &&
        shape.nodes.length >= (shape.closed ? 3 : 2) &&
        shape.nodes.length <= MAX_PATH_NODES &&
        shape.nodes.every(isPathNode)
      )
    default:
      return false
  }
}

export const isRegionItem = (value: unknown): value is RegionItem => {
  if (typeof value !== 'object' || value === null) return false
  const item = value as RegionItem
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    item.id.length <= MAX_ITEM_ID &&
    (item.op === 'add' || item.op === 'subtract') &&
    isRegionShape(item.shape)
  )
}

export const isRegionDocument = (value: unknown): value is RegionDocument => {
  if (typeof value !== 'object' || value === null) return false
  const items = (value as RegionDocument).items
  return (
    Array.isArray(items) &&
    items.length >= 1 &&
    items.length <= MAX_REGION_ITEMS &&
    items.every(isRegionItem) &&
    new Set(items.map((item) => item.id)).size === items.length
  )
}

const radians = (value: number): number => (value * Math.PI) / 180

const cubicAt = (a: number, b: number, c: number, d: number, t: number): number => {
  const u = 1 - t
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d
}

/**
 * A path as a polyline, beziers subdivided finely enough that no chord strays more than a pixel
 * from the curve at any reasonable size.
 */
export const flattenPath = (nodes: readonly PathNode[], closed: boolean): readonly Point[] => {
  const out: Point[] = []
  const count = closed ? nodes.length : nodes.length - 1
  for (let index = 0; index < count; index++) {
    const from = nodes[index] as PathNode
    const to = nodes[(index + 1) % nodes.length] as PathNode
    out.push({ x: from.x, y: from.y })
    if (from.out === undefined && to.in === undefined) continue
    const c1 = from.out ?? { x: from.x, y: from.y }
    const c2 = to.in ?? { x: to.x, y: to.y }
    const rough =
      Math.hypot(c1.x - from.x, c1.y - from.y) +
      Math.hypot(c2.x - c1.x, c2.y - c1.y) +
      Math.hypot(to.x - c2.x, to.y - c2.y)
    const steps = Math.max(4, Math.min(96, Math.ceil(rough / 3)))
    for (let step = 1; step < steps; step++) {
      const t = step / steps
      out.push({
        x: cubicAt(from.x, c1.x, c2.x, to.x, t),
        y: cubicAt(from.y, c1.y, c2.y, to.y, t),
      })
    }
  }
  if (!closed) {
    const last = nodes[nodes.length - 1]
    if (last !== undefined) out.push({ x: last.x, y: last.y })
  }
  return out
}

/**
 * The geometric outline as a ring or polyline of points, for handles and hit testing. Pixel
 * membership does not come from this; see `regionShapePixels`.
 */
export const regionShapeOutline = (shape: RegionShape): readonly Point[] => {
  switch (shape.kind) {
    case 'rectangle':
      return [
        { x: shape.x, y: shape.y },
        { x: shape.x + shape.w, y: shape.y },
        { x: shape.x + shape.w, y: shape.y + shape.h },
        { x: shape.x, y: shape.y + shape.h },
      ]
    case 'ellipse': {
      const cx = shape.x + shape.w / 2
      const cy = shape.y + shape.h / 2
      const segments = Math.max(24, Math.min(96, Math.round(Math.max(shape.w, shape.h) / 8)))
      return Array.from({ length: segments }, (_, index) => {
        const angle = (index / segments) * Math.PI * 2
        return {
          x: cx + (Math.cos(angle) * shape.w) / 2,
          y: cy + (Math.sin(angle) * shape.h) / 2,
        }
      })
    }
    case 'polygon':
      return Array.from({ length: shape.sides }, (_, index) => {
        const angle = radians(shape.rotation) + (index / shape.sides) * Math.PI * 2
        return { x: shape.cx + Math.cos(angle) * shape.r, y: shape.cy + Math.sin(angle) * shape.r }
      })
    case 'star':
      return Array.from({ length: shape.points * 2 }, (_, index) => {
        const angle = radians(shape.rotation) + (index / (shape.points * 2)) * Math.PI * 2
        const radius = index % 2 === 0 ? shape.r : shape.inner
        return { x: shape.cx + Math.cos(angle) * radius, y: shape.cy + Math.sin(angle) * radius }
      })
    case 'path':
      return flattenPath(shape.nodes, shape.closed)
  }
}

export const regionShapeCentre = (shape: RegionShape): Point => {
  if (shape.kind === 'rectangle' || shape.kind === 'ellipse')
    return { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 }
  if (shape.kind === 'path') {
    const bounds = regionShapeBounds(shape)
    return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }
  }
  return { x: shape.cx, y: shape.cy }
}

const boundsOf = (points: readonly Point[], pad = 0): PresenceRect => {
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const point of points) {
    left = Math.min(left, point.x)
    top = Math.min(top, point.y)
    right = Math.max(right, point.x)
    bottom = Math.max(bottom, point.y)
  }
  if (!Number.isFinite(left)) return { x: 0, y: 0, w: 1, h: 1 }
  const x = Math.max(0, Math.floor(left - pad))
  const y = Math.max(0, Math.floor(top - pad))
  return {
    x,
    y,
    w: Math.max(1, Math.ceil(right + pad) - x),
    h: Math.max(1, Math.ceil(bottom + pad) - y),
  }
}

/** The whole-pixel bounding box, clamped at the canvas origin. Interest checks use this. */
export const regionShapeBounds = (shape: RegionShape): PresenceRect => {
  if (shape.kind === 'rectangle' || shape.kind === 'ellipse')
    return { x: shape.x, y: shape.y, w: shape.w, h: shape.h }
  if (shape.kind === 'path') {
    const handles = shape.nodes.flatMap((node) => [
      node,
      ...(node.in === undefined ? [] : [node.in]),
      ...(node.out === undefined ? [] : [node.out]),
    ])
    return boundsOf(handles, shape.width / 2 + 1)
  }
  return boundsOf(regionShapeOutline(shape))
}

const unionRect = (a: PresenceRect, b: PresenceRect): PresenceRect => {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  }
}

/** The bounding box of every added item; subtractions cannot grow a claim. */
export const regionDocumentBounds = (document: RegionDocument): PresenceRect | null => {
  let bounds: PresenceRect | null = null
  for (const item of document.items) {
    if (item.op !== 'add') continue
    const rect = regionShapeBounds(item.shape)
    bounds = bounds === null ? rect : unionRect(bounds, rect)
  }
  return bounds
}

/** Move a shape by whole pixels, keeping it on the canvas. */
export const translateRegionShape = (shape: RegionShape, dx: number, dy: number): RegionShape => {
  const mx = Math.round(dx)
  const my = Math.round(dy)
  if (shape.kind === 'rectangle' || shape.kind === 'ellipse')
    return { ...shape, x: Math.max(0, shape.x + mx), y: Math.max(0, shape.y + my) }
  if (shape.kind === 'path') {
    const move = (point: Point): Point => ({ x: point.x + mx, y: point.y + my })
    return {
      ...shape,
      nodes: shape.nodes.map((node) => ({
        ...move(node),
        ...(node.in === undefined ? {} : { in: move(node.in) }),
        ...(node.out === undefined ? {} : { out: move(node.out) }),
      })),
    }
  }
  return { ...shape, cx: Math.max(0, shape.cx + mx), cy: Math.max(0, shape.cy + my) }
}

/**
 * Rasterise a ring by scanline: for each pixel row, the ring's crossings with the row's centre
 * line are sorted and filled in pairs, which is even-odd filling and exact for any simple or
 * self-crossing polygon. Linear in the area plus rows times vertices.
 */
const fillRing = (ring: readonly Point[], rect: PresenceRect, mask: Uint8Array): void => {
  const crossings: number[] = []
  for (let row = 0; row < rect.h; row++) {
    const y = rect.y + row + 0.5
    crossings.length = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i] as Point
      const b = ring[j] as Point
      if (a.y > y === b.y > y) continue
      crossings.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y))
    }
    crossings.sort((left, right) => left - right)
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(rect.x, Math.ceil((crossings[k] as number) - 0.5))
      const to = Math.min(rect.x + rect.w - 1, Math.floor((crossings[k + 1] as number) - 0.5))
      for (let x = from; x <= to; x++) mask[row * rect.w + (x - rect.x)] = 1
    }
  }
}

/** Mark every pixel whose centre lies within `width / 2` of the polyline: round caps and joins. */
const strokePolyline = (
  line: readonly Point[],
  width: number,
  rect: PresenceRect,
  mask: Uint8Array,
): void => {
  const radius = width / 2
  const radiusSquared = radius * radius
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i] as Point
    const b = line[i + 1] as Point
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSquared = dx * dx + dy * dy
    const left = Math.max(rect.x, Math.floor(Math.min(a.x, b.x) - radius))
    const right = Math.min(rect.x + rect.w - 1, Math.ceil(Math.max(a.x, b.x) + radius))
    const top = Math.max(rect.y, Math.floor(Math.min(a.y, b.y) - radius))
    const bottom = Math.min(rect.y + rect.h - 1, Math.ceil(Math.max(a.y, b.y) + radius))
    for (let y = top; y <= bottom; y++) {
      const cy = y + 0.5
      for (let x = left; x <= right; x++) {
        const cx = x + 0.5
        let t = lengthSquared === 0 ? 0 : ((cx - a.x) * dx + (cy - a.y) * dy) / lengthSquared
        t = Math.max(0, Math.min(1, t))
        const px = a.x + t * dx - cx
        const py = a.y + t * dy - cy
        if (px * px + py * py <= radiusSquared) mask[(y - rect.y) * rect.w + (x - rect.x)] = 1
      }
    }
  }
}

/** The whole pixels one shape covers. Callers should cache this per shape; it is O(area). */
export const regionShapePixels = (shape: RegionShape): RegionShapePixels => {
  const rect = regionShapeBounds(shape)
  const mask = new Uint8Array(rect.w * rect.h)
  if (shape.kind === 'rectangle') {
    mask.fill(1)
    return { rect, mask, count: mask.length }
  }
  if (shape.kind === 'ellipse') {
    const rx = shape.w / 2
    const ry = shape.h / 2
    for (let row = 0; row < shape.h; row++) {
      const dy = (row + 0.5 - ry) / ry
      const half = rx * Math.sqrt(Math.max(0, 1 - dy * dy))
      const from = Math.max(0, Math.ceil(rx - half - 0.5))
      const to = Math.min(shape.w - 1, Math.floor(rx + half - 0.5))
      for (let x = from; x <= to; x++) mask[row * shape.w + x] = 1
    }
  } else if (shape.kind === 'path') {
    const line = flattenPath(shape.nodes, shape.closed)
    if (shape.closed) fillRing(line, rect, mask)
    if (shape.width > 0)
      strokePolyline(shape.closed ? [...line, line[0] as Point] : line, shape.width, rect, mask)
  } else fillRing(regionShapeOutline(shape), rect, mask)
  let count = 0
  for (const bit of mask) if (bit !== 0) count++
  return { rect, mask, count }
}

/** Whether a whole canvas pixel belongs to the shape; consistent with `regionShapePixels`. */
export const regionShapeContainsPixel = (shape: RegionShape, px: number, py: number): boolean => {
  const x = Math.floor(px)
  const y = Math.floor(py)
  const rect = regionShapeBounds(shape)
  if (x < rect.x || x >= rect.x + rect.w || y < rect.y || y >= rect.y + rect.h) return false
  if (shape.kind === 'rectangle') return true
  const { mask } = regionShapePixels(shape)
  return mask[(y - rect.y) * rect.w + (x - rect.x)] === 1
}

/**
 * The whole pixels a document claims: items in order, each adding to or cutting from the mask.
 * Null when nothing is added or the document spans more than the pixel limit.
 */
export const regionDocumentPixels = (document: RegionDocument): RegionShapePixels | null => {
  const rect = regionDocumentBounds(document)
  if (rect === null || rect.w * rect.h > MAX_REGION_DOCUMENT_PIXELS) return null
  const mask = new Uint8Array(rect.w * rect.h)
  for (const item of document.items) {
    const pixels = regionShapePixels(item.shape)
    const value = item.op === 'add' ? 1 : 0
    for (let row = 0; row < pixels.rect.h; row++) {
      const y = pixels.rect.y + row - rect.y
      if (y < 0 || y >= rect.h) continue
      for (let column = 0; column < pixels.rect.w; column++) {
        if (pixels.mask[row * pixels.rect.w + column] !== 1) continue
        const x = pixels.rect.x + column - rect.x
        if (x < 0 || x >= rect.w) continue
        mask[y * rect.w + x] = value
      }
    }
  }
  let count = 0
  for (const bit of mask) if (bit !== 0) count++
  return { rect, mask, count }
}

/** Whether a whole canvas pixel is claimed by the document. */
export const regionDocumentContainsPixel = (
  document: RegionDocument,
  px: number,
  py: number,
): boolean => {
  const x = Math.floor(px)
  const y = Math.floor(py)
  let inside = false
  for (const item of document.items) {
    if (regionShapeContainsPixel(item.shape, x, y)) inside = item.op === 'add'
  }
  return inside
}
