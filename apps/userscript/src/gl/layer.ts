import { PALETTE_SIZE, TILE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@wts/shared'
import { log, warn } from '../debug.js'
import { getMap } from '../map-handle.js'
import { isPlain } from '../templates/appearance.js'
import { hiddenColoursFor } from '../templates/colour-filter.js'
import { appearanceOf, isTemplateVisible, localTemplates } from '../templates/local-store.js'
import { beginMismatchFrame, mismatchesIn } from '../templates/mismatch.js'
import { currentQuads, isDrawingTiles } from '../tile-transform.js'
import { drawMarkers, initMarkers, type MarkerStyle, releaseMarkers } from './markers.js'
import { FRAGMENT_SOURCE, VERTEX_SOURCE } from './shaders.js'

/**
 * The overlay, drawn inside wplace's own canvas.
 *
 * A MapLibre custom layer inserted before `pixel-hover`, which is the layer their selected-pixel
 * marker lives in. Being *in* their layer stack is what puts our templates under their crosshair and
 * under any pixels waiting to be placed, rather than on a canvas stacked over the lot.
 *
 * It also removes an entire class of bug rather than fixing it. Every seam, drift and half-pixel
 * fringe came from rasterising into our own screen-space canvas and then trying to make that grid
 * agree with theirs. Here there is one grid, and we do not re-derive it.
 *
 * **Positions come from their tiles, not from a projection of our own.** One quad per wplace tile a
 * template covers, placed on the on-screen rect that tile was actually drawn at this frame. Nothing
 * here projects anything, which is what keeps our pixel grid on theirs: MapLibre snaps raster tiles
 * to whole device pixels once the map stops moving and does not snap while it moves, so an overlay
 * that projects independently agrees during a pan and disagrees by a fraction of a pixel the moment
 * it settles. That fraction is a one-device-pixel seam wherever their canvas shows through.
 *
 * Tiling is also the culling: wplace only draws the tiles in view, so intersecting a template
 * against them is the entire visibility test.
 */

const LAYER_ID = 'wts-overlay'
/** Their marker layer. Ours goes immediately before it. */
const BEFORE_LAYER = 'pixel-hover'

interface TemplateGpu {
  readonly indices: WebGLTexture
  readonly palette: WebGLTexture
  readonly width: number
  readonly height: number
  /**
   * What the palette texture was built from, so it is only rewritten when the filter moves.
   *
   * Null rather than an empty string, because "nothing hidden" *is* the empty string — starting at
   * `''` meant a template with no filter matched on the first frame and the texture was never
   * uploaded at all. An unwritten texture reads as zero, zero alpha means hidden, and the whole
   * overlay silently drew nothing.
   */
  paletteKey: string | null
}

/** Four vertices of clip xyzw + uv, rewritten per template per frame. */
const corners = new Float32Array(4 * 6)

/**
 * A debug nudge, in canvas pixels, applied to every template's extent.
 *
 * Set from the console with `__wts.nudge(dx, dy)`. It exists to *measure* a suspected offset between
 * our pixel grid and wplace's rather than argue about where one might come from: a sub-pixel
 * disagreement is invisible wherever the overlay draws solidly, because our own pixels tile with
 * each other perfectly, and only shows at a hole where their canvas is visible underneath. Nudging
 * until the seam disappears reads the offset straight off the screen.
 */
let nudgeX = 0
let nudgeY = 0

export const setNudge = (x: number, y: number): { x: number; y: number } => {
  nudgeX = x
  nudgeY = y
  return { x: nudgeX, y: nudgeY }
}

/**
 * A corner, from a device-pixel position on the canvas straight to clip space.
 *
 * There is no projection here on purpose. The positions come from wplace's own tile draws, so the
 * only thing left is the viewport mapping, which is exact.
 */
const corner = (
  deviceX: number,
  deviceY: number,
  bufferWidth: number,
  bufferHeight: number,
  u: number,
  v: number,
  into: Float32Array,
  offset: number,
): void => {
  into[offset] = (2 * deviceX) / bufferWidth - 1
  into[offset + 1] = 1 - (2 * deviceY) / bufferHeight
  into[offset + 2] = 0
  into[offset + 3] = 1
  into[offset + 4] = u
  into[offset + 5] = v
}

/**
 * The mismatch marker, in device pixels — not in cells, and not in CSS pixels.
 *
 * Device pixels because the point of it is to be findable. Sized in cells it shrinks with the zoom,
 * and the view where you are hunting for the one wrong pixel in a hundred thousand is exactly the
 * view where a cell is a speck. This stays the same size on screen at every zoom, so it reads as an
 * annotation over the art rather than as part of it.
 */
const MARKER_STYLE: MarkerStyle = {
  size: 9,
  thickness: 2,
  /** Deliberately not a palette colour: nothing wplace can paint should be mistaken for a marker. */
  colour: [1, 0, 1],
}

/** How long a template takes to arrive or leave. */
const FADE_MS = 500

/** Cubic ease-in-out, the shape CSS `ease-in-out` describes. */
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

interface Fade {
  /** Where the ramp started, so a fade interrupted midway carries on from where it was. */
  readonly from: number
  readonly to: number
  readonly since: number
}

/**
 * Each template's opacity ramp, keyed by id.
 *
 * A template arriving is the same event as a template being switched back on, so both go through
 * here. On load there is always a moment of wplace's canvas alone — the bytes come out of
 * IndexedDB, the map has to exist before a layer can join it, and the layer needs a frame of their
 * tiles to place anything against — and the overlay used to appear in one frame at full strength
 * whenever that moment ended.
 *
 * Fading *out* is why this is keyed rather than global: a hidden template still has to be drawn,
 * at falling opacity, until its ramp reaches zero. It leaves the map only once it is invisible.
 */
const fades = new Map<string, Fade>()

/** The current value of a ramp, and whether it still has somewhere to go. */
const fadeOf = (id: string, target: number, now: number): { value: number; done: boolean } => {
  const existing = fades.get(id)
  if (existing === undefined) {
    // Never seen: ramp up from nothing, so a restored template arrives rather than appears.
    fades.set(id, { from: 0, to: target, since: now })
    return { value: 0, done: target === 0 }
  }
  const progress = Math.min(Math.max((now - existing.since) / FADE_MS, 0), 1)
  const value = existing.from + (existing.to - existing.from) * ease(progress)
  if (existing.to !== target) {
    // Turned around mid-ramp. Starting the new one from the value on screen is what stops a
    // half-faded template snapping to full before it fades back out.
    fades.set(id, { from: value, to: target, since: now })
    return { value, done: false }
  }
  return { value, done: progress >= 1 }
}

let program: WebGLProgram | null = null
let quad: WebGLBuffer | null = null
let vao: WebGLVertexArrayObject | null = null
const uniforms = new Map<string, WebGLUniformLocation | null>()
const gpu = new Map<string, TemplateGpu>()

const compile = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null => {
  const shader = gl.createShader(type)
  if (shader === null) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    warn('install', 'overlay shader failed to compile', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

const link = (gl: WebGL2RenderingContext): WebGLProgram | null => {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE)
  if (vertex === null || fragment === null) return null
  const created = gl.createProgram()
  if (created === null) return null
  gl.attachShader(created, vertex)
  gl.attachShader(created, fragment)
  gl.linkProgram(created)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(created, gl.LINK_STATUS)) {
    warn('install', 'overlay program failed to link', gl.getProgramInfoLog(created))
    return null
  }
  return created
}

const uniform = (gl: WebGL2RenderingContext, name: string): WebGLUniformLocation | null => {
  if (!uniforms.has(name)) {
    uniforms.set(name, program === null ? null : gl.getUniformLocation(program, name))
  }
  return uniforms.get(name) ?? null
}

/**
 * The palette as a 64x1 RGBA texture, with alpha standing in for "shown".
 *
 * Filtering a colour is then a 256-byte upload instead of a rebuilt bitmap. The wildcard index is
 * always alpha 0, which is also how a template pixel that requires nothing draws nothing.
 */
const buildPalette = (hidden: readonly number[]): Uint8Array => {
  const off = new Set(hidden)
  const data = new Uint8Array(PALETTE_SIZE * 4)
  for (let index = 0; index < PALETTE_SIZE; index++) {
    const colour = WPLACE_PALETTE[index]
    const shown = colour !== undefined && index !== TRANSPARENT_INDEX && !off.has(index)
    data[index * 4] = colour?.rgb[0] ?? 0
    data[index * 4 + 1] = colour?.rgb[1] ?? 0
    data[index * 4 + 2] = colour?.rgb[2] ?? 0
    data[index * 4 + 3] = shown ? 255 : 0
  }
  return data
}

const uploadPalette = (
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  hidden: readonly number[],
): void => {
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    PALETTE_SIZE,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    buildPalette(hidden),
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
}

/** Upload a template's indices once, as one byte per pixel. */
const uploadIndices = (
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  width: number,
  height: number,
  indices: Uint8Array,
): void => {
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8UI,
    width,
    height,
    0,
    gl.RED_INTEGER,
    gl.UNSIGNED_BYTE,
    indices,
  )
  // Integer textures cannot be filtered, which is also exactly what we want: an index is a name,
  // and the average of two names is not a name.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
}

const release = (gl: WebGL2RenderingContext, id: string): void => {
  const existing = gpu.get(id)
  if (existing === undefined) return
  gl.deleteTexture(existing.indices)
  gl.deleteTexture(existing.palette)
  gpu.delete(id)
}

/** Drop GPU copies of templates that no longer exist, so a deleted overlay frees its memory. */
const collect = (gl: WebGL2RenderingContext, live: ReadonlySet<string>): void => {
  for (const id of [...gpu.keys()]) if (!live.has(id)) release(gl, id)
}

export const overlayLayer = {
  id: LAYER_ID,
  type: 'custom' as const,
  renderingMode: '2d' as const,

  onAdd(_map: unknown, gl: WebGL2RenderingContext): void {
    program = link(gl)
    uniforms.clear()
    if (program === null) return
    quad = gl.createBuffer()
    vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    // Rewritten per template per frame, so the corners can be projected in double precision on the
    // way in. Six floats a vertex: clip xyzw, then uv.
    gl.bufferData(gl.ARRAY_BUFFER, corners.byteLength, gl.DYNAMIC_DRAW)
    const clip = gl.getAttribLocation(program, 'a_clip')
    const uv = gl.getAttribLocation(program, 'a_uv')
    gl.enableVertexAttribArray(clip)
    gl.vertexAttribPointer(clip, 4, gl.FLOAT, false, 24, 0)
    gl.enableVertexAttribArray(uv)
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 24, 16)
    gl.bindVertexArray(null)
    initMarkers(gl)
    log('install', 'overlay layer added to wplace’s own canvas', { projection: 'transform-double' })
  },

  onRemove(_map: unknown, gl: WebGL2RenderingContext): void {
    for (const id of [...gpu.keys()]) release(gl, id)
    releaseMarkers(gl)
    if (quad !== null) gl.deleteBuffer(quad)
    if (vao !== null) gl.deleteVertexArray(vao)
    if (program !== null) gl.deleteProgram(program)
    program = null
    quad = null
    vao = null
    uniforms.clear()
  },

  render(gl: WebGL2RenderingContext, args: unknown): void {
    // Never let this escape into MapLibre's render loop.
    //
    // A throw from a custom layer takes the whole frame with it, and MapLibre stops rendering
    // afterwards: the canvas freezes on its last framebuffer, so the page still *looks* alive while
    // no draw call of any kind is issued. Nothing recovers without a reload, which makes it read as
    // "the overlay is broken" rather than "the map died".
    try {
      this.draw(gl, args)
    } catch (error) {
      warn('install', 'overlay layer render failed; skipping this frame', String(error))
    }
  },

  draw(gl: WebGL2RenderingContext, _args: unknown): void {
    if (program === null || vao === null) return
    // Stop where wplace stops. A layer renders every frame whatever the zoom, so without this the
    // overlay stayed on screen past the point their canvas disappears — annotating nothing.
    if (!isDrawingTiles()) return
    // Their tiles, where they put them this frame. Also the culling: wplace only draws the tiles in
    // view, so intersecting against these is the whole visibility test.
    const tiles = currentQuads()
    if (tiles.length === 0) return
    const bufferWidth = gl.drawingBufferWidth
    const bufferHeight = gl.drawingBufferHeight

    const all = localTemplates()
    collect(gl, new Set(all.map((template) => template.id)))

    // Switched off is a destination, not an exclusion: a template on its way out is still drawn,
    // at falling opacity, and only leaves once its ramp has run out.
    const now = performance.now()
    let animating = false
    const visible: { template: (typeof all)[number]; fade: number }[] = []
    for (const template of all) {
      const { value, done } = fadeOf(template.id, isTemplateVisible(template) ? 1 : 0, now)
      if (!done) animating = true
      if (value > 0) visible.push({ template, fade: value })
    }
    for (const id of [...fades.keys()]) {
      if (!all.some((template) => template.id === id)) fades.delete(id)
    }
    if (visible.length === 0) return

    beginMismatchFrame()

    // MapLibre renders on demand, so a frame nobody asked for is a frame that never happens. Without
    // this a ramp would advance only as far as the next pan.
    if (animating) {
      const map = getMap() as { triggerRepaint?: () => void } | null
      map?.triggerRepaint?.()
    }

    // Everything we are about to disturb, so it can go back exactly as found. MapLibre assumes it
    // owns this context and does not re-set what it believes it already knows — leaving the active
    // unit on 1, or depth test off, quietly corrupts whatever it draws next.
    const hadBlend = gl.isEnabled(gl.BLEND)
    const hadDepth = gl.isEnabled(gl.DEPTH_TEST)
    const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null
    const previousBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null
    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null

    // Collected while drawing and flushed after, because markers use their own program and swapping
    // programs per tile would cost more than the markers do.
    const markerWork: { tile: (typeof tiles)[number]; marks: Float32Array; fade: number }[] = []
    let scanPending = false

    gl.useProgram(program)
    gl.bindVertexArray(vao)
    gl.enable(gl.BLEND)
    // Premultiplied source, which is what the fragment shader writes.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)

    for (const { template, fade } of visible) {
      let entry = gpu.get(template.id)
      if (entry === undefined) {
        const indices = gl.createTexture()
        const palette = gl.createTexture()
        if (indices === null || palette === null) continue
        uploadIndices(gl, indices, template.width, template.height, template.indices)
        entry = {
          indices,
          palette,
          width: template.width,
          height: template.height,
          paletteKey: null,
        }
        gpu.set(template.id, entry)
      }

      const appearance = appearanceOf(template)
      // The template's own appearance, not the resolved one: whether it *has* overrides is the
      // question, and `appearanceOf` has already answered it by falling back to the defaults.
      const hidden = hiddenColoursFor(template.appearance)
      const paletteKey = hidden.join(',')
      if (entry.paletteKey !== paletteKey) {
        uploadPalette(gl, entry.palette, hidden)
        entry.paletteKey = paletteKey
      }

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, entry.indices)
      gl.uniform1i(uniform(gl, 'u_indices'), 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, entry.palette)
      gl.uniform1i(uniform(gl, 'u_palette'), 1)

      gl.uniform1f(uniform(gl, 'u_fade'), fade)
      gl.uniform2f(uniform(gl, 'u_size'), template.width, template.height)
      gl.uniform1f(uniform(gl, 'u_opacity'), appearance.opacity)
      gl.uniform1f(uniform(gl, 'u_stampSize'), appearance.size)
      gl.uniform1f(uniform(gl, 'u_stampRadius'), appearance.radius)
      gl.uniform2f(uniform(gl, 'u_stampOffset'), appearance.translateX, appearance.translateY)
      gl.uniform1f(uniform(gl, 'u_stampRotation'), (appearance.rotation * Math.PI) / 180)
      gl.uniform1i(uniform(gl, 'u_plain'), isPlain(appearance) ? 1 : 0)

      const left = template.originX + nudgeX
      const top = template.originY + nudgeY
      const right = left + template.width
      const bottom = top + template.height

      for (const tile of tiles) {
        const tileLeft = tile.tile.x * TILE_SIZE
        const tileTop = tile.tile.y * TILE_SIZE
        // The part of this template that falls inside this tile, in canvas pixels.
        const cutLeft = Math.max(left, tileLeft)
        const cutTop = Math.max(top, tileTop)
        const cutRight = Math.min(right, tileLeft + TILE_SIZE)
        const cutBottom = Math.min(bottom, tileTop + TILE_SIZE)
        if (cutRight <= cutLeft || cutBottom <= cutTop) continue

        // Positioned from their tile's own on-screen rect, so whatever MapLibre did to place it —
        // including snapping it to whole device pixels once the map stops moving — is inherited
        // rather than guessed at.
        const scaleX = tile.width / TILE_SIZE
        const scaleY = tile.height / TILE_SIZE
        const screenLeft = tile.x + (cutLeft - tileLeft) * scaleX
        const screenRight = tile.x + (cutRight - tileLeft) * scaleX
        const screenTop = tile.y + (cutTop - tileTop) * scaleY
        const screenBottom = tile.y + (cutBottom - tileTop) * scaleY

        const u0 = (cutLeft - left) / template.width
        const u1 = (cutRight - left) / template.width
        const v0 = (cutTop - top) / template.height
        const v1 = (cutBottom - top) / template.height

        // Strip order: top-left, top-right, bottom-left, bottom-right.
        corner(screenLeft, screenTop, bufferWidth, bufferHeight, u0, v0, corners, 0)
        corner(screenRight, screenTop, bufferWidth, bufferHeight, u1, v0, corners, 6)
        corner(screenLeft, screenBottom, bufferWidth, bufferHeight, u0, v1, corners, 12)
        corner(screenRight, screenBottom, bufferWidth, bufferHeight, u1, v1, corners, 18)
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, corners)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

        if (appearance.markMismatch) {
          const marks = mismatchesIn(template, tile.tile)
          // Null is "ask again next frame", and on a still map there is no next frame unless one is
          // asked for. Without this the answer waited for the user to move — measured at about ten
          // seconds, which read as the scan being slow when it had simply not been run.
          if (marks === null) scanPending = true
          else if (marks.length > 0) markerWork.push({ tile, marks, fade })
        }
      }
    }

    // Markers last, so a crosshair is never drawn under a template that comes after it.
    for (const work of markerWork) {
      drawMarkers(gl, work.tile, work.marks, MARKER_STYLE, work.fade)
    }
    if (scanPending) {
      const map = getMap() as { triggerRepaint?: () => void } | null
      map?.triggerRepaint?.()
    }

    // Put it all back. The active texture unit especially: we leave it on 1 while binding the
    // palette, and MapLibre binds its own textures expecting to still be on 0.
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.bindVertexArray(previousVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, previousBuffer)
    gl.useProgram(previousProgram)
    if (!hadBlend) gl.disable(gl.BLEND)
    if (hadDepth) gl.enable(gl.DEPTH_TEST)
  },
}

/**
 * Put the layer in wplace's style, and keep it there.
 *
 * `beforeId` is their marker layer. If it ever disappears the call would throw, so an unknown id
 * falls back to adding on top — which is only what the old DOM canvas did anyway, and is better
 * than no overlay at all.
 */
export const installOverlayLayer = (): boolean => {
  const map = getMap() as {
    addLayer?: (layer: unknown, before?: string) => void
    getLayer?: (id: string) => unknown
  } | null
  if (map?.addLayer === undefined) return false
  if (map.getLayer?.(LAYER_ID) !== undefined) return true
  const before = map.getLayer?.(BEFORE_LAYER) === undefined ? undefined : BEFORE_LAYER
  try {
    map.addLayer(overlayLayer, before)
    log(
      'install',
      `overlay layer inserted${before === undefined ? ' on top' : ` before ${before}`}`,
    )
    return true
  } catch (error) {
    warn('install', 'could not add the overlay layer', String(error))
    return false
  }
}
