import { PALETTE_SIZE, TILE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@wts/shared'
import { log, warn } from '../debug.js'
import { getMap } from '../map-handle.js'
import { isPlain } from '../templates/appearance.js'
import { hiddenColoursFor } from '../templates/colour-filter.js'
import { appearanceOf, isTemplateVisible, localTemplates } from '../templates/local-store.js'
import { currentQuads, isDrawingTiles } from '../tile-transform.js'
import { colourFades, templateFades } from './fade.js'
import { markerLayer } from './markers.js'
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
  /** Whether any colour in it is still fading, and so whether it needs re-uploading next frame. */
  paletteMoving: boolean
}

/** Every palette index, for pruning ramps — one per template per colour. */
const paletteKeys = Array.from({ length: PALETTE_SIZE }, (_, index) => index)

/** Which templates existed last frame, so the colour ramps are only swept when that changes. */
let lastTemplateSet = ''

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
 * Filtering a colour is then a 256-byte upload instead of a rebuilt bitmap — which is also what
 * makes fading one affordable: alpha is a number rather than a switch, so a colour leaving the
 * drawing is the same upload as a colour that has left. The wildcard index is always alpha 0, which
 * is also how a template pixel that requires nothing draws nothing.
 *
 * Filled from ramps rather than from the hidden set directly, and the ramps are advanced here
 * because this is the only place that knows every index needs one — a colour switched off has to
 * keep being asked about until it has finished leaving.
 */
const buildPalette = (
  templateId: string,
  hidden: readonly number[],
  now: number,
): { data: Uint8Array; animating: boolean } => {
  const off = new Set(hidden)
  const data = new Uint8Array(PALETTE_SIZE * 4)
  let animating = false
  for (let index = 0; index < PALETTE_SIZE; index++) {
    const colour = WPLACE_PALETTE[index]
    const shown = colour !== undefined && index !== TRANSPARENT_INDEX && !off.has(index)
    const { value, done } = colourFades.advance(`${templateId}:${index}`, shown ? 1 : 0, now)
    if (!done) animating = true
    data[index * 4] = colour?.rgb[0] ?? 0
    data[index * 4 + 1] = colour?.rgb[1] ?? 0
    data[index * 4 + 2] = colour?.rgb[2] ?? 0
    data[index * 4 + 3] = Math.round(value * 255)
  }
  return { data, animating }
}

const uploadPalette = (
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  data: Uint8Array,
): void => {
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PALETTE_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
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
    log('install', 'overlay layer added to wplace’s own canvas', { projection: 'transform-double' })
  },

  onRemove(_map: unknown, gl: WebGL2RenderingContext): void {
    for (const id of [...gpu.keys()]) release(gl, id)
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
      const { value, done } = templateFades.advance(
        template.id,
        isTemplateVisible(template) ? 1 : 0,
        now,
      )
      if (!done) animating = true
      if (value > 0) visible.push({ template, fade: value })
    }
    const ids = new Set(all.map((template) => template.id))
    templateFades.prune(ids)
    /**
     * The colour ramps are keyed per template *per palette entry*, so their keep-set is sixty-four
     * strings per template — built only when the set of templates has actually changed, rather than
     * on every frame. This runs inside a render callback at whatever rate MapLibre draws at, and a
     * few hundred strings a frame is garbage collected for nothing: templates come and go on human
     * timescales.
     */
    const fingerprint = [...ids].join(' ')
    if (fingerprint !== lastTemplateSet) {
      lastTemplateSet = fingerprint
      colourFades.prune(new Set(all.flatMap((t) => paletteKeys.map((i) => `${t.id}:${i}`))))
    }
    if (visible.length === 0) return

    /**
     * MapLibre renders on demand, so a frame nobody asked for is a frame that never happens.
     * Without this a ramp would advance only as far as the next pan.
     *
     * Asked for at the end rather than here, because the colour ramps are advanced inside the draw
     * loop below and a filter fading with nothing else moving would otherwise stop after one frame.
     */
    const askForAnotherFrame = (): void => {
      if (!animating) return
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
          paletteMoving: false,
        }
        gpu.set(template.id, entry)
      }

      const appearance = appearanceOf(template)
      // The template's own appearance, not the resolved one: whether it *has* overrides is the
      // question, and `appearanceOf` has already answered it by falling back to the defaults.
      const hidden = hiddenColoursFor(template.appearance)
      const paletteKey = hidden.join(',')
      // Re-uploaded while anything in it is still moving, not only when the filter changes: the
      // filter changes once and the fade it starts takes half a second to arrive.
      if (entry.paletteKey !== paletteKey || entry.paletteMoving) {
        const built = buildPalette(template.id, hidden, now)
        uploadPalette(gl, entry.palette, built.data)
        entry.paletteKey = paletteKey
        entry.paletteMoving = built.animating
        if (built.animating) animating = true
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
      }
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
    askForAnotherFrame()
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

  /**
   * Each layer decides for itself whether it is already there, and nothing runs outside the `try`.
   *
   * Both matter because the caller retries on a false. A single answer for two layers meant a first
   * attempt that added one and threw on the other would re-add the first on every retry and never
   * add the second — and a throw from *outside* the try escapes into `setInterval`, where it repeats
   * every 250ms with nothing catching it.
   */
  const add = (layer: { readonly id: string }, what: string): boolean => {
    try {
      if (map.getLayer?.(layer.id) !== undefined) return true
      const before = map.getLayer?.(BEFORE_LAYER) === undefined ? undefined : BEFORE_LAYER
      map.addLayer?.(layer, before)
      log('install', `${what} inserted${before === undefined ? ' on top' : ` before ${before}`}`)
      return true
    } catch (error) {
      warn('install', `could not add the ${what}`, String(error))
      return false
    }
  }

  // The markers go in second so they land above the overlay: same anchor, later insertion.
  const overlay = add(overlayLayer, 'overlay layer')
  const markers = add(markerLayer, 'marker layer')
  return overlay && markers
}
