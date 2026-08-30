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
import { isOverlayPeekActive, onOverlayPeekChange } from '../overlay-peek.js'
import { onStateChange } from '../state.js'
import { isPlain } from '../templates/appearance.js'
import { appearanceWithPreview, hasAppearancePreview } from '../templates/appearance-preview.js'
import { hiddenColoursFor } from '../templates/colour-filter.js'
import {
  appearanceOf,
  displayTemplatesForSurface,
  isTemplateVisible,
  onLocalChange,
  onLocalPreviewChange,
  type PlacedTemplate,
} from '../templates/local-store.js'
import { abortMoveOutsideSurface } from '../templates/move.js'
import { detachOverlayControls, renderAllianceOverlayControls } from '../ui/overlay-menu.js'
import { appearanceTransitionSet, prefersReducedMotion } from './appearance-transition.js'
import { isDarkMapTheme } from './contrast-outline.js'
import { ramps } from './fade.js'
import { linkTemplateProgram, writeClipCorner } from './renderer-core.js'
import { FRAGMENT_SOURCE, OUTLINE_FRAGMENT_SOURCE } from './shaders.js'

const OVERLAY_ATTRIBUTE = 'data-caelestis-alliance-overlay'
const OUTLINE_ATTRIBUTE = 'data-caelestis-alliance-outline'

export interface ArtboardGeometry {
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
}

export interface ArtboardViewport {
  readonly bufferWidth: number
  readonly bufferHeight: number
  readonly frameLeft: number
  readonly frameTop: number
  readonly frameWidth: number
  readonly frameHeight: number
}

/** Keep fixed template controls in lockstep with whether the artboard has usable geometry. */
export const reconcileAllianceControlsForViewport = (
  viewport: ArtboardViewport | null,
  render: () => void,
): viewport is ArtboardViewport => {
  if (viewport === null) {
    detachOverlayControls()
    return false
  }
  render()
  return true
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

/** Project an artboard cell rectangle into the viewport-resolution WebGL backing store. */
export const artboardDevicePlacement = (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height'>,
  geometry: ArtboardGeometry,
  viewport: ArtboardViewport,
  margin = 0,
) => {
  const placement = artboardPlacement(template, geometry)
  const scaleX = viewport.frameWidth / geometry.width
  const scaleY = viewport.frameHeight / geometry.height
  return {
    left: viewport.frameLeft + (placement.left - margin) * scaleX,
    top: viewport.frameTop + (placement.top - margin) * scaleY,
    right: viewport.frameLeft + (placement.right + margin) * scaleX,
    bottom: viewport.frameTop + (placement.bottom + margin) * scaleY,
  }
}

const isCaelestisCanvas = (element: Element): boolean =>
  element.hasAttribute(OVERLAY_ATTRIBUTE) || element.hasAttribute(OUTLINE_ATTRIBUTE)

/** Keep the outline below Wplace art, and the coloured overlay below Wplace feedback. */
export const insertAllianceArtboardCanvases = (
  frame: HTMLElement,
  outline: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
): void => {
  outline.style.imageRendering = 'pixelated'
  overlay.style.imageRendering = 'pixelated'
  frame.insertBefore(outline, frame.firstChild)
  const directCanvases = [...frame.children].filter(
    (child): child is HTMLCanvasElement => child.tagName === 'CANVAS' && !isCaelestisCanvas(child),
  )
  const hasHqTiles = [...frame.children].some((child) => child.classList.contains('hq-tile-layer'))
  const nativeOverlay = hasHqTiles
    ? (directCanvases[0] ?? null)
    : directCanvases.length >= 2
      ? (directCanvases.at(-1) ?? null)
      : null
  frame.insertBefore(overlay, nativeOverlay)
}

interface GpuTemplate {
  readonly indices: WebGLTexture
  readonly palette: WebGLTexture
  readonly source: Uint8Array
  readonly width: number
  readonly height: number
}

interface RenderTemplate {
  readonly template: PlacedTemplate
  readonly appearance: ReturnType<typeof appearanceOf>
  readonly fade: number
  readonly outlineFade: number
  readonly palette: Uint8Array
}

const vertices = new Float32Array(4 * 6)

class ArtboardPass {
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>()
  private readonly gpu = new Map<string, GpuTemplate>()

  private constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly kind: 'outline' | 'overlay',
    private readonly gl: WebGL2RenderingContext,
    private readonly program: WebGLProgram,
    private readonly quad: WebGLBuffer,
    private readonly vao: WebGLVertexArrayObject,
  ) {}

  static create(document: Document, kind: 'outline' | 'overlay'): ArtboardPass | null {
    const canvas = document.createElement('canvas')
    canvas.setAttribute(kind === 'outline' ? OUTLINE_ATTRIBUTE : OVERLAY_ATTRIBUTE, '')
    canvas.setAttribute('aria-hidden', 'true')
    Object.assign(canvas.style, {
      position: 'absolute',
      pointerEvents: 'none',
      imageRendering: 'pixelated',
    } satisfies Partial<CSSStyleDeclaration>)
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      stencil: false,
    })
    if (gl === null) return null
    const program = linkTemplateProgram(
      gl,
      kind === 'outline' ? OUTLINE_FRAGMENT_SOURCE : FRAGMENT_SOURCE,
    )
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
    return new ArtboardPass(canvas, kind, gl, program, quad, vao)
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

  private uploadPalette(texture: WebGLTexture, data: Uint8Array): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PALETTE_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  private writeQuad(
    box: {
      readonly left: number
      readonly top: number
      readonly right: number
      readonly bottom: number
    },
    u0: number,
    v0: number,
    u1: number,
    v1: number,
  ): void {
    writeClipCorner(box.left, box.top, this.canvas.width, this.canvas.height, u0, v0, vertices, 0)
    writeClipCorner(box.right, box.top, this.canvas.width, this.canvas.height, u1, v0, vertices, 6)
    writeClipCorner(
      box.left,
      box.bottom,
      this.canvas.width,
      this.canvas.height,
      u0,
      v1,
      vertices,
      12,
    )
    writeClipCorner(
      box.right,
      box.bottom,
      this.canvas.width,
      this.canvas.height,
      u1,
      v1,
      vertices,
      18,
    )
  }

  draw(
    templates: readonly RenderTemplate[],
    geometry: ArtboardGeometry,
    viewport: ArtboardViewport,
  ): void {
    const gl = this.gl
    gl.disable(gl.SCISSOR_TEST)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (isOverlayPeekActive()) return
    const ids = new Set(templates.map(({ template }) => template.id))
    for (const id of this.gpu.keys()) if (!ids.has(id)) this.release(id)
    const scissorLeft = Math.max(0, Math.floor(viewport.frameLeft))
    const scissorTop = Math.max(0, Math.floor(viewport.frameTop))
    const scissorRight = Math.min(
      this.canvas.width,
      Math.ceil(viewport.frameLeft + viewport.frameWidth),
    )
    const scissorBottom = Math.min(
      this.canvas.height,
      Math.ceil(viewport.frameTop + viewport.frameHeight),
    )
    if (scissorRight <= scissorLeft || scissorBottom <= scissorTop) return
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(
      scissorLeft,
      this.canvas.height - scissorBottom,
      scissorRight - scissorLeft,
      scissorBottom - scissorTop,
    )
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    if (this.kind === 'outline') {
      gl.uniform1i(this.uniform('u_darkTheme'), isDarkMapTheme() ? 1 : 0)
    } else {
      gl.uniform1i(this.uniform('u_maxMinifyTaps'), 4)
    }
    for (const rendered of templates) {
      if (this.kind === 'outline' && rendered.outlineFade <= 0) continue
      const { template, appearance } = rendered
      const entry = this.textureFor(template)
      if (entry === null) continue
      this.uploadPalette(entry.palette, rendered.palette)
      const margin = this.kind === 'outline' ? 1 : 0
      const box = artboardDevicePlacement(template, geometry, viewport, margin)
      if (
        box.right <= viewport.frameLeft ||
        box.bottom <= viewport.frameTop ||
        box.left >= viewport.frameLeft + viewport.frameWidth ||
        box.top >= viewport.frameTop + viewport.frameHeight
      )
        continue
      const uMargin = margin / template.width
      const vMargin = margin / template.height
      this.writeQuad(box, -uMargin, -vMargin, 1 + uMargin, 1 + vMargin)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, entry.indices)
      gl.uniform1i(this.uniform('u_indices'), 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, entry.palette)
      gl.uniform1i(this.uniform('u_palette'), 1)
      gl.uniform2f(this.uniform('u_size'), template.width, template.height)
      gl.uniform1f(this.uniform('u_stampSize'), appearance.size)
      gl.uniform1f(this.uniform('u_stampRadius'), appearance.radius)
      gl.uniform2f(this.uniform('u_stampOffset'), appearance.translateX, appearance.translateY)
      gl.uniform1f(this.uniform('u_stampRotation'), (appearance.rotation * Math.PI) / 180)
      if (this.kind === 'outline') {
        gl.uniform1f(
          this.uniform('u_fade'),
          rendered.fade * appearance.opacity * rendered.outlineFade,
        )
        gl.uniform1f(this.uniform('u_outlineWidth'), appearance.contrastOutlineSize / 8)
      } else {
        gl.uniform1f(this.uniform('u_fade'), rendered.fade)
        gl.uniform1f(this.uniform('u_opacity'), appearance.opacity)
        gl.uniform1i(this.uniform('u_plain'), isPlain(appearance) ? 1 : 0)
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    gl.bindVertexArray(null)
    gl.disable(gl.SCISSOR_TEST)
  }

  dispose(): void {
    for (const id of [...this.gpu.keys()]) this.release(id)
    this.gl.deleteBuffer(this.quad)
    this.gl.deleteVertexArray(this.vao)
    this.gl.deleteProgram(this.program)
    this.canvas.remove()
  }
}

class ArtboardRenderer {
  private readonly templateFades = ramps()
  private readonly colourFades = ramps({ startAt: 'target' })
  private readonly outlineFades = ramps({ startAt: 'target' })
  private readonly appearanceTransitions = appearanceTransitionSet()
  private readonly observer: MutationObserver
  private readonly resizeObserver: ResizeObserver | null
  private framePending = false
  private disposed = false

  private constructor(
    private readonly active: ActiveAllianceSurface,
    readonly surface: TemplateSurface,
    readonly geometry: ArtboardGeometry,
    private readonly outline: ArtboardPass,
    private readonly overlay: ArtboardPass,
  ) {
    this.observer = new MutationObserver(() => this.requestRender())
    this.observer.observe(active.frame, { attributes: true, attributeFilter: ['class', 'style'] })
    this.observer.observe(active.stage, { attributes: true, attributeFilter: ['class', 'style'] })
    this.resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.requestRender()) : null
    this.resizeObserver?.observe(active.frame)
    this.resizeObserver?.observe(active.stage)
  }

  static create(
    active: ActiveAllianceSurface,
    geometry: ArtboardGeometry,
  ): ArtboardRenderer | null {
    const outline = ArtboardPass.create(active.frame.ownerDocument, 'outline')
    const overlay = ArtboardPass.create(active.frame.ownerDocument, 'overlay')
    if (outline === null || overlay === null) {
      outline?.dispose()
      overlay?.dispose()
      return null
    }
    insertAllianceArtboardCanvases(active.frame, outline.canvas, overlay.canvas)
    return new ArtboardRenderer(active, active.surface, geometry, outline, overlay)
  }

  private syncViewport(): ArtboardViewport | null {
    const stage = this.active.stage.getBoundingClientRect()
    const frame = this.active.frame.getBoundingClientRect()
    if (stage.width <= 0 || stage.height <= 0 || frame.width <= 0 || frame.height <= 0) return null
    const dpr = this.active.stage.ownerDocument.defaultView?.devicePixelRatio || 1
    const bufferWidth = Math.max(1, Math.round(stage.width * dpr))
    const bufferHeight = Math.max(1, Math.round(stage.height * dpr))
    for (const pass of [this.outline, this.overlay]) {
      const canvas = pass.canvas
      const left = `${stage.left - frame.left}px`
      const top = `${stage.top - frame.top}px`
      const width = `${stage.width}px`
      const height = `${stage.height}px`
      if (canvas.style.left !== left) canvas.style.left = left
      if (canvas.style.top !== top) canvas.style.top = top
      if (canvas.style.width !== width) canvas.style.width = width
      if (canvas.style.height !== height) canvas.style.height = height
      if (canvas.width !== bufferWidth) canvas.width = bufferWidth
      if (canvas.height !== bufferHeight) canvas.height = bufferHeight
    }
    const scaleX = bufferWidth / stage.width
    const scaleY = bufferHeight / stage.height
    return {
      bufferWidth,
      bufferHeight,
      frameLeft: (frame.left - stage.left) * scaleX,
      frameTop: (frame.top - stage.top) * scaleY,
      frameWidth: frame.width * scaleX,
      frameHeight: frame.height * scaleY,
    }
  }

  private paletteFor(template: PlacedTemplate, now: number): { data: Uint8Array; done: boolean } {
    const hidden = new Set(
      hiddenColoursFor(appearanceWithPreview(template.id, appearanceOf(template))),
    )
    const data = new Uint8Array(PALETTE_SIZE * 4)
    let done = true
    for (let index = 0; index < PALETTE_SIZE; index++) {
      const colour = WPLACE_PALETTE[index]
      const shown = colour !== undefined && index !== TRANSPARENT_INDEX && !hidden.has(index)
      const fade = this.colourFades.advance(`${template.id}:${index}`, shown ? 1 : 0, now)
      if (!fade.done) done = false
      data[index * 4] = colour?.rgb[0] ?? 0
      data[index * 4 + 1] = colour?.rgb[1] ?? 0
      data[index * 4 + 2] = colour?.rgb[2] ?? 0
      data[index * 4 + 3] = Math.round(fade.value * 255)
    }
    return { data, done }
  }

  requestRender(): void {
    if (this.disposed || this.framePending) return
    this.framePending = true
    const schedule =
      this.active.stage.ownerDocument.defaultView?.requestAnimationFrame ?? requestAnimationFrame
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
    const viewport = this.syncViewport()
    if (
      !reconcileAllianceControlsForViewport(viewport, () =>
        renderAllianceOverlayControls(
          () => this.requestRender(),
          this.active,
          this.geometry,
          this.overlay.canvas,
        ),
      )
    )
      return
    const all = displayTemplatesForSurface(this.surface)
    const ids = new Set(all.map(({ id }) => id))
    this.templateFades.prune(ids)
    this.outlineFades.prune(ids)
    this.appearanceTransitions.prune(ids)
    this.colourFades.prune(
      new Set(
        all.flatMap((template) =>
          Array.from({ length: PALETTE_SIZE }, (_, index) => `${template.id}:${index}`),
        ),
      ),
    )
    const now = performance.now()
    const reducedMotion = prefersReducedMotion()
    let animating = false
    const templates: RenderTemplate[] = []
    for (const template of all) {
      const fade = this.templateFades.advance(template.id, isTemplateVisible(template) ? 1 : 0, now)
      if (!fade.done) animating = true
      if (fade.value <= 0) continue
      const target = appearanceWithPreview(template.id, appearanceOf(template))
      const transitioned = this.appearanceTransitions.advance(
        template.id,
        target,
        now,
        reducedMotion,
        hasAppearancePreview(template.id),
      )
      if (!transitioned.done) animating = true
      const outline = this.outlineFades.advance(
        template.id,
        transitioned.appearance.contrastOutline ? 1 : 0,
        now,
      )
      if (!outline.done) animating = true
      const palette = this.paletteFor(template, now)
      if (!palette.done) animating = true
      templates.push({
        template,
        appearance: transitioned.appearance,
        fade: fade.value,
        outlineFade: outline.value,
        palette: palette.data,
      })
    }
    this.outline.draw(templates, this.geometry, viewport)
    this.overlay.draw(templates, this.geometry, viewport)
    if (animating) this.requestRender()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer.disconnect()
    this.resizeObserver?.disconnect()
    detachOverlayControls()
    this.outline.dispose()
    this.overlay.dispose()
  }
}

let renderer: ArtboardRenderer | null = null

const reconcileRenderer = (): void => {
  const active = activeAllianceSurface()
  void abortMoveOutsideSurface(active?.surface ?? null)
  renderer?.dispose()
  renderer = null
  if (active === null) return
  const geometry = artboardGeometry(active)
  if (geometry === null || geometry.width <= 0 || geometry.height <= 0) return
  renderer = ArtboardRenderer.create(active, geometry)
  renderer?.requestRender()
}

export const repaintAllianceOverlayLayer = (): void => renderer?.requestRender()

/** Attach viewport-resolution WebGL passes inside whichever Wplace alliance artboard is open. */
export const installAllianceOverlayLayer = (): void => {
  onActiveAllianceSurfaceChange(reconcileRenderer)
  onLocalChange(repaintAllianceOverlayLayer)
  onLocalPreviewChange(repaintAllianceOverlayLayer)
  onOverlayPeekChange(repaintAllianceOverlayLayer)
  onStateChange(repaintAllianceOverlayLayer)
  reconcileRenderer()
}
