import {
  decodePresenceDraftMask,
  type PresenceRect,
  type RegionShape,
  rectsIntersect,
  regionShapePixels,
  TILE_SIZE,
} from '@caelestis/shared'
import { claimToolEditingId, claimToolShape } from '../claim-tool.js'
import { log, warn } from '../debug.js'
import { getMap } from '../map-handle.js'
import { presenceView } from '../presence-client.js'
import { presenceRgb } from '../presence-colour.js'
import { getState } from '../state.js'
import { currentQuads, isDrawingTiles, type TileQuad } from '../tile-transform.js'
import { ramps } from './fade.js'
import { linkTemplateProgram, writeClipCorner } from './renderer-core.js'

/**
 * Other painters, drawn as two MapLibre custom layers that share one program.
 *
 * Drafts and region claims go *under* `pixel-art-layer`, so every placed pixel covers them and the
 * tint only shows where the canvas is still empty. A claim is a statement about unfinished space,
 * and finished art should never be recoloured by it.
 *
 * Viewports go *over* the artwork and our own overlay, just under Wplace's crosshair. A viewport is
 * a cursor, not a claim: it has to stay visible wherever the other painter is looking, including
 * over finished art, or it says nothing once an area fills in. It is a faint fill with a dashed
 * edge, so it reads as an outline rather than a tint.
 *
 * Every rect is drawn on the tile grid, and every draft and claim is a whole-pixel mask sampled
 * with nearest filtering: the tint stops exactly at a pixel edge, never half way across one. A
 * claim's edge pixels carry a stronger value so the outline stays crisp without any smoothing.
 * Everything arrives and leaves on the shared fade ramp so a painter closing their tab does not
 * blink out.
 */

export const PRESENCE_LAYER_ID = 'caelestis-presence'
export const PRESENCE_VIEWPORT_LAYER_ID = 'caelestis-presence-viewports'
const OUTLINE_LAYER_ID = 'caelestis-outline'
const PIXEL_ART_LAYER = 'pixel-art-layer'
const MARKER_LAYER_ID = 'caelestis-markers'
const CROSSHAIR_LAYER = 'pixel-hover'
const TOOL_KEY = 'tool'
/** Mask texel levels: outside, inside, and inside-on-the-edge. */
const MASK_INSIDE = 128
const MASK_EDGE = 255

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
uniform float u_maskEdge;
out vec4 fragColor;
void main() {
  float alpha = u_fill;
  if (u_hasMask == 1) {
    float level = texture(u_mask, v_uv).r;
    if (level > 0.9) alpha = max(alpha, u_maskEdge);
    else if (level > 0.4) alpha = max(alpha, u_maskAlpha);
  }
  if (u_borderWidth > 0.0) {
    vec2 px = v_uv * u_size;
    float horizontal = min(px.x, u_size.x - px.x);
    float vertical = min(px.y, u_size.y - px.y);
    float edge = min(horizontal, vertical);
    if (edge < u_borderWidth) {
      float along = horizontal < vertical ? px.y : px.x;
      bool on = u_dash <= 0.0 || mod(along, u_dash * 2.0) < u_dash;
      if (on) alpha = max(alpha, u_border);
    }
  }
  fragColor = vec4(u_colour * alpha, alpha);
}
`

type Kind = 'viewport' | 'draft' | 'region' | 'tool'

interface Style {
  readonly fill: number
  readonly border: number
  readonly borderWidth: number
  readonly dash: number
  readonly maskAlpha: number
  readonly maskEdge: number
}

const STYLES: Record<Kind, Style> = {
  viewport: { fill: 0.04, border: 0.35, borderWidth: 1.5, dash: 6, maskAlpha: 0, maskEdge: 0 },
  draft: { fill: 0.1, border: 0.6, borderWidth: 1.5, dash: 0, maskAlpha: 0.5, maskEdge: 0.5 },
  region: { fill: 0, border: 0, borderWidth: 0, dash: 0, maskAlpha: 0.1, maskEdge: 0.5 },
  tool: { fill: 0, border: 0, borderWidth: 0, dash: 0, maskAlpha: 0.22, maskEdge: 0.85 },
}

interface Item {
  readonly key: string
  readonly kind: Kind
  readonly rect: PresenceRect
  readonly colour: readonly [number, number, number]
  /** A draft's base64 bitmask, or a claim's shape; either becomes a nearest-sampled texture. */
  readonly mask: string | RegionShape | null
  readonly mine: boolean
}

interface MaskTexture {
  readonly source: string | RegionShape
  readonly texture: WebGLTexture
}

/** Paint a shape's pixels as texel levels, marking pixels whose 4-neighbour is outside as edge. */
const shapeTexels = (
  shape: RegionShape,
): { readonly rect: PresenceRect; readonly texels: Uint8Array } => {
  const { rect, mask } = regionShapePixels(shape)
  const texels = new Uint8Array(mask.length)
  const { w, h } = rect
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = y * w + x
      if (mask[at] !== 1) continue
      const edge =
        x === 0 ||
        y === 0 ||
        x === w - 1 ||
        y === h - 1 ||
        mask[at - 1] !== 1 ||
        mask[at + 1] !== 1 ||
        mask[at - w] !== 1 ||
        mask[at + w] !== 1
      texels[at] = edge ? MASK_EDGE : MASK_INSIDE
    }
  }
  return { rect, texels }
}

/** What the presence view and the claim tool say should be on screen, keyed for fading. */
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
  const editing = claimToolEditingId()
  for (const region of view.regions) {
    // The claim being edited is drawn by the tool instead, so its stored copy steps aside.
    if (region.id === editing) continue
    items.push({
      key: `region:${region.id}`,
      kind: 'region',
      rect: region.rect,
      colour: presenceRgb(region.claimant.wplaceUserId),
      mask: region.shape,
      mine: view.me?.wplaceUserId === region.claimant.wplaceUserId,
    })
  }
  const tool = claimToolShape()
  if (tool !== null) {
    const { rect } = regionShapePixels(tool)
    items.push({
      key: TOOL_KEY,
      kind: 'tool',
      rect,
      colour: view.me === null ? [1, 1, 1] : presenceRgb(view.me.wplaceUserId),
      mask: tool,
      mine: true,
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

/** One custom layer drawing a subset of presence rects. Two instances split under and over. */
class PresenceLayer {
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
  private readonly corners = new Float32Array(4 * 6)

  constructor(
    readonly id: string,
    private readonly kinds: ReadonlySet<Kind>,
    private readonly placement: string,
  ) {}

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
      texels = bits.map((bit) => (bit === 0 ? 0 : MASK_EDGE))
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
    log('install', `presence layer added ${this.placement}`)
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
    const shown = getState().showPresence
    // The tool's own shape shows even with other painters hidden; it is the user's own work.
    const items = currentItems().filter(
      (item) => this.kinds.has(item.kind) && (shown || item.kind === 'tool'),
    )
    const keys = new Set<string>()
    for (const item of items) {
      keys.add(item.key)
      this.retained.set(item.key, item)
    }
    // Everything drawn is what is present or still fading out. Ramps start from zero, so a new
    // item arrives over the shared fade rather than appearing. The tool preview skips the ramp:
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
        for (const { item, fade } of drawn) {
          const style = STYLES[item.kind]
          const texture = this.maskTexture(gl, item)
          const emphasis = item.mine && item.kind === 'region' ? 1.4 : 1
          gl.uniform3f(this.uniform(gl, 'u_colour'), item.colour[0], item.colour[1], item.colour[2])
          gl.uniform1f(this.uniform(gl, 'u_fill'), style.fill * emphasis * fade)
          gl.uniform1f(this.uniform(gl, 'u_border'), Math.min(1, style.border * emphasis) * fade)
          gl.uniform1f(this.uniform(gl, 'u_borderWidth'), style.borderWidth * deviceScale)
          gl.uniform1f(this.uniform(gl, 'u_dash'), style.dash * deviceScale)
          gl.uniform1f(
            this.uniform(gl, 'u_maskAlpha'),
            Math.min(1, style.maskAlpha * emphasis) * fade,
          )
          gl.uniform1f(
            this.uniform(gl, 'u_maskEdge'),
            Math.min(1, style.maskEdge * emphasis) * fade,
          )
          gl.uniform1i(this.uniform(gl, 'u_hasMask'), texture === null ? 0 : 1)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, texture)
          gl.uniform1i(this.uniform(gl, 'u_mask'), 0)
          this.drawRect(gl, item.rect, tiles, bufferWidth, bufferHeight)
        }
        gl.bindVertexArray(null)
      }
    }
    if (animating) {
      const map = getMap() as { triggerRepaint?: () => void } | null
      map?.triggerRepaint?.()
    }
  }
}

/** Drafts, claims, and the claim tool's shape, under the artwork. */
export const presenceLayer = new PresenceLayer(
  PRESENCE_LAYER_ID,
  new Set<Kind>(['draft', 'region', 'tool']),
  'under the artwork',
)

/** Viewports, over the artwork and our overlay, under Wplace's crosshair. */
export const presenceViewportLayer = new PresenceLayer(
  PRESENCE_VIEWPORT_LAYER_ID,
  new Set<Kind>(['viewport']),
  'over the artwork',
)

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
 * Insert one layer before its anchor, or move it back there if a style change displaced it.
 *
 * `anchors` are tried in order; the first one present wins. `mustFollow` names layers that have to
 * stay below this one, which is what catches a basemap swap that leaves the layer present but in
 * the wrong place.
 */
const place = (
  map: LayerMap,
  layer: PresenceLayer,
  anchors: readonly string[],
  mustFollow: readonly string[],
): boolean => {
  const anchor = anchors.find((id) => map.getLayer?.(id) !== undefined)
  if (anchor === undefined) return false
  try {
    if (map.getLayer?.(layer.id) === undefined) {
      map.addLayer?.(layer, anchor)
      log('install', `${layer.id} inserted before ${anchor}`)
      return true
    }
    const order = map.style?._order
    if (order === undefined || map.moveLayer === undefined) return true
    const at = order.indexOf(layer.id)
    const anchorAt = order.indexOf(anchor)
    const belowSomethingItShouldFollow = mustFollow.some((id) => {
      const index = order.indexOf(id)
      return index >= 0 && index > at
    })
    if (at >= 0 && ((anchorAt >= 0 && at > anchorAt) || belowSomethingItShouldFollow)) {
      map.moveLayer(layer.id, anchor)
      log('install', `restored ${layer.id} order after a style change`)
    }
    return true
  } catch (error) {
    warn('install', `could not add ${layer.id}`, String(error))
    return false
  }
}

/**
 * Put both layers in Wplace's style and keep them there across style changes.
 *
 * The under layer needs the outline or the pixel art to sit below; the over layer needs the
 * crosshair to sit below and the markers to sit above. Without those anchors there is nothing to
 * be relative to yet, so this waits for the overlay installer's next pass.
 */
export const installPresenceLayer = (): boolean => {
  const map = getMap() as LayerMap | null
  if (map?.addLayer === undefined) return false
  const under = place(map, presenceLayer, [OUTLINE_LAYER_ID, PIXEL_ART_LAYER], [])
  const over = place(
    map,
    presenceViewportLayer,
    [CROSSHAIR_LAYER],
    [MARKER_LAYER_ID, PIXEL_ART_LAYER],
  )
  return under && over
}
