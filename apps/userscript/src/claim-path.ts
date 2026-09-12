import type { PathNode, Point } from '@caelestis/shared'

/**
 * Path editing maths for claim mode: the operations behind the pen, the anchor-point tool, and
 * adding or deleting anchors. Pure functions over node lists; the editor owns the state.
 */

/** Samples per segment when looking for the closest point on a path. */
const SEGMENT_SAMPLES = 48

const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})

/** The control points of the segment from node `index` to the next, straight or curved. */
const controls = (
  nodes: readonly PathNode[],
  index: number,
): { from: PathNode; to: PathNode; c1: Point; c2: Point; curved: boolean } => {
  const from = nodes[index] as PathNode
  const to = nodes[(index + 1) % nodes.length] as PathNode
  return {
    from,
    to,
    c1: from.out ?? from,
    c2: to.in ?? to,
    curved: from.out !== undefined || to.in !== undefined,
  }
}

/** A point along a cubic bezier. */
export const cubicAt = (p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point => {
  const a = lerp(p0, p1, t)
  const b = lerp(p1, p2, t)
  const c = lerp(p2, p3, t)
  const d = lerp(a, b, t)
  const e = lerp(b, c, t)
  return lerp(d, e, t)
}

/** The rubber band the pen shows from its last anchor towards the pointer. */
export const rubberBand = (last: PathNode, pointer: Point, steps = 16): Point[] =>
  Array.from({ length: steps + 1 }, (_, step) =>
    cubicAt(last, last.out ?? last, pointer, pointer, step / steps),
  )

export interface PathHit {
  /** The segment: from node `index` to the next. */
  readonly index: number
  readonly t: number
  readonly at: Point
  readonly distance: number
}

/** The closest point on a path to `point`, or null for a path with no segments. */
export const nearestOnPath = (
  nodes: readonly PathNode[],
  closed: boolean,
  point: Point,
): PathHit | null => {
  const count = closed ? nodes.length : nodes.length - 1
  let best: PathHit | null = null
  for (let index = 0; index < count; index++) {
    const { from, to, c1, c2, curved } = controls(nodes, index)
    const samples = curved ? SEGMENT_SAMPLES : 1
    for (let step = 0; step <= samples; step++) {
      const t = step / samples
      let at: Point
      if (curved) at = cubicAt(from, c1, c2, to, t)
      else {
        // The exact foot of the perpendicular on a straight segment.
        const dx = to.x - from.x
        const dy = to.y - from.y
        const length = dx * dx + dy * dy
        const s =
          length === 0
            ? 0
            : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length))
        at = { x: from.x + dx * s, y: from.y + dy * s }
        if (step === 0) {
          const distance = Math.hypot(at.x - point.x, at.y - point.y)
          if (best === null || distance < best.distance) best = { index, t: s, at, distance }
        }
        break
      }
      const distance = Math.hypot(at.x - point.x, at.y - point.y)
      if (best === null || distance < best.distance) best = { index, t, at, distance }
    }
  }
  if (best === null) return null
  // Refine around the best sample: halve the step and keep whichever side comes closer.
  const { from, to, c1, c2, curved } = controls(nodes, best.index)
  if (!curved) return best
  let step = 1 / SEGMENT_SAMPLES
  let refined: PathHit = best
  for (let round = 0; round < 12; round++) {
    step /= 2
    for (const t of [refined.t - step, refined.t + step]) {
      if (t < 0 || t > 1) continue
      const at = cubicAt(from, c1, c2, to, t)
      const distance = Math.hypot(at.x - point.x, at.y - point.y)
      if (distance < refined.distance) refined = { index: refined.index, t, at, distance }
    }
  }
  return refined
}

/**
 * The path with an anchor inserted on segment `index` at `t`, the curve unchanged: de Casteljau
 * splits a curved segment into two with their own handles; a straight one just gains a corner.
 */
export const insertAnchor = (nodes: readonly PathNode[], index: number, t: number): PathNode[] => {
  const { from, to, c1, c2, curved } = controls(nodes, index)
  const nextIndex = (index + 1) % nodes.length
  if (!curved) {
    const at = lerp(from, to, t)
    const out = [...nodes]
    out.splice(index + 1, 0, { x: at.x, y: at.y })
    return out
  }
  const a = lerp(from, c1, t)
  const b = lerp(c1, c2, t)
  const c = lerp(c2, to, t)
  const d = lerp(a, b, t)
  const e = lerp(b, c, t)
  const at = lerp(d, e, t)
  const out = nodes.map((node, held) =>
    held === index ? { ...node, out: a } : held === nextIndex ? { ...node, in: c } : node,
  )
  out.splice(index + 1, 0, { x: at.x, y: at.y, in: d, out: e })
  return out
}

/** The path without one anchor; its neighbours keep their handles. */
export const removeAnchor = (nodes: readonly PathNode[], index: number): PathNode[] =>
  nodes.filter((_, held) => held !== index)

/** A smooth anchor whose handles point at `towards` and its mirror. */
export const smoothAnchor = (node: PathNode, towards: Point): PathNode => ({
  x: node.x,
  y: node.y,
  out: towards,
  in: { x: 2 * node.x - towards.x, y: 2 * node.y - towards.y },
})

/** A corner anchor: no handles at all. */
export const cornerAnchor = (node: PathNode): PathNode => ({ x: node.x, y: node.y })

/** Whether an anchor has any handle. */
export const isSmooth = (node: PathNode): boolean => node.in !== undefined || node.out !== undefined

/**
 * An open path turned so that the anchor at `end` (its first or last) is last, ready for the
 * pen to continue from it. Reversing swaps every anchor's in and out handles.
 */
export const orientToContinue = (nodes: readonly PathNode[], end: number): PathNode[] => {
  if (end === nodes.length - 1) return [...nodes]
  return [...nodes].reverse().map((node) => ({
    x: node.x,
    y: node.y,
    ...(node.out === undefined ? {} : { in: node.out }),
    ...(node.in === undefined ? {} : { out: node.in }),
  }))
}

/** The index of the anchor within `radius` of a point, closest first, or null. */
export const anchorNear = (
  nodes: readonly PathNode[],
  point: Point,
  radius: number,
): number | null => {
  let best: number | null = null
  let least = radius
  nodes.forEach((node, index) => {
    const distance = Math.hypot(node.x - point.x, node.y - point.y)
    if (distance <= least) {
      least = distance
      best = index
    }
  })
  return best
}
