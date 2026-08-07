import { PALETTE_SIZE, TILE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@wts/shared'
import { log, warn } from '../debug.js'
import { getMap } from '../map-handle.js'
import { isPlain } from '../templates/appearance.js'
import { effectiveHiddenColours } from '../templates/colour-filter.js'
import { appearanceOf, isTemplateVisible, localTemplates } from '../templates/local-store.js'
import { isDrawingTiles } from '../tile-transform.js'
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
 * agree with theirs. Here there is one grid: we draw with MapLibre's own matrix, so our pixels are
 * theirs by construction and cannot disagree.
 *
 * **The whole canvas is one square of Web Mercator.** wplace's world is 2048 tiles of 1000 pixels,
 * so a template's extent in mercator is just its pixel coordinates over that. One quad per template,
 * whatever its size — no tiling in the render path at all.
 */

const LAYER_ID = 'wts-overlay'
/** Their marker layer. Ours goes immediately before it. */
const BEFORE_LAYER = 'pixel-hover'
/** wplace's canvas is 2048 tiles across, and that spans the whole Mercator square. */
const CANVAS_PIXELS = TILE_SIZE * 2048

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
 * Project a Mercator point to clip space in double precision.
 *
 * Column-major, as WebGL stores matrices. The whole point of doing this here rather than in the
 * vertex shader is that the Mercator input stays a double: in float32 its neighbours are ~1.2e-8
 * apart, and the matrix scales by tens of millions at high zoom, so that gap becomes half a pixel
 * or more on screen — and lands differently every frame as the map moves, which is what made pixels
 * jump while panning. Clip space is -1..1, where float32 has precision to spare.
 */
const project = (
  matrix: Float32Array | number[],
  x: number,
  y: number,
  into: Float32Array,
  offset: number,
): void => {
  const m = matrix
  into[offset] = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[12] ?? 0)
  into[offset + 1] = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[13] ?? 0)
  into[offset + 2] = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[14] ?? 0)
  into[offset + 3] = (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[15] ?? 0)
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
const buildPalette = (gl: WebGL2RenderingContext, hidden: readonly number[]): Uint8Array => {
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
    buildPalette(gl, hidden),
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

/**
 * MapLibre hands the matrix differently across versions: older builds pass it directly, newer ones
 * wrap it in a projection-data object. Read whichever is there rather than pinning a version.
 */
const matrixOf = (args: unknown): Float32Array | number[] | null => {
  if (args instanceof Float32Array || Array.isArray(args)) return args
  if (typeof args !== 'object' || args === null) return null
  const holder = args as { defaultProjectionData?: { mainMatrix?: Float32Array } }
  return holder.defaultProjectionData?.mainMatrix ?? null
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
    log('install', 'overlay layer added to wplace’s own canvas')
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

  draw(gl: WebGL2RenderingContext, args: unknown): void {
    if (program === null || vao === null) return
    // Stop where wplace stops. A layer renders every frame whatever the zoom, so without this the
    // overlay stayed on screen past the point their canvas disappears — annotating nothing.
    if (!isDrawingTiles()) return
    const matrix = matrixOf(args)
    if (matrix === null) return

    const visible = localTemplates().filter(isTemplateVisible)
    collect(gl, new Set(localTemplates().map((template) => template.id)))
    if (visible.length === 0) return

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

    for (const template of visible) {
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
      const hidden = effectiveHiddenColours(appearance.hiddenColours)
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

      // Corners projected here, in double, then handed over as clip space. See `project`.
      const x0 = template.originX / CANVAS_PIXELS
      const y0 = template.originY / CANVAS_PIXELS
      const x1 = (template.originX + template.width) / CANVAS_PIXELS
      const y1 = (template.originY + template.height) / CANVAS_PIXELS
      // Strip order: top-left, top-right, bottom-left, bottom-right.
      project(matrix, x0, y0, corners, 0)
      corners[4] = 0
      corners[5] = 0
      project(matrix, x1, y0, corners, 6)
      corners[10] = 1
      corners[11] = 0
      project(matrix, x0, y1, corners, 12)
      corners[16] = 0
      corners[17] = 1
      project(matrix, x1, y1, corners, 18)
      corners[22] = 1
      corners[23] = 1
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, corners)

      gl.uniform2f(uniform(gl, 'u_size'), template.width, template.height)
      gl.uniform1f(uniform(gl, 'u_opacity'), appearance.opacity)
      gl.uniform1f(uniform(gl, 'u_stampSize'), appearance.size)
      gl.uniform1f(uniform(gl, 'u_stampRadius'), appearance.radius)
      gl.uniform2f(uniform(gl, 'u_stampOffset'), appearance.translateX, appearance.translateY)
      gl.uniform1f(uniform(gl, 'u_stampRotation'), (appearance.rotation * Math.PI) / 180)
      gl.uniform1i(uniform(gl, 'u_plain'), isPlain(appearance) ? 1 : 0)

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
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
