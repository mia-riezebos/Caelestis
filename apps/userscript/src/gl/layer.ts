import { PALETTE_SIZE, TILE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import { log, warn } from '../debug.js'
import { getMap } from '../map-handle.js'
import { clearGpuProfile, measureProfile, profileGpu } from '../profile.js'
import { isPlain } from '../templates/appearance.js'
import { appearanceWithPreview, hasAppearancePreview } from '../templates/appearance-preview.js'
import { hiddenColoursFor } from '../templates/colour-filter.js'
import {
  appearanceOf,
  displayTemplates,
  isTemplateVisible,
  type PlacedTemplate,
} from '../templates/local-store.js'
import { type HorizontalSpan, horizontalSpans } from '../templates/placement.js'
import { currentQuads, isDrawingTiles, type TileQuad } from '../tile-transform.js'
import { appearanceTransitions } from './appearance-transition.js'
import { colourFades, templateFades } from './fade.js'
import { gpuCacheEvictions } from './gpu-cache.js'
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

const LAYER_ID = 'caelestis-overlay'
/** Their marker layer. Ours goes immediately before it. */
const BEFORE_LAYER = 'pixel-hover'

interface IndexGpuTile {
  readonly texture: WebGLTexture
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface TemplateGpu {
  readonly indices: readonly IndexGpuTile[]
  readonly palette: WebGLTexture
  width: number
  height: number
  /** Array identity of the pixels currently uploaded into `indices`. */
  source: Uint8Array
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
  /** Render generation in which this template was most recently visible. */
  lastUsed: number
}

const MAX_OVERLAY_GPU_BYTES = 64 * 1024 * 1024
const UPLOAD_PIXELS_PER_FRAME = 2 * 1024 * 1024

/** Every palette index, for pruning ramps — one per template per colour. */
const paletteKeys = Array.from({ length: PALETTE_SIZE }, (_, index) => index)

/** Which templates existed last frame, so the colour ramps are only swept when that changes. */
let lastTemplateSet = ''

/** Four vertices of clip xyzw + uv, rewritten per template per frame. */
const corners = new Float32Array(4 * 6)

/**
 * A debug nudge, in canvas pixels, applied to every template's extent.
 *
 * Set from the console with `__caelestis.nudge(dx, dy)`. It exists to *measure* a suspected offset between
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
 * The context these handles belong to.
 *
 * `onAdd` already knows a replacement map can arrive without the old one ever delivering
 * `onRemove`. The reverse happens too: wplace can build the new map before tearing the old one
 * down, and an unguarded `onRemove` then deleted the *new* context's handles and nulled its state.
 * The attachment loop sees the layer already registered and never reinitialises, so nothing draws
 * again until the page is reloaded.
 */
let owner: WebGL2RenderingContext | null = null
let program: WebGLProgram | null = null
let quad: WebGLBuffer | null = null
let vao: WebGLVertexArrayObject | null = null
const uniforms = new Map<string, WebGLUniformLocation | null>()
const gpu = new Map<string, TemplateGpu>()
let renderGeneration = 0

const gpuBytes = (entry: TemplateGpu): number =>
  PALETTE_SIZE * 4 + entry.indices.reduce((total, tile) => total + tile.width * tile.height, 0)

export const overlayGpuMemoryBytes = (): number => {
  let bytes = quad === null ? 0 : corners.byteLength
  for (const entry of gpu.values()) bytes += gpuBytes(entry)
  return bytes
}

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

/** Maximum side this context accepts, falling back to one whole-template upload in test shims. */
const textureLimit = (gl: WebGL2RenderingContext, width: number, height: number): number => {
  const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as unknown
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return Math.max(width, height)
  }
  return Math.max(1, Math.floor(limit))
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

/** Split accepted templates into textures this particular device can upload. */
const uploadIndexTiles = (
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  indices: Uint8Array,
): readonly IndexGpuTile[] | null => {
  const limit = textureLimit(gl, width, height)
  const uploaded: IndexGpuTile[] = []
  for (let y = 0; y < height; y += limit) {
    const tileHeight = Math.min(limit, height - y)
    for (let x = 0; x < width; x += limit) {
      const tileWidth = Math.min(limit, width - x)
      const texture = gl.createTexture()
      if (texture === null) {
        for (const tile of uploaded) gl.deleteTexture(tile.texture)
        return null
      }
      let pixels = indices
      if (x !== 0 || y !== 0 || tileWidth !== width || tileHeight !== height) {
        pixels = new Uint8Array(tileWidth * tileHeight)
        for (let row = 0; row < tileHeight; row++) {
          const start = (y + row) * width + x
          pixels.set(indices.subarray(start, start + tileWidth), row * tileWidth)
        }
      }
      uploadIndices(gl, texture, tileWidth, tileHeight, pixels)
      uploaded.push({ texture, x, y, width: tileWidth, height: tileHeight })
    }
  }
  return uploaded
}

const release = (gl: WebGL2RenderingContext, id: string): void => {
  const existing = gpu.get(id)
  if (existing === undefined) return
  for (const tile of existing.indices) gl.deleteTexture(tile.texture)
  gl.deleteTexture(existing.palette)
  gpu.delete(id)
}

/** Keep recent offscreen uploads for pan-back, under a soft budget; deleted sources leave at once. */
const collect = (
  gl: WebGL2RenderingContext,
  existing: ReadonlySet<string>,
  visible: ReadonlySet<string>,
): void => {
  const records = [...gpu].map(([id, entry]) => ({
    id,
    bytes: gpuBytes(entry),
    lastUsed: entry.lastUsed,
    visible: visible.has(id),
    exists: existing.has(id),
  }))
  for (const id of gpuCacheEvictions(records, MAX_OVERLAY_GPU_BYTES)) release(gl, id)
}

/** Whether any source pixel can reach one of the tile quads wplace is drawing this frame. */
const intersectsTiles = (
  template: PlacedTemplate,
  spans: readonly HorizontalSpan[],
  tiles: readonly TileQuad[],
): boolean => {
  const top = template.originY + nudgeY
  const bottom = top + template.height
  return tiles.some((tile) => {
    const tileLeft = tile.tile.x * TILE_SIZE
    const tileTop = tile.tile.y * TILE_SIZE
    if (bottom <= tileTop || top >= tileTop + TILE_SIZE) return false
    return spans.some(
      (span) =>
        span.worldEnd + nudgeX > tileLeft && span.worldStart + nudgeX < tileLeft + TILE_SIZE,
    )
  })
}

export const overlayLayer = {
  id: LAYER_ID,
  type: 'custom' as const,
  renderingMode: '2d' as const,

  onAdd(_map: unknown, gl: WebGL2RenderingContext): void {
    // `onAdd` can belong to a replacement map and therefore a replacement context without the old
    // map ever delivering `onRemove`. None of these handles may cross that context boundary. The old
    // context owns their cleanup; our only safe action here is to forget them and rebuild.
    program = null
    quad = null
    vao = null
    uniforms.clear()
    gpu.clear()
    renderGeneration = 0
    owner = gl
    program = link(gl)
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
    // A later `onAdd` has already taken this state over for its own context. Those handles are not
    // ours to delete, and the context we are being removed from cleans up its own on teardown.
    if (owner !== gl) return
    clearGpuProfile(gl)
    owner = null
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
      profileGpu(gl, 'Overlay GPU', () =>
        measureProfile('Overlay render', () => this.draw(gl, args)),
      )
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

    const all = displayTemplates()
    renderGeneration++

    // Switched off is a destination, not an exclusion: a template on its way out is still drawn,
    // at falling opacity, and only leaves once its ramp has run out.
    const now = performance.now()
    let animating = false
    const visible: {
      template: (typeof all)[number]
      fade: number
      spans: readonly HorizontalSpan[]
    }[] = []
    for (const template of all) {
      const { value, done } = templateFades.advance(
        template.id,
        isTemplateVisible(template) ? 1 : 0,
        now,
      )
      if (!done) animating = true
      if (value > 0) {
        const spans = horizontalSpans(template)
        if (intersectsTiles(template, spans, tiles)) visible.push({ template, fade: value, spans })
      }
    }
    const ids = new Set(all.map((template) => template.id))
    templateFades.prune(ids)
    appearanceTransitions.prune(ids)
    // Offscreen textures can be large. Keep only the templates this frame could actually draw;
    // panning back uploads them lazily again.
    const visibleIds = new Set(visible.map(({ template }) => template.id))
    collect(gl, ids, visibleIds)
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
    // A newly visible template begins at zero. It therefore has no drawable entry on its first
    // frame, but the unfinished fade still needs another frame or it remains transparent forever.
    if (visible.length === 0) {
      askForAnotherFrame()
      return
    }

    // Everything we are about to disturb, so it can go back exactly as found. MapLibre assumes it
    // owns this context and does not re-set what it believes it already knows — leaving the active
    // unit on 1, or depth test off, quietly corrupts whatever it draws next.
    const hadBlend = gl.isEnabled(gl.BLEND)
    const hadDepth = gl.isEnabled(gl.DEPTH_TEST)
    const blendSrcRgb = gl.getParameter(gl.BLEND_SRC_RGB) as GLenum
    const blendDstRgb = gl.getParameter(gl.BLEND_DST_RGB) as GLenum
    const blendSrcAlpha = gl.getParameter(gl.BLEND_SRC_ALPHA) as GLenum
    const blendDstAlpha = gl.getParameter(gl.BLEND_DST_ALPHA) as GLenum
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
    let uploadPixelsLeft = UPLOAD_PIXELS_PER_FRAME
    let uploadedThisFrame = false

    // The restore runs even if the loop throws. `render` catches to keep a bad frame from freezing
    // MapLibre, but catching after the state has been disturbed and before it is put back means
    // MapLibre draws the rest of that frame with our program bound, blending forced, depth test off
    // and the active unit on 1 — which its own state cache believes is 0. Skipping a frame has to
    // mean skipping it cleanly.
    try {
      for (const { template, fade, spans } of visible) {
        let entry = gpu.get(template.id)
        const sourceChanged =
          entry !== undefined &&
          (entry.source !== template.indices ||
            entry.width !== template.width ||
            entry.height !== template.height)
        if (sourceChanged) {
          release(gl, template.id)
          entry = undefined
        }
        if (entry === undefined) {
          const uploadPixels = template.width * template.height
          if (uploadedThisFrame && uploadPixels > uploadPixelsLeft) {
            animating = true
            continue
          }
          const palette = gl.createTexture()
          if (palette === null) continue
          const indices = uploadIndexTiles(gl, template.width, template.height, template.indices)
          if (indices === null) {
            gl.deleteTexture(palette)
            continue
          }
          entry = {
            indices,
            palette,
            width: template.width,
            height: template.height,
            source: template.indices,
            paletteKey: null,
            paletteMoving: false,
            lastUsed: renderGeneration,
          }
          gpu.set(template.id, entry)
          uploadedThisFrame = true
          uploadPixelsLeft = Math.max(0, uploadPixelsLeft - uploadPixels)
        }
        entry.lastUsed = renderGeneration

        const targetAppearance = appearanceWithPreview(template.id, appearanceOf(template))
        const transitioned = appearanceTransitions.advance(
          template.id,
          targetAppearance,
          now,
          undefined,
          hasAppearancePreview(template.id),
        )
        const appearance = transitioned.appearance
        if (!transitioned.done) animating = true
        const hidden = hiddenColoursFor(appearance)
        const paletteKey = hidden.join(',')
        // Re-uploaded while anything in it is still moving, not only when the filter changes: the
        // filter changes once, and the fade it starts takes a few hundred milliseconds to arrive.
        if (entry.paletteKey !== paletteKey || entry.paletteMoving) {
          const built = buildPalette(template.id, hidden, now)
          uploadPalette(gl, entry.palette, built.data)
          entry.paletteKey = paletteKey
          entry.paletteMoving = built.animating
          if (built.animating) animating = true
        }

        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, entry.palette)
        gl.uniform1i(uniform(gl, 'u_palette'), 1)

        gl.uniform1f(uniform(gl, 'u_fade'), fade)
        gl.uniform1f(uniform(gl, 'u_opacity'), appearance.opacity)
        gl.uniform1f(uniform(gl, 'u_stampSize'), appearance.size)
        gl.uniform1f(uniform(gl, 'u_stampRadius'), appearance.radius)
        gl.uniform2f(uniform(gl, 'u_stampOffset'), appearance.translateX, appearance.translateY)
        gl.uniform1f(uniform(gl, 'u_stampRotation'), (appearance.rotation * Math.PI) / 180)
        gl.uniform1i(uniform(gl, 'u_plain'), isPlain(appearance) ? 1 : 0)

        const templateTop = template.originY + nudgeY

        for (const source of entry.indices) {
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, source.texture)
          gl.uniform1i(uniform(gl, 'u_indices'), 0)
          gl.uniform2f(uniform(gl, 'u_size'), source.width, source.height)
          const top = templateTop + source.y
          const bottom = top + source.height
          for (const span of spans) {
            const sourceStart = Math.max(source.x, span.sourceStart)
            const sourceEnd = Math.min(source.x + source.width, span.sourceEnd)
            if (sourceEnd <= sourceStart) continue
            const left = span.worldStart + sourceStart - span.sourceStart + nudgeX
            const right = span.worldStart + sourceEnd - span.sourceStart + nudgeX
            for (const tile of tiles) {
              const tileLeft = tile.tile.x * TILE_SIZE
              const tileTop = tile.tile.y * TILE_SIZE
              // The part of this template run that falls inside this tile, in canvas pixels.
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

              const u0 = (sourceStart - source.x + cutLeft - left) / source.width
              const u1 = (sourceStart - source.x + cutRight - left) / source.width
              const v0 = (cutTop - top) / source.height
              const v1 = (cutBottom - top) / source.height

              // Strip order: top-left, top-right, bottom-left, bottom-right.
              corner(screenLeft, screenTop, bufferWidth, bufferHeight, u0, v0, corners, 0)
              corner(screenRight, screenTop, bufferWidth, bufferHeight, u1, v0, corners, 6)
              corner(screenLeft, screenBottom, bufferWidth, bufferHeight, u0, v1, corners, 12)
              corner(screenRight, screenBottom, bufferWidth, bufferHeight, u1, v1, corners, 18)
              gl.bufferSubData(gl.ARRAY_BUFFER, 0, corners)
              gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
            }
          }
        }
      }
    } finally {
      // Put it all back. The active texture unit especially: we leave it on 1 while binding the
      // palette, and MapLibre binds its own textures expecting to still be on 0.
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, null)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, null)
      gl.bindVertexArray(previousVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, previousBuffer)
      gl.useProgram(previousProgram)
      gl.blendFuncSeparate(blendSrcRgb, blendDstRgb, blendSrcAlpha, blendDstAlpha)
      if (!hadBlend) gl.disable(gl.BLEND)
      if (hadDepth) gl.enable(gl.DEPTH_TEST)
      // Inside the restore, because a fade in progress asks for the frame that continues it. Left
      // outside, a throw mid-loop skipped the request and the fade stalled until the map next moved.
      askForAnotherFrame()
    }
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
