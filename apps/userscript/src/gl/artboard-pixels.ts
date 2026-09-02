import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import type { ActiveAllianceSurface } from '../alliance-surface.js'
import {
  type NativePixelRegion,
  type NativePixelSnapshot,
  NO_NATIVE_DRAFT,
} from '../native-pixels.js'
import { buildExactRgbIndex, canvasRgbIndex } from '../rgb-index.js'

export interface ArtboardPixelGeometry {
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
}

const rgbIndex = buildExactRgbIndex(WPLACE_PALETTE)
const isCaelestisCanvas = (canvas: HTMLCanvasElement): boolean =>
  canvas.hasAttribute('data-caelestis-alliance-overlay') ||
  canvas.hasAttribute('data-caelestis-alliance-outline') ||
  canvas.hasAttribute('data-caelestis-alliance-markers')

const palettePixels = (canvas: HTMLCanvasElement, emptyIndex: number): Uint8Array | null => {
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return null
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
    const pixels = new Uint8Array(canvas.width * canvas.height).fill(emptyIndex)
    for (let at = 0; at < pixels.length; at++) {
      const rgbaAt = at * 4
      if ((rgba[rgbaAt + 3] ?? 0) === 0) continue
      pixels[at] = canvasRgbIndex(
        rgbIndex,
        rgba[rgbaAt] ?? 0,
        rgba[rgbaAt + 1] ?? 0,
        rgba[rgbaAt + 2] ?? 0,
        TRANSPARENT_INDEX,
      )
    }
    return pixels
  } catch {
    return null
  }
}

const hqPixels = (
  active: ActiveAllianceSurface,
  geometry: ArtboardPixelGeometry,
): NativePixelRegion[] => {
  const layer = active.frame.querySelector('.hq-tile-layer')
  if (layer === null) return []
  const regions: NativePixelRegion[] = []
  for (const canvas of layer.querySelectorAll('canvas')) {
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width <= 0 || canvas.height <= 0) continue
    const drawnWidth = Number.parseFloat(canvas.style.width)
    const drawnHeight = Number.parseFloat(canvas.style.height)
    const left = Number.parseFloat(canvas.style.left)
    const top = Number.parseFloat(canvas.style.top)
    if (![drawnWidth, drawnHeight, left, top].every(Number.isFinite)) continue
    const scaleX = drawnWidth / canvas.width
    const scaleY = drawnHeight / canvas.height
    if (scaleX <= 0 || scaleY <= 0) continue
    const pixels = palettePixels(canvas, TRANSPARENT_INDEX)
    if (pixels === null) continue
    regions.push({
      x: Math.round(geometry.originX + left / scaleX),
      y: Math.round(geometry.originY + top / scaleY),
      width: canvas.width,
      height: canvas.height,
      pixels,
      emptyIndex: TRANSPARENT_INDEX,
    })
  }
  return regions
}

const assetPixels = (
  active: ActiveAllianceSurface,
  geometry: ArtboardPixelGeometry,
): NativePixelRegion[] => {
  const canvas = Array.from(active.frame.children).find(
    (child): child is HTMLCanvasElement =>
      child instanceof HTMLCanvasElement &&
      !isCaelestisCanvas(child) &&
      child.width === geometry.width &&
      child.height === geometry.height,
  )
  if (canvas === undefined) return []
  const pixels = palettePixels(canvas, TRANSPARENT_INDEX)
  return pixels === null
    ? []
    : [
        {
          x: geometry.originX,
          y: geometry.originY,
          width: canvas.width,
          height: canvas.height,
          pixels,
          emptyIndex: TRANSPARENT_INDEX,
        },
      ]
}

const directNativeCanvases = (active: ActiveAllianceSurface): HTMLCanvasElement[] =>
  Array.from(active.frame.children).filter(
    (child): child is HTMLCanvasElement =>
      child instanceof HTMLCanvasElement && !isCaelestisCanvas(child),
  )

const draftPixels = (
  active: ActiveAllianceSurface,
  geometry: ArtboardPixelGeometry,
): NativePixelRegion[] => {
  const canvases = directNativeCanvases(active)
  const canvas =
    active.surface.kind === 'alliance-headquarters'
      ? canvases[0]
      : canvases.length >= 2
        ? canvases.at(-1)
        : undefined
  if (canvas === undefined || canvas.width !== geometry.width || canvas.height !== geometry.height)
    return []
  const pixels = palettePixels(canvas, NO_NATIVE_DRAFT)
  return pixels === null
    ? []
    : [
        {
          x: geometry.originX,
          y: geometry.originY,
          width: canvas.width,
          height: canvas.height,
          pixels,
          emptyIndex: NO_NATIVE_DRAFT,
        },
      ]
}

/** Read Wplace's committed and draft art canvases without compositing Caelestis or feedback. */
export const readArtboardPixels = (
  active: ActiveAllianceSurface,
  geometry: ArtboardPixelGeometry,
): NativePixelSnapshot => ({
  committed:
    active.surface.kind === 'alliance-headquarters'
      ? hqPixels(active, geometry)
      : assetPixels(active, geometry),
  draft: draftPixels(active, geometry),
})
