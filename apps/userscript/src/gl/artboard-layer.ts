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
import { onCanvasWrite } from '../canvas-write.js'
import { warn } from '../debug.js'
import { isOverlayPeekActive, onOverlayPeekChange } from '../overlay-peek.js'
import { isProfileEnabled, measureProfile, profileGpu, recordProfileWorkload } from '../profile.js'
import { getState, onlySelectedColourFor, onStateChange } from '../state.js'
import { isColourHidden, isPlain, toRgbUnit } from '../templates/appearance.js'
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
import { isPaintOpen, onPaintSelectionChange, selectedColour } from '../wplace-paint.js'
import { appearanceTransitionSet, prefersReducedMotion } from './appearance-transition.js'
import {
  type ArtboardMarkerBatch,
  type ArtboardMarkerWork,
  artboardMarkerWork,
} from './artboard-markers.js'
import { readArtboardPixels } from './artboard-pixels.js'
import { isDarkMapTheme } from './contrast-outline.js'
import { ramps } from './fade.js'
import {
  type MarkerVisibilityBudget,
  markerSampleRate,
  markerVisibilityBudget,
  visibleMarkerPoints,
} from './marker-density.js'
import { MarkerRenderer, type MarkerStyle } from './marker-renderer.js'
import { movingOverlayTapCap } from './minify-quality.js'
import { linkTemplateProgram, writeClipCorner } from './renderer-core.js'
import { FRAGMENT_SOURCE, OUTLINE_FRAGMENT_SOURCE } from './shaders.js'
import {
  TEMPLATE_GPU_CACHE_BYTES,
  TEMPLATE_UPLOAD_PIXELS_PER_FRAME,
  type TemplateGpuEntry,
  TemplateGpuStore,
  type TemplateGpuTile,
} from './template-gpu-store.js'

const OVERLAY_ATTRIBUTE = 'data-caelestis-alliance-overlay'
const OUTLINE_ATTRIBUTE = 'data-caelestis-alliance-outline'
const MARKERS_ATTRIBUTE = 'data-caelestis-alliance-markers'

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

/** Project one shared GPU chunk, including only the outer outline halo, into an artboard. */
export const artboardGpuTilePlacement = (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height'>,
  source: Pick<
    TemplateGpuTile,
    'x' | 'y' | 'width' | 'height' | 'textureWidth' | 'textureHeight' | 'inset'
  >,
  geometry: ArtboardGeometry,
  viewport: ArtboardViewport,
  margin: number,
) => {
  const leftMargin = source.x === 0 ? Math.min(margin, source.inset) : 0
  const topMargin = source.y === 0 ? Math.min(margin, source.inset) : 0
  const rightMargin =
    source.x + source.width === template.width ? Math.min(margin, source.inset) : 0
  const bottomMargin =
    source.y + source.height === template.height ? Math.min(margin, source.inset) : 0
  return {
    box: artboardDevicePlacement(
      {
        originX: template.originX + source.x - leftMargin,
        originY: template.originY + source.y - topMargin,
        width: source.width + leftMargin + rightMargin,
        height: source.height + topMargin + bottomMargin,
      },
      geometry,
      viewport,
    ),
    u0: (source.inset - leftMargin) / source.textureWidth,
    v0: (source.inset - topMargin) / source.textureHeight,
    u1: (source.inset + source.width + rightMargin) / source.textureWidth,
    v1: (source.inset + source.height + bottomMargin) / source.textureHeight,
  }
}

/** Count marker points inside the current alliance artboard viewport. */
export const visibleArtboardMarkerPoints = (
  batch: ArtboardMarkerBatch,
  geometry: ArtboardGeometry,
  viewport: ArtboardViewport,
  budget: MarkerVisibilityBudget,
): number => {
  const box = artboardDevicePlacement(
    { originX: batch.x, originY: batch.y, width: batch.width, height: batch.height },
    geometry,
    viewport,
  )
  return visibleMarkerPoints(
    batch.marks,
    { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top },
    viewport.bufferWidth,
    viewport.bufferHeight,
    budget,
    batch.width,
    batch.height,
  )
}

const isCaelestisCanvas = (element: Element): boolean =>
  element.hasAttribute(OVERLAY_ATTRIBUTE) ||
  element.hasAttribute(OUTLINE_ATTRIBUTE) ||
  element.hasAttribute(MARKERS_ATTRIBUTE)

/** Match the world pass order: outline, native art, overlay, native draft, then markers. */
export const insertAllianceArtboardCanvases = (
  frame: HTMLElement,
  outline: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  markers: HTMLCanvasElement,
): void => {
  outline.style.imageRendering = 'pixelated'
  overlay.style.imageRendering = 'pixelated'
  markers.style.imageRendering = 'pixelated'
  frame.insertBefore(outline, frame.firstChild)
  const directCanvases = [...frame.children].filter(
    (child): child is HTMLCanvasElement => child.tagName === 'CANVAS' && !isCaelestisCanvas(child),
  )
  const hasHqTiles = [...frame.children].some((child) => child.classList.contains('hq-tile-layer'))
  const nativeDraft = hasHqTiles
    ? (directCanvases[0] ?? null)
    : directCanvases.length >= 2
      ? (directCanvases.at(-1) ?? null)
      : null
  frame.insertBefore(overlay, nativeDraft)
  frame.insertBefore(markers, nativeDraft?.nextSibling ?? null)
}

interface RenderTemplate {
  readonly template: PlacedTemplate
  readonly appearance: ReturnType<typeof appearanceOf>
  readonly fade: number
  readonly outlineFade: number
  readonly palette: Uint8Array
}

interface RenderMarker {
  readonly batch: ArtboardMarkerBatch
  readonly style: MarkerStyle
  readonly fade: number
  readonly sampleRate: number
}

interface ArtboardDrawResult {
  readonly animating: boolean
  readonly uploadedPixels: number
  readonly drawIntersections: number
}

const vertices = new Float32Array(4 * 6)

class ArtboardPass {
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>()
  private readonly gpu: TemplateGpuStore | null

  private constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly kind: 'outline' | 'overlay' | 'markers',
    private readonly gl: WebGL2RenderingContext,
    private readonly program: WebGLProgram,
    private readonly quad: WebGLBuffer,
    private readonly vao: WebGLVertexArrayObject,
    private readonly markers: MarkerRenderer | null,
  ) {
    this.gpu =
      kind === 'markers' ? null : new TemplateGpuStore(gl, Math.floor(TEMPLATE_GPU_CACHE_BYTES / 2))
  }

  static create(document: Document, kind: 'outline' | 'overlay' | 'markers'): ArtboardPass | null {
    const canvas = document.createElement('canvas')
    canvas.setAttribute(
      kind === 'outline'
        ? OUTLINE_ATTRIBUTE
        : kind === 'overlay'
          ? OVERLAY_ATTRIBUTE
          : MARKERS_ATTRIBUTE,
      '',
    )
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
    return new ArtboardPass(
      canvas,
      kind,
      gl,
      program,
      quad,
      vao,
      kind === 'markers' ? new MarkerRenderer(gl) : null,
    )
  }

  private uniform(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(name, this.gl.getUniformLocation(this.program, name))
    }
    return this.uniforms.get(name) ?? null
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

  private draw(
    templates: readonly RenderTemplate[],
    markers: readonly RenderMarker[],
    allIds: ReadonlySet<string>,
    geometry: ArtboardGeometry,
    viewport: ArtboardViewport,
    uploadAllowance: number,
    generation: number,
    minifyTapCap: number,
  ): ArtboardDrawResult {
    const gl = this.gl
    let animating = false
    let uploadedPixels = 0
    let drawIntersections = 0
    gl.disable(gl.SCISSOR_TEST)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (isOverlayPeekActive()) return { animating, uploadedPixels, drawIntersections }
    const margin = this.kind === 'outline' ? 1 : 0
    const visible = templates.filter(({ template, outlineFade }) => {
      if (this.kind === 'outline' && outlineFade <= 0) return false
      const box = artboardDevicePlacement(template, geometry, viewport, margin)
      return (
        box.right > viewport.frameLeft &&
        box.bottom > viewport.frameTop &&
        box.left < viewport.frameLeft + viewport.frameWidth &&
        box.top < viewport.frameTop + viewport.frameHeight
      )
    })
    this.gpu?.collect(allIds, new Set(visible.map(({ template }) => template.id)))
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
    if (scissorRight <= scissorLeft || scissorBottom <= scissorTop)
      return { animating, uploadedPixels, drawIntersections }
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
    } else if (this.kind === 'overlay') {
      gl.uniform1i(this.uniform('u_maxMinifyTaps'), minifyTapCap)
    }
    let uploadsLeft = visible.reduce(
      (total, { template }) => total + (this.gpu?.hasCurrent(template) === false ? 1 : 0),
      0,
    )
    let uploadPixelsLeft = uploadAllowance
    for (const rendered of visible) {
      const { template, appearance } = rendered
      let entry: TemplateGpuEntry | null = null
      if (this.gpu !== null) {
        const allowance = uploadsLeft > 0 ? Math.floor(uploadPixelsLeft / uploadsLeft) : 0
        if (!this.gpu.hasCurrent(template)) uploadsLeft = Math.max(0, uploadsLeft - 1)
        const advanced = this.gpu.advance(template, allowance, generation)
        uploadPixelsLeft -= advanced.uploadedPixels
        uploadedPixels += advanced.uploadedPixels
        if (advanced.status !== 'complete') {
          animating = true
          continue
        }
        entry = advanced.entry
      }
      if (entry === null) continue
      this.gpu?.uploadPalette(entry, rendered.palette)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, entry.palette)
      gl.uniform1i(this.uniform('u_palette'), 1)
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
      for (const source of entry.indices) {
        const placement = artboardGpuTilePlacement(template, source, geometry, viewport, margin)
        this.writeQuad(placement.box, placement.u0, placement.v0, placement.u1, placement.v1)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, source.texture)
        gl.uniform1i(this.uniform('u_indices'), 0)
        gl.uniform2f(this.uniform('u_size'), source.textureWidth, source.textureHeight)
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        drawIntersections++
      }
    }
    gl.bindVertexArray(null)
    if (this.markers !== null) {
      const scaleX = viewport.frameWidth / geometry.width
      const scaleY = viewport.frameHeight / geometry.height
      this.markers.beginFrame()
      for (const marker of markers) {
        const { batch } = marker
        this.markers.draw(
          {
            x: viewport.frameLeft + (batch.x - geometry.originX) * scaleX,
            y: viewport.frameTop + (batch.y - geometry.originY) * scaleY,
            width: batch.width * scaleX,
            height: batch.height * scaleY,
            pixelWidth: batch.width,
            pixelHeight: batch.height,
            seedX: Math.floor(batch.x / batch.width),
            seedY: Math.floor(batch.y / batch.height),
          },
          batch.marks,
          marker.style,
          marker.fade,
          marker.sampleRate,
        )
      }
      this.markers.endFrame()
    }
    gl.disable(gl.SCISSOR_TEST)
    return { animating, uploadedPixels, drawIntersections }
  }

  render(
    templates: readonly RenderTemplate[],
    markers: readonly RenderMarker[],
    allIds: ReadonlySet<string>,
    geometry: ArtboardGeometry,
    viewport: ArtboardViewport,
    uploadAllowance: number,
    generation: number,
    minifyTapCap: number,
  ): ArtboardDrawResult {
    const name =
      this.kind === 'outline'
        ? 'Alliance outline'
        : this.kind === 'overlay'
          ? 'Alliance overlay'
          : 'Alliance markers'
    return profileGpu(this.gl, `${name} GPU`, () =>
      measureProfile(`${name} render`, () =>
        this.draw(
          templates,
          markers,
          allIds,
          geometry,
          viewport,
          uploadAllowance,
          generation,
          minifyTapCap,
        ),
      ),
    )
  }

  memoryBytes(): number {
    return this.gpu?.memoryBytes() ?? this.markers?.memoryBytes() ?? 0
  }

  dispose(): void {
    this.gpu?.dispose()
    this.gl.deleteBuffer(this.quad)
    this.gl.deleteVertexArray(this.vao)
    this.gl.deleteProgram(this.program)
    this.markers?.dispose()
    this.canvas.remove()
  }
}

class ArtboardRenderer {
  private readonly templateFades = ramps()
  private readonly colourFades = ramps({ startAt: 'target' })
  private readonly outlineFades = ramps({ startAt: 'target' })
  private readonly markerFades = ramps({ startAt: 'target' })
  private readonly selectedColourMarkerFades = ramps()
  private readonly selectedMarkerColours = new Set<number>()
  private latestSelectedMarkerColour: number | null = null
  private readonly appearanceTransitions = appearanceTransitionSet()
  private readonly observer: MutationObserver
  private readonly resizeObserver: ResizeObserver | null
  private framePending = false
  private markerPixelsDirty = true
  private readonly markerWork = new Map<string, ArtboardMarkerWork>()
  private renderGeneration = 0
  private lastViewportKey = ''
  private settleFramePending = false
  private disposed = false

  private constructor(
    private readonly active: ActiveAllianceSurface,
    readonly surface: TemplateSurface,
    readonly geometry: ArtboardGeometry,
    private readonly outline: ArtboardPass,
    private readonly overlay: ArtboardPass,
    private readonly markers: ArtboardPass,
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
    const markers = ArtboardPass.create(active.frame.ownerDocument, 'markers')
    if (outline === null || overlay === null || markers === null) {
      outline?.dispose()
      overlay?.dispose()
      markers?.dispose()
      return null
    }
    insertAllianceArtboardCanvases(active.frame, outline.canvas, overlay.canvas, markers.canvas)
    return new ArtboardRenderer(active, active.surface, geometry, outline, overlay, markers)
  }

  private syncViewport(): ArtboardViewport | null {
    const stage = this.active.stage.getBoundingClientRect()
    const frame = this.active.frame.getBoundingClientRect()
    if (stage.width <= 0 || stage.height <= 0 || frame.width <= 0 || frame.height <= 0) return null
    const dpr = this.active.stage.ownerDocument.defaultView?.devicePixelRatio || 1
    const bufferWidth = Math.max(1, Math.round(stage.width * dpr))
    const bufferHeight = Math.max(1, Math.round(stage.height * dpr))
    for (const pass of [this.outline, this.overlay, this.markers]) {
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

  private viewportIsMoving(viewport: ArtboardViewport): boolean {
    const key = [
      viewport.frameLeft,
      viewport.frameTop,
      viewport.frameWidth,
      viewport.frameHeight,
    ].join(':')
    const moving = this.lastViewportKey !== '' && key !== this.lastViewportKey
    this.lastViewportKey = key
    if (moving) this.settleFramePending = true
    else if (this.settleFramePending) this.settleFramePending = false
    return moving
  }

  private paletteFor(template: PlacedTemplate, now: number): { data: Uint8Array; done: boolean } {
    const hidden = new Set(
      hiddenColoursFor(appearanceWithPreview(template.id, appearanceOf(template)), this.surface),
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

  invalidatePixels(): void {
    this.markerPixelsDirty = true
    this.requestRender()
  }

  nativeCanvasWritten(canvas: object): void {
    try {
      if (this.active.frame.contains(canvas as Node)) this.invalidatePixels()
    } catch {
      // Offscreen and foreign-realm canvases cannot belong to this DOM artboard.
    }
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
    this.renderGeneration++
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
    const selected = isPaintOpen() ? selectedColour() : null
    if (selected !== null && selected !== this.latestSelectedMarkerColour) {
      this.selectedMarkerColours.add(selected)
      this.latestSelectedMarkerColour = selected
    }
    const selectedColourKeys = new Set<string>()
    const selectedColourFades: { index: number; fade: number }[] = []
    for (const index of [...this.selectedMarkerColours]) {
      const key = String(index)
      const target = index === this.latestSelectedMarkerColour ? 1 : 0
      const fade = this.selectedColourMarkerFades.advance(key, target, now)
      if (!fade.done) animating = true
      if (target > 0 || fade.value > 0 || !fade.done) selectedColourKeys.add(key)
      if (fade.value > 0) selectedColourFades.push({ index, fade: fade.value })
      if (target === 0 && fade.done) this.selectedMarkerColours.delete(index)
    }
    this.selectedColourMarkerFades.prune(selectedColourKeys)
    if (this.markerPixelsDirty) {
      const regions = readArtboardPixels(this.active, this.geometry)
      this.markerWork.clear()
      for (const template of all) {
        this.markerWork.set(
          template.id,
          artboardMarkerWork(
            template,
            regions,
            appearanceWithPreview(template.id, appearanceOf(template)),
          ),
        )
      }
      this.markerPixelsDirty = false
    }
    const selectedLayers: Omit<RenderMarker, 'sampleRate'>[] = []
    const mismatchLayers: Omit<RenderMarker, 'sampleRate'>[] = []
    const markerKeys = new Set<string>()
    const state = getState()
    for (const rendered of templates) {
      const appearance = rendered.appearance
      const work = this.markerWork.get(rendered.template.id)
      if (work === undefined) continue
      const mismatchKey = `mismatch:${rendered.template.id}`
      const selectedKey = `selected:${rendered.template.id}`
      markerKeys.add(mismatchKey)
      markerKeys.add(selectedKey)
      const mismatchFade = this.markerFades.advance(
        mismatchKey,
        appearance.markMismatch ? 1 : 0,
        now,
      )
      const selectedMarkerFade = this.markerFades.advance(
        selectedKey,
        appearance.markSelectedColour && selected !== null && !isColourHidden(appearance, selected)
          ? 1
          : 0,
        now,
      )
      if (!mismatchFade.done || !selectedMarkerFade.done) animating = true
      const mismatchStyle: MarkerStyle = {
        size: appearance.markerSize,
        thickness: 2,
        colour: toRgbUnit(appearance.markerColour),
        otherColour:
          !appearance.dimOthers || appearance.otherColour === null
            ? null
            : toRgbUnit(appearance.otherColour),
        otherOpacity: appearance.dimOthers ? appearance.otherOpacity : 1,
        selected: onlySelectedColourFor(this.surface) && selected !== null ? selected : -1,
      }
      const selectedStyle: MarkerStyle = {
        size: appearance.selectedMarkerSize,
        thickness: 2,
        colour: toRgbUnit(appearance.selectedMarkerColour),
        otherColour: null,
        otherOpacity: 1,
        selected: -1,
      }
      for (const selectedColourFade of selectedColourFades) {
        if (isColourHidden(appearance, selectedColourFade.index)) continue
        const selectedWork = work.selected.find(({ index }) => index === selectedColourFade.index)
        if (selectedWork === undefined) continue
        for (const batch of selectedWork.batches) {
          selectedLayers.push({
            batch,
            style: selectedStyle,
            fade: rendered.fade * selectedMarkerFade.value * selectedColourFade.fade,
          })
        }
      }
      for (const batch of work.mismatch)
        mismatchLayers.push({
          batch,
          style: mismatchStyle,
          fade: rendered.fade * mismatchFade.value,
        })
    }
    this.markerFades.prune(markerKeys)
    const visibilityBudget = markerVisibilityBudget()
    const visiblePoints = (layers: readonly Omit<RenderMarker, 'sampleRate'>[]) =>
      layers.reduce(
        (total, layer) =>
          total +
          visibleArtboardMarkerPoints(layer.batch, this.geometry, viewport, visibilityBudget),
        0,
      )
    const selectedSampleRate = markerSampleRate(visiblePoints(selectedLayers), state.markerBudget)
    const mismatchSampleRate = markerSampleRate(visiblePoints(mismatchLayers), state.markerBudget)
    const markerLayers: RenderMarker[] = [
      ...selectedLayers.map((layer) => ({ ...layer, sampleRate: selectedSampleRate })),
      ...mismatchLayers.map((layer) => ({ ...layer, sampleRate: mismatchSampleRate })),
    ]
    const moving = this.viewportIsMoving(viewport)
    const minifyTapCap = moving ? movingOverlayTapCap(templates.length) : 4
    const outlineAllowance = Math.floor(TEMPLATE_UPLOAD_PIXELS_PER_FRAME / 2)
    const outlineResult = this.outline.render(
      templates,
      [],
      ids,
      this.geometry,
      viewport,
      outlineAllowance,
      this.renderGeneration,
      minifyTapCap,
    )
    const overlayResult = this.overlay.render(
      templates,
      [],
      ids,
      this.geometry,
      viewport,
      TEMPLATE_UPLOAD_PIXELS_PER_FRAME - outlineAllowance,
      this.renderGeneration,
      minifyTapCap,
    )
    this.markers.render(
      [],
      markerLayers,
      ids,
      this.geometry,
      viewport,
      0,
      this.renderGeneration,
      minifyTapCap,
    )
    if (isProfileEnabled()) {
      recordProfileWorkload('Alliance overlay visible templates', templates.length)
      recordProfileWorkload(
        'Alliance overlay visible source pixels',
        templates.reduce((total, { template }) => total + template.width * template.height, 0),
      )
      recordProfileWorkload(
        'Alliance overlay draw intersections',
        outlineResult.drawIntersections + overlayResult.drawIntersections,
      )
      recordProfileWorkload(
        'Alliance overlay uploaded index pixels',
        outlineResult.uploadedPixels + overlayResult.uploadedPixels,
      )
      recordProfileWorkload('Alliance overlay minify tap cap', minifyTapCap)
      recordProfileWorkload('Alliance overlay moving', moving ? 1 : 0)
      recordProfileWorkload('Alliance marker source batches', markerLayers.length)
      recordProfileWorkload(
        'Alliance marker source points',
        markerLayers.reduce((total, marker) => total + marker.batch.marks.length, 0),
      )
    }
    if (outlineResult.animating || overlayResult.animating || moving) animating = true
    if (animating) this.requestRender()
  }

  memoryBytes(): number {
    return this.outline.memoryBytes() + this.overlay.memoryBytes() + this.markers.memoryBytes()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer.disconnect()
    this.resizeObserver?.disconnect()
    detachOverlayControls()
    this.outline.dispose()
    this.overlay.dispose()
    this.markers.dispose()
  }
}

let renderer: ArtboardRenderer | null = null

export const allianceOverlayGpuMemoryBytes = (): number => renderer?.memoryBytes() ?? 0

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

export const repaintAllianceOverlayLayer = (): void => renderer?.invalidatePixels()

/** Attach viewport-resolution WebGL passes inside whichever Wplace alliance artboard is open. */
export const installAllianceOverlayLayer = (): void => {
  onActiveAllianceSurfaceChange(reconcileRenderer)
  onLocalChange(repaintAllianceOverlayLayer)
  onLocalPreviewChange(repaintAllianceOverlayLayer)
  onOverlayPeekChange(repaintAllianceOverlayLayer)
  onStateChange(repaintAllianceOverlayLayer)
  onPaintSelectionChange(() => renderer?.requestRender())
  onCanvasWrite((canvas) => renderer?.nativeCanvasWritten(canvas))
  reconcileRenderer()
}
