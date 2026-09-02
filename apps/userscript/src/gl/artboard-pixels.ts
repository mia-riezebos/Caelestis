import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import type { ActiveAllianceSurface } from '../alliance-surface.js'
import type { CanvasWriteRect } from '../canvas-write.js'
import {
  type NativePixelRect,
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
interface CachedCanvasPixels {
  readonly width: number
  readonly height: number
  readonly emptyIndex: number
  readonly pixels: Uint8Array
}

const canvasPixels = new WeakMap<HTMLCanvasElement, CachedCanvasPixels>()
const isCaelestisCanvas = (canvas: HTMLCanvasElement): boolean =>
  canvas.hasAttribute('data-caelestis-alliance-overlay') ||
  canvas.hasAttribute('data-caelestis-alliance-outline') ||
  canvas.hasAttribute('data-caelestis-alliance-markers')

const writePalettePixels = (
  target: Uint8Array,
  targetWidth: number,
  image: ImageData,
  targetX: number,
  targetY: number,
  emptyIndex: number,
): void => {
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const imageAt = (y * image.width + x) * 4
      const targetAt = (targetY + y) * targetWidth + targetX + x
      if ((image.data[imageAt + 3] ?? 0) === 0) {
        target[targetAt] = emptyIndex
        continue
      }
      target[targetAt] = canvasRgbIndex(
        rgbIndex,
        image.data[imageAt] ?? 0,
        image.data[imageAt + 1] ?? 0,
        image.data[imageAt + 2] ?? 0,
        TRANSPARENT_INDEX,
      )
    }
  }
}

const palettePixels = (canvas: HTMLCanvasElement, emptyIndex: number): Uint8Array | null => {
  const held = canvasPixels.get(canvas)
  if (
    held !== undefined &&
    held.width === canvas.width &&
    held.height === canvas.height &&
    held.emptyIndex === emptyIndex
  )
    return held.pixels
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return null
    const pixels = new Uint8Array(canvas.width * canvas.height).fill(emptyIndex)
    writePalettePixels(
      pixels,
      canvas.width,
      context.getImageData(0, 0, canvas.width, canvas.height),
      0,
      0,
      emptyIndex,
    )
    canvasPixels.set(canvas, { width: canvas.width, height: canvas.height, emptyIndex, pixels })
    return pixels
  } catch {
    return null
  }
}

/** Patch a retained native canvas snapshot after Wplace changes a bounded rectangle. */
export const patchArtboardPixels = (
  canvas: HTMLCanvasElement,
  dirty: CanvasWriteRect | null,
): void => {
  const held = canvasPixels.get(canvas)
  if (held === undefined) return
  if (held.width !== canvas.width || held.height !== canvas.height || dirty === null) {
    canvasPixels.delete(canvas)
    return
  }
  const x = Math.max(0, Math.floor(Math.min(dirty.x, dirty.x + dirty.width)))
  const y = Math.max(0, Math.floor(Math.min(dirty.y, dirty.y + dirty.height)))
  const farX = Math.min(canvas.width, Math.ceil(Math.max(dirty.x, dirty.x + dirty.width)))
  const farY = Math.min(canvas.height, Math.ceil(Math.max(dirty.y, dirty.y + dirty.height)))
  if (farX <= x || farY <= y) return
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return
    writePalettePixels(
      held.pixels,
      held.width,
      context.getImageData(x, y, farX - x, farY - y),
      x,
      y,
      held.emptyIndex,
    )
  } catch {
    canvasPixels.delete(canvas)
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

/** Map one native canvas write into logical artboard pixels for retained marker accounting. */
export const artboardCanvasWriteRect = (
  active: ActiveAllianceSurface,
  geometry: ArtboardPixelGeometry,
  canvas: HTMLCanvasElement,
  dirty: CanvasWriteRect | null,
): NativePixelRect | null => {
  if (isCaelestisCanvas(canvas)) return null
  let x = geometry.originX
  let y = geometry.originY
  if (canvas.parentElement?.classList.contains('hq-tile-layer')) {
    const drawnWidth = Number.parseFloat(canvas.style.width)
    const drawnHeight = Number.parseFloat(canvas.style.height)
    const left = Number.parseFloat(canvas.style.left)
    const top = Number.parseFloat(canvas.style.top)
    if (![drawnWidth, drawnHeight, left, top].every(Number.isFinite)) return null
    const scaleX = drawnWidth / canvas.width
    const scaleY = drawnHeight / canvas.height
    if (scaleX <= 0 || scaleY <= 0) return null
    x += Math.round(left / scaleX)
    y += Math.round(top / scaleY)
  } else if (!active.frame.contains(canvas)) return null

  if (dirty === null) return { x, y, width: canvas.width, height: canvas.height }
  const localX = Math.max(0, Math.floor(Math.min(dirty.x, dirty.x + dirty.width)))
  const localY = Math.max(0, Math.floor(Math.min(dirty.y, dirty.y + dirty.height)))
  const farX = Math.min(canvas.width, Math.ceil(Math.max(dirty.x, dirty.x + dirty.width)))
  const farY = Math.min(canvas.height, Math.ceil(Math.max(dirty.y, dirty.y + dirty.height)))
  return farX <= localX || farY <= localY
    ? null
    : { x: x + localX, y: y + localY, width: farX - localX, height: farY - localY }
}

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
