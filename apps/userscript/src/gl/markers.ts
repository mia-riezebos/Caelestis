import { sameTemplateSurface, TILE_SIZE, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { count, warn } from '../debug.js'
import { getMap } from '../map-handle.js'
import { overlayPeekFade } from '../overlay-peek.js'
import { isProfileEnabled, measureProfile, profileGpu, recordProfileWorkload } from '../profile.js'
import { getState } from '../state.js'
import { toRgbUnit } from '../templates/appearance.js'
import { colourMarksIn } from '../templates/colour-marker.js'
import {
  displayTemplates,
  isTemplateVisible,
  type PlacedTemplate,
} from '../templates/local-store.js'
import { pixelAccounting } from '../templates/mismatch.js'
import type { MismatchMarks } from '../templates/mismatch-marks.js'
import { horizontalSpans } from '../templates/placement.js'
import {
  currentQuads,
  isDrawingTiles,
  registerDraftCanvas,
  retainDraftCanvases,
  type TileQuad,
} from '../tile-transform.js'
import { isPaintOpen, selectedColour } from '../wplace-paint.js'
import { prefersReducedMotion } from './appearance-transition.js'
import {
  batchMarkerWork,
  beginMarkerBatchFrame,
  endMarkerBatchFrame,
  markerBatchMemoryBytes,
} from './marker-batching.js'
import {
  markerDensityMemoryBytes,
  markerSampleRate,
  markerVisibilityBudget,
  visibleMarkerPoints,
} from './marker-density.js'
import { MarkerRenderer, type MarkerStyle } from './marker-renderer.js'
import { worldRenderScene } from './render-scene.js'

export { deviceScale, MarkerRenderer, type MarkerStyle } from './marker-renderer.js'
export { markerBatchMemoryBytes, markerDensityMemoryBytes }

let worldMarkerRenderer: MarkerRenderer | null = null

export const markerGpuMemoryBytes = (): number => worldMarkerRenderer?.memoryBytes() ?? 0
export const initMarkers = (gl: WebGL2RenderingContext): void => {
  worldMarkerRenderer = new MarkerRenderer(gl)
}
export const releaseMarkers = (gl: WebGL2RenderingContext): void => {
  if (worldMarkerRenderer?.gl !== gl) return
  worldMarkerRenderer.dispose()
  worldMarkerRenderer = null
}

/**
 * Draw one crosshair per marked pixel of one tile.
 *
 * `pixels` packs tile-local x/y/wanted-index into one uint. Placement comes from the tile's own
 * on-screen rect, the same rect the overlay itself is drawn on, so markers inherit whatever
 * MapLibre did to place that tile rather than being projected separately.
 */
export const drawMarkers = (
  gl: WebGL2RenderingContext,
  tile: TileQuad,
  pixels: MismatchMarks,
  style: MarkerStyle,
  fade: number,
  sampleRate = 1,
): void => {
  if (worldMarkerRenderer?.gl !== gl) return
  worldMarkerRenderer.draw(
    {
      x: tile.x,
      y: tile.y,
      width: tile.width,
      height: tile.height,
      pixelWidth: TILE_SIZE,
      pixelHeight: TILE_SIZE,
      seedX: tile.tile.x,
      seedY: tile.tile.y,
    },
    pixels,
    style,
    fade,
    sampleRate,
  )
}

export const MARKER_LAYER_ID = 'caelestis-markers'

/** Their crosshair. It stays on top; the markers go directly below it. */
const CROSSHAIR_LAYER = 'pixel-hover'

/** A tile being painted gets its own layer, named for the tile. */
const DRAFT_LAYER = /^paint-preview-/

interface Ordered {
  /** MapLibre's own draw order. Custom layers are in it; `getStyle` leaves them out. */
  style?: { _order?: string[] }
  getLayer?: (id: string) => unknown
  getSource?: (id: string) => { getCanvas?: () => HTMLCanvasElement } | undefined
  moveLayer?: (id: string, before?: string) => void
}

/** Their id ends with the tile: `paint-preview-0.9268…-325,1783`. */
const DRAFT_TILE = /-(\d+),(\d+)$/

/**
 * Keep the markers above wplace's draft layers.
 *
 * They add one per tile being painted, inserted wherever MapLibre puts it, which lands above a layer
 * of ours added earlier — so the pixel just placed covers the marker it was meant to clear, and the
 * only way to see the marker go is to zoom out until the placed pixel is too small to hide it.
 *
 * Checked from the frame hook rather than from `styledata`. Moving a layer *fires* `styledata`, so
 * listening to it to decide whether to move is a loop that provokes itself — and if wplace re-insert
 * a draft above ours, the two take turns for as long as the tab lasts. A poll cannot do that, and
 * reading `_order` is an array scan. Register canvases on every frame so the first native writes
 * become available immediately, including when Paint closes and reopens between frames.
 */
export const keepMarkersAboveDrafts = (): void => {
  const map = getMap() as Ordered | null
  const order = map?.style?._order
  if (map === null || order === undefined) {
    count('paint:no layer order to read')
    return
  }
  count('paint:checked the layer order')

  const markers = order.indexOf(MARKER_LAYER_ID)
  let lastDraft = -1
  const canvases = new Set<object>()
  for (let i = 0; i < order.length; i++) {
    const id = order[i] as string
    if (!DRAFT_LAYER.test(id)) continue
    lastDraft = i
    /**
     * Tell the pixel capture which tile this canvas is, while we are already looking at the style.
     *
     * wplace name the layer and its image source for the tile, and the source hands back the canvas
     * a placed-but-unsubmitted pixel is drawn into. Working it out from where the texture landed
     * instead does not work: those quads measure 0.125x and 0.063x of a tile, so they are not draft
     * layers at all, and the writes went to whichever tile the geometry matched — every patched
     * pixel came out "became wrong" and none came out "fixed".
     */
    count('paint:saw a draft layer')
    const match = DRAFT_TILE.exec(id)
    if (match === null) {
      count('paint:draft layer id had no tile in it')
      continue
    }
    const canvas = map.getSource?.(id)?.getCanvas?.()
    if (canvas === undefined) {
      count('paint:draft source gave no canvas')
      continue
    }
    canvases.add(canvas)
    registerDraftCanvas(canvas, { x: Number(match[1]), y: Number(match[2]) })
  }
  retainDraftCanvases(canvases)
  if (markers < 0 || lastDraft < 0 || markers > lastDraft) return

  const crosshair = map.getLayer?.(CROSSHAIR_LAYER) === undefined ? undefined : CROSSHAIR_LAYER
  map.moveLayer?.(MARKER_LAYER_ID, crosshair)
  count('marker:moved above the draft layers')
}

/**
 * The soonest a deferred scan may ask for another frame.
 *
 * Asking from inside a render callback is asking for the next frame from the frame you are in, so a
 * tile that can never be answered — because its pixels were never captured, say — turns into a
 * render loop at full rate that looks exactly like a hang. This makes the retry a heartbeat instead.
 */
const RETRY_MS = 250
let nextRetry = 0

/** Every marked pixel of every template that asks for it, over every tile on screen. */
const drawVisible = (
  gl: WebGL2RenderingContext,
  peek: { readonly opacity: number; readonly done: boolean },
): void => {
  if (!isDrawingTiles()) return
  const tiles = currentQuads()
  if (tiles.length === 0) return
  /**
   * Everything whose markers are still worth anything, which is not the same as everything that
   * asked for them.
   *
   * Switching markers off used to remove the template from this list, and every crosshair on it
   * vanished between two frames. On dense artwork that is indistinguishable from the overlay
   * breaking: a few thousand marks disappear at once and nothing says whether they were fixed,
   * filtered, or lost. So the switch is a destination — the marks keep being drawn at falling
   * opacity until the ramp runs out, and only then does the template drop off this list.
   */
  const now = performance.now()
  const selected = isPaintOpen() ? (selectedColour() ?? -1) : -1
  const sceneTemplates = worldRenderScene.advanceTemplates(
    displayTemplates().filter((candidate) =>
      sameTemplateSurface(candidate.surface ?? WORLD_TEMPLATE_SURFACE, WORLD_TEMPLATE_SURFACE),
    ),
    WORLD_TEMPLATE_SURFACE,
    now,
    prefersReducedMotion(),
  )
  const sceneMarkers = worldRenderScene.advanceMarkers(
    sceneTemplates.templates,
    selected >= 0 ? selected : null,
    now,
  )
  const animating = sceneTemplates.animating || sceneMarkers.animating || !peek.done
  const wanted: {
    template: PlacedTemplate
    appearance: (typeof sceneTemplates.templates)[number]['appearance']
    mismatchFade: number
    selectedFades: readonly { index: number; fade: number }[]
  }[] = []
  const progressOnly: PlacedTemplate[] = []
  for (const { rendered, mismatchFade, selectedFades } of sceneMarkers.templates) {
    const { template, appearance } = rendered
    const hasSelectedFade = selectedFades.some(({ fade }) => fade > 0)
    if (
      template.serverUrl === undefined &&
      isTemplateVisible(template) &&
      mismatchFade === 0 &&
      !hasSelectedFade
    )
      progressOnly.push(template)
    if (mismatchFade > 0 || hasSelectedFade) {
      wanted.push({ template, appearance, mismatchFade, selectedFades })
    }
  }
  if (animating) {
    const map = getMap() as { triggerRepaint?: () => void } | null
    map?.triggerRepaint?.()
  }
  if (wanted.length > 0) count('marker:layer rendered')
  // Only the tiles a template covers. Asking about a tile is not free — one whose pixels have not
  // been captured triggers a fetch and a 1000x1000 `getImageData`.
  const covers = (template: PlacedTemplate, tile: TileQuad): boolean => {
    const left = tile.tile.x * TILE_SIZE
    const top = tile.tile.y * TILE_SIZE
    if (
      !horizontalSpans(template).some(
        (span) => span.worldStart < left + TILE_SIZE && span.worldEnd > left,
      )
    )
      return false
    if (template.originY >= top + TILE_SIZE || template.originY + template.height <= top)
      return false
    return true
  }

  type Work = {
    tile: TileQuad
    marks: MismatchMarks
    style: MarkerStyle
    fade: number
  }
  const selectedWork: Work[] = []
  const mismatchWork: Work[] = []
  let deferred = false
  for (const template of progressOnly) {
    const accounting = pixelAccounting.read(template)
    for (const tile of tiles) {
      if (covers(template, tile) && !accounting.ensure(tile.tile)) deferred = true
    }
  }
  const { markerBudget, onlySelectedColour } = getState()
  const moving = (getMap() as { isMoving?: () => boolean } | null)?.isMoving?.() === true
  const renderBudget = markerBudget
  const profiling = isProfileEnabled()
  const mismatchSelection = onlySelectedColour && isPaintOpen() ? selected : -1
  for (const { template, appearance, mismatchFade, selectedFades } of wanted) {
    const accounting = pixelAccounting.read(template)
    const mismatchStyle: MarkerStyle = {
      size: appearance.markerSize,
      thickness: 2,
      colour: toRgbUnit(appearance.markerColour),
      // One switch above both: off means every marker is drawn the same, and the fade and the second
      // colour keep their values for whenever it goes back on.
      otherColour:
        !appearance.dimOthers || appearance.otherColour === null
          ? null
          : toRgbUnit(appearance.otherColour),
      otherOpacity: appearance.dimOthers ? appearance.otherOpacity : 1,
      selected: mismatchSelection,
    }
    const selectedStyle: MarkerStyle = {
      size: appearance.selectedMarkerSize,
      thickness: 2,
      colour: toRgbUnit(appearance.selectedMarkerColour),
      otherColour: null,
      otherOpacity: 1,
      selected: -1,
    }
    for (const tile of tiles) {
      if (!covers(template, tile)) continue
      if (selectedFades.length > 0) {
        const unpainted = accounting.unpainted(tile.tile)
        if (unpainted === null) deferred = true
        else {
          for (const selectedFade of selectedFades) {
            if (selectedFade.fade <= 0) continue
            const marks = colourMarksIn(unpainted, selectedFade.index)
            if (marks.length > 0) {
              selectedWork.push({
                tile,
                marks,
                style: selectedStyle,
                fade: selectedFade.fade * peek.opacity,
              })
            }
          }
        }
      }
      if (mismatchFade > 0) {
        const tileAccounting = accounting.tile(tile.tile)
        if (tileAccounting === null) deferred = true
        else if (tileAccounting.markers.length > 0) {
          mismatchWork.push({
            tile,
            marks: tileAccounting.markers,
            style: mismatchStyle,
            fade: mismatchFade * peek.opacity,
          })
        }
      }
    }
  }
  const points = (work: readonly { readonly marks: { readonly length: number } }[]): number =>
    work.reduce((total, one) => total + one.marks.length, 0)
  const visibilityBudget = markerVisibilityBudget()
  const estimatedVisiblePoints = (work: readonly Work[]): number =>
    work.reduce(
      (total, one) =>
        total +
        visibleMarkerPoints(
          one.marks,
          one.tile,
          gl.drawingBufferWidth,
          gl.drawingBufferHeight,
          visibilityBudget,
        ),
      0,
    )
  const selectedSourcePoints = points(selectedWork)
  const mismatchSourcePoints = points(mismatchWork)
  const selectedSampleRate = markerSampleRate(estimatedVisiblePoints(selectedWork), renderBudget)
  const mismatchSampleRate = markerSampleRate(estimatedVisiblePoints(mismatchWork), renderBudget)
  const expectedSelectedPoints = Math.round(selectedSourcePoints * selectedSampleRate)
  const expectedMismatchPoints = Math.round(mismatchSourcePoints * mismatchSampleRate)
  const reportWorkload = (drawBatches: number, drawnPoints: number): void => {
    if (!profiling) return
    const sourcePoints = selectedSourcePoints + mismatchSourcePoints
    const expectedPoints = expectedSelectedPoints + expectedMismatchPoints
    recordProfileWorkload('Marker eligible templates', wanted.length)
    recordProfileWorkload('Marker host tiles', tiles.length)
    recordProfileWorkload('Marker effective budget', renderBudget)
    recordProfileWorkload('Marker moving', moving ? 1 : 0)
    recordProfileWorkload('Marker source batches', selectedWork.length + mismatchWork.length)
    recordProfileWorkload('Marker source points', sourcePoints)
    recordProfileWorkload('Marker retained batches', selectedWork.length + mismatchWork.length)
    recordProfileWorkload('Marker retained points', expectedPoints)
    recordProfileWorkload('Marker submitted points', sourcePoints)
    recordProfileWorkload('Marker draw batches', drawBatches)
    recordProfileWorkload('Marker drawn points', drawnPoints)
    if (moving) {
      recordProfileWorkload('Marker moving effective budget', renderBudget)
      recordProfileWorkload('Marker moving retained points', expectedPoints)
      recordProfileWorkload('Marker moving draw batches', drawBatches)
      recordProfileWorkload('Marker moving drawn points', drawnPoints)
    }
  }
  count('marker:selected-colour tiles with marks', selectedWork.length)
  count('marker:mismatch tiles with marks', mismatchWork.length)

  if (selectedWork.length === 0 && mismatchWork.length === 0) {
    reportWorkload(0, 0)
    if (deferred && now >= nextRetry) {
      nextRetry = now + RETRY_MS
      const map = getMap() as { triggerRepaint?: () => void } | null
      map?.triggerRepaint?.()
      count('marker:asked for another frame')
    }
    return
  }

  // MapLibre resets custom-layer defaults before calling us and invalidates its state cache after.
  // Synchronous state reads here would merely move the overlay's drag-time GPU stall to this layer.
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.disable(gl.DEPTH_TEST)

  // The selected colour is a guide; a real mismatch is the error signal and wins where they meet.
  const selectedDraws = batchMarkerWork(selectedWork)
  const mismatchDraws = batchMarkerWork(mismatchWork)
  const drawBatches = selectedDraws.length + mismatchDraws.length
  const drawnPoints = profiling ? expectedSelectedPoints + expectedMismatchPoints : 0
  reportWorkload(drawBatches, drawnPoints)
  count('marker:draw batches before batching', selectedWork.length + mismatchWork.length)
  count('marker:draw batches after batching', drawBatches)
  for (const one of selectedDraws)
    drawMarkers(gl, one.tile, one.marks, one.style, one.fade, selectedSampleRate)
  for (const one of mismatchDraws)
    drawMarkers(gl, one.tile, one.marks, one.style, one.fade, mismatchSampleRate)

  if (deferred && now >= nextRetry) {
    nextRetry = now + RETRY_MS
    const map = getMap() as { triggerRepaint?: () => void } | null
    map?.triggerRepaint?.()
    count('marker:asked for another frame')
  }
}

const drawAll = (
  gl: WebGL2RenderingContext,
  peek: { readonly opacity: number; readonly done: boolean },
): void => {
  worldMarkerRenderer?.beginFrame()
  beginMarkerBatchFrame()
  try {
    pixelAccounting.frame(() => drawVisible(gl, peek))
  } finally {
    endMarkerBatchFrame()
    worldMarkerRenderer?.endFrame()
  }
}

/**
 * The markers, in a layer of their own.
 *
 * The overlay belongs *under* a pixel waiting to be placed — that is what makes placing one look
 * like it covers the template. A marker is the opposite: an annotation about a pixel, which cannot
 * sit beneath the pixel it describes. One layer could not be both.
 */
export const markerLayer = {
  id: MARKER_LAYER_ID,
  type: 'custom' as const,
  renderingMode: '2d' as const,

  onAdd(_map: unknown, gl: WebGL2RenderingContext): void {
    initMarkers(gl)
    count('marker:layer added')
  },

  onRemove(_map: unknown, gl: WebGL2RenderingContext): void {
    releaseMarkers(gl)
    worldRenderScene.resetMarkers()
  },

  render(gl: WebGL2RenderingContext): void {
    const peek = overlayPeekFade(performance.now())
    // Peek is display suppression, not cache invalidation. Once the fade reaches zero, stop before
    // `drawAll` so its normal unused-buffer sweep keeps every retained marker buffer warm.
    if (peek.opacity <= 0 && peek.done) return
    // Never let this escape into MapLibre's render loop; a throw here takes the whole frame with it.
    try {
      profileGpu(gl, 'Marker GPU', () => measureProfile('Marker render', () => drawAll(gl, peek)))
    } catch (error) {
      warn('install', 'marker layer render failed; skipping this frame', String(error))
    }
  },
}
