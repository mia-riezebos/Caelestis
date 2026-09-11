import type { PresenceRect } from './presence.js'

/**
 * The shapes a painter can claim.
 *
 * A claim is a set of whole canvas pixels, never a smooth curve: a pixel belongs to a shape when
 * its centre does. Rectangles and ellipses are defined by a whole-pixel box, so their edges land
 * on the grid by construction. Polygons and stars are defined by an integer centre, radius, and
 * whole-degree rotation, and rasterised by scanline against pixel centres. `regionShapePixels` is
 * the one source of truth for membership; every renderer and hit test goes through it.
 */
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

export type RegionShapeKind = RegionShape['kind']

export const REGION_SHAPE_KINDS: readonly RegionShapeKind[] = [
  'rectangle',
  'ellipse',
  'polygon',
  'star',
]
export const MIN_REGION_SHAPE_CORNERS = 3
export const MAX_REGION_SHAPE_CORNERS = 12
/** Largest radius or box side, in canvas pixels. Keeps the bounding box and mask bounded. */
export const MAX_REGION_SHAPE_EXTENT = 2_000

export interface Point {
  readonly x: number
  readonly y: number
}

/** A shape as whole pixels: `mask[i]` is 1 inside, row-major over `rect`. */
export interface RegionShapePixels {
  readonly rect: PresenceRect
  readonly mask: Uint8Array
  readonly count: number
}

const int = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)

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
    default:
      return false
  }
}

const radians = (value: number): number => (value * Math.PI) / 180

/**
 * The geometric outline as a ring of points, for handles and hit testing. Pixel membership does
 * not come from this; see `regionShapePixels`.
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
  }
}

export const regionShapeCentre = (shape: RegionShape): Point =>
  shape.kind === 'rectangle' || shape.kind === 'ellipse'
    ? { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 }
    : { x: shape.cx, y: shape.cy }

/** The whole-pixel bounding box, clamped at the canvas origin. Interest checks use this. */
export const regionShapeBounds = (shape: RegionShape): PresenceRect => {
  if (shape.kind === 'rectangle' || shape.kind === 'ellipse')
    return { x: shape.x, y: shape.y, w: shape.w, h: shape.h }
  const ring = regionShapeOutline(shape)
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const point of ring) {
    left = Math.min(left, point.x)
    top = Math.min(top, point.y)
    right = Math.max(right, point.x)
    bottom = Math.max(bottom, point.y)
  }
  const x = Math.max(0, Math.floor(left))
  const y = Math.max(0, Math.floor(top))
  return { x, y, w: Math.max(1, Math.ceil(right) - x), h: Math.max(1, Math.ceil(bottom) - y) }
}

/** Move a shape by whole pixels, keeping it on the canvas. */
export const translateRegionShape = (shape: RegionShape, dx: number, dy: number): RegionShape => {
  const mx = Math.round(dx)
  const my = Math.round(dy)
  if (shape.kind === 'rectangle' || shape.kind === 'ellipse')
    return { ...shape, x: Math.max(0, shape.x + mx), y: Math.max(0, shape.y + my) }
  return { ...shape, cx: Math.max(0, shape.cx + mx), cy: Math.max(0, shape.cy + my) }
}

/**
 * Rasterise by scanline: for each pixel row, the ring's crossings with the row's centre line are
 * sorted and filled in pairs. Exact for every simple polygon, including stars, and linear in the
 * area plus rows times vertices.
 */
const scanlineFill = (ring: readonly Point[], rect: PresenceRect, mask: Uint8Array): number => {
  let count = 0
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
      for (let x = from; x <= to; x++) {
        const at = row * rect.w + (x - rect.x)
        if (mask[at] === 0) {
          mask[at] = 1
          count++
        }
      }
    }
  }
  return count
}

/** The whole pixels a shape covers. Callers should cache this per shape; it is O(area). */
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
    let count = 0
    for (let row = 0; row < shape.h; row++) {
      const dy = (row + 0.5 - ry) / ry
      const half = rx * Math.sqrt(Math.max(0, 1 - dy * dy))
      const from = Math.max(0, Math.ceil(rx - half - 0.5))
      const to = Math.min(shape.w - 1, Math.floor(rx + half - 0.5))
      for (let x = from; x <= to; x++) {
        mask[row * shape.w + x] = 1
        count++
      }
    }
    return { rect, mask, count }
  }
  const count = scanlineFill(regionShapeOutline(shape), rect, mask)
  return { rect, mask, count }
}

/** Whether a whole canvas pixel belongs to the shape; consistent with `regionShapePixels`. */
export const regionShapeContainsPixel = (shape: RegionShape, px: number, py: number): boolean => {
  const x = Math.floor(px)
  const y = Math.floor(py)
  if (shape.kind === 'rectangle')
    return x >= shape.x && x < shape.x + shape.w && y >= shape.y && y < shape.y + shape.h
  if (shape.kind === 'ellipse') {
    const rx = shape.w / 2
    const ry = shape.h / 2
    const dx = (x + 0.5 - shape.x - rx) / rx
    const dy = (y + 0.5 - shape.y - ry) / ry
    return dx * dx + dy * dy <= 1
  }
  const cx = x + 0.5
  const cy = y + 0.5
  const ring = regionShapeOutline(shape)
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point
    const b = ring[j] as Point
    if (a.y > cy !== b.y > cy && cx < ((b.x - a.x) * (cy - a.y)) / (b.y - a.y) + a.x)
      inside = !inside
  }
  return inside
}
