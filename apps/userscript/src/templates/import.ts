import {
  latLngToCanvasPixel,
  PALETTE_RGB,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  uuidV7,
  WORLD_PIXELS,
  WORLD_TILES,
} from '@wts/shared'
import { log, warn } from '../debug.js'

/**
 * Bringing a template in from a file.
 *
 * Three sources, one result. They disagree on both of the things that matter, so this is one
 * importer with three front ends rather than one parser:
 *
 * - **`.wplace`** — a single image as a data URL, placed by lat/lng `bounds`. Needs projecting.
 * - **Blue Marble / Skirk** — already sliced into per-tile PNGs, placed by `"tileX, tileY, pxX, pxY"`.
 *   Counterintuitively the easier import, because its coordinates never left our system.
 * - **A plain PNG** — no placement at all, so the caller supplies one.
 *
 * Decoding uses the browser's own PNG support via `createImageBitmap` rather than a bundled decoder.
 * The userscript is the one place where bundle size actually matters, and the platform already has
 * this.
 */

export type TemplateSource = 'wplace' | 'marble' | 'image'

export interface ImportedTemplate {
  readonly id: string
  readonly name: string
  readonly source: TemplateSource
  /** Source z-order, lowest first. Optional only for records written by older builds. */
  readonly sortOrder?: number
  /** Top-left corner in global canvas pixels. */
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
  /** One byte per pixel: wplace's palette index, `TRANSPARENT_INDEX` for absent. */
  readonly indices: Uint8Array
  /** How far the quantiser had to move things, for reporting to whoever imported it. */
  readonly moved: number
  readonly opaque: number
}

// Large enough for the observed 11 MB / 1612x2584 `.wplace` fixture, while keeping a malformed or
// hostile local file from turning one click into an unbounded browser allocation.
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_IMPORT_PIXELS = 16 * 1024 * 1024
const MAX_MARBLE_TILES = 64
const MAX_MARBLE_TEMPLATES = 64
const MARBLE_DRAW_MULT = 3
const QUANTISE_WORK_PER_YIELD = 1_000_000
const DENSE_CACHE_THRESHOLD = 65_536
const RGB_SPACE = 1 << 24

const newId = (): string => `local-${uuidV7()}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const yieldToBrowser = async (): Promise<void> => {
  const browserScheduler = (
    globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }
  ).scheduler
  if (browserScheduler?.yield !== undefined) {
    await browserScheduler.yield()
    return
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

const pngDimensions = async (blob: Blob): Promise<{ width: number; height: number }> => {
  if (blob.size > MAX_FILE_BYTES) throw new Error('image is too large to import safely')
  const bytes = new Uint8Array(await blob.slice(0, 24).arrayBuffer())
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (
    bytes.length !== 24 ||
    signature.some((value, index) => bytes[index] !== value) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR'
  ) {
    throw new Error('only PNG images can be imported')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (
    width <= 0 ||
    height <= 0 ||
    width > WORLD_PIXELS ||
    height > WORLD_PIXELS ||
    width * height > MAX_IMPORT_PIXELS
  ) {
    throw new Error('decoded image is too large to import safely')
  }
  return { width, height }
}

/** RGBA for a PNG whose dimensions have already passed the allocation preflight. */
const decodeToRgba = async (
  blob: Blob,
): Promise<{ width: number; height: number; pixels: Uint8Array }> => {
  // PNG dimensions live in the fixed IHDR header. Check them before asking the browser to decode,
  // otherwise a tiny compressed file can force a huge native allocation before bitmap.width exists.
  const expected = await pngDimensions(blob)
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  })
  try {
    // Read the dimensions *before* closing: an ImageBitmap reports 0x0 once closed, so reading them
    // afterwards silently produced zero-sized templates whose origin was nonetheless correct.
    const width = bitmap.width
    const height = bitmap.height
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width * height > MAX_IMPORT_PIXELS ||
      width !== expected.width ||
      height !== expected.height
    ) {
      throw new Error('decoded image is too large to import safely')
    }
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })
    if (context === null) throw new Error('could not get a 2d context to decode the image')
    context.drawImage(bitmap, 0, 0)
    const data = context.getImageData(0, 0, width, height)
    return { width, height, pixels: new Uint8Array(data.data.buffer) }
  } finally {
    bitmap.close()
  }
}

const blobFromDataUrl = async (dataUrl: string): Promise<Blob> =>
  await (await fetch(dataUrl)).blob()

const quantise = async (
  pixels: Uint8Array,
): Promise<{ indices: Uint8Array; moved: number; opaque: number }> => {
  const indices = new Uint8Array(pixels.length / 4).fill(TRANSPARENT_INDEX)
  // Start cheap for normal pixel art. If an image has photographic colour cardinality, migrate to
  // one packed 32 MiB RGB lookup instead of allowing millions of object-heavy Map entries.
  const sparse = new Map<number, number>()
  let dense: Uint16Array | null = null
  let moved = 0
  let opaque = 0
  let work = 0

  for (let pixel = 0; pixel < indices.length; pixel++) {
    const at = pixel * 4
    work++
    if ((pixels[at + 3] ?? 0) < 128) {
      if (work >= QUANTISE_WORK_PER_YIELD) {
        work = 0
        await yieldToBrowser()
      }
      continue
    }
    const red = pixels[at] ?? 0
    const green = pixels[at + 1] ?? 0
    const blue = pixels[at + 2] ?? 0
    const key = (red << 16) | (green << 8) | blue
    let packed = dense === null ? (sparse.get(key) ?? 0) : (dense[key] ?? 0)
    if (packed === 0) {
      let best = 0
      let bestDistance = Number.POSITIVE_INFINITY
      for (const [index, entry] of PALETTE_RGB.entries()) {
        const dr = red - entry[0]
        const dg = green - entry[1]
        const db = blue - entry[2]
        const distance = dr * dr + dg * dg + db * db
        if (distance < bestDistance) {
          best = index
          bestDistance = distance
        }
      }
      const chosen = PALETTE_RGB[best]
      if (chosen === undefined) throw new Error('wplace palette is empty')
      const distance = Math.max(
        Math.abs(red - chosen[0]),
        Math.abs(green - chosen[1]),
        Math.abs(blue - chosen[2]),
      )
      packed = (distance << 8) | (best + 1)
      if (dense === null) {
        sparse.set(key, packed)
        if (sparse.size >= DENSE_CACHE_THRESHOLD) {
          dense = new Uint16Array(RGB_SPACE)
          for (const [colour, choice] of sparse) dense[colour] = choice
          sparse.clear()
        }
      } else {
        dense[key] = packed
      }
      work += PALETTE_RGB.length
    }
    const paletteIndex = (packed & 0xff) - 1
    const distance = packed >>> 8
    indices[pixel] = paletteIndex
    opaque++
    if (distance > 0) moved++
    if (work >= QUANTISE_WORK_PER_YIELD) {
      work = 0
      await yieldToBrowser()
    }
  }
  return { indices, moved, opaque }
}

const importWplace = async (file: Record<string, unknown>): Promise<ImportedTemplate[]> => {
  const image = isRecord(file.image) ? file.image : null
  const bounds = isRecord(file.bounds) ? file.bounds : null
  const dataUrl = image?.dataUrl
  if (typeof dataUrl !== 'string' || bounds === null) {
    warn('install', 'skipping .wplace template: missing embedded image or bounds')
    return []
  }
  if (!/^data:image\/png;base64,/i.test(dataUrl)) {
    throw new Error('.wplace image must be an embedded PNG data URL')
  }
  const { north, west } = bounds
  if (
    typeof north !== 'number' ||
    typeof west !== 'number' ||
    !Number.isFinite(north) ||
    !Number.isFinite(west)
  ) {
    warn('install', 'skipping .wplace template: invalid geographic bounds')
    return []
  }

  const { width, height, pixels } = await decodeToRgba(await blobFromDataUrl(dataUrl))
  const { indices, moved, opaque } = await quantise(pixels)
  // The file places by geography; the canvas thinks in pixels. `28-native-wplace-format` confirmed
  // this projection to the pixel against this exact file.
  const origin = latLngToCanvasPixel({ lat: north, lng: west })
  const originX = Math.round(origin.x)
  const originY = Math.round(origin.y)
  if (
    originX < 0 ||
    originY < 0 ||
    originX + width > WORLD_PIXELS ||
    originY + height > WORLD_PIXELS
  ) {
    warn('install', 'skipping .wplace template: projected image leaves the canvas')
    return []
  }
  return [
    {
      id: newId(),
      name: typeof file.name === 'string' ? file.name : 'Imported template',
      source: 'wplace',
      sortOrder:
        typeof file.order === 'number' && Number.isSafeInteger(file.order) ? file.order : 0,
      originX,
      originY,
      width,
      height,
      indices,
      moved,
      opaque,
    },
  ]
}

interface MarbleFile {
  readonly templates?: unknown
}

/** Blue Marble stores native pixels as the centre dot of a 3x3 display cell. Decode that storage
 * representation; this restores the original fixed dimensions and is not image resizing. */
const decodeMarbleTile = async (
  blob: Blob,
): Promise<{ width: number; height: number; pixels: Uint8Array }> => {
  const encoded = await decodeToRgba(blob)
  if (encoded.width % MARBLE_DRAW_MULT !== 0 || encoded.height % MARBLE_DRAW_MULT !== 0) {
    throw new Error('Marble tile does not use the expected 3x stamped encoding')
  }
  const width = encoded.width / MARBLE_DRAW_MULT
  const height = encoded.height / MARBLE_DRAW_MULT
  const pixels = new Uint8Array(width * height * 4)
  const centre = Math.floor(MARBLE_DRAW_MULT / 2)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source =
        ((y * MARBLE_DRAW_MULT + centre) * encoded.width + x * MARBLE_DRAW_MULT + centre) * 4
      const target = (y * width + x) * 4
      pixels[target] = encoded.pixels[source] ?? 0
      pixels[target + 1] = encoded.pixels[source + 1] ?? 0
      pixels[target + 2] = encoded.pixels[source + 2] ?? 0
      pixels[target + 3] = encoded.pixels[source + 3] ?? 0
    }
  }
  return { width, height, pixels }
}

const importMarble = async (file: MarbleFile): Promise<ImportedTemplate[]> => {
  const out: ImportedTemplate[] = []
  if (!isRecord(file.templates)) return out
  const entries = Object.entries(file.templates)
  if (entries.length > MAX_MARBLE_TEMPLATES) {
    throw new Error('Marble file contains too many templates')
  }
  let retainedPixels = 0
  for (const [key, entryValue] of entries) {
    if (!isRecord(entryValue)) {
      warn('install', `skipping Marble template "${key}": unreadable record`)
      continue
    }
    const entry = entryValue
    const parts = (typeof entry.coords === 'string' ? entry.coords : '')
      .split(',')
      .map((part) => Number(part.trim()))
    if (parts.length !== 4 || !validMarbleCoords(parts)) {
      warn('install', `skipping Marble template "${key}": unreadable coords`, entry.coords)
      continue
    }
    const [tileX, tileY, pixelX, pixelY] = parts as [number, number, number, number]
    const originX = tileX * TILE_SIZE + pixelX
    const originY = tileY * TILE_SIZE + pixelY

    // Tiles are keyed by their own coordinates; the extent is whatever they cover together.
    const decoded: Array<{
      x: number
      y: number
      width: number
      height: number
      pixels: Uint8Array
    }> = []
    if (entry.tiles !== undefined && !isRecord(entry.tiles)) {
      warn('install', `skipping Marble template "${key}": unreadable tiles`)
      continue
    }
    const pieces = Object.entries(isRecord(entry.tiles) ? entry.tiles : {})
    if (pieces.length > MAX_MARBLE_TILES) {
      warn('install', `skipping Marble template "${key}": too many tiles`, pieces.length)
      continue
    }
    let malformed = false
    let decodedPixels = 0
    const seenCoordinates = new Set<string>()
    for (const [tileKey, base64Value] of pieces) {
      const coords = tileKey.split(/[,\s]+/).map(Number)
      if (coords.length !== 4 || !validMarbleCoords(coords)) {
        warn('install', `skipping Marble template "${key}": unreadable tile coords`, tileKey)
        malformed = true
        break
      }
      const coordinateKey = coords.join(',')
      if (seenCoordinates.has(coordinateKey)) {
        warn('install', `skipping Marble template "${key}": duplicate tile coords`, tileKey)
        malformed = true
        break
      }
      seenCoordinates.add(coordinateKey)
      if (typeof base64Value !== 'string') {
        warn('install', `skipping Marble template "${key}": unreadable tile`, tileKey)
        malformed = true
        break
      }
      const source = base64Value.startsWith('data:')
        ? base64Value
        : `data:image/png;base64,${base64Value}`
      if (!/^data:image\/png;base64,/i.test(source)) {
        warn('install', `skipping Marble template "${key}": tile is not an embedded PNG`, tileKey)
        malformed = true
        break
      }
      let image: Awaited<ReturnType<typeof decodeMarbleTile>>
      try {
        image = await decodeMarbleTile(await blobFromDataUrl(source))
      } catch (error) {
        warn('install', `skipping Marble template "${key}": unreadable tile ${tileKey}`, error)
        malformed = true
        break
      }
      decodedPixels += image.width * image.height
      if (retainedPixels + decodedPixels > MAX_IMPORT_PIXELS) {
        warn('install', `skipping Marble template "${key}": decoded tiles are too large`)
        malformed = true
        break
      }
      decoded.push({
        x: (coords[0] ?? 0) * TILE_SIZE + (coords[2] ?? 0),
        y: (coords[1] ?? 0) * TILE_SIZE + (coords[3] ?? 0),
        ...image,
      })
    }
    if (malformed || decoded.length === 0) continue

    let maxX = originX
    let maxY = originY
    for (const piece of decoded) {
      if (piece.x < originX || piece.y < originY) {
        malformed = true
        break
      }
      maxX = Math.max(maxX, piece.x + piece.width)
      maxY = Math.max(maxY, piece.y + piece.height)
    }
    const width = maxX - originX
    const height = maxY - originY
    if (
      malformed ||
      width <= 0 ||
      height <= 0 ||
      retainedPixels + width * height > MAX_IMPORT_PIXELS ||
      maxX > WORLD_PIXELS ||
      maxY > WORLD_PIXELS
    ) {
      warn('install', `skipping Marble template "${key}": assembled image is too large or invalid`)
      continue
    }

    const indices = new Uint8Array(width * height).fill(TRANSPARENT_INDEX)
    let moved = 0
    let opaque = 0
    for (const piece of decoded) {
      const quantised = await quantise(piece.pixels)
      moved += quantised.moved
      for (let row = 0; row < piece.height; row++) {
        const target = (piece.y - originY + row) * width + (piece.x - originX)
        for (let column = 0; column < piece.width; column++) {
          const index = quantised.indices[row * piece.width + column] ?? TRANSPARENT_INDEX
          if (index === TRANSPARENT_INDEX) continue
          if (indices[target + column] === TRANSPARENT_INDEX) opaque++
          indices[target + column] = index
        }
      }
    }

    out.push({
      id: newId(),
      name: typeof entry.name === 'string' ? entry.name : key,
      source: 'marble',
      sortOrder: marbleSortOrder(key, out.length),
      // The declared coords win over the assembled extent. Including the space before the first
      // decoded tile preserves transparent/native margins instead of shifting the fixed-size art.
      originX,
      originY,
      width,
      height,
      indices,
      moved,
      opaque,
    })
    retainedPixels += width * height
  }
  return out
}

/** A plain image has no placement of its own, so the caller says where it goes. */
const importImage = async (
  blob: Blob,
  name: string,
  centre: { x: number; y: number },
): Promise<ImportedTemplate[]> => {
  const { width, height, pixels } = await decodeToRgba(blob)
  const { indices, moved, opaque } = await quantise(pixels)
  if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y)) return []
  const originX = Math.min(Math.max(0, Math.round(centre.x - width / 2)), WORLD_PIXELS - width)
  const originY = Math.min(Math.max(0, Math.round(centre.y - height / 2)), WORLD_PIXELS - height)
  return [
    {
      id: newId(),
      name,
      source: 'image',
      sortOrder: 0,
      originX,
      originY,
      width,
      height,
      indices,
      moved,
      opaque,
    },
  ]
}

export const importFile = async (
  file: File,
  centre: { x: number; y: number },
): Promise<ImportedTemplate[]> => {
  const started = performance.now()
  if (file.size > MAX_FILE_BYTES) throw new Error('file is too large to import safely')
  const isJson =
    file.name.toLowerCase().endsWith('.wplace') ||
    file.name.toLowerCase().endsWith('.json') ||
    file.type === 'application/json'

  let result: ImportedTemplate[]
  if (isJson) {
    const parsed: unknown = JSON.parse(await file.text())
    if (!isRecord(parsed)) return []
    // Tell them apart by shape rather than by extension: both ship as .json, and Marble's export
    // has no version marker to check.
    result =
      parsed.templates !== undefined ? await importMarble(parsed) : await importWplace(parsed)
  } else {
    result = await importImage(file, file.name.replace(/\.[^.]+$/, ''), centre)
  }

  result = result.filter((template) => {
    if (template.opaque > 0) return true
    warn('install', `skipping ${template.name}: image has no painted pixels`)
    return false
  })

  for (const template of result) {
    log('install', `imported ${template.name}`, {
      source: template.source,
      size: `${template.width}x${template.height}`,
      origin: `${template.originX},${template.originY}`,
      opaque: template.opaque,
      moved: template.moved,
      ms: Math.round(performance.now() - started),
    })
  }
  return result
}

const validMarbleCoords = (parts: readonly number[]): boolean => {
  const [tileX, tileY, pixelX, pixelY] = parts
  return (
    parts.length === 4 &&
    [tileX, tileY, pixelX, pixelY].every((value) => Number.isSafeInteger(value)) &&
    tileX !== undefined &&
    tileY !== undefined &&
    pixelX !== undefined &&
    pixelY !== undefined &&
    tileX >= 0 &&
    tileX < WORLD_TILES &&
    tileY >= 0 &&
    tileY < WORLD_TILES &&
    pixelX >= 0 &&
    pixelX < TILE_SIZE &&
    pixelY >= 0 &&
    pixelY < TILE_SIZE
  )
}

const marbleSortOrder = (key: string, fallback: number): number => {
  const value = Number(key.trim().split(/\s+/)[0])
  return Number.isSafeInteger(value) ? value : fallback
}
