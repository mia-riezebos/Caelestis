// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { markLocalX, packMismatchMark } from '../templates/mismatch-marks.js'

const fixture = vi.hoisted(() => ({
  appearance: {
    markMismatch: false,
    markSelectedColour: false,
    markerSize: 10,
    selectedMarkerSize: 10,
    markerColour: '#ff00ff',
    selectedMarkerColour: '#00e5ff',
    dimOthers: false,
    otherColour: null as string | null,
    otherOpacity: 1,
  },
  marks: new Uint32Array(0),
  mismatchesIn: vi.fn(),
  disagreementsIn: vi.fn(),
  progressIn: vi.fn(() => true),
  markerBudget: 16_384,
  moving: false,
  quad: { tile: { x: 0, y: 0 }, x: 0, y: 0, width: 100, height: 100 },
  paintOpen: false,
  selected: null as number | null,
}))

vi.mock('../debug.js', () => ({ count: vi.fn(), warn: vi.fn() }))
vi.mock('../map-handle.js', () => ({ getMap: () => ({ isMoving: () => fixture.moving }) }))
vi.mock('../profile.js', () => ({
  isProfileEnabled: () => false,
  measureProfile: (_name: string, run: () => unknown) => run(),
  profileGpu: (_gl: unknown, _name: string, run: () => unknown) => run(),
  recordProfileWorkload: vi.fn(),
}))
vi.mock('../state.js', () => ({
  getState: () => ({ markerBudget: fixture.markerBudget, onlySelectedColour: false }),
}))
vi.mock('../templates/appearance.js', () => ({
  isColourHidden: () => false,
  toRgbUnit: () => [1, 0, 1],
}))
vi.mock('../templates/colour-marker.js', () => ({ colourMarksIn: (marks: Uint32Array) => marks }))
vi.mock('../templates/local-store.js', () => ({
  appearanceOf: () => fixture.appearance,
  displayTemplates: () => [
    {
      id: 'template',
      originX: 0,
      originY: 0,
      width: 1_000,
      height: 1_000,
      indices: new Uint8Array(0),
    },
  ],
  isTemplateVisible: () => true,
}))
vi.mock('../templates/mismatch.js', () => ({
  beginMismatchFrame: vi.fn(),
  disagreementsIn: fixture.disagreementsIn,
  endMismatchFrame: vi.fn(),
  mismatchesIn: fixture.mismatchesIn,
  progressIn: fixture.progressIn,
}))
vi.mock('../templates/placement.js', () => ({
  horizontalSpans: () => [{ worldStart: 0, worldEnd: 1_000 }],
}))
vi.mock('../tile-transform.js', () => ({
  currentQuads: () => [fixture.quad],
  isDrawingTiles: () => true,
  registerDraftCanvas: vi.fn(),
}))
vi.mock('../wplace-paint.js', () => ({
  isPaintOpen: () => fixture.paintOpen,
  selectedColour: () => fixture.selected,
}))
vi.mock('./fade.js', () => ({
  markerFades: {
    advance: (_id: string, target: number) => ({ value: target, done: true }),
    prune: vi.fn(),
  },
  templateFades: {
    advance: () => ({ value: 1, done: true }),
  },
}))

const context = (): WebGL2RenderingContext => {
  const canvas = document.createElement('canvas')
  canvas.getBoundingClientRect = () => ({ width: 100 }) as DOMRect
  return {
    canvas,
    drawingBufferWidth: 100,
    drawingBufferHeight: 100,
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    UNSIGNED_INT: 6,
    STATIC_DRAW: 7,
    POINTS: 8,
    BLEND: 9,
    DEPTH_TEST: 10,
    ONE: 11,
    ONE_MINUS_SRC_ALPHA: 12,
    BLEND_SRC_RGB: 13,
    BLEND_DST_RGB: 14,
    BLEND_SRC_ALPHA: 15,
    BLEND_DST_ALPHA: 16,
    CURRENT_PROGRAM: 17,
    ARRAY_BUFFER_BINDING: 18,
    VERTEX_ARRAY_BINDING: 19,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    deleteShader: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(),
    createVertexArray: vi.fn(() => ({})),
    bindVertexArray: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    deleteBuffer: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    vertexAttribIPointer: vi.fn(),
    useProgram: vi.fn(),
    getUniformLocation: vi.fn(() => ({})),
    uniform2f: vi.fn(),
    uniform1f: vi.fn(),
    uniform3f: vi.fn(),
    drawArrays: vi.fn(),
    deleteVertexArray: vi.fn(),
    deleteProgram: vi.fn(),
    isEnabled: vi.fn(() => false),
    getParameter: vi.fn(() => null),
    enable: vi.fn(),
    disable: vi.fn(),
    blendFunc: vi.fn(),
    blendFuncSeparate: vi.fn(),
  } as unknown as WebGL2RenderingContext
}

describe('marker work selection', () => {
  beforeEach(() => {
    fixture.appearance.markMismatch = false
    fixture.appearance.markSelectedColour = false
    fixture.marks = new Uint32Array(0)
    fixture.mismatchesIn.mockReset().mockImplementation(() => fixture.marks)
    fixture.disagreementsIn.mockReset().mockImplementation(() => fixture.marks)
    fixture.progressIn.mockReset().mockReturnValue(true)
    fixture.markerBudget = 16_384
    fixture.moving = false
    fixture.quad = { tile: { x: 0, y: 0 }, x: 0, y: 0, width: 100, height: 100 }
    fixture.paintOpen = false
    fixture.selected = null
  })

  it('does not calculate mismatch answers for a template whose markers are disabled', async () => {
    const { markerLayer } = await import('./markers.js')

    markerLayer.render(context())

    expect(fixture.mismatchesIn).not.toHaveBeenCalled()
    expect(fixture.disagreementsIn).not.toHaveBeenCalled()
    expect(fixture.progressIn).toHaveBeenCalledOnce()
  })

  it('draws every known mismatch without density sampling', async () => {
    fixture.appearance.markMismatch = true
    fixture.marks = new Uint32Array(1_000)
    const gl = context()
    const { markerLayer } = await import('./markers.js')
    markerLayer.onAdd(null, gl)

    markerLayer.render(gl)

    expect(gl.drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, fixture.marks.length)
    markerLayer.onRemove(null, gl)
  })

  it('uses the configured viewport marker budget', async () => {
    fixture.appearance.markMismatch = true
    fixture.markerBudget = 100
    fixture.marks = new Uint32Array(1_000)
    const gl = context()
    const { markerLayer } = await import('./markers.js')
    markerLayer.onAdd(null, gl)

    markerLayer.render(gl)

    expect(gl.drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, 100)
    markerLayer.onRemove(null, gl)
  })

  it('keeps the configured marker budget while the map is moving', async () => {
    fixture.appearance.markMismatch = true
    fixture.moving = true
    fixture.marks = new Uint32Array(16_384)
    const gl = context()
    const { markerLayer } = await import('./markers.js')
    markerLayer.onAdd(null, gl)

    markerLayer.render(gl)

    expect(gl.drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, 16_384)
    const uploaded = vi.mocked(gl.bufferData).mock.calls.at(-1)?.[1]
    expect(uploaded).toBeInstanceOf(Uint32Array)
    markerLayer.onRemove(null, gl)
  })

  it('reuses a bounded marker buffer across unchanged render transforms', async () => {
    fixture.appearance.markMismatch = true
    fixture.markerBudget = 100
    fixture.marks = new Uint32Array(1_000)
    const gl = context()
    const { markerLayer } = await import('./markers.js')
    markerLayer.onAdd(null, gl)

    markerLayer.render(gl)
    vi.mocked(gl.drawArrays).mockClear()
    vi.mocked(gl.bufferData).mockClear()
    markerLayer.render(gl)

    expect(gl.drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, fixture.markerBudget)
    expect(gl.bufferData).not.toHaveBeenCalled()
    markerLayer.onRemove(null, gl)
  })

  it('does not synchronously read WebGL state while drawing', async () => {
    fixture.appearance.markMismatch = true
    fixture.marks = new Uint32Array([packMismatchMark(1, 1, 1)])
    const gl = context()
    const { markerLayer } = await import('./markers.js')
    markerLayer.onAdd(null, gl)

    markerLayer.render(gl)

    expect(gl.getParameter).not.toHaveBeenCalled()
    expect(gl.isEnabled).not.toHaveBeenCalled()
    markerLayer.onRemove(null, gl)
  })

  it('refreshes the drawn selection when a hidden source region enters the viewport', async () => {
    fixture.appearance.markMismatch = true
    fixture.markerBudget = 1_000
    fixture.quad = { tile: { x: 0, y: 0 }, x: 0, y: 0, width: 512, height: 512 }
    fixture.marks = new Uint32Array(
      Array.from({ length: 100 }, (_, y) =>
        Array.from({ length: 400 }, (_, x) => packMismatchMark(x, y, 1)),
      ).flat(),
    )
    const gl = context()
    const { markerLayer } = await import('./markers.js')
    markerLayer.onAdd(null, gl)

    markerLayer.render(gl)
    const first = vi.mocked(gl.bufferData).mock.calls.at(-1)?.[1] as Uint32Array
    fixture.quad = { ...fixture.quad, x: -120 }
    markerLayer.render(gl)
    const moved = vi.mocked(gl.bufferData).mock.calls.at(-1)?.[1] as Uint32Array

    expect(Math.max(...Array.from(moved, markLocalX))).toBeGreaterThan(
      Math.max(...Array.from(first, markLocalX)),
    )
    markerLayer.onRemove(null, gl)
  })

  it('applies the same viewport budget to selected-colour markers', async () => {
    fixture.appearance.markSelectedColour = true
    fixture.markerBudget = 100
    fixture.paintOpen = true
    fixture.selected = 1
    fixture.marks = new Uint32Array(1_000)
    const gl = context()
    const { markerLayer } = await import('./markers.js')
    markerLayer.onAdd(null, gl)

    markerLayer.render(gl)

    expect(fixture.disagreementsIn).toHaveBeenCalledOnce()
    expect(gl.drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, 100)
    markerLayer.onRemove(null, gl)
  })
})
