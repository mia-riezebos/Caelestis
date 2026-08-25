/**
 * Select one wanted colour from an already classified mismatch list.
 *
 * The input contains only wrong or unpainted pixels. Correct template pixels never reach this
 * module, so the selected-colour marker cannot accidentally become a second overlay renderer.
 */
const cache = new WeakMap<Float32Array, Map<number, Float32Array>>()

export const colourMarksIn = (disagreements: Float32Array, selected: number): Float32Array => {
  const held = cache.get(disagreements)
  const cached = held?.get(selected)
  if (cached !== undefined) return cached

  const points: number[] = []
  for (let at = 0; at < disagreements.length; at += 3) {
    if (disagreements[at + 2] !== selected) continue
    points.push(
      disagreements[at] as number,
      disagreements[at + 1] as number,
      disagreements[at + 2] as number,
    )
  }
  const marks = new Float32Array(points)
  const entries = held ?? new Map<number, Float32Array>()
  entries.set(selected, marks)
  if (held === undefined) cache.set(disagreements, entries)
  return marks
}
