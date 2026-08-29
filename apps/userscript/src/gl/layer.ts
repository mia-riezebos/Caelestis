import { PALETTE_SIZE, TILE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import { log, warn } from '../debug.js'
import { getMap } from '../map-handle.js'
import { isOverlayPeekActive } from '../overlay-peek.js'
import {
  clearGpuProfile,
  isProfileEnabled,
  measureProfile,
  measureProfileDetail,
  profileGpu,
  recordProfileWorkload,
} from '../profile.js'
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
import { completedQuads, currentQuads, isDrawingTiles, type TileQuad } from '../tile-transform.js'
import { appearanceTransitions, prefersReducedMotion } from './appearance-transition.js'
import { isDarkMapTheme } from './contrast-outline.js'
import { colourFades, templateFades } from './fade.js'
import { gpuCacheEvictions } from './gpu-cache.js'
import { markerLayer } from './markers.js'
import { movingOverlayTapCap } from './minify-quality.js'
import { FRAGMENT_SOURCE, OUTLINE_FRAGMENT_SOURCE, VERTEX_SOURCE } from './shaders.js'

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

interface IndexGpuTile {
  readonly texture: WebGLTexture
  /** Top-left and size of the non-halo source cells in template coordinates. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly textureWidth: number
  readonly textureHeight: number
  readonly inset: number
}

interface PendingIndexGpuTile {
  texture: WebGLTexture | null
  /** Top-left and size of the non-halo source cells in template coordinates. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly textureWidth: number
  readonly textureHeight: number
  readonly inset: number
  uploadedPixels: number
}

interface PendingTemplateGpu {
  readonly indices: readonly PendingIndexGpuTile[]
  readonly palette: WebGLTexture
  readonly width: number
  readonly height: number
  readonly source: Uint8Array
  lastUsed: number
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
  /** Whether the earlier outline pass already prepared this frame's shared palette. */
  palettePreparedForOverlay: boolean
  /** Render generation in which this template was most recently visible. */
  lastUsed: number
}

const MAX_OVERLAY_GPU_BYTES = 64 * 1024 * 1024
export const OVERLAY_UPLOAD_PIXELS_PER_FRAME = 512 * 1024

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
let maximumTextureSize: number | null = null
const uniforms = new Map<string, WebGLUniformLocation | null>()
const gpu = new Map<string, TemplateGpu>()
const pendingGpu = new Map<string, PendingTemplateGpu>()
let renderGeneration = 0

const gpuBytes = (entry: TemplateGpu): number =>
  PALETTE_SIZE * 4 +
  entry.indices.reduce((total, tile) => total + tile.textureWidth * tile.textureHeight, 0)

const pendingGpuBytes = (entry: PendingTemplateGpu): number =>
  PALETTE_SIZE * 4 +
  entry.indices.reduce((total, tile) => total + tile.textureWidth * tile.textureHeight, 0)

export const overlayGpuMemoryBytes = (): number => {
  let bytes = quad === null ? 0 : corners.byteLength
  for (const entry of gpu.values()) bytes += gpuBytes(entry)
  for (const entry of pendingGpu.values()) bytes += pendingGpuBytes(entry)
  return bytes
}

/** Upload chunks are ephemeral; no full-template CPU staging copy is retained. */
export const overlayStagingMemoryBytes = (): number => 0

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

const link = (gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram | null => {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  if (vertex === null || fragment === null) {
    if (vertex !== null) gl.deleteShader(vertex)
    if (fragment !== null) gl.deleteShader(fragment)
    return null
  }
  const created = gl.createProgram()
  if (created === null) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    return null
  }
  gl.attachShader(created, vertex)
  gl.attachShader(created, fragment)
  gl.linkProgram(created)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(created, gl.LINK_STATUS)) {
    warn('install', 'overlay program failed to link', gl.getProgramInfoLog(created))
    gl.deleteProgram(created)
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

/**
 * Bring the one palette texture shared by the outline and overlay to the requested visibility.
 *
 * The outline sits earlier in MapLibre's layer stack, so it must prepare the texture first. The
 * overlay then consumes that exact preparation instead of advancing the same colour ramps again a
 * few milliseconds later. Besides keeping both passes on the same pixels and alpha, this matters
 * on the final fade frame: if the overlay were the first pass to upload alpha zero, MapLibre could
 * retain the stale outline drawn immediately before it without scheduling another repaint.
 */
const preparePalette = (
  gl: WebGL2RenderingContext,
  entry: TemplateGpu,
  templateId: string,
  hidden: readonly number[],
  now: number,
  pass: 'outline' | 'overlay',
): boolean => {
  if (pass === 'overlay' && entry.palettePreparedForOverlay) {
    entry.palettePreparedForOverlay = false
    return entry.paletteMoving
  }

  const paletteKey = hidden.join(',')
  if (entry.paletteKey !== paletteKey || entry.paletteMoving) {
    const built = buildPalette(templateId, hidden, now)
    uploadPalette(gl, entry.palette, built.data)
    entry.paletteKey = paletteKey
    entry.paletteMoving = built.animating
  }
  entry.palettePreparedForOverlay = pass === 'outline'
  return entry.paletteMoving
}

/** Maximum side this context accepts, falling back to one whole-template upload in test shims. */
const textureLimit = (width: number, height: number): number => {
  if (maximumTextureSize === null) {
    return Math.max(width, height) + 2
  }
  return maximumTextureSize
}

/** Allocate one index texture without synchronously transferring the whole template into it. */
const allocateIndices = (
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  width: number,
  height: number,
): void => {
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, width, height, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, null)
  // Integer textures cannot be filtered, which is also exactly what we want: an index is a name,
  // and the average of two names is not a name.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
}

/** Split accepted templates into bounded allocations this particular device can upload gradually. */
const pendingIndexTiles = (width: number, height: number): readonly PendingIndexGpuTile[] => {
  const allocationLimit = textureLimit(width, height)
  // A one-cell halo lets the outline inspect neighbours across texture and template edges. WebGL 2
  // guarantees a far larger limit, but tiny test shims keep the unpadded fallback valid.
  const inset = allocationLimit >= 3 ? 1 : 0
  const contentLimit = Math.max(1, allocationLimit - inset * 2)
  const pending: PendingIndexGpuTile[] = []
  for (let y = 0; y < height; y += contentLimit) {
    const tileHeight = Math.min(contentLimit, height - y)
    for (let x = 0; x < width; x += contentLimit) {
      const tileWidth = Math.min(contentLimit, width - x)
      const textureWidth = tileWidth + inset * 2
      const textureHeight = tileHeight + inset * 2
      pending.push({
        texture: null,
        x,
        y,
        width: tileWidth,
        height: tileHeight,
        textureWidth,
        textureHeight,
        inset,
        uploadedPixels: 0,
      })
    }
  }
  return pending
}

const fillIndexUpload = (
  pending: PendingTemplateGpu,
  tile: PendingIndexGpuTile,
  uploadX: number,
  uploadY: number,
  uploadWidth: number,
  uploadHeight: number,
): Uint8Array => {
  const pixels = new Uint8Array(uploadWidth * uploadHeight).fill(TRANSPARENT_INDEX)
  const textureLeft = tile.x - tile.inset
  for (let row = 0; row < uploadHeight; row++) {
    const textureY = uploadY + row
    const destination = row * uploadWidth
    const sourceY = tile.y - tile.inset + textureY
    if (sourceY < 0 || sourceY >= pending.height) continue
    const requestedLeft = textureLeft + uploadX
    const sourceLeft = Math.max(0, requestedLeft)
    const sourceRight = Math.min(pending.width, requestedLeft + uploadWidth)
    if (sourceRight <= sourceLeft) continue
    const source = sourceY * pending.width + sourceLeft
    pixels.set(
      pending.source.subarray(source, source + sourceRight - sourceLeft),
      destination + sourceLeft - requestedLeft,
    )
  }
  return pixels
}

type UploadAdvance =
  | { readonly status: 'pending'; readonly uploadedPixels: number }
  | { readonly status: 'failed'; readonly uploadedPixels: number }
  | {
      readonly status: 'complete'
      readonly uploadedPixels: number
      readonly indices: readonly IndexGpuTile[]
    }

/** Transfer bounded rectangles until this frame's allowance is spent. */
const advanceIndexUpload = (
  gl: WebGL2RenderingContext,
  pending: PendingTemplateGpu,
  allowance: number,
): UploadAdvance => {
  let left = Math.max(0, Math.floor(allowance))
  let uploadedPixels = 0
  for (const tile of pending.indices) {
    const total = tile.textureWidth * tile.textureHeight
    if (tile.uploadedPixels >= total) continue
    if (left === 0) return { status: 'pending', uploadedPixels }
    if (tile.texture === null) {
      const texture = gl.createTexture()
      if (texture === null) return { status: 'failed', uploadedPixels }
      tile.texture = texture
      measureProfileDetail('Overlay texture allocation', () =>
        allocateIndices(gl, texture, tile.textureWidth, tile.textureHeight),
      )
    }
    gl.bindTexture(gl.TEXTURE_2D, tile.texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    while (tile.uploadedPixels < total && left > 0) {
      const uploadY = Math.floor(tile.uploadedPixels / tile.textureWidth)
      const uploadX = tile.uploadedPixels - uploadY * tile.textureWidth
      const uploadWidth =
        uploadX === 0 && left >= tile.textureWidth
          ? tile.textureWidth
          : Math.min(tile.textureWidth - uploadX, left)
      const uploadHeight =
        uploadX === 0 && uploadWidth === tile.textureWidth
          ? Math.min(tile.textureHeight - uploadY, Math.max(1, Math.floor(left / uploadWidth)))
          : 1
      const count = uploadWidth * uploadHeight
      const pixels = measureProfileDetail('Overlay index staging', () =>
        fillIndexUpload(pending, tile, uploadX, uploadY, uploadWidth, uploadHeight),
      )
      measureProfileDetail('Overlay index upload', () =>
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          uploadX,
          uploadY,
          uploadWidth,
          uploadHeight,
          gl.RED_INTEGER,
          gl.UNSIGNED_BYTE,
          pixels,
        ),
      )
      tile.uploadedPixels += count
      uploadedPixels += count
      left -= count
    }
  }

  const complete: IndexGpuTile[] = []
  for (const tile of pending.indices) {
    if (tile.texture === null || tile.uploadedPixels < tile.textureWidth * tile.textureHeight) {
      return { status: 'pending', uploadedPixels }
    }
    complete.push({
      texture: tile.texture,
      x: tile.x,
      y: tile.y,
      width: tile.width,
      height: tile.height,
      textureWidth: tile.textureWidth,
      textureHeight: tile.textureHeight,
      inset: tile.inset,
    })
  }
  return { status: 'complete', uploadedPixels, indices: complete }
}

const release = (gl: WebGL2RenderingContext, id: string): void => {
  measureProfileDetail('Overlay texture deletion', () => {
    const existing = gpu.get(id)
    if (existing !== undefined) {
      for (const tile of existing.indices) gl.deleteTexture(tile.texture)
      gl.deleteTexture(existing.palette)
      gpu.delete(id)
    }
    const pending = pendingGpu.get(id)
    if (pending !== undefined) {
      for (const tile of pending.indices) {
        if (tile.texture !== null) gl.deleteTexture(tile.texture)
      }
      gl.deleteTexture(pending.palette)
      pendingGpu.delete(id)
    }
  })
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
  for (const [id, entry] of pendingGpu) {
    records.push({
      id,
      bytes: pendingGpuBytes(entry),
      lastUsed: entry.lastUsed,
      visible: visible.has(id),
      exists: existing.has(id),
    })
  }
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

/** Visit each source/host-tile intersection once, with exact clip-space corners from Wplace. */
const visitIntersections = (
  template: PlacedTemplate,
  spans: readonly HorizontalSpan[],
  entry: TemplateGpu,
  tiles: readonly TileQuad[],
  bufferWidth: number,
  bufferHeight: number,
  draw: (source: IndexGpuTile, vertices: Float32Array) => void,
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
        const v0 = (source.inset + cutTop - top) / source.textureHeight
        const v1 = (source.inset + cutBottom - top) / source.textureHeight

        corner(screenLeft, screenTop, bufferWidth, bufferHeight, u0, v0, corners, 0)
        corner(screenRight, screenTop, bufferWidth, bufferHeight, u1, v0, corners, 6)
        corner(screenLeft, screenBottom, bufferWidth, bufferHeight, u0, v1, corners, 12)
        corner(screenRight, screenBottom, bufferWidth, bufferHeight, u1, v1, corners, 18)
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
    maximumTextureSize = null
    uniforms.clear()
    gpu.clear()
    pendingGpu.clear()
    renderGeneration = 0
    owner = gl
    try {
      const measured = gl.getParameter(gl.MAX_TEXTURE_SIZE) as unknown
      if (typeof measured === 'number' && Number.isFinite(measured) && measured > 0) {
        maximumTextureSize = Math.max(1, Math.floor(measured))
      }
    } catch {}
    program = link(gl, FRAGMENT_SOURCE)
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
    for (const id of new Set([...gpu.keys(), ...pendingGpu.keys()])) release(gl, id)
    if (quad !== null) gl.deleteBuffer(quad)
    if (vao !== null) gl.deleteVertexArray(vao)
    if (program !== null) gl.deleteProgram(program)
    program = null
    quad = null
    vao = null
    maximumTextureSize = null
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
    if (isOverlayPeekActive()) return
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
    // This is a browser preference, not a template property. Reading matchMedia for every visible
    // template made a dense viewport repeat the same native query dozens of times per frame.
    const reducedMotion = prefersReducedMotion()
    const profiling = isProfileEnabled()
    let animating = false
    let visibleSourcePixels = 0
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
        if (intersectsTiles(template, spans, tiles)) {
          visible.push({ template, fade: value, spans })
          if (profiling) visibleSourcePixels += template.width * template.height
        }
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
    let uploadsLeft = visible.reduce((total, { template }) => {
      const entry = gpu.get(template.id)
      const complete =
        entry !== undefined &&
        entry.source === template.indices &&
        entry.width === template.width &&
        entry.height === template.height
      return total + (complete ? 0 : 1)
    }, 0)

    try {
      for (const { template, fade, spans } of visible) {
        let entry = gpu.get(template.id)
        let pending = pendingGpu.get(template.id)
        const sourceChanged =
          (entry !== undefined &&
            (entry.source !== template.indices ||
              entry.width !== template.width ||
              entry.height !== template.height)) ||
          (pending !== undefined &&
            (pending.source !== template.indices ||
              pending.width !== template.width ||
              pending.height !== template.height))
        if (sourceChanged) {
          release(gl, template.id)
          entry = undefined
          pending = undefined
        }
        if (entry === undefined) {
          const uploadAllowance =
            uploadsLeft > 0 ? Math.floor(uploadPixelsLeft / uploadsLeft) : uploadPixelsLeft
          uploadsLeft = Math.max(0, uploadsLeft - 1)
          if (pending === undefined) {
            const palette = gl.createTexture()
            if (palette === null) continue
            pending = {
              indices: measureProfileDetail('Overlay upload planning', () =>
                pendingIndexTiles(template.width, template.height),
              ),
              palette,
              width: template.width,
              height: template.height,
              source: template.indices,
              lastUsed: renderGeneration,
            }
            pendingGpu.set(template.id, pending)
          }
          pending.lastUsed = renderGeneration
          const advanced = advanceIndexUpload(gl, pending, uploadAllowance)
          uploadPixelsLeft -= advanced.uploadedPixels
          uploadedIndexPixels += advanced.uploadedPixels
          if (advanced.status === 'failed') {
            release(gl, template.id)
            animating = true
            continue
          }
          if (advanced.status === 'pending') {
            animating = true
            continue
          }
          entry = {
            indices: advanced.indices,
            palette: pending.palette,
            width: template.width,
            height: template.height,
            source: template.indices,
            paletteKey: null,
            paletteMoving: false,
            palettePreparedForOverlay: false,
            lastUsed: renderGeneration,
          }
          pendingGpu.delete(template.id)
          gpu.set(template.id, entry)
          // The outline layer already ran earlier in this frame and could not see this entry.
          animating = true
        }
        entry.lastUsed = renderGeneration

        const targetAppearance = appearanceWithPreview(template.id, appearanceOf(template))
        const transitioned = appearanceTransitions.advance(
          template.id,
          targetAppearance,
          now,
          reducedMotion,
          hasAppearancePreview(template.id),
        )
        const appearance = transitioned.appearance
        if (!transitioned.done) animating = true
        const hidden = hiddenColoursFor(appearance)
        // Re-uploaded while anything in it is still moving, not only when the filter changes: the
        // filter changes once, and the fade it starts takes a few hundred milliseconds to arrive.
        if (preparePalette(gl, entry, template.id, hidden, now, 'overlay')) animating = true

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
    outlineProgram = link(gl, OUTLINE_FRAGMENT_SOURCE)
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
    if (outlineProgram === null || outlineVao === null || outlineQuad === null) return
    // This pass is always before the overlay. Clear any preparation the overlay did not consume in
    // an earlier partial frame, then mark only entries actually prepared below.
    for (const entry of gpu.values()) entry.palettePreparedForOverlay = false
    if (isOverlayPeekActive() || !isDrawingTiles()) return
    const map = getMap() as { isMoving?: () => boolean; triggerRepaint?: () => void } | null
    // The current frame's tile quads are emitted later in the layer stack. During motion the last
    // complete frame is stale, so omit this decorative pass until the map settles.
    if (map?.isMoving?.() === true) return
    const completed = completedQuads()
    if (completed.length === 0) return
    // Match the shader's close-zoom cutoff on the CPU too. At distant zoom there is no room for an
    // individual ring, so avoid issuing draws whose every fragment would immediately discard.
    const tiles = completed.filter(
      (tile) => tile.width / TILE_SIZE > 1 / 0.75 && tile.height / TILE_SIZE > 1 / 0.75,
    )
    if (tiles.length === 0) return

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
    const now = performance.now()
    const reducedMotion = prefersReducedMotion()
    let drawIntersections = 0
    let visibleTemplates = 0
    for (const template of displayTemplates()) {
      const entry = gpu.get(template.id)
      if (entry === undefined) continue
      const fade = templateFades.advance(
        template.id,
        isTemplateVisible(template) ? 1 : 0,
        now,
      ).value
      if (fade <= 0) continue
      const targetAppearance = appearanceWithPreview(template.id, appearanceOf(template))
      const appearance = appearanceTransitions.advance(
        template.id,
        targetAppearance,
        now,
        reducedMotion,
        hasAppearancePreview(template.id),
      ).appearance
      if (!appearance.contrastOutline) continue
      const spans = horizontalSpans(template)
      if (!intersectsTiles(template, spans, tiles)) continue
      visibleTemplates++

      preparePalette(gl, entry, template.id, hiddenColoursFor(appearance), now, 'outline')

      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, entry.palette)
      gl.uniform1i(outlineUniform(gl, 'u_palette'), 1)
      gl.uniform1f(outlineUniform(gl, 'u_fade'), fade * appearance.opacity)
      gl.uniform1f(outlineUniform(gl, 'u_outlineSize'), appearance.contrastOutlineSize)
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
