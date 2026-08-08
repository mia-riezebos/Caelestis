/**
 * The comparison itself, as one self-contained function.
 *
 * Deliberately depends on nothing. It is `toString`d into a worker (see `mismatch-worker.ts`), so a
 * single reference to anything outside it — a constant, a helper, an import — would compile fine
 * here and throw there, on a thread with no way to say so. Everything it needs arrives in the job.
 *
 * It is also what the main thread runs when there is no worker to be had, so the two paths cannot
 * drift: there is only one comparison.
 */

export interface ScanJob {
  /** Which template, so the worker can find the pixels it was given earlier. */
  readonly templateKey: string
  /** Those pixels, when the worker has not been given them yet. */
  readonly indices: Uint8Array | null
  readonly width: number
  readonly originX: number
  readonly originY: number
  readonly height: number
  readonly tileX: number
  readonly tileY: number
  readonly tileSize: number
  /**
   * The tile, as the rows the template actually covers.
   *
   * A template usually crosses a corner of a tile, so sending the whole million pixels would be
   * mostly zeroes. `bandTop` is the first tile row present, and the arrays are indexed from there.
   */
  readonly bandTop: number
  readonly server: Uint8Array | null
  readonly draft: Uint8Array | null
  /** Palette indices that assert nothing: the wildcard, the unpainted sentinel, anything filtered. */
  readonly ignored: readonly number[]
  /** The value meaning "nothing placed here", which is a state rather than a colour. */
  readonly unpainted: number
}

export interface ScanOutcome {
  /** Pixels with the wrong colour on them, including a pixel drafted Transparent. */
  readonly wrong: Float32Array
  /** Pixels with nothing on them at all. */
  readonly unpainted: Float32Array
  /** Pixels this tile asserts a colour for, so a caller can say how much is left. */
  readonly asserted: number
}

export const scanTile = (job: ScanJob, wantedPixels: Uint8Array): ScanOutcome => {
  const tileSize = job.tileSize
  const tileLeft = job.tileX * tileSize
  const tileTop = job.tileY * tileSize
  const left = Math.max(job.originX, tileLeft)
  const top = Math.max(job.originY, tileTop)
  const right = Math.min(job.originX + job.width, tileLeft + tileSize)
  const bottom = Math.min(job.originY + job.height, tileTop + tileSize)
  if (right <= left || bottom <= top) {
    return { wrong: new Float32Array(0), unpainted: new Float32Array(0), asserted: 0 }
  }

  // "Is this colour one we are asserting", as a lookup rather than a question. A `Set.has` per pixel
  // is a hash of a boxed number a million times over, for an answer with 256 possible inputs.
  const asserted = new Uint8Array(256).fill(1)
  for (const index of job.ignored) asserted[index] = 0

  const unpaintedIndex = job.unpainted
  const server = job.server
  const draft = job.draft
  const bandOffset = job.bandTop * tileSize

  const wrong: number[] = []
  const unpainted: number[] = []
  let assertedHere = 0
  for (let y = top; y < bottom; y++) {
    let templateAt = (y - job.originY) * job.width + (left - job.originX)
    let tileAt = (y - tileTop) * tileSize + (left - tileLeft) - bandOffset
    for (let x = left; x < right; x++, templateAt++, tileAt++) {
      const wanted = wantedPixels[templateAt] as number
      if (asserted[wanted] === 0) continue
      assertedHere++
      const drafted = draft === null ? unpaintedIndex : (draft[tileAt] as number)
      const placed =
        drafted !== unpaintedIndex
          ? drafted
          : server === null
            ? unpaintedIndex
            : (server[tileAt] as number)
      if (placed === wanted) continue
      // An empty pixel is only "not done yet" when nobody chose it. One drafted Transparent arrives
      // as a real palette index rather than the sentinel, so it lands with the mistakes.
      if (placed === unpaintedIndex) unpainted.push(x, y, wanted)
      else wrong.push(x, y, wanted)
    }
  }

  return {
    wrong: new Float32Array(wrong),
    unpainted: new Float32Array(unpainted),
    asserted: assertedHere,
  }
}
