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
import {
  headquartersPixels,
  onHeadquartersPixelsChange,
  refreshHeadquartersPixels,
  resetHeadquartersPixelCache,
} from './headquarters-pixels.js'

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
const CROSSHAIR_CELL_PIXELS = 10
interface CachedCrosshairPixels {
  readonly width: number
  readonly height: number
  readonly logicalWidth: number
  readonly pixels: Uint8Array
}

const crosshairPixels = new WeakMap<HTMLCanvasElement, CachedCrosshairPixels>()
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

const writeCrosshairPixels = (
  target: CachedCrosshairPixels,
  image: ImageData,
  logicalX: number,
  logicalY: number,
): void => {
  const logicalWidth = image.width / CROSSHAIR_CELL_PIXELS
  const logicalHeight = image.height / CROSSHAIR_CELL_PIXELS
  for (let y = 0; y < logicalHeight; y++) {
    for (let x = 0; x < logicalWidth; x++) {
      const imageX = x * CROSSHAIR_CELL_PIXELS
      const imageY = y * CROSSHAIR_CELL_PIXELS
      target.pixels[(logicalY + y) * target.logicalWidth + logicalX + x] =
        (image.data[(imageY * image.width + imageX) * 4 + 3] ?? 0) === 0 ? 0 : 1
    }
  }
}

const crosshairPresence = (canvas: HTMLCanvasElement): Uint8Array | null => {
  const held = crosshairPixels.get(canvas)
  if (held !== undefined && held.width === canvas.width && held.height === canvas.height)
    return held.pixels
  if (
    canvas.width <= 0 ||
    canvas.height <= 0 ||
    canvas.width % CROSSHAIR_CELL_PIXELS !== 0 ||
    canvas.height % CROSSHAIR_CELL_PIXELS !== 0
  )
    return null
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return null
    const cached: CachedCrosshairPixels = {
      width: canvas.width,
      height: canvas.height,
      logicalWidth: canvas.width / CROSSHAIR_CELL_PIXELS,
      pixels: new Uint8Array(
        (canvas.width / CROSSHAIR_CELL_PIXELS) * (canvas.height / CROSSHAIR_CELL_PIXELS),
      ),
    }
    writeCrosshairPixels(cached, context.getImageData(0, 0, canvas.width, canvas.height), 0, 0)
    crosshairPixels.set(canvas, cached)
    return cached.pixels
  } catch {
    return null
  }
}

const patchCrosshairPixels = (canvas: HTMLCanvasElement, dirty: CanvasWriteRect | null): void => {
  const held = crosshairPixels.get(canvas)
  if (held === undefined) return
  if (held.width !== canvas.width || held.height !== canvas.height || dirty === null) {
    crosshairPixels.delete(canvas)
    return
  }
  const logicalX = Math.max(
    0,
    Math.floor(Math.min(dirty.x, dirty.x + dirty.width) / CROSSHAIR_CELL_PIXELS),
  )
  const logicalY = Math.max(
    0,
    Math.floor(Math.min(dirty.y, dirty.y + dirty.height) / CROSSHAIR_CELL_PIXELS),
  )
  const farX = Math.min(
    held.logicalWidth,
    Math.ceil(Math.max(dirty.x, dirty.x + dirty.width) / CROSSHAIR_CELL_PIXELS),
  )
  const logicalHeight = held.height / CROSSHAIR_CELL_PIXELS
  const farY = Math.min(
    logicalHeight,
    Math.ceil(Math.max(dirty.y, dirty.y + dirty.height) / CROSSHAIR_CELL_PIXELS),
  )
  if (farX <= logicalX || farY <= logicalY) return
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return
    writeCrosshairPixels(
      held,
      context.getImageData(
        logicalX * CROSSHAIR_CELL_PIXELS,
        logicalY * CROSSHAIR_CELL_PIXELS,
        (farX - logicalX) * CROSSHAIR_CELL_PIXELS,
        (farY - logicalY) * CROSSHAIR_CELL_PIXELS,
      ),
      logicalX,
      logicalY,
    )
  } catch {
    crosshairPixels.delete(canvas)
  }
}

/** Patch a retained native canvas snapshot after Wplace changes a bounded rectangle. */
export const patchArtboardPixels = (
  active: ActiveAllianceSurface,
  geometry: ArtboardPixelGeometry,
  canvas: HTMLCanvasElement,
  dirty: CanvasWriteRect | null,
): void => {
  if (canvas.classList.contains('paint-crosshair-tile')) {
    patchCrosshairPixels(canvas, dirty)
    return
  }
  const syncHeadquartersPixels = (): void => {
    if (
      active.surface.kind === 'alliance-headquarters' &&
      canvas.parentElement?.classList.contains('hq-tile-layer') === true
    )
      headquartersPixels(active.surface.allianceId, geometry, hqPixels(active, geometry), true)
  }
  const held = canvasPixels.get(canvas)
  if (held === undefined) {
    syncHeadquartersPixels()
    return
  }
  if (held.width !== canvas.width || held.height !== canvas.height || dirty === null) {
    canvasPixels.delete(canvas)
    syncHeadquartersPixels()
    return
  }
  const x = Math.max(0, Math.floor(Math.min(dirty.x, dirty.x + dirty.width)))
  const y = Math.max(0, Math.floor(Math.min(dirty.y, dirty.y + dirty.height)))
  const farX = Math.min(canvas.width, Math.ceil(Math.max(dirty.x, dirty.x + dirty.width)))
  const farY = Math.min(canvas.height, Math.ceil(Math.max(dirty.y, dirty.y + dirty.height)))
  if (farX <= x || farY <= y) {
    syncHeadquartersPixels()
    return
  }
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) {
      syncHeadquartersPixels()
      return
    }
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
  syncHeadquartersPixels()
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

interface CrosshairLayout extends NativePixelRect {
  readonly cellWidth: number
  readonly cellHeight: number
}

/** Wplace keeps drafted-pixel presence outside the transparent draft canvas. */
export const isArtboardCrosshairCanvas = (
  active: ActiveAllianceSurface,
  canvas: HTMLCanvasElement,
): boolean =>
  active.stage.contains(canvas) &&
  canvas.classList.contains('paint-crosshair-tile') &&
  canvas.parentElement?.classList.contains('paint-crosshair-layer') === true

const crosshairLayout = (
  active: ActiveAllianceSurface,
  geometry: ArtboardPixelGeometry,
  canvas: HTMLCanvasElement,
): CrosshairLayout | null => {
  if (!isArtboardCrosshairCanvas(active, canvas)) return null
  const left = Number.parseFloat(canvas.style.left)
  const top = Number.parseFloat(canvas.style.top)
  const drawnWidth = Number.parseFloat(canvas.style.width)
  const drawnHeight = Number.parseFloat(canvas.style.height)
  const width = canvas.width / CROSSHAIR_CELL_PIXELS
  const height = canvas.height / CROSSHAIR_CELL_PIXELS
  if (
    ![left, top, drawnWidth, drawnHeight, width, height].every(Number.isFinite) ||
    drawnWidth <= 0 ||
    drawnHeight <= 0 ||
    width <= 0 ||
    height <= 0 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  )
    return null
  const scaleX = drawnWidth / width
  const scaleY = drawnHeight / height
  return {
    x: geometry.originX + Math.round(left / scaleX),
    y: geometry.originY + Math.round(top / scaleY),
    width,
    height,
    cellWidth: canvas.width / width,
    cellHeight: canvas.height / height,
  }
}

const crosshairDraftRegions = (
  active: ActiveAllianceSurface,
  geometry: ArtboardPixelGeometry,
  draft: NativePixelRegion,
): NativePixelRegion[] => {
  const regions: NativePixelRegion[] = []
  for (const canvas of active.stage.querySelectorAll('canvas.paint-crosshair-tile')) {
    if (!(canvas instanceof HTMLCanvasElement)) continue
    const layout = crosshairLayout(active, geometry, canvas)
    if (layout === null) continue
    const present = crosshairPresence(canvas)
    if (present === null) continue
    const pixels = new Uint8Array(present.length).fill(NO_NATIVE_DRAFT)
    let count = 0
    for (let y = 0; y < layout.height; y++) {
      for (let x = 0; x < layout.width; x++) {
        const at = y * layout.width + x
        if (present[at] !== 1) continue
        const draftX = layout.x + x - draft.x
        const draftY = layout.y + y - draft.y
        const draftAt = draftY * draft.width + draftX
        pixels[at] =
          draftX < 0 || draftY < 0 || draftX >= draft.width || draftY >= draft.height
            ? NO_NATIVE_DRAFT
            : (draft.pixels[draftAt] ?? NO_NATIVE_DRAFT)
        count++
      }
    }
    if (count > 0)
      regions.push({
        x: layout.x,
        y: layout.y,
        width: layout.width,
        height: layout.height,
        pixels,
        present,
        emptyIndex: NO_NATIVE_DRAFT,
      })
  }
  return regions
}

/** Map one native canvas write into logical artboard pixels for retained marker accounting. */
export const artboardCanvasWriteRect = (
  active: ActiveAllianceSurface,
  geometry: ArtboardPixelGeometry,
  canvas: HTMLCanvasElement,
  dirty: CanvasWriteRect | null,
): NativePixelRect | null => {
  if (isCaelestisCanvas(canvas)) return null
  const crosshair = crosshairLayout(active, geometry, canvas)
  if (crosshair !== null) {
    if (dirty === null)
      return {
        x: crosshair.x,
        y: crosshair.y,
        width: crosshair.width,
        height: crosshair.height,
      }
    const localX = Math.max(
      0,
      Math.floor(Math.min(dirty.x, dirty.x + dirty.width) / crosshair.cellWidth),
    )
    const localY = Math.max(
      0,
      Math.floor(Math.min(dirty.y, dirty.y + dirty.height) / crosshair.cellHeight),
    )
    const farX = Math.min(
      crosshair.width,
      Math.ceil(Math.max(dirty.x, dirty.x + dirty.width) / crosshair.cellWidth),
    )
    const farY = Math.min(
      crosshair.height,
      Math.ceil(Math.max(dirty.y, dirty.y + dirty.height) / crosshair.cellHeight),
    )
    return farX <= localX || farY <= localY
      ? null
      : {
          x: crosshair.x + localX,
          y: crosshair.y + localY,
          width: farX - localX,
          height: farY - localY,
        }
  }
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
  if (pixels === null) return []
  const draft = {
    x: geometry.originX,
    y: geometry.originY,
    width: canvas.width,
    height: canvas.height,
    pixels,
    emptyIndex: NO_NATIVE_DRAFT,
  } satisfies NativePixelRegion
  return [draft, ...crosshairDraftRegions(active, geometry, draft)]
}

/** Notify progress, marker, and palette consumers when the complete HQ snapshot changes. */
export const onArtboardPixelsChange = onHeadquartersPixelsChange

/** Load or update the complete bounded native canvas for the active alliance surface. */
export const refreshArtboardPixels = (
  active: ActiveAllianceSurface,
  geometry: ArtboardPixelGeometry,
): Promise<void> => {
  if (active.surface.kind !== 'alliance-headquarters') return Promise.resolve()
  return refreshHeadquartersPixels(active.surface.allianceId, geometry)
}

/** Test-only reset for the retained bounded snapshot. */
export const resetArtboardPixelCache = resetHeadquartersPixelCache

/** Read Wplace's committed and draft art canvases without compositing Caelestis or feedback. */
export const readArtboardPixels = (
  active: ActiveAllianceSurface,
  geometry: ArtboardPixelGeometry,
): NativePixelSnapshot => {
  const visible =
    active.surface.kind === 'alliance-headquarters'
      ? hqPixels(active, geometry)
      : assetPixels(active, geometry)
  const committed =
    active.surface.kind === 'alliance-headquarters'
      ? (headquartersPixels(active.surface.allianceId, geometry, visible) ?? visible)
      : visible
  return {
    committed,
    draft: draftPixels(active, geometry),
  }
}
