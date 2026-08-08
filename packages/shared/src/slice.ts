import { TRANSPARENT_INDEX } from './palette.js'
import { TILE_SIZE, WORLD_PIXELS } from './tiles.js'

/**
 * Cut a placed template into per-tile chunks.
 *
 * The userscript composites one wplace tile at a time, so a chunk that spanned a tile boundary would
 * have to be fetched and cropped by every tile it touched. Slicing on the boundary makes a chunk
 * exactly what one tile render needs.
 *
 * @see .scratch/v1/issues/01-template-storage-and-chunk-model.md
 */

/** Half-open, matching the wire: `min` is inclusive, `max` exclusive. */
/**
 * Whether two placed bounding boxes share a pixel.
 *
 * The canvas wraps in x and does not in y, so `minX > maxX` means "spans the antimeridian" and has
 * to be read as two ranges; `minY > maxY` has no meaning and cannot occur. The wire refuses two
 * templates in one group that overlap, so a server that stores such a pair can emit a manifest its
 * own clients reject — which is why this lives here rather than only in the decoder.
 */
export const boundsOverlap = (left: PixelBounds, right: PixelBounds): boolean => {
  if (left.minY >= right.maxY || right.minY >= left.maxY) return false
  const spans = ({ minX, maxX }: PixelBounds): [number, number][] =>
    minX < maxX
      ? [[minX, maxX]]
      : [
          [minX, WORLD_PIXELS],
          [0, maxX],
        ]
  return spans(left).some(([leftStart, leftEnd]) =>
    spans(right).some(([rightStart, rightEnd]) => leftStart < rightEnd && rightStart < leftEnd),
  )
}

export interface PixelBounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

export interface TemplateChunk {
  readonly tileX: number
  readonly tileY: number
  readonly width: number
  readonly height: number
  /** One byte per pixel, wplace palette indices, `width * height` long. */
  readonly indices: Uint8Array
}

export interface SliceResult {
  /**
   * The painted extent, not the image rect.
   *
   * A template with transparent margins would otherwise claim a box larger than it covers, and every
   * consumer of the bbox — culling, overlap detection, the progress denominator's ceiling — would be
   * working from padding.
   */
  readonly bbox: PixelBounds
  /** Non-transparent pixels, which is the progress denominator. */
  readonly totalPixels: number
  /** One per tile that carries at least one painted pixel. */
  readonly chunks: readonly TemplateChunk[]
}

export class SliceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SliceError'
  }
}

/**
 * Slice `indices` — a `width` x `height` image of palette indices — placed with its top-left corner
 * at canvas pixel (`originX`, `originY`).
 *
 * **A tile the template merely spans but paints nothing in produces no chunk.** A diagonal shape
 * crossing four tiles may paint in only three, and emitting the fourth would store an empty image
 * and advertise coverage the template does not have.
 *
 * Templates that would run past the east edge are rejected rather than wrapped. The wire supports a
 * bounding box spanning the antimeridian, so wrapped *placement* is a coherent feature — but it
 * needs a decision this ticket does not make, namely which of the two runs is the bbox's `minX`.
 * Rejecting is the honest interim: it fails loudly instead of silently placing pixels on the far
 * side of the canvas.
 */
export const sliceTemplate = (
  indices: Uint8Array,
  width: number,
  height: number,
  originX: number,
  originY: number,
): SliceResult => {
  if (indices.length !== width * height) {
    throw new SliceError(`expected ${width * height} indices, received ${indices.length}`)
  }
  if (!Number.isSafeInteger(originX) || !Number.isSafeInteger(originY)) {
    throw new SliceError('origin must be whole canvas pixels')
  }
  if (originX < 0 || originY < 0) throw new SliceError('origin is outside the canvas')
  if (originX + width > WORLD_PIXELS) {
    throw new SliceError('template runs past the east edge; wrapped placement is not supported yet')
  }
  if (originY + height > WORLD_PIXELS) throw new SliceError('template runs past the south edge')

  // Painted extent in image coordinates, so the bbox does not include transparent margins.
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let totalPixels = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (indices[y * width + x] === TRANSPARENT_INDEX) continue
      totalPixels += 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (totalPixels === 0) throw new SliceError('template has no painted pixels')

  const bbox: PixelBounds = {
    minX: originX + minX,
    minY: originY + minY,
    // Exclusive, so one past the last painted pixel.
    maxX: originX + maxX + 1,
    maxY: originY + maxY + 1,
  }

  const chunks: TemplateChunk[] = []
  // `maxX - 1` because the bound is exclusive: a box ending exactly on a tile edge does not reach
  // into the next tile. Using `maxX` directly is an equivalent mutation rather than a bug — the
  // extra column intersects the box in zero pixels, so it is dropped by the empty-chunk guard below
  // — but it would allocate and scan a tile per row for nothing.
  const firstTileX = Math.floor(bbox.minX / TILE_SIZE)
  const lastTileX = Math.floor((bbox.maxX - 1) / TILE_SIZE)
  const firstTileY = Math.floor(bbox.minY / TILE_SIZE)
  const lastTileY = Math.floor((bbox.maxY - 1) / TILE_SIZE)

  for (let tileY = firstTileY; tileY <= lastTileY; tileY += 1) {
    for (let tileX = firstTileX; tileX <= lastTileX; tileX += 1) {
      // The chunk is exactly bbox ∩ tile, which is why the wire does not carry an offset or a size:
      // both are recoverable from the bounding box and the tile key.
      const startX = Math.max(bbox.minX, tileX * TILE_SIZE)
      const endX = Math.min(bbox.maxX, (tileX + 1) * TILE_SIZE)
      const startY = Math.max(bbox.minY, tileY * TILE_SIZE)
      const endY = Math.min(bbox.maxY, (tileY + 1) * TILE_SIZE)
      const chunkWidth = endX - startX
      const chunkHeight = endY - startY

      const chunk = new Uint8Array(chunkWidth * chunkHeight).fill(TRANSPARENT_INDEX)
      let painted = 0
      for (let y = 0; y < chunkHeight; y += 1) {
        const sourceRow = (startY - originY + y) * width + (startX - originX)
        for (let x = 0; x < chunkWidth; x += 1) {
          const value = indices[sourceRow + x] ?? TRANSPARENT_INDEX
          if (value === TRANSPARENT_INDEX) continue
          chunk[y * chunkWidth + x] = value
          painted += 1
        }
      }
      if (painted === 0) continue

      chunks.push({ tileX, tileY, width: chunkWidth, height: chunkHeight, indices: chunk })
    }
  }

  return { bbox, totalPixels, chunks }
}
