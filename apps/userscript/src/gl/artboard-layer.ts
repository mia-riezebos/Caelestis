import {
  PALETTE_SIZE,
  type TemplateSurface,
  TRANSPARENT_INDEX,
  templateSurfaceBounds,
  WPLACE_PALETTE,
} from '@caelestis/shared'
import {
  type ActiveAllianceSurface,
  activeAllianceSurface,
  onActiveAllianceSurfaceChange,
} from '../alliance-surface.js'
import { warn } from '../debug.js'
import { onStateChange } from '../state.js'
import { isPlain } from '../templates/appearance.js'
import { appearanceWithPreview } from '../templates/appearance-preview.js'
import { hiddenColoursFor } from '../templates/colour-filter.js'
import {
  appearanceOf,
  displayTemplatesForSurface,
  isTemplateVisible,
  onLocalChange,
  onLocalPreviewChange,
  type PlacedTemplate,
} from '../templates/local-store.js'
import { linkTemplateProgram, writeClipCorner } from './renderer-core.js'
import { FRAGMENT_SOURCE } from './shaders.js'

const CANVAS_ATTRIBUTE = 'data-caelestis-alliance-overlay'

export interface ArtboardGeometry {
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
}

export const artboardGeometry = (active: ActiveAllianceSurface): ArtboardGeometry | null => {
  const bounds =
    active.surface.kind === 'alliance-headquarters'
      ? active.bounds
      : templateSurfaceBounds(active.surface)
  if (bounds === null) return null
  return {
    originX: bounds.minX,
    originY: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  }
}

/** Signed HQ placement becomes frame-local only at this final projection boundary. */
export const artboardPlacement = (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height'>,
  geometry: ArtboardGeometry,
) => ({
  left: template.originX - geometry.originX,
  top: template.originY - geometry.originY,
  right: template.originX - geometry.originX + template.width,
  bottom: template.originY - geometry.originY + template.height,
})

/** Keep base art below us and Wplace's own full-artboard overlay/feedback above us. */
export const insertAllianceOverlayCanvas = (
  frame: HTMLElement,
  canvas: HTMLCanvasElement,
): void => {
  const directCanvases = [...frame.children].filter(
    (child): child is HTMLCanvasElement =>
      child.tagName === 'CANVAS' && !child.hasAttribute(CANVAS_ATTRIBUTE),
  )
  const hasHqTiles = [...frame.children].some((child) => child.classList.contains('hq-tile-layer'))
  const nativeOverlay = hasHqTiles
    ? (directCanvases[0] ?? null)
    : directCanvases.length >= 2
      ? (directCanvases.at(-1) ?? null)
      : null
  frame.insertBefore(canvas, nativeOverlay)
}

interface GpuTemplate {
  readonly indices: WebGLTexture
  readonly palette: WebGLTexture
  readonly source: Uint8Array
  readonly width: number
  readonly height: number
}

const vertices = new Float32Array(4 * 6)

class ArtboardRenderer {
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>()
  private readonly gpu = new Map<string, GpuTemplate>()
  private framePending = false
  private disposed = false

  private constructor(
    readonly canvas: HTMLCanvasElement,
    readonly surface: TemplateSurface,
    readonly geometry: ArtboardGeometry,
    private readonly gl: WebGL2RenderingContext,
    private readonly program: WebGLProgram,
    private readonly quad: WebGLBuffer,
    private readonly vao: WebGLVertexArrayObject,
  ) {}

  static create(
    active: ActiveAllianceSurface,
    geometry: ArtboardGeometry,
  ): ArtboardRenderer | null {
    const canvas = active.frame.ownerDocument.createElement('canvas')
    canvas.setAttribute(CANVAS_ATTRIBUTE, '')
    canvas.setAttribute('aria-hidden', 'true')
    canvas.width = geometry.width
    canvas.height = geometry.height
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
    })
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      stencil: false,
    })
    if (gl === null) return null
    const program = linkTemplateProgram(gl, FRAGMENT_SOURCE)
    const quad = gl.createBuffer()
    const vao = gl.createVertexArray()
    if (program === null || quad === null || vao === null) {
      if (program !== null) gl.deleteProgram(program)
      if (quad !== null) gl.deleteBuffer(quad)
      if (vao !== null) gl.deleteVertexArray(vao)
      return null
    }
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, vertices.byteLength, gl.DYNAMIC_DRAW)
    const clip = gl.getAttribLocation(program, 'a_clip')
    const uv = gl.getAttribLocation(program, 'a_uv')
    gl.enableVertexAttribArray(clip)
    gl.vertexAttribPointer(clip, 4, gl.FLOAT, false, 24, 0)
    gl.enableVertexAttribArray(uv)
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 24, 16)
    gl.bindVertexArray(null)
    insertAllianceOverlayCanvas(active.frame, canvas)
    return new ArtboardRenderer(canvas, active.surface, geometry, gl, program, quad, vao)
  }

  private uniform(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(name, this.gl.getUniformLocation(this.program, name))
    }
    return this.uniforms.get(name) ?? null
  }

  private release(id: string): void {
    const entry = this.gpu.get(id)
    if (entry === undefined) return
    this.gl.deleteTexture(entry.indices)
    this.gl.deleteTexture(entry.palette)
    this.gpu.delete(id)
  }

  private textureFor(template: PlacedTemplate): GpuTemplate | null {
    const held = this.gpu.get(template.id)
    if (
      held !== undefined &&
      held.source === template.indices &&
      held.width === template.width &&
      held.height === template.height
    )
      return held
    this.release(template.id)
    const measured = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as unknown
    if (typeof measured === 'number' && (template.width > measured || template.height > measured))
      return null
    const indices = this.gl.createTexture()
    const palette = this.gl.createTexture()
    if (indices === null || palette === null) {
      if (indices !== null) this.gl.deleteTexture(indices)
      if (palette !== null) this.gl.deleteTexture(palette)
      return null
    }
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, indices)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8UI,
      template.width,
      template.height,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      template.indices,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const entry = {
      indices,
      palette,
      source: template.indices,
      width: template.width,
      height: template.height,
    }
    this.gpu.set(template.id, entry)
    return entry
  }

  private uploadPalette(texture: WebGLTexture, template: PlacedTemplate): void {
    const hidden = new Set(
      hiddenColoursFor(appearanceWithPreview(template.id, appearanceOf(template))),
    )
    const data = new Uint8Array(PALETTE_SIZE * 4)
    for (let index = 0; index < PALETTE_SIZE; index++) {
      const colour = WPLACE_PALETTE[index]
      data[index * 4] = colour?.rgb[0] ?? 0
      data[index * 4 + 1] = colour?.rgb[1] ?? 0
      data[index * 4 + 2] = colour?.rgb[2] ?? 0
      data[index * 4 + 3] =
        colour !== undefined && index !== TRANSPARENT_INDEX && !hidden.has(index) ? 255 : 0
    }
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PALETTE_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  requestRender(): void {
    if (this.disposed || this.framePending) return
    this.framePending = true
    const schedule =
      this.canvas.ownerDocument.defaultView?.requestAnimationFrame ?? requestAnimationFrame
    schedule(() => {
      this.framePending = false
      if (this.disposed) return
      try {
        this.draw()
      } catch (error) {
        warn('install', 'alliance artboard render failed; skipping this frame', String(error))
      }
    })
  }

  private draw(): void {
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const templates = displayTemplatesForSurface(this.surface)
    const ids = new Set(templates.map(({ id }) => id))
    for (const id of this.gpu.keys()) if (!ids.has(id)) this.release(id)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    gl.uniform1i(this.uniform('u_maxMinifyTaps'), 4)
    for (const template of templates) {
      if (!isTemplateVisible(template)) continue
      const entry = this.textureFor(template)
      if (entry === null) continue
      this.uploadPalette(entry.palette, template)
      const appearance = appearanceWithPreview(template.id, appearanceOf(template))
      const placement = artboardPlacement(template, this.geometry)
      if (
        placement.right <= 0 ||
        placement.bottom <= 0 ||
        placement.left >= this.geometry.width ||
        placement.top >= this.geometry.height
      )
        continue
      writeClipCorner(
        placement.left,
        placement.top,
        this.canvas.width,
        this.canvas.height,
        0,
        0,
        vertices,
        0,
      )
      writeClipCorner(
        placement.right,
        placement.top,
        this.canvas.width,
        this.canvas.height,
        1,
        0,
        vertices,
        6,
      )
      writeClipCorner(
        placement.left,
        placement.bottom,
        this.canvas.width,
        this.canvas.height,
        0,
        1,
        vertices,
        12,
      )
      writeClipCorner(
        placement.right,
        placement.bottom,
        this.canvas.width,
        this.canvas.height,
        1,
        1,
        vertices,
        18,
      )
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, entry.indices)
      gl.uniform1i(this.uniform('u_indices'), 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, entry.palette)
      gl.uniform1i(this.uniform('u_palette'), 1)
      gl.uniform2f(this.uniform('u_size'), template.width, template.height)
      gl.uniform1f(this.uniform('u_fade'), 1)
      gl.uniform1f(this.uniform('u_opacity'), appearance.opacity)
      gl.uniform1f(this.uniform('u_stampSize'), appearance.size)
      gl.uniform1f(this.uniform('u_stampRadius'), appearance.radius)
      gl.uniform2f(this.uniform('u_stampOffset'), appearance.translateX, appearance.translateY)
      gl.uniform1f(this.uniform('u_stampRotation'), (appearance.rotation * Math.PI) / 180)
      gl.uniform1i(this.uniform('u_plain'), isPlain(appearance) ? 1 : 0)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    gl.bindVertexArray(null)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const id of [...this.gpu.keys()]) this.release(id)
    this.gl.deleteBuffer(this.quad)
    this.gl.deleteVertexArray(this.vao)
    this.gl.deleteProgram(this.program)
    this.canvas.remove()
  }
}

let renderer: ArtboardRenderer | null = null

const reconcileRenderer = (): void => {
  renderer?.dispose()
  renderer = null
  const active = activeAllianceSurface()
  if (active === null) return
  const geometry = artboardGeometry(active)
  if (geometry === null || geometry.width <= 0 || geometry.height <= 0) return
  renderer = ArtboardRenderer.create(active, geometry)
  renderer?.requestRender()
}

export const repaintAllianceOverlayLayer = (): void => renderer?.requestRender()

/** Attach one independent WebGL canvas inside whichever Wplace alliance artboard is open. */
export const installAllianceOverlayLayer = (): void => {
  onActiveAllianceSurfaceChange(reconcileRenderer)
  onLocalChange(repaintAllianceOverlayLayer)
  onLocalPreviewChange(repaintAllianceOverlayLayer)
  onStateChange(repaintAllianceOverlayLayer)
  reconcileRenderer()
}
