import {
  flattenPath,
  MAX_PATH_NODES,
  type Point,
  type RegionItem,
  type RegionShape,
  regionShapeOutline,
} from '@caelestis/shared'
import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from 'polygon-clipping'

/**
 * Cutting vector shapes with the eraser, Illustrator-style: the eraser's stroke is subtracted
 * from each shape it crosses, and what remains becomes separate closed paths, one per piece, so
 * the pieces can be selected, moved, and deleted on their own.
 *
 * Curves do not survive a cut. The shape is flattened to a polygon first (the same flattening the
 * rasteriser uses), so the pieces are corner paths that rasterise to the same pixels as before,
 * minus the eraser. A hole the eraser leaves in the middle of a piece is a subtract path right
 * after it.
 */

/** Corners on a round cap or join; enough that a cut edge reads as round at any claim zoom. */
const CAP_SEGMENTS = 16
/**
 * Coordinates are snapped to this grid before clipping. The sweep-line clipper loses its footing
 * on near-coincident vertices that the many overlapping discs and quads of a stroke produce; a
 * sixteenth of a pixel is far below anything the rasteriser can tell apart.
 */
const SNAP = 16
const snap = (value: number): number => Math.round(value * SNAP) / SNAP
const pair = (x: number, y: number): [number, number] => [snap(x), snap(y)]

const disc = (centre: Point, radius: number): Polygon => [
  Array.from({ length: CAP_SEGMENTS }, (_, index) => {
    const angle = (index / CAP_SEGMENTS) * Math.PI * 2
    return pair(centre.x + Math.cos(angle) * radius, centre.y + Math.sin(angle) * radius)
  }),
]

/** The area within `width / 2` of a polyline: every segment as a quad, every joint as a disc. */
export const strokeArea = (line: readonly Point[], width: number): MultiPolygon => {
  const radius = width / 2
  const pieces: Polygon[] = []
  for (const point of line) pieces.push(disc(point, radius))
  for (let index = 0; index + 1 < line.length; index++) {
    const a = line[index] as Point
    const b = line[index + 1] as Point
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = Math.hypot(dx, dy)
    if (length === 0) continue
    const nx = (-dy / length) * radius
    const ny = (dx / length) * radius
    pieces.push([
      [
        pair(a.x + nx, a.y + ny),
        pair(b.x + nx, b.y + ny),
        pair(b.x - nx, b.y - ny),
        pair(a.x - nx, a.y - ny),
      ],
    ])
  }
  if (pieces.length === 0) return []
  const [first, ...rest] = pieces
  return polygonClipping.union(first as Polygon, ...rest)
}

/** A shape as the area it fills, flattened; an open stroke is its thick outline. */
export const shapeArea = (shape: RegionShape): MultiPolygon => {
  if (shape.kind === 'pixels') return []
  if (shape.kind === 'path') {
    const line = flattenPath(shape.nodes, shape.closed)
    const fill: MultiPolygon = shape.closed ? [[line.map((p) => pair(p.x, p.y))]] : []
    if (shape.width <= 0) return fill
    const stroke = strokeArea(shape.closed ? [...line, line[0] as Point] : line, shape.width)
    return fill.length === 0 ? stroke : polygonClipping.union(fill, stroke)
  }
  return [[regionShapeOutline(shape).map((p) => pair(p.x, p.y))]]
}

/** Fewer points along a ring, dropping the ones that deviate least, until it fits a path. */
const thin = (ring: Ring): Ring => {
  let points = ring
  while (points.length > MAX_PATH_NODES) {
    let worst = -1
    let least = Number.POSITIVE_INFINITY
    for (let index = 0; index < points.length; index++) {
      const previous = points[(index + points.length - 1) % points.length] as [number, number]
      const next = points[(index + 1) % points.length] as [number, number]
      const here = points[index] as [number, number]
      const deviation = Math.abs(
        (next[0] - previous[0]) * (previous[1] - here[1]) -
          (previous[0] - here[0]) * (next[1] - previous[1]),
      )
      if (deviation < least) {
        least = deviation
        worst = index
      }
    }
    points = points.filter((_, index) => index !== worst)
  }
  return points
}

const closedRing = (ring: Ring): Ring => {
  const first = ring[0]
  const last = ring[ring.length - 1]
  return first !== undefined &&
    last !== undefined &&
    first[0] === last[0] &&
    first[1] === last[1] &&
    ring.length > 1
    ? ring.slice(0, -1)
    : ring
}

const pathFrom = (ring: Ring): RegionShape => ({
  kind: 'path',
  closed: true,
  width: 0,
  nodes: thin(closedRing(ring)).map(([x, y]) => ({ x, y })),
})

/** Far beyond any canvas coordinate; the half-planes below reach this far. */
const FAR = 1e7

/**
 * Polygons without holes: a polygon that has one is cut in two along a vertical line through
 * that hole's middle, and each half is cut again until none is left. Ordered add-and-subtract
 * items cannot express a hole any other way without changing pixels outside the shape: a
 * "hole" flipped to the opposite op would add coverage under a subtract item.
 */
const withoutHoles = (polygon: Polygon, depth = 0): Polygon[] => {
  const [outer, hole] = polygon
  if (outer === undefined) return []
  if (hole === undefined || depth > 12) return [[outer]]
  const cx = snap(hole.reduce((sum, [x]) => sum + x, 0) / hole.length)
  const left: Polygon = [
    [
      [-FAR, -FAR],
      [cx, -FAR],
      [cx, FAR],
      [-FAR, FAR],
    ],
  ]
  const right: Polygon = [
    [
      [cx, -FAR],
      [FAR, -FAR],
      [FAR, FAR],
      [cx, FAR],
    ],
  ]
  return [
    ...polygonClipping.intersection([polygon], left).flatMap((p) => withoutHoles(p, depth + 1)),
    ...polygonClipping.intersection([polygon], right).flatMap((p) => withoutHoles(p, depth + 1)),
  ]
}

/**
 * The pieces of an item after the eraser's area is cut out of it, as new items in the same op.
 * Every piece is a simple polygon; where the eraser left a hole, the shape is split into parts
 * around it. An empty result means the eraser took the whole shape.
 */
export const splitItem = (
  item: RegionItem,
  eraser: MultiPolygon,
  nextId: () => string,
): RegionItem[] => {
  const area = shapeArea(item.shape)
  if (area.length === 0) return [item]
  const remaining = polygonClipping.difference(area, eraser)
  const pieces: RegionItem[] = []
  for (const polygon of remaining.flatMap((held) => withoutHoles(held))) {
    const outer = polygon[0]
    if (outer === undefined || closedRing(outer).length < 3) continue
    pieces.push({ id: nextId(), shape: pathFrom(outer), op: item.op })
  }
  return pieces
}
