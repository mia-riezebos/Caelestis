/**
 * Select one wanted colour from an already classified mismatch list.
 *
 * The input contains only wrong or unpainted pixels. Correct template pixels never reach this
 * module, so the selected-colour marker cannot accidentally become a second overlay renderer.
 */
import { markWanted, type MismatchMarks } from './mismatch-marks.js'

const cache = new WeakMap<MismatchMarks, Map<number, MismatchMarks>>()

export const colourMarksIn = (disagreements: MismatchMarks, selected: number): MismatchMarks => {
  const held = cache.get(disagreements)
  const cached = held?.get(selected)
  if (cached !== undefined) return cached

  const points: number[] = []
  for (const mark of disagreements) {
    if (markWanted(mark) !== selected) continue
    points.push(mark)
  }
  const marks = new Uint32Array(points)
  const entries = held ?? new Map<number, MismatchMarks>()
  entries.set(selected, marks)
  if (held === undefined) cache.set(disagreements, entries)
  return marks
}
