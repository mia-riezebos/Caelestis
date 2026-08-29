interface IndexedRgb {
  readonly rgb: readonly [number, number, number]
  readonly index: number
}

/**
 * An exact-colour lookup keyed by red and blue, with green stored in the entry for verification.
 * The wplace palette has no red-blue collisions, so this stays 256 KiB instead of 16 MiB.
 */
export const buildExactRgbIndex = (colours: readonly IndexedRgb[]): Uint32Array => {
  const table = new Uint32Array(1 << 16)
  for (const colour of colours) {
    const [r, g, b] = colour.rgb
    const key = (r << 8) | b
    if (table[key] !== 0) throw new Error('palette has a red-blue collision')
    // Green is offset by one so zero can remain the empty-entry sentinel.
    table[key] = ((g + 1) << 8) | colour.index
  }
  return table
}

export const exactRgbIndex = (
  table: Uint32Array,
  r: number,
  g: number,
  b: number,
  missing: number,
): number => {
  const entry = table[(r << 8) | b] ?? 0
  return entry >>> 8 === g + 1 ? entry & 0xff : missing
}

const CANVAS_RGB_NOISE = 2

/**
 * Decode palette pixels read back from a canvas while tolerating Helium's bounded privacy noise.
 * Exact colours retain the fast path; noisy reads probe only their small RGB neighbourhood.
 */
export const canvasRgbIndex = (
  table: Uint32Array,
  r: number,
  g: number,
  b: number,
  missing: number,
): number => {
  const exact = exactRgbIndex(table, r, g, b, missing)
  if (exact !== missing) return exact

  for (let dr = -CANVAS_RGB_NOISE; dr <= CANVAS_RGB_NOISE; dr += 1) {
    const candidateR = r + dr
    if (candidateR < 0 || candidateR > 255) continue

    for (let db = -CANVAS_RGB_NOISE; db <= CANVAS_RGB_NOISE; db += 1) {
      const candidateB = b + db
      if (candidateB < 0 || candidateB > 255) continue

      const entry = table[(candidateR << 8) | candidateB] ?? 0
      if (entry !== 0 && Math.abs((entry >>> 8) - 1 - g) <= CANVAS_RGB_NOISE) {
        return entry & 0xff
      }
    }
  }

  return missing
}
