import {
  decodePresenceDraftMask,
  type PresenceRect,
  rectsIntersect,
  TILE_SIZE,
} from '@caelestis/shared'
import { log, warn } from '../debug.js'
import { getMap } from '../map-handle.js'
import { presenceView } from '../presence-client.js'
import { presenceRgb } from '../presence-colour.js'
import { getState } from '../state.js'
import { currentQuads, isDrawingTiles, type TileQuad } from '../tile-transform.js'
import { ramps } from './fade.js'
import { linkTemplateProgram, writeClipCorner } from './renderer-core.js'

/**
 * Other painters, drawn under the artwork.
 *
 * A MapLibre custom layer inserted below `pixel-art-layer`, so every placed pixel covers it and the
 * tint only shows where the canvas is still empty. That is the whole point: a claim or a viewport
 * is a statement about unfinished space, and finished art should never be recoloured by it.
 *
 * Three kinds of rect, one program. A viewport is a faint fill with a dashed edge; a draft is a
 * stronger fill with a solid edge and its drafted pixels picked out from a bitmask texture; a
 * region claim is a solid-edged fill in the claimant's colour. Everything arrives and leaves on
 * the shared fade ramp so a painter closing their tab does not blink out.
 */

export const PRESENCE_LAYER_ID = 'caelestis-presence'
const OUTLINE_LAYER_ID = 'caelestis-outline'
const PIXEL_ART_LAYER = 'pixel-art-layer'

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec3 u_colour;
uniform float u_fill;
uniform float u_border;
uniform float u_borderWidth;
uniform float u_dash;
uniform vec2 u_size;
uniform int u_hasMask;
uniform sampler2D u_mask;
uniform float u_maskAlpha;
out vec4 fragColor;
void main() {
  vec2 px = v_uv * u_size;
  float horizontal = min(px.x, u_size.x - px.x);
  float vertical = min(px.y, u_size.y - px.y);
  float edge = min(horizontal, vertical);
  float alpha = u_fill;
  if (u_hasMask == 1 && texture(u_mask, v_uv).r > 0.5) alpha = max(alpha, u_maskAlpha);
  if (edge < u_borderWidth) {
    float along = horizontal < vertical ? px.y : px.x;
    bool on = u_dash <= 0.0 || mod(along, u_dash * 2.0) < u_dash;
    if (on) alpha = max(alpha, u_border);
  }
  fragColor = vec4(u_colour * alpha, alpha);
}
`

type Kind = 'viewport' | 'draft' | 'region'

interface Style {
  readonly fill: number
  readonly border: number
  readonly borderWidth: number
  readonly dash: number
  readonly maskAlpha: number
}

const STYLES: Record<Kind, Style> = {
  viewport: { fill: 0.05, border: 0.35, borderWidth: 1.5, dash: 6, maskAlpha: 0 },
  draft: { fill: 0.1, border: 0.6, borderWidth: 1.5, dash: 0, maskAlpha: 0.5 },
  region: { fill: 0.09, border: 0.5, borderWidth: 2, dash: 0, maskAlpha: 0 },
}

interface Item {
  readonly key: string
  readonly kind: Kind
  readonly rect: PresenceRect
  readonly colour: readonly [number, number, number]
  readonly mask: string | null
  readonly mine: boolean
}

interface MaskTexture {
  readonly mask: string
  readonly texture: WebGLTexture
}

let owner: WebGL2RenderingContext | null = null
let program: WebGLProgram | null = null
let quad: WebGLBuffer | null = null
let vao: WebGLVertexArrayObject | null = null
const uniforms = new Map<string, WebGLUniformLocation | null>()
const masks = new Map<string, MaskTexture>()
const retained = new Map<string, Item>()
const fades = ramps()
const corners = new Float32Array(4 * 6)

const uniform = (gl: WebGL2RenderingContext, name: string): WebGLUniformLocation | null => {
  if (!uniforms.has(name)) {
    uniforms.set(name, program === null ? null : gl.getUniformLocation(program, name))
  }
  return uniforms.get(name) ?? null
}

/** What the presence view says should be on screen, keyed for fading. */
const currentItems = (): Item[] => {
  const view = presenceView()
  const items: Item[] = []
  for (const peer of view.peers) {
    const colour = presenceRgb(peer.painter.wplaceUserId)
    if (peer.viewport !== null) {
      items.push({
        key: `peer:${peer.sessionId}:viewport`,
        kind: 'viewport',
        rect: peer.viewport,
        colour,
        mask: null,
        mine: false,
      })
    }
    if (peer.draft !== null) {
      items.push({
        key: `peer:${peer.sessionId}:draft`,
        kind: 'draft',
        rect: peer.draft.rect,
        colour,
        mask: peer.draft.mask ?? null,
        mine: false,
      })
    }
  }
  for (const region of view.regions) {
    items.push({
      key: `region:${region.id}`,
      kind: 'region',
      rect: region.rect,
      colour: presenceRgb(region.claimant.wplaceUserId),
      mask: null,
      mine: view.me?.wplaceUserId === region.claimant.wplaceUserId,
    })
  }
  return items
}

const maskTexture = (gl: WebGL2RenderingContext, item: Item): WebGLTexture | null => {
  if (item.mask === null) return null
  const held = masks.get(item.key)
  if (held !== undefined && held.mask === item.mask) return held.texture
  if (held !== undefined) gl.deleteTexture(held.texture)
  masks.delete(item.key)
  const bits = decodePresenceDraftMask({ rect: item.rect, mask: item.mask, pixels: 0 })
  if (bits === null) return null
  const texture = gl.createTexture()
  if (texture === null) return null
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8,
    item.rect.w,
    item.rect.h,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    bits.map((bit) => (bit === 0 ? 0 : 255)),
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  masks.set(item.key, { mask: item.mask, texture })
  return texture
}

const releaseMasks = (gl: WebGL2RenderingContext, keep: ReadonlySet<string>): void => {
  for (const [key, held] of masks) {
    if (keep.has(key)) continue
    gl.deleteTexture(held.texture)
    masks.delete(key)
  }
}

const tileRect = (tile: TileQuad): PresenceRect => ({
  x: tile.tile.x * TILE_SIZE,
  y: tile.tile.y * TILE_SIZE,
  w: TILE_SIZE,
  h: TILE_SIZE,
})

/** Draw one rect across every host tile it touches, with uv spanning the whole rect. */
const drawRect = (
  gl: WebGL2RenderingContext,
  rect: PresenceRect,
  tiles: readonly TileQuad[],
  bufferWidth: number,
  bufferHeight: number,
): { readonly drawn: number; readonly scale: number } => {
  let drawn = 0
  let scale = 1
  for (const tile of tiles) {
    if (!rectsIntersect(rect, tileRect(tile))) continue
    const tileLeft = tile.tile.x * TILE_SIZE
    const tileTop = tile.tile.y * TILE_SIZE
    const cutLeft = Math.max(rect.x, tileLeft)
    const cutTop = Math.max(rect.y, tileTop)
    const cutRight = Math.min(rect.x + rect.w, tileLeft + TILE_SIZE)
    const cutBottom = Math.min(rect.y + rect.h, tileTop + TILE_SIZE)
    if (cutRight <= cutLeft || cutBottom <= cutTop) continue
    const scaleX = tile.width / TILE_SIZE
    const scaleY = tile.height / TILE_SIZE
    scale = scaleX
    const screenLeft = tile.x + (cutLeft - tileLeft) * scaleX
    const screenRight = tile.x + (cutRight - tileLeft) * scaleX
    const screenTop = tile.y + (cutTop - tileTop) * scaleY
    const screenBottom = tile.y + (cutBottom - tileTop) * scaleY
    const u0 = (cutLeft - rect.x) / rect.w
    const u1 = (cutRight - rect.x) / rect.w
    const v0 = (cutTop - rect.y) / rect.h
    const v1 = (cutBottom - rect.y) / rect.h
    gl.uniform2f(uniform(gl, 'u_size'), rect.w * scaleX, rect.h * scaleY)
    writeClipCorner(screenLeft, screenTop, bufferWidth, bufferHeight, u0, v0, corners, 0)
    writeClipCorner(screenRight, screenTop, bufferWidth, bufferHeight, u1, v0, corners, 6)
    writeClipCorner(screenLeft, screenBottom, bufferWidth, bufferHeight, u0, v1, corners, 12)
    writeClipCorner(screenRight, screenBottom, bufferWidth, bufferHeight, u1, v1, corners, 18)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, corners)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    drawn++
  }
  return { drawn, scale }
}

export const presenceLayer = {
  id: PRESENCE_LAYER_ID,
  type: 'custom' as const,
  renderingMode: '2d' as const,

  onAdd(_map: unknown, gl: WebGL2RenderingContext): void {
    program = null
    quad = null
    vao = null
    uniforms.clear()
    masks.clear()
    owner = gl
    program = linkTemplateProgram(gl, FRAGMENT_SOURCE)
    if (program === null) return
    quad = gl.createBuffer()
    vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, corners.byteLength, gl.DYNAMIC_DRAW)
    const clip = gl.getAttribLocation(program, 'a_clip')
    const uv = gl.getAttribLocation(program, 'a_uv')
    gl.enableVertexAttribArray(clip)
    gl.vertexAttribPointer(clip, 4, gl.FLOAT, false, 24, 0)
    gl.enableVertexAttribArray(uv)
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 24, 16)
    gl.bindVertexArray(null)
    log('install', 'presence layer added under the artwork')
  },

  onRemove(_map: unknown, gl: WebGL2RenderingContext): void {
    if (owner !== gl) return
    owner = null
    releaseMasks(gl, new Set())
    if (quad !== null) gl.deleteBuffer(quad)
    if (vao !== null) gl.deleteVertexArray(vao)
    if (program !== null) gl.deleteProgram(program)
    program = null
    quad = null
    vao = null
    uniforms.clear()
  },

  render(gl: WebGL2RenderingContext, _args: unknown): void {
    try {
      this.draw(gl)
    } catch (error) {
      warn('install', 'presence layer render failed; skipping this frame', String(error))
    }
  },

  draw(gl: WebGL2RenderingContext): void {
    if (program === null || vao === null || quad === null) return
    const now = performance.now()
    const shown = getState().showPresence
    const items = shown ? currentItems() : []
    const keys = new Set<string>()
    for (const item of items) {
      keys.add(item.key)
      retained.set(item.key, item)
    }
    // Everything drawn is what is present or still fading out. Ramps start from zero, so a new
    // item arrives over the shared fade rather than appearing.
    let animating = false
    const drawn: { item: Item; fade: number }[] = []
    for (const [key, item] of retained) {
      const fade = fades.advance(key, keys.has(key) ? 1 : 0, now)
      if (!fade.done) animating = true
      if (fade.value <= 0 && fade.done && !keys.has(key)) {
        retained.delete(key)
        continue
      }
      if (fade.value > 0) drawn.push({ item, fade: fade.value })
    }
    fades.prune(new Set(retained.keys()))
    releaseMasks(
      gl,
      new Set(drawn.filter(({ item }) => item.mask !== null).map(({ item }) => item.key)),
    )
    if (drawn.length > 0 && isDrawingTiles()) {
      const tiles = currentQuads()
      if (tiles.length > 0) {
        const bufferWidth = gl.drawingBufferWidth
        const bufferHeight = gl.drawingBufferHeight
        const deviceScale = Math.max(1, window.devicePixelRatio || 1)
        gl.useProgram(program)
        gl.bindVertexArray(vao)
        gl.bindBuffer(gl.ARRAY_BUFFER, quad)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.disable(gl.DEPTH_TEST)
        for (const { item, fade } of drawn) {
          const style = STYLES[item.kind]
          const texture = maskTexture(gl, item)
          const emphasis = item.mine ? 1.4 : 1
          gl.uniform3f(uniform(gl, 'u_colour'), item.colour[0], item.colour[1], item.colour[2])
          gl.uniform1f(uniform(gl, 'u_fill'), style.fill * emphasis * fade)
          gl.uniform1f(uniform(gl, 'u_border'), Math.min(1, style.border * emphasis) * fade)
          gl.uniform1f(uniform(gl, 'u_borderWidth'), style.borderWidth * deviceScale)
          gl.uniform1f(uniform(gl, 'u_dash'), style.dash * deviceScale)
          gl.uniform1f(uniform(gl, 'u_maskAlpha'), style.maskAlpha * fade)
          gl.uniform1i(uniform(gl, 'u_hasMask'), texture === null ? 0 : 1)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, texture)
          gl.uniform1i(uniform(gl, 'u_mask'), 0)
          drawRect(gl, item.rect, tiles, bufferWidth, bufferHeight)
        }
        gl.bindVertexArray(null)
      }
    }
    if (animating) {
      const map = getMap() as { triggerRepaint?: () => void } | null
      map?.triggerRepaint?.()
    }
  },
}

/** Ask MapLibre for a frame after presence data changed while the map is idle. */
export const repaintPresence = (): void => {
  const map = getMap() as { triggerRepaint?: () => void } | null
  map?.triggerRepaint?.()
}

/**
 * Put the layer under the outline and the artwork, and keep it there across style changes.
 *
 * The overlay installer owns the outline, overlay, and marker order; this only has to sit below
 * the lowest of them. Without either anchor there is nothing to be under yet, so it waits.
 */
export const installPresenceLayer = (): boolean => {
  const map = getMap() as {
    addLayer?: (layer: unknown, before?: string) => void
    getLayer?: (id: string) => unknown
    moveLayer?: (id: string, before?: string) => void
    style?: { _order?: string[] }
  } | null
  if (map?.addLayer === undefined) return false
  const anchor =
    map.getLayer?.(OUTLINE_LAYER_ID) !== undefined
      ? OUTLINE_LAYER_ID
      : map.getLayer?.(PIXEL_ART_LAYER) !== undefined
        ? PIXEL_ART_LAYER
        : null
  if (anchor === null) return false
  try {
    if (map.getLayer?.(PRESENCE_LAYER_ID) === undefined) {
      map.addLayer(presenceLayer, anchor)
      log('install', `presence layer inserted before ${anchor}`)
      return true
    }
    const order = map.style?._order
    if (order === undefined || map.moveLayer === undefined) return true
    const at = order.indexOf(PRESENCE_LAYER_ID)
    const anchorAt = order.indexOf(anchor)
    if (at >= 0 && anchorAt >= 0 && at > anchorAt) {
      map.moveLayer(PRESENCE_LAYER_ID, anchor)
      log('install', 'restored presence layer order after a style change')
    }
    return true
  } catch (error) {
    warn('install', 'could not add the presence layer', String(error))
    return false
  }
}
