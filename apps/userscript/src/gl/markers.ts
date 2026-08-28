import { TILE_SIZE } from '@caelestis/shared'
import { count, warn } from '../debug.js'
import { getMap } from '../map-handle.js'
import { isOverlayPeekActive } from '../overlay-peek.js'
import { isProfileEnabled, measureProfile, profileGpu, recordProfileWorkload } from '../profile.js'
import { getState } from '../state.js'
import { isColourHidden, toRgbUnit } from '../templates/appearance.js'
import { colourMarksIn } from '../templates/colour-marker.js'
import {
  appearanceOf,
  displayTemplates,
  isTemplateVisible,
  type PlacedTemplate,
} from '../templates/local-store.js'
import {
  beginMismatchFrame,
  disagreementsIn,
  endMismatchFrame,
  mismatchesIn,
  progressIn,
} from '../templates/mismatch.js'
import type { MismatchMarks } from '../templates/mismatch-marks.js'
import { horizontalSpans } from '../templates/placement.js'
import {
  currentQuads,
  isDrawingTiles,
  registerDraftCanvas,
  type TileQuad,
} from '../tile-transform.js'
import { isPaintOpen, selectedColour } from '../wplace-paint.js'
import { markerFades, templateFades } from './fade.js'
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

export { markerBatchMemoryBytes, markerDensityMemoryBytes }

/**
 * Mismatch markers, drawn one point per marked pixel.
 *
 * The first version asked this question in the fragment shader: for every fragment, walk outwards
 * looking for a marked cell whose arms reach it. That is O(fragments on screen) with a texture fetch
 * per step, and a marker sized in device pixels means the walk gets *longer* the further out you
 * zoom. It killed the GPU — not the tab, the whole compositor.
 *
 * The shape of the problem is the fix. There are a handful of mismatched pixels and millions of
 * fragments, so the work belongs where the handful is: find them once on the CPU, per tile, and draw
 * one point each. Cost becomes O(mismatches), which is what it always should have been.
 *
 * Points rather than quads because `gl_PointSize` is specified in device pixels, which is exactly
 * the property being asked for — a marker the same size at every zoom — with no per-instance
 * geometry to build and no matrix to get wrong.
 */

const VERTEX = `#version 300 es
precision highp int;
/** Tile-local x, y and wanted palette index packed into one uint. */
in uint a_mark;

/** Where this tile landed on screen this frame. */
uniform vec2 u_tileScreen;
/** Device pixels per canvas pixel, from the tile's own on-screen size. */
uniform vec2 u_tileScale;
uniform vec2 u_buffer;
uniform float u_size;
uniform float u_sampleRate;
uniform uint u_sampleSeed;

flat out float v_wanted;

uint markerHash(uint value) {
  value = (value ^ (value >> 16u)) * 0x7feb352du;
  value = (value ^ (value >> 15u)) * 0x846ca68bu;
  return value ^ (value >> 16u);
}

void main() {
  v_wanted = float(a_mark >> 20u);
  if (u_sampleRate < 1.0) {
    // Hash uint ordinals before converting to float. Converting a large vertex ID first collapses
    // the fractional bins and badly exceeds low budgets on million-point buffers.
    float random = float(markerHash(uint(gl_VertexID) ^ u_sampleSeed) >> 8u) / 16777216.0;
    if (random >= u_sampleRate) {
      gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
  }
  vec2 pixel = vec2(float(a_mark & 1023u), float((a_mark >> 10u) & 1023u));
  // The centre of the pixel, not its corner, so the crosshair sits on the thing it marks.
  vec2 device = u_tileScreen + (pixel + 0.5) * u_tileScale;
  gl_Position = vec4((2.0 * device.x) / u_buffer.x - 1.0, 1.0 - (2.0 * device.y) / u_buffer.y, 0.0, 1.0);
  gl_PointSize = u_size;
}
`

const FRAGMENT = `#version 300 es
precision highp float;

uniform float u_size;
uniform float u_thickness;
uniform vec3 u_colour;
uniform vec3 u_otherColour;
uniform float u_otherOpacity;
uniform float u_selected;
uniform float u_fade;

flat in float v_wanted;

out vec4 fragColor;

void main() {
  // Device pixels from the centre of the point, which is where the marked pixel is.
  vec2 offset = (gl_PointCoord - 0.5) * u_size;
  float half_ = u_thickness * 0.5;
  // A cross, not a box: it has to be findable against dense art without hiding the pixel it marks.
  if (abs(offset.x) > half_ && abs(offset.y) > half_) discard;
  bool other = u_selected >= 0.0 && round(v_wanted) != round(u_selected);
  vec3 colour = other ? u_otherColour : u_colour;
  float alpha = u_fade * (other ? u_otherOpacity : 1.0);
  fragColor = vec4(colour * alpha, alpha);
}
`

/** The context these handles belong to; see the same guard in `layer.ts`. */
let owner: WebGL2RenderingContext | null = null
let program: WebGLProgram | null = null
let vao: WebGLVertexArrayObject | null = null
let markAttribute = -1
let markerBufferBytes = 0
const markerBuffers = new Map<MismatchMarks, WebGLBuffer>()
const usedMarkerBuffers = new Set<MismatchMarks>()

export const markerGpuMemoryBytes = (): number => markerBufferBytes
const uniforms = new Map<string, WebGLUniformLocation | null>()

const compile = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null => {
  const shader = gl.createShader(type)
  if (shader === null) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    warn('install', 'marker shader failed to compile', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

const uniform = (gl: WebGL2RenderingContext, name: string): WebGLUniformLocation | null => {
  if (!uniforms.has(name)) {
    uniforms.set(name, program === null ? null : gl.getUniformLocation(program, name))
  }
  return uniforms.get(name) ?? null
}

export const initMarkers = (gl: WebGL2RenderingContext): void => {
  // Forget the old context's handles before claiming this one, exactly as `layer.ts` does. Claiming
  // first and overwriting them only on the success path meant a compile or link that failed — which
  // is what every `create*` returns on a context lost to a GPU-process crash, and precisely when
  // MapLibre re-runs this lifecycle — left `owner` naming the new context while the handles still
  // belonged to the old one. Every frame then bound foreign objects, and the old context's objects
  // could never be freed because the guard in `releaseMarkers` no longer recognised them.
  program = null
  markerBuffers.clear()
  usedMarkerBuffers.clear()
  markerBufferBytes = 0
  markAttribute = -1
  vao = null
  uniforms.clear()
  owner = gl
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  if (vertex === null || fragment === null) return
  const created = gl.createProgram()
  if (created === null) return
  gl.attachShader(created, vertex)
  gl.attachShader(created, fragment)
  gl.linkProgram(created)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(created, gl.LINK_STATUS)) {
    warn('install', 'marker program failed to link', gl.getProgramInfoLog(created))
    return
  }
  program = created
  uniforms.clear()
  vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  markAttribute = gl.getAttribLocation(program, 'a_mark')
  gl.enableVertexAttribArray(markAttribute)
  gl.bindVertexArray(null)
}

export const releaseMarkers = (gl: WebGL2RenderingContext): void => {
  // A replacement map's `initMarkers` may already have claimed this state; see `layer.ts`.
  if (owner !== gl) return
  owner = null
  for (const held of markerBuffers.values()) gl.deleteBuffer(held)
  markerBuffers.clear()
  usedMarkerBuffers.clear()
  if (vao !== null) gl.deleteVertexArray(vao)
  if (program !== null) gl.deleteProgram(program)
  markerBufferBytes = 0
  markAttribute = -1
  vao = null
  program = null
  uniforms.clear()
}

export interface MarkerStyle {
  /** CSS pixels; scaled to the device inside `drawMarkers`, as size already is. */
  readonly size: number
  readonly thickness: number
  /** The marker colour, as 0..1 RGB. */
  readonly colour: readonly [number, number, number]
  /**
   * Drawn instead of `colour` for a mark whose wanted colour is not the selected one, when
   * `dimColour` is on. Null means use `colour` for everything.
   */
  readonly otherColour: readonly [number, number, number] | null
  /** Opacity multiplier for those same marks, 0..1. 1 means do not dim. */
  readonly otherOpacity: number
  /**
   * The palette index currently selected in wplace, or -1 when nothing is selected or the mode that
   * makes this meaningful is off. -1 must draw every mark at full strength in `colour`.
   */
  readonly selected: number
}

const applyMarkerStyle = (gl: WebGL2RenderingContext, style: MarkerStyle, fade: number): void => {
  const scale = deviceScale(gl)
  gl.uniform1f(uniform(gl, 'u_size'), style.size * scale)
  gl.uniform1f(uniform(gl, 'u_thickness'), Math.max(1, Math.round(style.thickness * scale)))
  gl.uniform3f(uniform(gl, 'u_colour'), ...style.colour)
  gl.uniform3f(uniform(gl, 'u_otherColour'), ...(style.otherColour ?? style.colour))
  gl.uniform1f(uniform(gl, 'u_otherOpacity'), style.otherOpacity)
  gl.uniform1f(uniform(gl, 'u_selected'), style.selected)
  gl.uniform1f(uniform(gl, 'u_fade'), fade)
}

/**
 * How many device pixels one CSS pixel is, right now.
 *
 * Never captured once and kept: dragging a window between a laptop's own display and an external
 * monitor changes it without reloading the page, and a marker that stayed the size it was on the
 * other screen is exactly the bug this is here to avoid.
 *
 * Falls back to the drawing buffer against the canvas's CSS width, because that is what MapLibre
 * itself sized the buffer by — on a page that has overridden `devicePixelRatio`, the buffer is the
 * honest answer and `window.devicePixelRatio` is not.
 *
 * That fallback is a layout read, and this is called once per tile per frame — twelve hundred
 * forced reflows a second on a full screen of tiles. So the answer is held against the buffer size
 * and browser DPR it was measured at. Browser zoom can change CSS width and DPR while leaving the
 * backing buffer unchanged, so the DPR is the cheap witness that invalidates that otherwise-stale
 * entry without putting a layout read back on every tile.
 */
let cachedScale: {
  canvas: unknown
  buffer: number
  dpr: number
  scale: number
} | null = null

/** @internal Exported so the zoom-without-buffer-resize invariant can be exercised directly. */
export const deviceScale = (gl: WebGL2RenderingContext): number => {
  const canvas = gl.canvas
  const buffer = gl.drawingBufferWidth
  const dpr = window.devicePixelRatio || 1
  if (
    cachedScale !== null &&
    cachedScale.canvas === canvas &&
    cachedScale.buffer === buffer &&
    cachedScale.dpr === dpr
  )
    return cachedScale.scale
  const measured = canvas instanceof HTMLCanvasElement ? canvas.getBoundingClientRect().width : 0
  const scale = measured > 0 ? buffer / measured : dpr
  cachedScale = { canvas, buffer, dpr, scale }
  return scale
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
  if (program === null || vao === null || pixels.length === 0) return

  gl.useProgram(program)
  gl.bindVertexArray(vao)
  let held = markerBuffers.get(pixels)
  if (held === undefined) {
    held = gl.createBuffer()
    if (held === null) return
    markerBuffers.set(pixels, held)
    markerBufferBytes += pixels.byteLength
    gl.bindBuffer(gl.ARRAY_BUFFER, held)
    gl.bufferData(gl.ARRAY_BUFFER, pixels, gl.STATIC_DRAW)
  } else gl.bindBuffer(gl.ARRAY_BUFFER, held)
  usedMarkerBuffers.add(pixels)
  gl.vertexAttribIPointer(markAttribute, 1, gl.UNSIGNED_INT, Uint32Array.BYTES_PER_ELEMENT, 0)

  gl.uniform2f(uniform(gl, 'u_tileScreen'), tile.x, tile.y)
  gl.uniform2f(uniform(gl, 'u_tileScale'), tile.width / TILE_SIZE, tile.height / TILE_SIZE)
  gl.uniform2f(uniform(gl, 'u_buffer'), gl.drawingBufferWidth, gl.drawingBufferHeight)
  gl.uniform1f(uniform(gl, 'u_sampleRate'), sampleRate)
  const sampleSeed = (Math.imul(tile.tile.x, 73_856_093) ^ Math.imul(tile.tile.y, 19_349_663)) >>> 0
  gl.uniform1ui(uniform(gl, 'u_sampleSeed'), sampleSeed)
  // `gl_PointSize` is in device pixels, so a size fixed there is half as big on a 2x display and a
  // quarter on 3x — the markers shrank exactly where the screen has more room to show them.
  applyMarkerStyle(gl, style, fade)

  gl.drawArrays(gl.POINTS, 0, pixels.length)
  gl.bindVertexArray(null)
}

export const MARKER_LAYER_ID = 'caelestis-markers'

/** Their crosshair. It stays on top; the markers go directly below it. */
const CROSSHAIR_LAYER = 'pixel-hover'

/** A tile being painted gets its own layer, named for the tile. */
const DRAFT_LAYER = /^paint-preview-/

/** Not every frame: this is only ever wrong just after a draft layer appears. */
const REORDER_MS = 500
let nextCheck = 0

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
 * reading `_order` is an array scan.
 */
export const keepMarkersAboveDrafts = (): void => {
  const now = performance.now()
  if (now < nextCheck) return
  nextCheck = now + REORDER_MS

  const map = getMap() as Ordered | null
  const order = map?.style?._order
  if (map === null || order === undefined) {
    count('paint:no layer order to read')
    return
  }
  count('paint:checked the layer order')

  const markers = order.indexOf(MARKER_LAYER_ID)
  let lastDraft = -1
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
    registerDraftCanvas(canvas, { x: Number(match[1]), y: Number(match[2]) })
  }
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
const drawVisible = (gl: WebGL2RenderingContext): void => {
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
  let animating = false
  const selected = isPaintOpen() ? (selectedColour() ?? -1) : -1
  const wanted: {
    template: PlacedTemplate
    mismatchFade: number
    selectedFade: number
  }[] = []
  const progressOnly: PlacedTemplate[] = []
  const markerKeys = new Set<string>()
  for (const template of displayTemplates()) {
    const appearance = appearanceOf(template)
    const mismatchKey = `mismatch:${template.id}`
    const selectedKey = `selected:${template.id}`
    markerKeys.add(mismatchKey)
    markerKeys.add(selectedKey)
    const mismatch = markerFades.advance(mismatchKey, appearance.markMismatch ? 1 : 0, now)
    const selectedMarker = markerFades.advance(
      selectedKey,
      appearance.markSelectedColour && selected >= 0 && !isColourHidden(appearance, selected)
        ? 1
        : 0,
      now,
    )
    if (!mismatch.done || !selectedMarker.done) animating = true
    // Multiplied by the template's own ramp: markers belong to it, so one arriving with its markers
    // on brings them with it rather than laying them over a template that is not there yet.
    // Hiding the template is already in there: its own ramp is on its way to zero, and the markers
    // leave with it rather than a step ahead of it.
    const templateFade = templateFades.advance(
      template.id,
      isTemplateVisible(template) ? 1 : 0,
      now,
    )
    if (!templateFade.done) animating = true
    const mismatchFade = mismatch.value * templateFade.value
    const selectedFade = selectedMarker.value * templateFade.value
    if (
      template.serverUrl === undefined &&
      isTemplateVisible(template) &&
      mismatchFade === 0 &&
      selectedFade === 0
    )
      progressOnly.push(template)
    if (mismatchFade > 0 || selectedFade > 0) {
      wanted.push({ template, mismatchFade, selectedFade })
    }
  }
  markerFades.prune(markerKeys)
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
    for (const tile of tiles) {
      if (covers(template, tile) && !progressIn(template, tile.tile)) deferred = true
    }
  }
  const { markerBudget, onlySelectedColour } = getState()
  const moving = (getMap() as { isMoving?: () => boolean } | null)?.isMoving?.() === true
  const renderBudget = markerBudget
  const profiling = isProfileEnabled()
  const mismatchSelection = onlySelectedColour && isPaintOpen() ? selected : -1
  for (const { template, mismatchFade, selectedFade } of wanted) {
    const appearance = appearanceOf(template)
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
      if (selectedFade > 0 && selected >= 0) {
        const disagreements = disagreementsIn(template, tile.tile)
        if (disagreements === null) deferred = true
        else {
          const marks = colourMarksIn(disagreements, selected)
          if (marks.length > 0) {
            selectedWork.push({
              tile,
              marks,
              style: selectedStyle,
              fade: selectedFade,
            })
          }
        }
      }
      if (mismatchFade > 0) {
        const mismatches = mismatchesIn(template, tile.tile)
        if (mismatches === null) deferred = true
        else if (mismatches.length > 0) {
          mismatchWork.push({
            tile,
            marks: mismatches,
            style: mismatchStyle,
            fade: mismatchFade,
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

const drawAll = (gl: WebGL2RenderingContext): void => {
  usedMarkerBuffers.clear()
  beginMarkerBatchFrame()
  beginMismatchFrame()
  try {
    drawVisible(gl)
  } finally {
    endMismatchFrame()
    endMarkerBatchFrame()
    for (const [pixels, held] of markerBuffers) {
      if (usedMarkerBuffers.has(pixels)) continue
      gl.deleteBuffer(held)
      markerBuffers.delete(pixels)
      markerBufferBytes -= pixels.byteLength
    }
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
  },

  render(gl: WebGL2RenderingContext): void {
    // Peek is a display suppression, not cache invalidation. Stop before `drawAll` so its normal
    // unused-buffer sweep does not discard every retained marker buffer during the held key.
    if (isOverlayPeekActive()) return
    // Never let this escape into MapLibre's render loop; a throw here takes the whole frame with it.
    try {
      profileGpu(gl, 'Marker GPU', () => measureProfile('Marker render', () => drawAll(gl)))
    } catch (error) {
      warn('install', 'marker layer render failed; skipping this frame', String(error))
    }
  },
}
