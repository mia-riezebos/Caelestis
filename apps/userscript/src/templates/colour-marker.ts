/** Select one exact template colour from an already classified unpainted-pixel list. */
import { type MismatchMarks, markWanted } from './mismatch-marks.js'

const cache = new WeakMap<MismatchMarks, Map<number, MismatchMarks>>()

export const colourMarksIn = (unpainted: MismatchMarks, selected: number): MismatchMarks => {
  const held = cache.get(unpainted)
  const cached = held?.get(selected)
  if (cached !== undefined) return cached

  const points: number[] = []
  for (const mark of unpainted) {
    if (markWanted(mark) !== selected) continue
    points.push(mark)
  }
  const marks = new Uint32Array(points)
  const entries = held ?? new Map<number, MismatchMarks>()
  entries.set(selected, marks)
  if (held === undefined) cache.set(unpainted, entries)
  return marks
}
