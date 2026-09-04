import {
  parseTileKey,
  type Template,
  TILE_SIZE,
  type TileKey,
  tileKey,
  WORLD_PIXELS,
} from '@caelestis/shared'
import { chunkImageUrl, tileImageUrl } from '$lib/api/client'

/**
 * A template's bounding box as a drawable rectangle.
 *
 * `minX > maxX` means the artwork wraps through longitude zero; the rectangle is unrolled past the
 * seam so drawing stays a single translate, and tile lookups fold x back into the world.
 */
export interface CanvasRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Return every whole tile touched by the template. The viewer uses these tiles as its boundary.
 */
export const tileUnionRect = (template: Template): CanvasRect => {
  let minTX = Number.POSITIVE_INFINITY
  let minTY = Number.POSITIVE_INFINITY
  let maxTX = Number.NEGATIVE_INFINITY
  let maxTY = Number.NEGATIVE_INFINITY
  for (const chunk of template.chunks) {
    const coord = parseTileKey(chunk.tile)
    if (coord === null) continue
    minTX = Math.min(minTX, coord.x)
    minTY = Math.min(minTY, coord.y)
    maxTX = Math.max(maxTX, coord.x)
    maxTY = Math.max(maxTY, coord.y)
  }
  if (!Number.isFinite(minTX)) return templateRect(template)
  return {
    x: minTX * TILE_SIZE,
    y: minTY * TILE_SIZE,
    width: (maxTX - minTX + 1) * TILE_SIZE,
    height: (maxTY - minTY + 1) * TILE_SIZE,
  }
}

/** The bbox padded by `margin` × its own size on each side, clamped to `bounds`. */
export const paddedRect = (inner: CanvasRect, margin: number, bounds: CanvasRect): CanvasRect => {
  const padX = Math.round(inner.width * margin)
  const padY = Math.round(inner.height * margin)
  const x = Math.max(bounds.x, inner.x - padX)
  const y = Math.max(bounds.y, inner.y - padY)
  return {
    x,
    y,
    width: Math.min(bounds.x + bounds.width, inner.x + inner.width + padX) - x,
    height: Math.min(bounds.y + bounds.height, inner.y + inner.height + padY) - y,
  }
}

export const templateRect = (template: Template): CanvasRect => {
  const { minX, minY, maxX, maxY } = template.bbox
  return {
    x: minX,
    y: minY,
    width: maxX > minX ? maxX - minX : maxX + WORLD_PIXELS - minX,
    height: maxY - minY,
  }
}

export interface TilePlacement {
  readonly key: TileKey
  /** Where the tile's top-left corner lands in rect-local pixels. */
  readonly drawX: number
  readonly drawY: number
}

/** Every canvas tile the rectangle touches, with its rect-local draw position. */
export const tilesInRect = (rect: CanvasRect): TilePlacement[] => {
  const placements: TilePlacement[] = []
  const firstTileX = Math.floor(rect.x / TILE_SIZE)
  const lastTileX = Math.ceil((rect.x + rect.width) / TILE_SIZE) - 1
  const firstTileY = Math.floor(rect.y / TILE_SIZE)
  const lastTileY = Math.ceil((rect.y + rect.height) / TILE_SIZE) - 1
  for (let ty = firstTileY; ty <= lastTileY; ty++) {
    for (let tx = firstTileX; tx <= lastTileX; tx++) {
      const worldX =
        ((tx % (WORLD_PIXELS / TILE_SIZE)) + WORLD_PIXELS / TILE_SIZE) % (WORLD_PIXELS / TILE_SIZE)
      placements.push({
        key: tileKey({ x: worldX, y: ty }),
        drawX: tx * TILE_SIZE - rect.x,
        drawY: ty * TILE_SIZE - rect.y,
      })
    }
  }
  return placements
}

const imageCache = new Map<string, Promise<HTMLImageElement>>()

const loadImage = (url: Promise<string>, cors = false): Promise<HTMLImageElement> =>
  url.then(
    (src) =>
      new Promise((resolve, reject) => {
        const image = new Image()
        // CORS-clean, so drawing a basemap tile never taints the canvas.
        if (cors) image.crossOrigin = 'anonymous'
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error(`image failed to load: ${src}`))
        image.src = src
      }),
  )

const cachedImage = (
  cacheKey: string,
  url: () => Promise<string>,
  cors = false,
): Promise<HTMLImageElement> => {
  const hit = imageCache.get(cacheKey)
  if (hit !== undefined) return hit
  const image = loadImage(url(), cors).catch((error) => {
    imageCache.delete(cacheKey)
    throw error
  })
  imageCache.set(cacheKey, image)
  return image
}

export const tileImage = (hash: string): Promise<HTMLImageElement> =>
  cachedImage(`tile:${hash}`, () => tileImageUrl(hash))

export const chunkImage = (hash: string): Promise<HTMLImageElement> =>
  cachedImage(`chunk:${hash}`, () => chunkImageUrl(hash))

/**
 * The OpenStreetMap basemap under the canvas, which is what wplace itself draws pixels over.
 *
 * The wplace canvas is a web-mercator overlay at zoom `CANVAS_ZOOM`, so slippy-map tiles line up
 * exactly: an OSM tile at zoom `z` covers `WORLD_PIXELS / 2^z` canvas pixels, and picking `z` is
 * matching that to the screen's pixels-per-canvas-pixel.
 */
export const OSM_TILE_SIZE = 256

export const osmZoomFor = (screenPxPerCanvasPx: number): number =>
  Math.min(
    16,
    Math.max(
      6,
      Math.round(Math.log2(screenPxPerCanvasPx) + Math.log2(WORLD_PIXELS / OSM_TILE_SIZE)),
    ),
  )

/** Canvas pixels one OSM tile covers at zoom `z`. */
export const osmSpan = (z: number): number => WORLD_PIXELS / 2 ** z

/** Destination rectangle for one slippy-map tile in canvas-pixel coordinates. */
export const osmTileDrawRect = (
  tileX: number,
  tileY: number,
  span: number,
  deviceScale: number,
): CanvasRect => ({
  x: tileX * span,
  y: tileY * span,
  // Canvas filtering samples just outside each independently drawn image. Extend toward the next
  // tile by one physical pixel so that sample comes from an opaque neighbour instead of the cleared
  // canvas. Later tiles paint over the overlap, so map detail is neither shifted nor duplicated.
  width: span + 1 / Math.max(Number.EPSILON, deviceScale),
  height: span + 1 / Math.max(Number.EPSILON, deviceScale),
})

export const osmImage = (z: number, x: number, y: number): Promise<HTMLImageElement> =>
  cachedImage(
    `osm:${z}/${x}/${y}`,
    () => Promise.resolve(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`),
    true,
  )

/** One chunk's draw position in world (canvas-pixel) coordinates. */
export interface ChunkPlacement {
  readonly hash: string
  readonly x: number
  readonly y: number
}

export const chunkPlacements = (template: Template): ChunkPlacement[] => {
  const placements: ChunkPlacement[] = []
  for (const chunk of template.chunks) {
    const coord = parseTileKey(chunk.tile)
    if (coord === null) continue
    // A chunk is the intersection of its bounding box and tile. Its top-left uses the later start.
    placements.push({
      hash: chunk.hash,
      x: Math.max(coord.x * TILE_SIZE, template.bbox.minX),
      y: Math.max(coord.y * TILE_SIZE, template.bbox.minY),
    })
  }
  return placements
}

/**
 * Draw the observed canvas under a rect: each tile the server holds is painted where it belongs,
 * unobserved tiles stay transparent so the checkerboard beneath shows "never scanned" honestly.
 * Images arrive asynchronously; `onDirty` fires after each landing so the caller can composite.
 */
export const drawCanvasTiles = (
  ctx: CanvasRenderingContext2D,
  rect: CanvasRect,
  hashFor: (key: TileKey) => string | undefined,
  signal: AbortSignal,
  onDirty: () => void,
): void => {
  for (const placement of tilesInRect(rect)) {
    const hash = hashFor(placement.key)
    if (hash === undefined) continue
    tileImage(hash)
      .then((image) => {
        if (signal.aborted) return
        ctx.drawImage(image, placement.drawX, placement.drawY)
        onDirty()
      })
      .catch(() => {})
  }
}

/** Draw a template's chunks over a rect at the given opacity. */
export const drawTemplateChunks = (
  ctx: CanvasRenderingContext2D,
  rect: CanvasRect,
  template: Template,
  alpha: number,
  signal: AbortSignal,
  onDirty: () => void,
): void => {
  for (const chunk of template.chunks) {
    const coord = parseTileKey(chunk.tile)
    if (coord === null) continue
    // A chunk is the intersection of its bounding box and tile. Its top-left uses the later start
    // on each axis. The rectangle only translates it.
    const drawX = Math.max(coord.x * TILE_SIZE, template.bbox.minX) - rect.x
    const drawY = Math.max(coord.y * TILE_SIZE, template.bbox.minY) - rect.y
    chunkImage(chunk.hash)
      .then((image) => {
        if (signal.aborted) return
        ctx.save()
        ctx.globalAlpha = alpha
        ctx.drawImage(image, drawX, drawY)
        ctx.restore()
        onDirty()
      })
      .catch(() => {})
  }
}
