import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import type { ActiveAllianceSurface } from '../alliance-surface.js'
import { buildExactRgbIndex, canvasRgbIndex } from '../rgb-index.js'

export interface ArtboardPixelGeometry {
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
}

export interface ArtboardPixelRegion {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
}

const rgbIndex = buildExactRgbIndex(WPLACE_PALETTE)
const isCaelestisCanvas = (canvas: HTMLCanvasElement): boolean =>
  canvas.hasAttribute('data-caelestis-alliance-overlay') ||
  canvas.hasAttribute('data-caelestis-alliance-outline')

const palettePixels = (canvas: HTMLCanvasElement): Uint8Array | null => {
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return null
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
    const pixels = new Uint8Array(canvas.width * canvas.height).fill(TRANSPARENT_INDEX)
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
): ArtboardPixelRegion[] => {
  const layer = active.frame.querySelector('.hq-tile-layer')
  if (layer === null) return []
  const regions: ArtboardPixelRegion[] = []
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
    const pixels = palettePixels(canvas)
    if (pixels === null) continue
    regions.push({
      x: Math.round(geometry.originX + left / scaleX),
      y: Math.round(geometry.originY + top / scaleY),
      width: canvas.width,
      height: canvas.height,
      pixels,
    })
  }
  return regions
}

const assetPixels = (
  active: ActiveAllianceSurface,
  geometry: ArtboardPixelGeometry,
): ArtboardPixelRegion[] => {
  const canvas = Array.from(active.frame.children).find(
    (child): child is HTMLCanvasElement =>
      child instanceof HTMLCanvasElement &&
      !isCaelestisCanvas(child) &&
      child.width === geometry.width &&
      child.height === geometry.height,
  )
  if (canvas === undefined) return []
  const pixels = palettePixels(canvas)
  return pixels === null
    ? []
    : [
        {
          x: geometry.originX,
          y: geometry.originY,
          width: canvas.width,
          height: canvas.height,
          pixels,
        },
      ]
}

/** Read Wplace's uncomposited art canvases as palette indices. Caelestis and feedback stay out. */
export const readArtboardPixels = (
  active: ActiveAllianceSurface,
  geometry: ArtboardPixelGeometry,
): ArtboardPixelRegion[] =>
  active.surface.kind === 'alliance-headquarters'
    ? hqPixels(active, geometry)
    : assetPixels(active, geometry)

export const artboardPixelIndexAt = (
  regions: readonly ArtboardPixelRegion[],
  x: number,
  y: number,
): number | null => {
  const column = Math.floor(x)
  const row = Math.floor(y)
  for (const region of regions) {
    const localX = column - region.x
    const localY = row - region.y
    if (localX < 0 || localY < 0 || localX >= region.width || localY >= region.height) continue
    return region.pixels[localY * region.width + localX] ?? null
  }
  return TRANSPARENT_INDEX
}
