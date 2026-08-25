/**
 * Keep at most one marker for each available backing-store pixel.
 *
 * Mismatch lists are row-major, so evenly spaced source indices preserve their distribution without
 * sorting or randomness. Results are retained by source identity and limit, which also gives the GPU
 * layer a stable identity to upload once.
 */
interface MarkerSample {
  readonly limit: number
  readonly marks: Float32Array
}

const samples = new WeakMap<Float32Array, MarkerSample>()

export const sampleMarkers = (marks: Float32Array, maxPoints: number): Float32Array => {
  const points = Math.floor(marks.length / 3)
  const limit = Math.max(0, Math.floor(maxPoints))
  if (points <= limit) return marks
  if (limit === 0) return new Float32Array(0)
  const held = samples.get(marks)
  if (held?.limit === limit) return held.marks

  const sampled = new Float32Array(limit * 3)
  for (let point = 0; point < limit; point++) {
    const source = Math.floor((point * points) / limit) * 3
    const target = point * 3
    sampled[target] = marks[source] as number
    sampled[target + 1] = marks[source + 1] as number
    sampled[target + 2] = marks[source + 2] as number
  }
  // Zoom can produce a different limit on every frame. The previous sample is no longer useful,
  // and retaining every historical limit makes one dense mismatch list grow without bound.
  samples.set(marks, { limit, marks: sampled })
  return sampled
}
