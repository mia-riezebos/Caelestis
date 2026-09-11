import type { PresenceRect } from './presence.js'

/**
 * The shapes a painter can claim. Every shape is star-shaped about its centre, so a fill is one
 * triangle fan and an outline is one ring of points; that is what keeps the renderer simple and
 * the wire small. Coordinates are canvas pixels; angles are whole degrees, clockwise from +x.
 */
export type RegionShape =
  | {
      readonly kind: 'rectangle'
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
    }
  | { readonly kind: 'circle'; readonly cx: number; readonly cy: number; readonly r: number }
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
  'circle',
  'polygon',
  'star',
]
export const MIN_REGION_SHAPE_CORNERS = 3
export const MAX_REGION_SHAPE_CORNERS = 12
/** Largest radius, in canvas pixels, a round shape may have. Keeps the bounding box bounded. */
export const MAX_REGION_SHAPE_RADIUS = 1_000
const MIN_CIRCLE_SEGMENTS = 24
const MAX_CIRCLE_SEGMENTS = 96

const int = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)

const validRotation = (value: unknown): value is number => int(value) && value >= 0 && value < 360

const validRadius = (value: unknown): value is number =>
  int(value) && value >= 1 && value <= MAX_REGION_SHAPE_RADIUS

const validCentre = (cx: unknown, cy: unknown): boolean => int(cx) && int(cy) && cx >= 0 && cy >= 0

/** Structural validation only; surface bounds are the caller's concern. */
export const isRegionShape = (value: unknown): value is RegionShape => {
  if (typeof value !== 'object' || value === null) return false
  const shape = value as Record<string, unknown>
  switch (shape.kind) {
    case 'rectangle':
      return (
        int(shape.x) &&
        int(shape.y) &&
        int(shape.w) &&
        int(shape.h) &&
        shape.x >= 0 &&
        shape.y >= 0 &&
        shape.w > 0 &&
        shape.h > 0
      )
    case 'circle':
      return validCentre(shape.cx, shape.cy) && validRadius(shape.r)
    case 'polygon':
      return (
        validCentre(shape.cx, shape.cy) &&
        validRadius(shape.r) &&
        int(shape.sides) &&
        shape.sides >= MIN_REGION_SHAPE_CORNERS &&
        shape.sides <= MAX_REGION_SHAPE_CORNERS &&
        validRotation(shape.rotation)
      )
    case 'star':
      return (
        validCentre(shape.cx, shape.cy) &&
        validRadius(shape.r) &&
        int(shape.inner) &&
        shape.inner >= 1 &&
        shape.inner < Number(shape.r) &&
        int(shape.points) &&
        shape.points >= MIN_REGION_SHAPE_CORNERS &&
        shape.points <= MAX_REGION_SHAPE_CORNERS &&
        validRotation(shape.rotation)
      )
    default:
      return false
  }
}

export const regionShapeCentre = (
  shape: RegionShape,
): { readonly x: number; readonly y: number } =>
  shape.kind === 'rectangle'
    ? { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 }
    : { x: shape.cx, y: shape.cy }

const radians = (degrees: number): number => (degrees * Math.PI) / 180

/**
 * The outline as a closed ring of canvas-pixel points, clockwise in screen space.
 *
 * Round shapes are sampled so that a large circle stays smooth and a small one stays cheap.
 * Polygon and star vertices are exact; the first vertex sits at `rotation`.
 */
export const regionShapeOutline = (
  shape: RegionShape,
): readonly { readonly x: number; readonly y: number }[] => {
  switch (shape.kind) {
    case 'rectangle':
      return [
        { x: shape.x, y: shape.y },
        { x: shape.x + shape.w, y: shape.y },
        { x: shape.x + shape.w, y: shape.y + shape.h },
        { x: shape.x, y: shape.y + shape.h },
      ]
    case 'circle': {
      const segments = Math.max(
        MIN_CIRCLE_SEGMENTS,
        Math.min(MAX_CIRCLE_SEGMENTS, Math.round(shape.r / 4)),
      )
      return Array.from({ length: segments }, (_, index) => {
        const angle = (index / segments) * Math.PI * 2
        return { x: shape.cx + Math.cos(angle) * shape.r, y: shape.cy + Math.sin(angle) * shape.r }
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

/** The whole-pixel bounding box, clamped at the canvas origin. Interest checks use this. */
export const regionShapeBounds = (shape: RegionShape): PresenceRect => {
  if (shape.kind === 'rectangle') return { x: shape.x, y: shape.y, w: shape.w, h: shape.h }
  const left = Math.max(0, shape.cx - shape.r)
  const top = Math.max(0, shape.cy - shape.r)
  return {
    x: left,
    y: top,
    w: Math.max(1, shape.cx + shape.r - left),
    h: Math.max(1, shape.cy + shape.r - top),
  }
}

/** Whether a canvas pixel lies inside the shape. Used for hit tests, not for rendering. */
export const regionShapeContains = (shape: RegionShape, x: number, y: number): boolean => {
  if (shape.kind === 'rectangle')
    return x >= shape.x && x < shape.x + shape.w && y >= shape.y && y < shape.y + shape.h
  const dx = x - shape.cx
  const dy = y - shape.cy
  if (shape.kind === 'circle') return dx * dx + dy * dy <= shape.r * shape.r
  // Ray cast against the exact outline; both remaining shapes are simple polygons.
  const ring = regionShapeOutline(shape)
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a === undefined || b === undefined) continue
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
