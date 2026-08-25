/**
 * Keep at most one marker for each available backing-store pixel.
 *
 * Mismatch lists are row-major, so evenly spaced source indices preserve their distribution without
 * sorting or randomness. Results are retained by source identity and limit, which also gives the GPU
 * layer a stable identity to upload once.
 */
const samples = new WeakMap<Float32Array, Map<number, Float32Array>>()

export const sampleMarkers = (marks: Float32Array, maxPoints: number): Float32Array => {
  const points = Math.floor(marks.length / 3)
  const limit = Math.max(0, Math.floor(maxPoints))
  if (points <= limit) return marks
  if (limit === 0) return new Float32Array(0)
  const held = samples.get(marks)
  const cached = held?.get(limit)
  if (cached !== undefined) return cached

  const sampled = new Float32Array(limit * 3)
  for (let point = 0; point < limit; point++) {
    const source = Math.floor((point * points) / limit) * 3
    const target = point * 3
    sampled[target] = marks[source] as number
    sampled[target + 1] = marks[source + 1] as number
    sampled[target + 2] = marks[source + 2] as number
  }
  const entries = held ?? new Map<number, Float32Array>()
  entries.set(limit, sampled)
  if (held === undefined) samples.set(marks, entries)
  return sampled
}
