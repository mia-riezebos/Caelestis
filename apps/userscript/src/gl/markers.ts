import { TILE_SIZE } from '@wts/shared'
import { count, warn } from '../debug.js'
import { getMap } from '../map-handle.js'
import { appearanceOf, isTemplateVisible, localTemplates } from '../templates/local-store.js'
import { beginMismatchFrame, mismatchesIn } from '../templates/mismatch.js'
import {
  currentQuads,
  isDrawingTiles,
  registerDraftCanvas,
  type TileQuad,
} from '../tile-transform.js'
import { templateFade } from './fade.js'

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
/** A marked pixel, in wplace canvas pixels. */
in vec2 a_pixel;

/** The tile's top-left in canvas pixels, and where it landed on screen this frame. */
uniform vec2 u_tileOrigin;
uniform vec2 u_tileScreen;
/** Device pixels per canvas pixel, from the tile's own on-screen size. */
uniform vec2 u_tileScale;
uniform vec2 u_buffer;
uniform float u_size;

void main() {
  // The centre of the pixel, not its corner, so the crosshair sits on the thing it marks.
  vec2 device = u_tileScreen + (a_pixel - u_tileOrigin + 0.5) * u_tileScale;
  gl_Position = vec4((2.0 * device.x) / u_buffer.x - 1.0, 1.0 - (2.0 * device.y) / u_buffer.y, 0.0, 1.0);
  gl_PointSize = u_size;
}
`

const FRAGMENT = `#version 300 es
precision highp float;

uniform float u_size;
uniform float u_thickness;
uniform vec3 u_colour;
uniform float u_fade;

out vec4 fragColor;

void main() {
  // Device pixels from the centre of the point, which is where the marked pixel is.
  vec2 offset = (gl_PointCoord - 0.5) * u_size;
  float half_ = u_thickness * 0.5;
  // A cross, not a box: it has to be findable against dense art without hiding the pixel it marks.
  if (abs(offset.x) > half_ && abs(offset.y) > half_) discard;
  float alpha = u_fade;
  fragColor = vec4(u_colour * alpha, alpha);
}
`

let program: WebGLProgram | null = null
let buffer: WebGLBuffer | null = null
let vao: WebGLVertexArrayObject | null = null
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
  buffer = gl.createBuffer()
  vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  const pixel = gl.getAttribLocation(program, 'a_pixel')
  gl.enableVertexAttribArray(pixel)
  gl.vertexAttribPointer(pixel, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)
}

export const releaseMarkers = (gl: WebGL2RenderingContext): void => {
  if (buffer !== null) gl.deleteBuffer(buffer)
  if (vao !== null) gl.deleteVertexArray(vao)
  if (program !== null) gl.deleteProgram(program)
  buffer = null
  vao = null
  program = null
  uniforms.clear()
}

export interface MarkerStyle {
  readonly size: number
  readonly thickness: number
  readonly colour: readonly [number, number, number]
}

/**
 * Draw one crosshair per marked pixel of one tile.
 *
 * `pixels` is x,y pairs in canvas coordinates. Placement comes from the tile's own on-screen rect,
 * the same rect the overlay itself is drawn on, so markers inherit whatever MapLibre did to place
 * that tile rather than being projected separately.
 */
export const drawMarkers = (
  gl: WebGL2RenderingContext,
  tile: TileQuad,
  pixels: Float32Array,
  style: MarkerStyle,
  fade: number,
): void => {
  if (program === null || vao === null || pixels.length === 0) return

  gl.useProgram(program)
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, pixels, gl.DYNAMIC_DRAW)

  gl.uniform2f(uniform(gl, 'u_tileOrigin'), tile.tile.x * TILE_SIZE, tile.tile.y * TILE_SIZE)
  gl.uniform2f(uniform(gl, 'u_tileScreen'), tile.x, tile.y)
  gl.uniform2f(uniform(gl, 'u_tileScale'), tile.width / TILE_SIZE, tile.height / TILE_SIZE)
  gl.uniform2f(uniform(gl, 'u_buffer'), gl.drawingBufferWidth, gl.drawingBufferHeight)
  gl.uniform1f(uniform(gl, 'u_size'), style.size)
  gl.uniform1f(uniform(gl, 'u_thickness'), style.thickness)
  gl.uniform3f(uniform(gl, 'u_colour'), ...style.colour)
  gl.uniform1f(uniform(gl, 'u_fade'), fade)

  gl.drawArrays(gl.POINTS, 0, pixels.length / 2)
  gl.bindVertexArray(null)
}

export const MARKER_LAYER_ID = 'wts-markers'

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
 * Same shape at every zoom, in device pixels.
 *
 * Sized in cells it shrinks with the zoom, and the view where you are hunting for one wrong pixel in
 * a hundred thousand is exactly the view where a cell is a speck.
 */
const MARKER_STYLE: MarkerStyle = {
  size: 9,
  thickness: 2,
  /** Deliberately not a palette colour: nothing wplace can paint should be mistaken for a marker. */
  colour: [1, 0, 1],
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
const drawAll = (gl: WebGL2RenderingContext): void => {
  if (!isDrawingTiles()) return
  const tiles = currentQuads()
  if (tiles.length === 0) return
  const wanted = localTemplates().filter(
    (template) => isTemplateVisible(template) && appearanceOf(template).markMismatch,
  )
  if (wanted.length === 0) return

  count('marker:layer rendered')
  beginMismatchFrame()

  // Only the tiles a template covers. Asking about a tile is not free — one whose pixels have not
  // been captured triggers a fetch and a 1000x1000 `getImageData`.
  const covers = (template: (typeof wanted)[number], tile: TileQuad): boolean => {
    const left = tile.tile.x * TILE_SIZE
    const top = tile.tile.y * TILE_SIZE
    if (template.originX >= left + TILE_SIZE || template.originX + template.width <= left)
      return false
    if (template.originY >= top + TILE_SIZE || template.originY + template.height <= top)
      return false
    return true
  }

  const work: { tile: TileQuad; marks: Float32Array; fade: number }[] = []
  let deferred = false
  for (const template of wanted) {
    const fade = templateFade(template.id)
    if (fade <= 0) continue
    for (const tile of tiles) {
      if (!covers(template, tile)) continue
      const marks = mismatchesIn(template, tile.tile)
      if (marks === null) deferred = true
      else if (marks.length > 0) work.push({ tile, marks, fade })
    }
  }
  count('marker:tiles with marks', work.length)

  const hadBlend = gl.isEnabled(gl.BLEND)
  const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null
  const previousBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null
  const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

  for (const one of work) drawMarkers(gl, one.tile, one.marks, MARKER_STYLE, one.fade)

  gl.bindVertexArray(previousVao)
  gl.bindBuffer(gl.ARRAY_BUFFER, previousBuffer)
  gl.useProgram(previousProgram)
  if (!hadBlend) gl.disable(gl.BLEND)

  const now = performance.now()
  if (deferred && now >= nextRetry) {
    nextRetry = now + RETRY_MS
    const map = getMap() as { triggerRepaint?: () => void } | null
    map?.triggerRepaint?.()
    count('marker:asked for another frame')
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
    // Never let this escape into MapLibre's render loop; a throw here takes the whole frame with it.
    try {
      drawAll(gl)
    } catch (error) {
      warn('install', 'marker layer render failed; skipping this frame', String(error))
    }
  },
}
