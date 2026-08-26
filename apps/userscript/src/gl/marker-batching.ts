import type { MismatchMarks } from '../templates/mismatch-marks.js'
import type { TileQuad } from '../tile-transform.js'

export interface BatchableMarkerStyle {
  readonly size: number
  readonly thickness: number
  readonly colour: readonly [number, number, number]
  readonly otherColour: readonly [number, number, number] | null
  readonly otherOpacity: number
  readonly selected: number
}

export interface BatchableMarkerWork {
  readonly tile: TileQuad
  readonly marks: MismatchMarks
  readonly style: BatchableMarkerStyle
  readonly fade: number
}

const sourceIds = new WeakMap<MismatchMarks, number>()
let nextSourceId = 1
const mergedMarks = new Map<string, MismatchMarks>()
const usedMergedMarks = new Set<string>()

const sourceId = (marks: MismatchMarks): number => {
  const held = sourceIds.get(marks)
  if (held !== undefined) return held
  const created = nextSourceId++
  sourceIds.set(marks, created)
  return created
}

const sameColour = (
  left: readonly [number, number, number] | null,
  right: readonly [number, number, number] | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left[0] === right[0] &&
    left[1] === right[1] &&
    left[2] === right[2])

const sameDrawState = (left: BatchableMarkerWork, right: BatchableMarkerWork): boolean =>
  left.fade === right.fade &&
  left.style.size === right.style.size &&
  left.style.thickness === right.style.thickness &&
  sameColour(left.style.colour, right.style.colour) &&
  sameColour(left.style.otherColour, right.style.otherColour) &&
  left.style.otherOpacity === right.style.otherOpacity &&
  left.style.selected === right.style.selected

/** Whether every point in this work necessarily emits the same RGB colour. */
const hasOrderIndependentColour = ({ style }: BatchableMarkerWork): boolean =>
  style.selected < 0 || style.otherColour === null || sameColour(style.colour, style.otherColour)

const merge = (sources: readonly MismatchMarks[]): MismatchMarks => {
  if (sources.length === 1) return sources[0] as MismatchMarks
  const key = sources.map(sourceId).join(',')
  usedMergedMarks.add(key)
  const held = mergedMarks.get(key)
  if (held !== undefined) return held
  const length = sources.reduce((total, marks) => total + marks.length, 0)
  const combined = new Uint32Array(length)
  let offset = 0
  for (const marks of sources) {
    combined.set(marks, offset)
    offset += marks.length
  }
  mergedMarks.set(key, combined)
  return combined
}

export const beginMarkerBatchFrame = (): void => {
  usedMergedMarks.clear()
}

export const endMarkerBatchFrame = (): void => {
  for (const key of mergedMarks.keys()) if (!usedMergedMarks.has(key)) mergedMarks.delete(key)
}

export const markerBatchMemoryBytes = (): number => {
  let bytes = 0
  for (const marks of mergedMarks.values()) bytes += marks.byteLength
  return bytes
}

/**
 * Collapse the common case of many templates sharing one marker appearance into one draw per tile.
 *
 * Different appearances retain their exact draw order. Combining them by style would reorder
 * overlapping translucent markers, which changes the result; when every batch has the same draw
 * state, concatenating its point lists is pixel-for-pixel equivalent and removes dozens of tiny
 * WebGL calls from a dense multi-template viewport.
 */
export const batchMarkerWork = <Work extends BatchableMarkerWork>(
  work: readonly Work[],
): Work[] => {
  const first = work[0]
  if (first === undefined || work.length === 1) return [...work]
  if (!work.every((candidate) => sameDrawState(first, candidate))) return [...work]
  // Tile grouping changes template-major primitive order. That is blend-equivalent when every
  // point uses one RGB colour, but not while selected-colour dimming can emit two different colours
  // from the same work item at an overlapping tile boundary.
  if (!work.every(hasOrderIndependentColour)) return [...work]

  const byTile = new Map<TileQuad, Work[]>()
  for (const candidate of work) {
    const group = byTile.get(candidate.tile)
    if (group === undefined) byTile.set(candidate.tile, [candidate])
    else group.push(candidate)
  }
  return [...byTile.values()].map((group) => {
    const representative = group[0] as Work
    if (group.length === 1) return representative
    return {
      ...representative,
      marks: merge(group.map(({ marks }) => marks)),
    }
  })
}
