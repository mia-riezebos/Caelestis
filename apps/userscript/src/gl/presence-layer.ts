import {
  decodePresenceDraftMask,
  PRESENCE_VIEWPORT_MIN_MS,
  type PresenceRect,
  type RegionDocument,
  type RegionShapePixels,
  rectsIntersect,
  regionDocumentPixels,
  sameRect,
  TILE_SIZE,
} from '@caelestis/shared'
import { claimEditorEditingIds, claimEditorPixels } from '../claim-editor.js'
import { log, warn } from '../debug.js'
import { getMap } from '../map-handle.js'
import { presenceView } from '../presence-client.js'
import { presenceRgb } from '../presence-colour.js'
import { hoveredPresenceRegions } from '../presence-hover.js'
import { getState } from '../state.js'
import { currentQuads, isDrawingTiles, type TileQuad } from '../tile-transform.js'
import { ramps } from './fade.js'
import { linkTemplateProgram, writeClipCorner } from './renderer-core.js'

/**
 * Other painters, drawn over the artwork as see-through coloured shapes.
 *
 * One MapLibre custom layer, inserted just under Wplace's crosshair, so everything here sits on
 * top of the pixel art and our own overlay. Each painter has a named colour, and what they are
 * doing is told by the pattern and the edge:
 *
 * - A viewport of someone browsing: dashed edge, 15% fill, dotted grid.
 * - A viewport of someone painting: solid edge, 30% fill, diagonal stripes.
 * - Their drafted pixels: the same colour, solid, so the exact pixels show inside the viewport.
 * - A region claim: solid edge, 30% fill, diagonal stripes. The claim is the union of its shapes,
 *   rasterised to whole pixels and sampled with nearest filtering, so the tint stops on a pixel
 *   edge. The outline is a stroke of fixed device-pixel width along that boundary, found in the
 *   shader by sampling the mask a stroke-width away in screen space, so it never claims a pixel
 *   of its own and stays the same thickness at every zoom.
 * - The claim being edited: the same as a claim, from the editor's working document.
 *
 * Everything arrives and leaves on the shared fade ramp so a painter closing their tab does not
 * blink out.
 */

export const PRESENCE_LAYER_ID = 'caelestis-presence'
const PIXEL_ART_LAYER = 'pixel-art-layer'
const MARKER_LAYER_ID = 'caelestis-markers'
const CROSSHAIR_LAYER = 'pixel-hover'
const TOOL_KEY = 'tool'
/** Mask texel level for an inside pixel; outside stays zero. */
const MASK_INSIDE = 255

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
uniform int u_pattern;
uniform float u_patternAlpha;
uniform float u_scale;
out vec4 fragColor;
bool outsideAt(vec2 uv) {
  // Beyond the texture is outside too; clamping would otherwise repeat the edge texel.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return true;
  return texture(u_mask, uv).r < 0.5;
}
void main() {
  vec2 px = v_uv * u_size;
  float alpha = 0.0;
  bool inside = false;
  bool edge = false;
  if (u_hasMask == 1) {
    inside = !outsideAt(v_uv);
    if (inside) {
      alpha = u_maskAlpha;
      // A stroke of u_borderWidth device pixels along the boundary, drawn on the inside: a
      // fragment is on it when anything that far away, in screen space, is outside the mask.
      if (u_borderWidth > 0.0) {
        vec2 d = vec2(u_borderWidth) / u_size;
        vec2 g = d * 0.7071;
        edge = outsideAt(v_uv + vec2(d.x, 0.0)) || outsideAt(v_uv - vec2(d.x, 0.0)) ||
          outsideAt(v_uv + vec2(0.0, d.y)) || outsideAt(v_uv - vec2(0.0, d.y)) ||
          outsideAt(v_uv + g) || outsideAt(v_uv - g) ||
          outsideAt(v_uv + vec2(g.x, -g.y)) || outsideAt(v_uv - vec2(g.x, -g.y));
      }
    }
  } else {
    inside = true;
    alpha = u_fill;
    if (u_borderWidth > 0.0) {
      float horizontal = min(px.x, u_size.x - px.x);
      float vertical = min(px.y, u_size.y - px.y);
      if (min(horizontal, vertical) < u_borderWidth) {
        float along = horizontal < vertical ? px.y : px.x;
        edge = u_dash <= 0.0 || mod(along, u_dash * 2.0) < u_dash;
      }
    }
  }
  if (inside && u_pattern == 1) {
    // Diagonal stripes, in device pixels so they read the same at every zoom.
    if (mod((px.x + px.y) / u_scale, 12.0) < 4.0) alpha = max(alpha, u_patternAlpha);
  } else if (inside && u_pattern == 2) {
    // A dotted grid.
    vec2 cell = mod(px / u_scale, 8.0);
    if (cell.x < 2.0 && cell.y < 2.0) alpha = max(alpha, u_patternAlpha);
  }
  if (edge) alpha = max(alpha, u_border);
  fragColor = vec4(u_colour * alpha, alpha);
}
`

type Kind = 'viewport' | 'painting' | 'draft' | 'region' | 'tool'

interface Style {
  readonly fill: number
  readonly border: number
  readonly borderWidth: number
  readonly dash: number
  /** Fill alpha inside a mask; `border` and `borderWidth` stroke its boundary in device pixels. */
  readonly maskAlpha: number
  /** 0 none, 1 diagonal stripes, 2 dotted grid. */
  readonly pattern: 0 | 1 | 2
  readonly patternAlpha: number
}

const STYLES: Record<Kind, Style> = {
  viewport: {
    fill: 0.15,
    border: 0.9,
    borderWidth: 1.5,
    dash: 6,
    maskAlpha: 0,
    pattern: 2,
    patternAlpha: 0.35,
  },
  painting: {
    fill: 0.3,
    border: 0.9,
    borderWidth: 1.5,
    dash: 0,
    maskAlpha: 0,
    pattern: 1,
    patternAlpha: 0.5,
  },
  draft: {
    fill: 0,
    border: 0,
    borderWidth: 0,
    dash: 0,
    maskAlpha: 0.55,
    pattern: 0,
    patternAlpha: 0,
  },
  region: {
    fill: 0,
    border: 0.95,
    borderWidth: 1.5,
    dash: 0,
    maskAlpha: 0.3,
    pattern: 1,
    patternAlpha: 0.5,
  },
  tool: {
    fill: 0,
    border: 1,
    borderWidth: 1.5,
    dash: 0,
    maskAlpha: 0.3,
    pattern: 1,
    patternAlpha: 0.5,
  },
}

interface Item {
  readonly key: string
  readonly kind: Kind
  readonly rect: PresenceRect
  readonly colour: readonly [number, number, number]
  /** A draft's base64 bitmask, or a claim's pixels; either becomes a nearest-sampled texture. */
  readonly mask: string | RegionShapePixels | null
  /** Your own claim: its fill steps aside while the pointer is inside it, so you can paint. */
  readonly mine?: boolean
}

interface MaskTexture {
  readonly source: string | RegionShapePixels
  readonly texture: WebGLTexture
}

/** A rect gliding from `from` to `to`, started at `since`. */
interface Motion {
  readonly from: PresenceRect
  readonly to: PresenceRect
  readonly since: number
}

/** A glide lasts exactly one publish interval, so a steadily panning peer never quite stops. */
export const PRESENCE_MOTION_MS = PRESENCE_VIEWPORT_MIN_MS

const motionProgress = (elapsed: number): number => {
  const t = Math.min(1, Math.max(0, elapsed / PRESENCE_MOTION_MS))
  // Cubic ease-out: quick to leave, gentle to arrive, so successive updates chain smoothly.
  return 1 - (1 - t) * (1 - t) * (1 - t)
}

const lerpRect = (from: PresenceRect, to: PresenceRect, t: number): PresenceRect => ({
  x: from.x + (to.x - from.x) * t,
  y: from.y + (to.y - from.y) * t,
  w: from.w + (to.w - from.w) * t,
  h: from.h + (to.h - from.h) * t,
})

/** Rasterised claim documents, kept per region so a redraw does not rasterise again. */
const documentPixels = new Map<string, { document: RegionDocument; pixels: RegionShapePixels }>()

export const regionPixelsFor = (id: string, document: RegionDocument): RegionShapePixels | null => {
  const held = documentPixels.get(id)
  if (held?.document === document) return held.pixels
  const pixels = regionDocumentPixels(document)
  if (pixels === null) {
    documentPixels.delete(id)
    return null
  }
  documentPixels.set(id, { document, pixels })
  return pixels
}

/** Pixels as texels: inside or not. The outline is found in the shader, in device pixels. */
const shapeTexels = ({
  rect,
  mask,
}: RegionShapePixels): { readonly rect: PresenceRect; readonly texels: Uint8Array } => {
  const texels = new Uint8Array(mask.length)
  for (let at = 0; at < mask.length; at++) if (mask[at] === 1) texels[at] = MASK_INSIDE
  return { rect, texels }
}

/** What the presence view and the claim editor say should be on screen, keyed for fading. */
const currentItems = (): Item[] => {
  const view = presenceView()
  const items: Item[] = []
  for (const peer of view.peers) {
    const colour = presenceRgb(peer.painter.wplaceUserId)
    if (peer.viewport !== null) {
      items.push({
        key: `peer:${peer.sessionId}:viewport`,
        kind: peer.draft === null ? 'viewport' : 'painting',
        rect: peer.viewport,
        colour,
        mask: null,
      })
    }
    if (peer.draft?.mask !== undefined) {
      items.push({
        key: `peer:${peer.sessionId}:draft`,
        kind: 'draft',
        rect: peer.draft.rect,
        colour,
        mask: peer.draft.mask,
      })
    }
  }
  const editing = new Set(claimEditorEditingIds())
  const seen = new Set<string>()
  for (const region of view.regions) {
    seen.add(region.id)
    // The claim being edited is drawn by the editor instead, so its stored copy steps aside.
    if (editing.has(region.id)) continue
    const pixels = regionPixelsFor(region.id, region.document)
    if (pixels === null) continue
    items.push({
      key: `region:${region.id}`,
      kind: 'region',
      rect: pixels.rect,
      colour: presenceRgb(region.claimant.wplaceUserId),
      mask: pixels,
      mine: view.me !== null && region.claimant.wplaceUserId === view.me.wplaceUserId,
    })
  }
  for (const id of documentPixels.keys()) if (!seen.has(id)) documentPixels.delete(id)
  const editorPixels = claimEditorPixels()
  if (editorPixels !== null) {
    items.push({
      key: TOOL_KEY,
      kind: 'tool',
      rect: editorPixels.rect,
      colour: view.me === null ? [1, 1, 1] : presenceRgb(view.me.wplaceUserId),
      mask: editorPixels,
    })
  }
  return items
}

const tileRect = (tile: TileQuad): PresenceRect => ({
  x: tile.tile.x * TILE_SIZE,
  y: tile.tile.y * TILE_SIZE,
  w: TILE_SIZE,
  h: TILE_SIZE,
})

class PresenceLayer {
  readonly id = PRESENCE_LAYER_ID
  readonly type = 'custom' as const
  readonly renderingMode = '2d' as const
  private owner: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private quad: WebGLBuffer | null = null
  private vao: WebGLVertexArrayObject | null = null
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>()
  private readonly masks = new Map<string, MaskTexture>()
  private readonly retained = new Map<string, Item>()
  private readonly fades = ramps()
  /** How far each of your own claims has stepped aside under the pointer, 0 to 1. */
  private readonly hovers = ramps()
  private readonly motions = new Map<string, Motion>()
  private readonly corners = new Float32Array(4 * 6)

  /**
   * Where a rect is drawn this frame. A viewport that moved glides from where it was to where it
   * is over `PRESENCE_MOTION_MS`, so peers are seen moving rather than jumping; anything with a
   * mask snaps, because its texture is cut to its rect.
   */
  displayRect(item: Item, now: number): { rect: PresenceRect; moving: boolean } {
    if (item.mask !== null) {
      this.motions.delete(item.key)
      return { rect: item.rect, moving: false }
    }
    const motion = this.motions.get(item.key)
    if (motion === undefined) {
      this.motions.set(item.key, { from: item.rect, to: item.rect, since: now })
      return { rect: item.rect, moving: false }
    }
    if (!sameRect(motion.to, item.rect)) {
      const from = lerpRect(motion.from, motion.to, motionProgress(now - motion.since))
      this.motions.set(item.key, { from, to: item.rect, since: now })
      return { rect: from, moving: true }
    }
    const t = motionProgress(now - motion.since)
    return { rect: t >= 1 ? motion.to : lerpRect(motion.from, motion.to, t), moving: t < 1 }
  }

  /** The rect a keyed item is drawn at right now, for name tags that follow the motion. */
  displayedRect(key: string): PresenceRect | null {
    const item = this.retained.get(key)
    if (item === undefined) return null
    return this.displayRect(item, performance.now()).rect
  }

  private uniform(gl: WebGL2RenderingContext, name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(
        name,
        this.program === null ? null : gl.getUniformLocation(this.program, name),
      )
    }
    return this.uniforms.get(name) ?? null
  }

  private maskTexture(gl: WebGL2RenderingContext, item: Item): WebGLTexture | null {
    if (item.mask === null) return null
    const held = this.masks.get(item.key)
    if (held !== undefined && held.source === item.mask) return held.texture
    if (held !== undefined) gl.deleteTexture(held.texture)
    this.masks.delete(item.key)
    let texels: Uint8Array
    let width: number
    let height: number
    if (typeof item.mask === 'string') {
      const bits = decodePresenceDraftMask({ rect: item.rect, mask: item.mask, pixels: 0 })
      if (bits === null) return null
      const painted = shapeTexels({ rect: item.rect, mask: bits, count: 0 })
      texels = painted.texels
      width = item.rect.w
      height = item.rect.h
    } else {
      const painted = shapeTexels(item.mask)
      texels = painted.texels
      width = painted.rect.w
      height = painted.rect.h
    }
    const texture = gl.createTexture()
    if (texture === null) return null
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, texels)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.masks.set(item.key, { source: item.mask, texture })
    return texture
  }

  private releaseMasks(gl: WebGL2RenderingContext, keep: ReadonlySet<string>): void {
    for (const [key, held] of this.masks) {
      if (keep.has(key)) continue
      gl.deleteTexture(held.texture)
      this.masks.delete(key)
    }
  }

  /** Draw one rect across every host tile it touches, with uv spanning the whole rect. */
  private drawRect(
    gl: WebGL2RenderingContext,
    rect: PresenceRect,
    tiles: readonly TileQuad[],
    bufferWidth: number,
    bufferHeight: number,
  ): void {
    const corners = this.corners
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
      const screenLeft = tile.x + (cutLeft - tileLeft) * scaleX
      const screenRight = tile.x + (cutRight - tileLeft) * scaleX
      const screenTop = tile.y + (cutTop - tileTop) * scaleY
      const screenBottom = tile.y + (cutBottom - tileTop) * scaleY
      const u0 = (cutLeft - rect.x) / rect.w
      const u1 = (cutRight - rect.x) / rect.w
      const v0 = (cutTop - rect.y) / rect.h
      const v1 = (cutBottom - rect.y) / rect.h
      gl.uniform2f(this.uniform(gl, 'u_size'), rect.w * scaleX, rect.h * scaleY)
      writeClipCorner(screenLeft, screenTop, bufferWidth, bufferHeight, u0, v0, corners, 0)
      writeClipCorner(screenRight, screenTop, bufferWidth, bufferHeight, u1, v0, corners, 6)
      writeClipCorner(screenLeft, screenBottom, bufferWidth, bufferHeight, u0, v1, corners, 12)
      writeClipCorner(screenRight, screenBottom, bufferWidth, bufferHeight, u1, v1, corners, 18)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, corners)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
  }

  onAdd(_map: unknown, gl: WebGL2RenderingContext): void {
    // A replacement map can arrive without the old one delivering `onRemove`; those handles belong
    // to the old context, so forget them rather than delete them here.
    this.program = null
    this.quad = null
    this.vao = null
    this.uniforms.clear()
    this.masks.clear()
    this.owner = gl
    this.program = linkTemplateProgram(gl, FRAGMENT_SOURCE)
    if (this.program === null) return
    this.quad = gl.createBuffer()
    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(gl.ARRAY_BUFFER, this.corners.byteLength, gl.DYNAMIC_DRAW)
    const clip = gl.getAttribLocation(this.program, 'a_clip')
    const uv = gl.getAttribLocation(this.program, 'a_uv')
    gl.enableVertexAttribArray(clip)
    gl.vertexAttribPointer(clip, 4, gl.FLOAT, false, 24, 0)
    gl.enableVertexAttribArray(uv)
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 24, 16)
    gl.bindVertexArray(null)
    log('install', 'presence layer added over the artwork')
  }

  onRemove(_map: unknown, gl: WebGL2RenderingContext): void {
    if (this.owner !== gl) return
    this.owner = null
    this.releaseMasks(gl, new Set())
    if (this.quad !== null) gl.deleteBuffer(this.quad)
    if (this.vao !== null) gl.deleteVertexArray(this.vao)
    if (this.program !== null) gl.deleteProgram(this.program)
    this.program = null
    this.quad = null
    this.vao = null
    this.uniforms.clear()
  }

  render(gl: WebGL2RenderingContext, _args: unknown): void {
    // A throw from a custom layer freezes MapLibre's whole render loop, so it never escapes.
    try {
      this.draw(gl)
    } catch (error) {
      warn('install', 'presence layer render failed; skipping this frame', String(error))
    }
  }

  draw(gl: WebGL2RenderingContext): void {
    const { program, vao, quad } = this
    if (program === null || vao === null || quad === null) return
    const now = performance.now()
    const state = getState()
    const shown = state.showPresence
    // The editor's own claim shows even with other painters hidden; it is the user's own work.
    const items = currentItems().filter(
      (item) =>
        item.kind === 'tool' ||
        (shown &&
          (item.kind === 'region' ? state.showPresenceClaims : state.showPresenceViewports)),
    )
    const hovered = hoveredPresenceRegions()
    const keys = new Set<string>()
    for (const item of items) {
      keys.add(item.key)
      this.retained.set(item.key, item)
    }
    // Everything drawn is what is present or still fading out. Ramps start from zero, so a new
    // item arrives over the shared fade rather than appearing. The editor's claim skips the ramp:
    // a shape being dragged has to follow the pointer this frame.
    let animating = false
    const drawn: { item: Item; fade: number }[] = []
    for (const [key, item] of this.retained) {
      if (key === TOOL_KEY) {
        if (keys.has(key)) drawn.push({ item, fade: 1 })
        else this.retained.delete(key)
        continue
      }
      const fade = this.fades.advance(key, keys.has(key) ? 1 : 0, now)
      if (!fade.done) animating = true
      if (fade.value <= 0 && fade.done && !keys.has(key)) {
        this.retained.delete(key)
        continue
      }
      if (fade.value > 0) drawn.push({ item, fade: fade.value })
    }
    this.fades.prune(new Set(this.retained.keys()))
    this.hovers.prune(new Set(this.retained.keys()))
    this.releaseMasks(
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
        gl.uniform1f(this.uniform(gl, 'u_scale'), deviceScale)
        for (const { item, fade } of drawn) {
          const style = STYLES[item.kind]
          const texture = this.maskTexture(gl, item)
          // Your own claim under the pointer: the fill and stripes fade out over the shared ramp
          // and the outline stays, so the pixels underneath show in their true colours.
          let aside = 0
          if (item.mine === true) {
            const target = hovered.has(item.key.slice('region:'.length)) ? 1 : 0
            const ramp = this.hovers.advance(item.key, target, now)
            aside = ramp.value
            if (!ramp.done) animating = true
          }
          const fill = 1 - aside
          gl.uniform3f(this.uniform(gl, 'u_colour'), item.colour[0], item.colour[1], item.colour[2])
          gl.uniform1f(this.uniform(gl, 'u_fill'), style.fill * fade)
          gl.uniform1f(this.uniform(gl, 'u_border'), style.border * fade)
          gl.uniform1f(this.uniform(gl, 'u_borderWidth'), style.borderWidth * deviceScale)
          gl.uniform1f(this.uniform(gl, 'u_dash'), style.dash * deviceScale)
          gl.uniform1f(this.uniform(gl, 'u_maskAlpha'), style.maskAlpha * fade * fill)
          gl.uniform1i(this.uniform(gl, 'u_pattern'), style.pattern)
          gl.uniform1f(this.uniform(gl, 'u_patternAlpha'), style.patternAlpha * fade * fill)
          gl.uniform1i(this.uniform(gl, 'u_hasMask'), texture === null ? 0 : 1)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, texture)
          gl.uniform1i(this.uniform(gl, 'u_mask'), 0)
          const shown = this.displayRect(item, now)
          if (shown.moving) animating = true
          this.drawRect(gl, shown.rect, tiles, bufferWidth, bufferHeight)
        }
        gl.bindVertexArray(null)
      }
    }
    for (const key of [...this.motions.keys()])
      if (!this.retained.has(key)) this.motions.delete(key)
    if (animating) {
      const map = getMap() as { triggerRepaint?: () => void } | null
      map?.triggerRepaint?.()
    }
  }
}

export const presenceLayer = new PresenceLayer()

/** Where a peer's viewport or draft is drawn right now, mid-glide included. */
export const displayedPresenceRect = (key: string): PresenceRect | null =>
  presenceLayer.displayedRect(key)

/** Ask MapLibre for a frame after presence data changed while the map is idle. */
export const repaintPresence = (): void => {
  const map = getMap() as { triggerRepaint?: () => void } | null
  map?.triggerRepaint?.()
}

interface LayerMap {
  addLayer?: (layer: unknown, before?: string) => void
  getLayer?: (id: string) => unknown
  moveLayer?: (id: string, before?: string) => void
  style?: { _order?: string[] }
}

/**
 * Put the layer just under Wplace's crosshair and keep it there across style changes.
 *
 * It needs the crosshair to sit below, and it must stay above the pixel art and our markers; a
 * basemap swap can leave it present but in the wrong place, which is what the order check catches.
 * Without the anchor there is nothing to be relative to yet, so this waits for the next pass.
 */
export const installPresenceLayer = (): boolean => {
  const map = getMap() as LayerMap | null
  if (map?.addLayer === undefined) return false
  if (map.getLayer?.(CROSSHAIR_LAYER) === undefined) return false
  try {
    if (map.getLayer?.(PRESENCE_LAYER_ID) === undefined) {
      map.addLayer(presenceLayer, CROSSHAIR_LAYER)
      log('install', `${PRESENCE_LAYER_ID} inserted before ${CROSSHAIR_LAYER}`)
      return true
    }
    const order = map.style?._order
    if (order === undefined || map.moveLayer === undefined) return true
    const at = order.indexOf(PRESENCE_LAYER_ID)
    const anchorAt = order.indexOf(CROSSHAIR_LAYER)
    const belowSomethingItShouldFollow = [MARKER_LAYER_ID, PIXEL_ART_LAYER].some((id) => {
      const index = order.indexOf(id)
      return index >= 0 && index > at
    })
    if (at >= 0 && ((anchorAt >= 0 && at > anchorAt) || belowSomethingItShouldFollow)) {
      map.moveLayer(PRESENCE_LAYER_ID, CROSSHAIR_LAYER)
      log('install', `restored ${PRESENCE_LAYER_ID} order after a style change`)
    }
    return true
  } catch (error) {
    warn('install', `could not add ${PRESENCE_LAYER_ID}`, String(error))
    return false
  }
}
