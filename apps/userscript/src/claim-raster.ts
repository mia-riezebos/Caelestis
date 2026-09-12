import {
  MAX_RASTER_BITS,
  type Point,
  type PresenceRect,
  type RegionShape,
  type RegionShapePixels,
  rasterShapeFrom,
  regionShapePixels,
  WORLD_PIXELS,
} from '@caelestis/shared'

/**
 * Raster drawing for claim mode: what the pencil paints and the eraser removes.
 *
 * A pencil stroke is a set of whole pixels, stamped along the pointer's path with a round tip.
 * It becomes a `pixels` shape, nothing to vectorise. The eraser uses the same stamping to know
 * which pixels to clear from a raster; cutting vector shapes is `claim-split.ts`'s job.
 */

/** A growing set of canvas pixels, keyed by row-major index over the whole world. */
export class PixelSet {
  private readonly held = new Set<number>()
  private left = Number.POSITIVE_INFINITY
  private top = Number.POSITIVE_INFINITY
  private right = Number.NEGATIVE_INFINITY
  private bottom = Number.NEGATIVE_INFINITY

  static readonly STRIDE = 1 << 22
  /** Set once a stamp would grow the box past what a raster may hold; nothing more is stamped. */
  tooLarge = false

  get size(): number {
    return this.held.size
  }

  /** Whether stamping a tip at a pixel keeps the bounding box within the raster limit. */
  private fits(x: number, y: number, reach: number): boolean {
    const left = Math.min(this.left, x - reach)
    const top = Math.min(this.top, y - reach)
    const right = Math.max(this.right, x + reach)
    const bottom = Math.max(this.bottom, y + reach)
    return (right - left + 1) * (bottom - top + 1) <= MAX_RASTER_BITS
  }

  has(x: number, y: number): boolean {
    return this.held.has(y * PixelSet.STRIDE + x)
  }

  add(x: number, y: number): void {
    // A wide tip at the canvas edge reaches past it; those pixels do not exist.
    if (x < 0 || y < 0 || x >= WORLD_PIXELS || y >= WORLD_PIXELS) return
    this.held.add(y * PixelSet.STRIDE + x)
    if (x < this.left) this.left = x
    if (x > this.right) this.right = x
    if (y < this.top) this.top = y
    if (y > this.bottom) this.bottom = y
  }

  /** Stamp a round tip of `width` pixels centred on a pixel. Width one is the pixel itself. */
  stamp(x: number, y: number, width: number): void {
    // The box is checked before the tip is stamped, so a long stroke with a wide tip stops
    // doing work the moment it would no longer fit, instead of stamping millions of pixels
    // that a raster could never hold.
    if (this.tooLarge) return
    const radius = width / 2
    const reach = width <= 1 ? 0 : Math.ceil(radius)
    if (!this.fits(x, y, reach)) {
      this.tooLarge = true
      return
    }
    if (width <= 1) {
      this.add(x, y)
      return
    }
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        // Pixel-centre membership, like the shared rasteriser: the disc is measured from centres.
        if (dx * dx + dy * dy <= radius * radius) this.add(x + dx, y + dy)
      }
    }
  }

  /** Stamp along the straight line between two pixels, every pixel of the way. */
  line(from: Point, to: Point, width: number): void {
    if (this.tooLarge) return
    const x0 = Math.floor(from.x)
    const y0 = Math.floor(from.y)
    const x1 = Math.floor(to.x)
    const y1 = Math.floor(to.y)
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    for (let step = 0; step <= steps; step++) {
      const t = steps === 0 ? 0 : step / steps
      this.stamp(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), width)
    }
  }

  bounds(): PresenceRect | null {
    if (this.held.size === 0) return null
    return {
      x: this.left,
      y: this.top,
      w: this.right - this.left + 1,
      h: this.bottom - this.top + 1,
    }
  }

  /** The set as shared pixels over its bounding box, or null when empty or too large to hold. */
  pixels(): RegionShapePixels | null {
    const rect = this.bounds()
    if (rect === null || this.tooLarge) return null
    // A long diagonal stroke has a huge box for few pixels; refuse before allocating it.
    if (rect.w * rect.h > MAX_RASTER_BITS) return null
    const mask = new Uint8Array(rect.w * rect.h)
    for (const key of this.held) {
      const y = Math.floor(key / PixelSet.STRIDE)
      const x = key - y * PixelSet.STRIDE
      mask[(y - rect.y) * rect.w + (x - rect.x)] = 1
    }
    return { rect, mask, count: this.held.size }
  }

  /** The set as a raster shape, or null when empty or too large for one. */
  shape(): RegionShape | null {
    const pixels = this.pixels()
    return pixels === null ? null : rasterShapeFrom(pixels)
  }
}

const rectsTouch = (a: PresenceRect, b: PresenceRect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Two rasters as one: the union of their pixels. Null when the union is too large for one. */
export const mergeRasters = (base: RegionShape, added: RegionShape): RegionShape | null => {
  if (base.kind !== 'pixels' || added.kind !== 'pixels') return null
  const set = new PixelSet()
  for (const shape of [base, added]) {
    const { rect, mask } = regionShapePixels(shape)
    for (let row = 0; row < rect.h; row++) {
      for (let column = 0; column < rect.w; column++)
        if (mask[row * rect.w + column] === 1) set.add(rect.x + column, rect.y + row)
    }
  }
  return set.shape()
}

/**
 * A raster with some pixels rubbed out. Null when nothing is left; the same shape when the
 * eraser never touched its box.
 */
export const eraseFromRaster = (shape: RegionShape, erased: PixelSet): RegionShape | null => {
  if (shape.kind !== 'pixels') return shape
  const touched = erased.bounds()
  const box = { x: shape.x, y: shape.y, w: shape.w, h: shape.h }
  if (touched === null || !rectsTouch(box, touched)) return shape
  const { rect, mask } = regionShapePixels(shape)
  let changed = false
  for (let row = 0; row < rect.h; row++) {
    for (let column = 0; column < rect.w; column++) {
      const at = row * rect.w + column
      if (mask[at] === 1 && erased.has(rect.x + column, rect.y + row)) {
        mask[at] = 0
        changed = true
      }
    }
  }
  if (!changed) return shape
  let count = 0
  for (const bit of mask) if (bit === 1) count++
  return rasterShapeFrom({ rect, mask, count })
}

/** Whether any pixel of a shape lies under the eraser. */
export const rasterTouches = (shape: RegionShape, erased: PixelSet): boolean => {
  const touched = erased.bounds()
  if (touched === null) return false
  const { rect, mask } = regionShapePixels(shape)
  if (!rectsTouch(rect, touched)) return false
  for (let row = 0; row < rect.h; row++) {
    for (let column = 0; column < rect.w; column++) {
      if (mask[row * rect.w + column] === 1 && erased.has(rect.x + column, rect.y + row))
        return true
    }
  }
  return false
}
