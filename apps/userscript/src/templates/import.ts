import {
  latLngToCanvasPixel,
  PALETTE_RGB,
  quantiseToPalette,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  WPLACE_PALETTE,
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
 * - **A plain image** — no placement at all, so the caller supplies one.
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

const newId = (): string =>
  `local-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

/** RGBA for an image the browser can decode, which is every format it natively supports. */
const decodeToRgba = async (
  blob: Blob,
): Promise<{ width: number; height: number; pixels: Uint8Array }> => {
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new Error('could not get a 2d context to decode the image')
  context.drawImage(bitmap, 0, 0)
  // Read the dimensions *before* closing: an ImageBitmap reports 0x0 once closed, so reading them
  // afterwards silently produced zero-sized templates whose origin was nonetheless correct.
  const width = bitmap.width
  const height = bitmap.height
  const data = context.getImageData(0, 0, width, height)
  bitmap.close()
  return { width, height, pixels: new Uint8Array(data.data.buffer) }
}

const blobFromDataUrl = async (dataUrl: string): Promise<Blob> =>
  await (await fetch(dataUrl)).blob()

const quantise = (pixels: Uint8Array): { indices: Uint8Array; moved: number; opaque: number } => {
  const { indices, report } = quantiseToPalette(pixels, PALETTE_RGB)
  return { indices, moved: report.movedPixels, opaque: report.opaquePixels }
}

interface WplaceFile {
  readonly schemaVersion?: string
  readonly name?: string
  readonly image?: { dataUrl?: string; width?: number; height?: number }
  readonly bounds?: { north?: number; south?: number; west?: number; east?: number }
}

const importWplace = async (file: WplaceFile): Promise<ImportedTemplate[]> => {
  const dataUrl = file.image?.dataUrl
  const bounds = file.bounds
  if (typeof dataUrl !== 'string' || bounds === undefined) return []
  const { north, west } = bounds
  if (typeof north !== 'number' || typeof west !== 'number') return []

  const { width, height, pixels } = await decodeToRgba(await blobFromDataUrl(dataUrl))
  const { indices, moved, opaque } = quantise(pixels)
  // The file places by geography; the canvas thinks in pixels. `28-native-wplace-format` confirmed
  // this projection to the pixel against this exact file.
  const origin = latLngToCanvasPixel({ lat: north, lng: west })
  return [
    {
      id: newId(),
      name: file.name ?? 'Imported template',
      source: 'wplace',
      originX: Math.round(origin.x),
      originY: Math.round(origin.y),
      width,
      height,
      indices,
      moved,
      opaque,
    },
  ]
}

interface MarbleFile {
  readonly templates?: Record<
    string,
    { name?: string; coords?: string; tiles?: Record<string, string> }
  >
}

const importMarble = async (file: MarbleFile): Promise<ImportedTemplate[]> => {
  const out: ImportedTemplate[] = []
  for (const [key, entry] of Object.entries(file.templates ?? {})) {
    const parts = (entry.coords ?? '').split(',').map((part) => Number(part.trim()))
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
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
    for (const [tileKey, base64] of Object.entries(entry.tiles ?? {})) {
      const coords = tileKey.split(/[,\s]+/).map(Number)
      const source = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`
      const image = await decodeToRgba(await blobFromDataUrl(source))
      decoded.push({
        x: (coords[0] ?? 0) * TILE_SIZE + (coords[2] ?? 0),
        y: (coords[1] ?? 0) * TILE_SIZE + (coords[3] ?? 0),
        ...image,
      })
    }
    if (decoded.length === 0) continue

    const minX = Math.min(...decoded.map((d) => d.x))
    const minY = Math.min(...decoded.map((d) => d.y))
    const maxX = Math.max(...decoded.map((d) => d.x + d.width))
    const maxY = Math.max(...decoded.map((d) => d.y + d.height))
    const width = maxX - minX
    const height = maxY - minY

    const indices = new Uint8Array(width * height).fill(TRANSPARENT_INDEX)
    let moved = 0
    let opaque = 0
    for (const piece of decoded) {
      const quantised = quantise(piece.pixels)
      moved += quantised.moved
      opaque += quantised.opaque
      for (let row = 0; row < piece.height; row++) {
        const target = (piece.y - minY + row) * width + (piece.x - minX)
        indices.set(quantised.indices.subarray(row * piece.width, (row + 1) * piece.width), target)
      }
    }

    out.push({
      id: newId(),
      name: entry.name ?? key,
      source: 'marble',
      // The declared coords win over the assembled extent: a Marble file's tiles start at its
      // origin, and trusting the tiles instead would silently shift anything with an empty edge.
      originX: decoded.length > 0 ? minX : originX,
      originY: decoded.length > 0 ? minY : originY,
      width,
      height,
      indices,
      moved,
      opaque,
    })
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
  const { indices, moved, opaque } = quantise(pixels)
  return [
    {
      id: newId(),
      name,
      source: 'image',
      originX: Math.round(centre.x - width / 2),
      originY: Math.round(centre.y - height / 2),
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
  const isJson =
    file.name.toLowerCase().endsWith('.wplace') ||
    file.name.toLowerCase().endsWith('.json') ||
    file.type === 'application/json'

  let result: ImportedTemplate[]
  if (isJson) {
    const parsed = JSON.parse(await file.text()) as WplaceFile & MarbleFile
    // Tell them apart by shape rather than by extension: both ship as .json, and Marble's export
    // has no version marker to check.
    result =
      parsed.templates !== undefined ? await importMarble(parsed) : await importWplace(parsed)
  } else {
    result = await importImage(file, file.name.replace(/\.[^.]+$/, ''), centre)
  }

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

/** Palette index to RGBA, for painting a preview. */
export const PALETTE_RGBA = WPLACE_PALETTE.map((colour) => colour.rgb)
