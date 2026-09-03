import { TILE_SIZE, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { log, warn } from '../debug.js'
import { getMap } from '../map-handle.js'
import { overlayPeekFade } from '../overlay-peek.js'
import {
  clearGpuProfile,
  isProfileEnabled,
  measureProfile,
  profileGpu,
  recordProfileWorkload,
} from '../profile.js'
import { isPlain } from '../templates/appearance.js'
import { displayTemplatesForSurface, type PlacedTemplate } from '../templates/local-store.js'
import { type HorizontalSpan, horizontalSpans } from '../templates/placement.js'
import { currentQuads, isDrawingTiles, type TileQuad, underlayQuads } from '../tile-transform.js'
import { prefersReducedMotion } from './appearance-transition.js'
import { isDarkMapTheme } from './contrast-outline.js'
import { markerLayer } from './markers.js'
import { movingOverlayTapCap } from './minify-quality.js'
import { type SceneTemplate, worldRenderScene } from './render-scene.js'
import { linkTemplateProgram, writeClipCorner } from './renderer-core.js'
import { FRAGMENT_SOURCE, OUTLINE_FRAGMENT_SOURCE } from './shaders.js'
import {
  TEMPLATE_UPLOAD_PIXELS_PER_FRAME,
  type TemplateGpuEntry,
  TemplateGpuStore,
  type TemplateGpuTile,
} from './template-gpu-store.js'

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
const OUTLINE_LAYER_ID = 'caelestis-outline'
const PIXEL_ART_LAYER = 'pixel-art-layer'
/** Their marker layer. Ours goes immediately before it. */
const BEFORE_LAYER = 'pixel-hover'
const DRAFT_LAYER_ID = /^paint-preview-/

export const OVERLAY_UPLOAD_PIXELS_PER_FRAME = TEMPLATE_UPLOAD_PIXELS_PER_FRAME

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
let gpu: TemplateGpuStore | null = null
let renderGeneration = 0

export const overlayGpuMemoryBytes = (): number => {
  return (quad === null ? 0 : corners.byteLength) + (gpu?.memoryBytes() ?? 0)
}

/** Upload chunks are ephemeral; no full-template CPU staging copy is retained. */
export const overlayStagingMemoryBytes = (): number => 0

const uniform = (gl: WebGL2RenderingContext, name: string): WebGLUniformLocation | null => {
  if (!uniforms.has(name)) {
    uniforms.set(name, program === null ? null : gl.getUniformLocation(program, name))
  }
  return uniforms.get(name) ?? null
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

/** Visit each source/host-tile intersection once, with exact clip-space corners from Wplace. */
/** @internal Host-adapter seam used by differential projection tests. */
export const visitIntersections = (
  template: PlacedTemplate,
  spans: readonly HorizontalSpan[],
  entry: TemplateGpuEntry,
  tiles: readonly TileQuad[],
  bufferWidth: number,
  bufferHeight: number,
  draw: (source: TemplateGpuTile, vertices: Float32Array) => void,
  margin = 0,
): number => {
  let count = 0
  const templateTop = template.originY + nudgeY
  for (const source of entry.indices) {
    const topMargin = source.y === 0 ? Math.min(margin, source.inset) : 0
    const bottomMargin =
      source.y + source.height === entry.height ? Math.min(margin, source.inset) : 0
    const top = templateTop + source.y - topMargin
    const bottom = templateTop + source.y + source.height + bottomMargin
    for (const span of spans) {
      const leftMargin =
        source.x === 0 && span.sourceStart === 0 ? Math.min(margin, source.inset) : 0
      const rightMargin =
        source.x + source.width === entry.width && span.sourceEnd === entry.width
          ? Math.min(margin, source.inset)
          : 0
      const sourceStart = Math.max(source.x - leftMargin, span.sourceStart - leftMargin)
      const sourceEnd = Math.min(
        source.x + source.width + rightMargin,
        span.sourceEnd + rightMargin,
      )
      if (sourceEnd <= sourceStart) continue
      const left = span.worldStart + sourceStart - span.sourceStart + nudgeX
      const right = span.worldStart + sourceEnd - span.sourceStart + nudgeX
      for (const tile of tiles) {
        const tileLeft = tile.tile.x * TILE_SIZE
        const tileTop = tile.tile.y * TILE_SIZE
        const cutLeft = Math.max(left, tileLeft)
        const cutTop = Math.max(top, tileTop)
        const cutRight = Math.min(right, tileLeft + TILE_SIZE)
        const cutBottom = Math.min(bottom, tileTop + TILE_SIZE)
        if (cutRight <= cutLeft || cutBottom <= cutTop) continue

        const scaleX = tile.width / TILE_SIZE
        const scaleY = tile.height / TILE_SIZE
        const screenLeft = tile.x + (cutLeft - tileLeft) * scaleX
        const screenRight = tile.x + (cutRight - tileLeft) * scaleX
        const screenTop = tile.y + (cutTop - tileTop) * scaleY
        const screenBottom = tile.y + (cutBottom - tileTop) * scaleY

        const u0 = (source.inset + sourceStart - source.x + cutLeft - left) / source.textureWidth
        const u1 = (source.inset + sourceStart - source.x + cutRight - left) / source.textureWidth
        const v0 = (source.inset - topMargin + cutTop - top) / source.textureHeight
        const v1 = (source.inset - topMargin + cutBottom - top) / source.textureHeight

        writeClipCorner(screenLeft, screenTop, bufferWidth, bufferHeight, u0, v0, corners, 0)
        writeClipCorner(screenRight, screenTop, bufferWidth, bufferHeight, u1, v0, corners, 6)
        writeClipCorner(screenLeft, screenBottom, bufferWidth, bufferHeight, u0, v1, corners, 12)
        writeClipCorner(screenRight, screenBottom, bufferWidth, bufferHeight, u1, v1, corners, 18)
        draw(source, corners)
        count++
      }
    }
  }
  return count
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
    gpu = new TemplateGpuStore(gl)
    renderGeneration = 0
    owner = gl
    program = linkTemplateProgram(gl, FRAGMENT_SOURCE)
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
    gpu?.dispose()
    gpu = null
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
    if (program === null || vao === null || gpu === null) return
    const store = gpu
    const now = performance.now()
    const peek = overlayPeekFade(now)
    if (peek.opacity <= 0 && peek.done) return
    // Stop where wplace stops. A layer renders every frame whatever the zoom, so without this the
    // overlay stayed on screen past the point their canvas disappears — annotating nothing.
    if (!isDrawingTiles()) return
    // Their tiles, where they put them this frame. Also the culling: wplace only draws the tiles in
    // view, so intersecting against these is the whole visibility test.
    const tiles = currentQuads()
    if (tiles.length === 0) return
    const bufferWidth = gl.drawingBufferWidth
    const bufferHeight = gl.drawingBufferHeight

    const all = displayTemplatesForSurface(WORLD_TEMPLATE_SURFACE)
    renderGeneration++

    // Switched off is a destination, not an exclusion: a template on its way out is still drawn,
    // at falling opacity, and only leaves once its ramp has run out.
    // This is a browser preference, not a template property. Reading matchMedia for every visible
    // template made a dense viewport repeat the same native query dozens of times per frame.
    const reducedMotion = prefersReducedMotion()
    const profiling = isProfileEnabled()
    const scene = worldRenderScene.advanceTemplates(all, WORLD_TEMPLATE_SURFACE, now, reducedMotion)
    let animating = scene.animating || !peek.done
    let visibleSourcePixels = 0
    const visible: {
      rendered: SceneTemplate
      spans: readonly HorizontalSpan[]
    }[] = []
    for (const rendered of scene.templates) {
      const { template } = rendered
      if (rendered.fade > 0 && rendered.palette !== null) {
        const spans = horizontalSpans(rendered.template)
        if (intersectsTiles(rendered.template, spans, tiles)) {
          visible.push({ rendered, spans })
          if (profiling) visibleSourcePixels += template.width * template.height
        }
      }
    }
    const ids = new Set(all.map((template) => template.id))
    // Offscreen textures can be large. Keep only the templates this frame could actually draw;
    // panning back uploads them lazily again.
    const visibleIds = new Set(visible.map(({ rendered }) => rendered.template.id))
    store.collect(ids, visibleIds)
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
      if (profiling) {
        recordProfileWorkload('Overlay host tiles', tiles.length)
        recordProfileWorkload('Overlay visible source pixels', 0)
        recordProfileWorkload('Overlay visible templates', 0)
        recordProfileWorkload('Overlay draw intersections', 0)
        recordProfileWorkload('Overlay uploaded index pixels', 0)
        recordProfileWorkload('Overlay minify tap cap', 0)
      }
      askForAnotherFrame()
      return
    }

    // MapLibre applies custom-layer defaults before this callback and marks its state cache dirty
    // afterwards. Reading state back here is both redundant and expensive: getParameter serialises
    // the CPU behind Wplace's raster GPU work, which consumed a full frame during click-drag pans.
    gl.useProgram(program)
    gl.bindVertexArray(vao)
    gl.enable(gl.BLEND)
    // Premultiplied source, which is what the fragment shader writes.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    // At far zoom the settled renderer samples a 4x4 grid for each output fragment. During a drag,
    // distributed samples retain anti-moire coverage while leaving enough GPU budget for Wplace to
    // move its own raster tiles; template-dense views use a smaller cap. The first settled frame
    // returns to the exact full grid.
    const moving = (getMap() as { isMoving?: () => boolean } | null)?.isMoving?.() === true
    const minifyTapCap = moving ? movingOverlayTapCap(visible.length) : 4
    gl.uniform1i(uniform(gl, 'u_maxMinifyTaps'), minifyTapCap)
    let uploadPixelsLeft = OVERLAY_UPLOAD_PIXELS_PER_FRAME
    let uploadedIndexPixels = 0
    let drawIntersections = 0
    let uploadsLeft = visible.reduce((total, { rendered }) => {
      const { template } = rendered
      const entry = store.entry(template.id)
      const complete =
        entry !== null &&
        entry.source === template.indices &&
        entry.width === template.width &&
        entry.height === template.height
      return total + (complete ? 0 : 1)
    }, 0)

    try {
      for (const { rendered, spans } of visible) {
        const { template, appearance, fade, palette } = rendered
        let entry = store.hasCurrent(template) ? store.entry(template.id) : null
        if (entry === null) {
          const uploadAllowance =
            uploadsLeft > 0 ? Math.floor(uploadPixelsLeft / uploadsLeft) : uploadPixelsLeft
          uploadsLeft = Math.max(0, uploadsLeft - 1)
          const advanced = store.advance(template, uploadAllowance, renderGeneration)
          uploadPixelsLeft -= advanced.uploadedPixels
          uploadedIndexPixels += advanced.uploadedPixels
          if (advanced.status === 'failed') continue
          if (advanced.status === 'pending') {
            animating = true
            continue
          }
          entry = advanced.entry
          // The outline layer already ran earlier in this frame and could not see this entry.
          animating = true
        }
        if (entry === null) continue
        entry.lastUsed = renderGeneration
        if (palette === null) continue
        store.uploadPalette(entry, palette)

        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, entry.palette)
        gl.uniform1i(uniform(gl, 'u_palette'), 1)

        gl.uniform1f(uniform(gl, 'u_fade'), fade * peek.opacity)
        gl.uniform1f(uniform(gl, 'u_opacity'), appearance.opacity)
        gl.uniform1f(uniform(gl, 'u_stampSize'), appearance.size)
        gl.uniform1f(uniform(gl, 'u_stampRadius'), appearance.radius)
        gl.uniform2f(uniform(gl, 'u_stampOffset'), appearance.translateX, appearance.translateY)
        gl.uniform1f(uniform(gl, 'u_stampRotation'), (appearance.rotation * Math.PI) / 180)
        gl.uniform1i(uniform(gl, 'u_plain'), isPlain(appearance) ? 1 : 0)

        drawIntersections += visitIntersections(
          template,
          spans,
          entry,
          tiles,
          bufferWidth,
          bufferHeight,
          (source, vertices) => {
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, source.texture)
            gl.uniform1i(uniform(gl, 'u_indices'), 0)
            gl.uniform2f(uniform(gl, 'u_size'), source.textureWidth, source.textureHeight)
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices)
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
          },
        )
      }
    } finally {
      if (profiling) {
        recordProfileWorkload('Overlay host tiles', tiles.length)
        recordProfileWorkload('Overlay visible source pixels', visibleSourcePixels)
        recordProfileWorkload('Overlay visible templates', visible.length)
        recordProfileWorkload('Overlay draw intersections', drawIntersections)
        recordProfileWorkload('Overlay uploaded index pixels', uploadedIndexPixels)
        recordProfileWorkload('Overlay minify tap cap', minifyTapCap)
        recordProfileWorkload('Overlay moving', moving ? 1 : 0)
        if (moving) {
          recordProfileWorkload('Overlay moving draw intersections', drawIntersections)
          recordProfileWorkload('Overlay moving minify tap cap', minifyTapCap)
        }
      }
      // A fade in progress still needs its next frame if one template failed to draw.
      askForAnotherFrame()
    }
  },
}

let outlineOwner: WebGL2RenderingContext | null = null
let outlineProgram: WebGLProgram | null = null
let outlineQuad: WebGLBuffer | null = null
let outlineVao: WebGLVertexArrayObject | null = null
const outlineUniforms = new Map<string, WebGLUniformLocation | null>()
let lastOutlineQuadKey = ''

const outlineUniform = (gl: WebGL2RenderingContext, name: string): WebGLUniformLocation | null => {
  if (!outlineUniforms.has(name)) {
    outlineUniforms.set(
      name,
      outlineProgram === null ? null : gl.getUniformLocation(outlineProgram, name),
    )
  }
  return outlineUniforms.get(name) ?? null
}

/**
 * A cheap silhouette below Wplace's art.
 *
 * Painted art covers this layer naturally; the coloured overlay later covers the middle of the
 * silhouette. This is the whole painted/unpainted test, expressed by layer order instead of a CPU
 * scan and sparse index-texture rewrites.
 */
export const outlineLayer = {
  id: OUTLINE_LAYER_ID,
  type: 'custom' as const,
  renderingMode: '2d' as const,

  onAdd(_map: unknown, gl: WebGL2RenderingContext): void {
    outlineProgram = null
    outlineQuad = null
    outlineVao = null
    outlineUniforms.clear()
    lastOutlineQuadKey = ''
    outlineOwner = gl
    outlineProgram = linkTemplateProgram(gl, OUTLINE_FRAGMENT_SOURCE)
    if (outlineProgram === null) return
    outlineQuad = gl.createBuffer()
    outlineVao = gl.createVertexArray()
    gl.bindVertexArray(outlineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, outlineQuad)
    gl.bufferData(gl.ARRAY_BUFFER, corners.byteLength, gl.DYNAMIC_DRAW)
    const clip = gl.getAttribLocation(outlineProgram, 'a_clip')
    const uv = gl.getAttribLocation(outlineProgram, 'a_uv')
    gl.enableVertexAttribArray(clip)
    gl.vertexAttribPointer(clip, 4, gl.FLOAT, false, 24, 0)
    gl.enableVertexAttribArray(uv)
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 24, 16)
    gl.bindVertexArray(null)
    log('install', 'outline layer added below wplace art')
  },

  onRemove(_map: unknown, gl: WebGL2RenderingContext): void {
    if (outlineOwner !== gl) return
    outlineOwner = null
    if (outlineQuad !== null) gl.deleteBuffer(outlineQuad)
    if (outlineVao !== null) gl.deleteVertexArray(outlineVao)
    if (outlineProgram !== null) gl.deleteProgram(outlineProgram)
    outlineProgram = null
    outlineQuad = null
    outlineVao = null
    outlineUniforms.clear()
    lastOutlineQuadKey = ''
  },

  render(gl: WebGL2RenderingContext, args: unknown): void {
    try {
      profileGpu(gl, 'Outline GPU', () =>
        measureProfile('Outline render', () => this.draw(gl, args)),
      )
    } catch (error) {
      warn('install', 'outline layer render failed; skipping this frame', String(error))
    }
  },

  draw(gl: WebGL2RenderingContext, _args: unknown): void {
    if (outlineProgram === null || outlineVao === null || outlineQuad === null || gpu === null)
      return
    const store = gpu
    const now = performance.now()
    const peek = overlayPeekFade(now)
    if ((peek.opacity <= 0 && peek.done) || !isDrawingTiles()) return
    const map = getMap() as { triggerRepaint?: () => void } | null
    // MapLibre exposes the same current tile matrices its raster layer will upload later in this
    // frame. The coordinate module reads those early, with the intercepted previous frame only as
    // a compatibility fallback when private MapLibre state is unavailable.
    const underlay = underlayQuads()
    if (underlay.length === 0) return
    const tiles = underlay

    const quadKey = tiles
      .map(({ tile, x, y, width, height }) => `${tile.x}:${tile.y}:${x}:${y}:${width}:${height}`)
      .join('|')
    if (quadKey !== lastOutlineQuadKey) {
      lastOutlineQuadKey = quadKey
      // Wplace records the settled quads later in this frame. One follow-up repaint lets the next
      // outline pass consume those exact positions without creating a continuous render loop.
      map?.triggerRepaint?.()
    }

    gl.useProgram(outlineProgram)
    gl.bindVertexArray(outlineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, outlineQuad)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    gl.uniform1i(outlineUniform(gl, 'u_darkTheme'), isDarkMapTheme() ? 1 : 0)

    const bufferWidth = gl.drawingBufferWidth
    const bufferHeight = gl.drawingBufferHeight
    const reducedMotion = prefersReducedMotion()
    let drawIntersections = 0
    let visibleTemplates = 0
    const scene = worldRenderScene.advanceTemplates(
      displayTemplatesForSurface(WORLD_TEMPLATE_SURFACE),
      WORLD_TEMPLATE_SURFACE,
      now,
      reducedMotion,
    )
    for (const rendered of scene.templates) {
      const { template, appearance, fade, outlineFade, palette } = rendered
      const entry = store.entry(template.id)
      if (entry === null) continue
      if (fade <= 0 || outlineFade <= 0 || palette === null) continue
      const spans = horizontalSpans(template)
      if (!intersectsTiles(template, spans, tiles)) continue
      visibleTemplates++

      store.uploadPalette(entry, palette)

      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, entry.palette)
      gl.uniform1i(outlineUniform(gl, 'u_palette'), 1)
      gl.uniform1f(
        outlineUniform(gl, 'u_fade'),
        fade * appearance.opacity * outlineFade * peek.opacity,
      )
      // Keep the persisted control scale, but render it as 3.125%..25% of a canvas pixel. Unlike a
      // device-pixel width, this grows and shrinks with Wplace's pixels as the map zooms.
      gl.uniform1f(outlineUniform(gl, 'u_outlineWidth'), appearance.contrastOutlineSize / 8)
      gl.uniform1f(outlineUniform(gl, 'u_stampSize'), appearance.size)
      gl.uniform1f(outlineUniform(gl, 'u_stampRadius'), appearance.radius)
      gl.uniform2f(
        outlineUniform(gl, 'u_stampOffset'),
        appearance.translateX,
        appearance.translateY,
      )
      gl.uniform1f(outlineUniform(gl, 'u_stampRotation'), (appearance.rotation * Math.PI) / 180)

      drawIntersections += visitIntersections(
        template,
        spans,
        entry,
        tiles,
        bufferWidth,
        bufferHeight,
        (source, vertices) => {
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, source.texture)
          gl.uniform1i(outlineUniform(gl, 'u_indices'), 0)
          gl.uniform2f(outlineUniform(gl, 'u_size'), source.textureWidth, source.textureHeight)
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices)
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        },
        1,
      )
    }
    if (isProfileEnabled()) {
      recordProfileWorkload('Outline host tiles', tiles.length)
      recordProfileWorkload('Outline visible templates', visibleTemplates)
      recordProfileWorkload('Outline draw intersections', drawIntersections)
    }
    if (scene.animating || !peek.done) map?.triggerRepaint?.()
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
    moveLayer?: (id: string, before?: string) => void
    style?: { _order?: string[] }
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
  const add = (
    layer: { readonly id: string },
    what: string,
    requestedBefore: string = BEFORE_LAYER,
    requireAnchor = false,
  ): boolean => {
    try {
      if (map.getLayer?.(layer.id) !== undefined) return true
      const before = map.getLayer?.(requestedBefore) === undefined ? undefined : requestedBefore
      if (requireAnchor && before === undefined) return false
      map.addLayer?.(layer, before)
      log('install', `${what} inserted${before === undefined ? ' on top' : ` before ${before}`}`)
      return true
    } catch (error) {
      warn('install', `could not add the ${what}`, String(error))
      return false
    }
  }

  const outline = add(outlineLayer, 'outline layer', PIXEL_ART_LAYER, true)
  // The markers go in second so they land above the overlay: same anchor, later insertion.
  const overlay = add(overlayLayer, 'overlay layer')
  const markers = add(markerLayer, 'marker layer')
  /**
   * A Wplace theme change swaps the basemap style. MapLibre preserves custom layers across that
   * diff, but preserves their old numeric position too. The two basemaps have different layer
   * counts, so ours can land below `pixel-art-layer`: callbacks still run, but before the tile quads
   * they need have been recorded. Existing is therefore not enough; the order is part of attachment.
   */
  const order = map.style?._order
  if (outline && overlay && markers && order !== undefined && map.moveLayer !== undefined) {
    const tile = order.indexOf(PIXEL_ART_LAYER)
    const outlineAt = order.indexOf(outlineLayer.id)
    const overlayAt = order.indexOf(overlayLayer.id)
    const markersAt = order.indexOf(markerLayer.id)
    const crosshair = order.indexOf(BEFORE_LAYER)
    const surroundsTiles = tile < 0 || (outlineAt < tile && tile < overlayAt)
    const correctlyOrdered =
      outlineAt >= 0 &&
      overlayAt >= 0 &&
      markersAt > overlayAt &&
      (crosshair < 0 || markersAt < crosshair) &&
      surroundsTiles
    if (!correctlyOrdered) {
      try {
        const firstDraft = order.find(
          (id, index) =>
            DRAFT_LAYER_ID.test(id) &&
            (tile < 0 || index > tile) &&
            (crosshair < 0 || index < crosshair),
        )
        const markersFollowTiles = tile < 0 || markersAt > tile
        const overlayAnchor =
          firstDraft ??
          (markersFollowTiles ? markerLayer.id : crosshair < 0 ? undefined : BEFORE_LAYER)
        map.moveLayer(outlineLayer.id, tile < 0 ? undefined : PIXEL_ART_LAYER)
        map.moveLayer(overlayLayer.id, overlayAnchor)
        map.moveLayer(markerLayer.id, crosshair < 0 ? undefined : BEFORE_LAYER)
        log('install', 'restored overlay order after a style change')
      } catch (error) {
        warn('install', 'could not restore the overlay layer order', String(error))
        return false
      }
    }
  }
  return outline && overlay && markers
}
