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

interface CommonScanJob {
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
  readonly draft: Uint8Array | null
  /** Palette indices that assert nothing: the wildcard, the unpainted sentinel, anything filtered. */
  readonly ignored: readonly number[]
  /** The palette index that means the template makes no assertion at this pixel. */
  readonly transparent: number
  /** The value meaning "nothing placed here", which is a state rather than a colour. */
  readonly unpainted: number
  /** False for progress-only work, which must not allocate coordinate lists nobody will draw. */
  readonly collectMarkers?: boolean
}

export interface PixelScanJob extends CommonScanJob {
  readonly kind: 'pixels'
  readonly server: Uint8Array | null
}

export interface MaskScanJob extends CommonScanJob {
  readonly kind: 'mask'
  /** Tile-local rectangle described by the packed two-bit classifications. */
  readonly maskLeft: number
  readonly maskTop: number
  readonly maskWidth: number
  readonly maskHeight: number
  readonly maskPacked: Uint8Array
}

export type ScanJob = PixelScanJob | MaskScanJob

export interface ScanOutcome {
  /** Pixels with the wrong colour on them, including a pixel drafted Transparent. */
  readonly wrong: Uint32Array
  /** Pixels with nothing on them at all. */
  readonly unpainted: Uint32Array
  /** Pixels this tile asserts a colour for, so a caller can say how much is left. */
  readonly asserted: number
  /** Progress counts ignore display-only colour filters, unlike the marker lists above. */
  readonly completed: number
  readonly mismatched: number
  readonly progressUnpainted: number
  readonly progressAsserted: number
  /** Sparse `[palette index, completed, mismatched, unpainted]` progress tuples. */
  readonly progressByColour: Uint32Array
}

export const scanTile = (job: ScanJob, wantedPixels: Uint8Array): ScanOutcome => {
  const tileSize = job.tileSize
  const tileLeft = job.tileX * tileSize
  const tileTop = job.tileY * tileSize
  const maskLeft = job.kind === 'mask' ? tileLeft + job.maskLeft : tileLeft
  const maskTop = job.kind === 'mask' ? tileTop + job.maskTop : tileTop
  const maskRight = job.kind === 'mask' ? maskLeft + job.maskWidth : tileLeft + tileSize
  const maskBottom = job.kind === 'mask' ? maskTop + job.maskHeight : tileTop + tileSize
  const left = Math.max(job.originX, tileLeft, maskLeft)
  const top = Math.max(job.originY, tileTop, maskTop)
  const right = Math.min(job.originX + job.width, tileLeft + tileSize, maskRight)
  const bottom = Math.min(job.originY + job.height, tileTop + tileSize, maskBottom)
  if (right <= left || bottom <= top) {
    return {
      wrong: new Uint32Array(0),
      unpainted: new Uint32Array(0),
      asserted: 0,
      completed: 0,
      mismatched: 0,
      progressUnpainted: 0,
      progressAsserted: 0,
      progressByColour: new Uint32Array(0),
    }
  }

  // "Is this colour one we are asserting", as a lookup rather than a question. A `Set.has` per pixel
  // is a hash of a boxed number a million times over, for an answer with 256 possible inputs.
  const asserted = new Uint8Array(256).fill(1)
  for (const index of job.ignored) asserted[index] = 0

  const unpaintedIndex = job.unpainted
  const draft = job.draft
  const bandOffset = job.bandTop * tileSize
  // Kept local because this function is stringified into the worker.
  const match = 0
  const wrongClass = 1
  const blank = 2

  const wrong: number[] = []
  const unpainted: number[] = []
  let assertedHere = 0
  let completed = 0
  let mismatched = 0
  let progressUnpainted = 0
  let progressAsserted = 0
  // `scanTile` is stringified into a worker, so this deliberately uses the byte-sized palette
  // domain rather than importing the application's current palette length.
  const progressByColour = new Uint32Array(256 * 3)
  const collectMarkers = job.collectMarkers !== false
  for (let y = top; y < bottom; y++) {
    let templateAt = (y - job.originY) * job.width + (left - job.originX)
    let tileAt = (y - tileTop) * tileSize + (left - tileLeft) - bandOffset
    for (let x = left; x < right; x++, templateAt++, tileAt++) {
      const wanted = wantedPixels[templateAt] as number
      const drafted = draft === null ? unpaintedIndex : (draft[tileAt] as number)
      let classification: number
      if (drafted !== unpaintedIndex) classification = drafted === wanted ? match : wrongClass
      else if (job.kind === 'mask') {
        const maskAt = (y - tileTop - job.maskTop) * job.maskWidth + (x - tileLeft - job.maskLeft)
        classification =
          ((job.maskPacked[Math.floor(maskAt / 4)] ?? 0) >> ((maskAt % 4) * 2)) & 0b11
      } else {
        const placed = job.server === null ? unpaintedIndex : (job.server[tileAt] as number)
        classification = placed === wanted ? match : placed === unpaintedIndex ? blank : wrongClass
      }

      // Progress describes the template, not the current display filter. A colour hidden from the
      // overlay still needs painting and therefore still belongs in these counts.
      if (wanted !== job.transparent && wanted !== unpaintedIndex) {
        progressAsserted++
        const colourAt = wanted * 3
        if (classification === match) {
          completed++
          progressByColour[colourAt] = (progressByColour[colourAt] ?? 0) + 1
        } else if (classification === blank) {
          progressUnpainted++
          progressByColour[colourAt + 2] = (progressByColour[colourAt + 2] ?? 0) + 1
        } else {
          mismatched++
          progressByColour[colourAt + 1] = (progressByColour[colourAt + 1] ?? 0) + 1
        }
      }

      if (!collectMarkers || asserted[wanted] === 0) continue
      assertedHere++
      if (classification === match) continue
      // An empty pixel is only "not done yet" when nobody chose it. One drafted Transparent arrives
      // as a real palette index rather than the sentinel, so it lands with the mistakes.
      const mark = (x - tileLeft) | ((y - tileTop) << 10) | (wanted << 20)
      if (classification === blank) unpainted.push(mark)
      else wrong.push(mark)
    }
  }

  let usedColours = 0
  for (let index = 0; index < 256; index++) {
    const at = index * 3
    if (
      progressByColour[at] !== 0 ||
      progressByColour[at + 1] !== 0 ||
      progressByColour[at + 2] !== 0
    )
      usedColours++
  }
  const packedProgress = new Uint32Array(usedColours * 4)
  let packedAt = 0
  for (let index = 0; index < 256; index++) {
    const at = index * 3
    const colourCompleted = progressByColour[at] as number
    const colourMismatched = progressByColour[at + 1] as number
    const colourUnpainted = progressByColour[at + 2] as number
    if (colourCompleted === 0 && colourMismatched === 0 && colourUnpainted === 0) continue
    packedProgress[packedAt++] = index
    packedProgress[packedAt++] = colourCompleted
    packedProgress[packedAt++] = colourMismatched
    packedProgress[packedAt++] = colourUnpainted
  }

  const marks = new Uint32Array(wrong.length + unpainted.length)
  marks.set(wrong)
  marks.set(unpainted, wrong.length)
  return {
    wrong: marks.subarray(0, wrong.length),
    unpainted: marks.subarray(wrong.length),
    asserted: assertedHere,
    completed,
    mismatched,
    progressUnpainted,
    progressAsserted,
    progressByColour: packedProgress,
  }
}
