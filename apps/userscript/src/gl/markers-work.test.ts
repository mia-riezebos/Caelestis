// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { packMismatchMark } from '../templates/mismatch-marks.js'

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
  unpainted: new Uint32Array(0),
  mismatchesIn: vi.fn(),
  disagreementsIn: vi.fn(),
  unpaintedIn: vi.fn(),
  colourMarksIn: vi.fn((marks: Uint32Array) => marks),
  progressIn: vi.fn(() => true),
  markerBudget: 16_384,
  moving: false,
  quad: { tile: { x: 0, y: 0 }, x: 0, y: 0, width: 100, height: 100 },
  paintOpen: false,
  selected: null as number | null,
  selectedFade: vi.fn((_id: string, target: number, _now = 0) => ({ value: target, done: true })),
  sceneSelected: new Set<number>(),
  sceneLatest: null as number | null,
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
vi.mock('../templates/colour-marker.js', () => ({ colourMarksIn: fixture.colourMarksIn }))
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
  pixelAccounting: {
    read: () => ({
      ensure: fixture.progressIn,
      unpainted: fixture.unpaintedIn,
      tile: () => {
        const disagreements = fixture.disagreementsIn()
        const markers = fixture.mismatchesIn()
        return disagreements === null || markers === null
          ? null
          : {
              disagreements,
              markers,
              mismatched: markers,
              unpainted: fixture.unpainted,
            }
      },
    }),
    frame: (read: () => unknown) => read(),
  },
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
  FADE_MS: 300,
  fadeProgress: () => 1,
  markerFades: {
    advance: (_id: string, target: number) => ({ value: target, done: true }),
    prune: vi.fn(),
  },
  selectedColourMarkerFades: {
    advance: fixture.selectedFade,
    prune: vi.fn(),
  },
  templateFades: {
    advance: () => ({ value: 1, done: true }),
  },
}))
vi.mock('./render-scene.js', () => ({
  worldRenderScene: {
    advanceTemplates: (templates: readonly Record<string, unknown>[]) => ({
      animating: false,
      templates: templates.map((template) => ({
        template,
        appearance: fixture.appearance,
        fade: 1,
        outlineFade: 1,
        palette: new Uint8Array(256),
      })),
    }),
    advanceMarkers: (
      templates: readonly {
        readonly template: Record<string, unknown>
        readonly appearance: typeof fixture.appearance
        readonly fade: number
      }[],
      selected: number | null,
      now: number,
    ) => {
      if (selected !== null && selected !== fixture.sceneLatest) {
        fixture.sceneSelected.add(selected)
        fixture.sceneLatest = selected
      }
      const selectedFades = [...fixture.sceneSelected]
        .map((index) => ({
          index,
          ...fixture.selectedFade(String(index), index === fixture.sceneLatest ? 1 : 0, now),
        }))
        .filter(({ value }) => value > 0)
        .map(({ index, value }) => ({ index, fade: value }))
      return {
        animating: false,
        templates: templates.map((rendered) => ({
          rendered,
          mismatchFade: fixture.appearance.markMismatch ? 1 : 0,
          selectedFades: fixture.appearance.markSelectedColour ? selectedFades : [],
        })),
      }
    },
    resetMarkers: () => {
      fixture.sceneSelected.clear()
      fixture.sceneLatest = null
    },
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
    getUniformLocation: vi.fn((_program: unknown, name: string) => name),
    uniform2f: vi.fn(),
    uniform1f: vi.fn(),
    uniform1ui: vi.fn(),
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

const clippedClusterMarks = () => {
  const marks = new Uint32Array(20_000)
  let at = 0
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 100; x++) marks[at++] = packMismatchMark(x, y, 1)
  }
  for (let y = 900; y < 1_000; y++) {
    for (let x = 900; x < 1_000; x++) marks[at++] = packMismatchMark(x, y, 1)
  }
  return marks
}

describe('marker work selection', () => {
  beforeEach(() => {
    fixture.appearance.markMismatch = false
    fixture.appearance.markSelectedColour = false
    fixture.marks = new Uint32Array(0)
    fixture.unpainted = new Uint32Array(0)
    fixture.mismatchesIn.mockReset().mockImplementation(() => fixture.marks)
    fixture.disagreementsIn.mockReset().mockImplementation(() => fixture.marks)
    fixture.unpaintedIn.mockReset().mockImplementation(() => fixture.unpainted)
    fixture.colourMarksIn.mockReset().mockImplementation((marks: Uint32Array) => marks)
    fixture.progressIn.mockReset().mockReturnValue(true)
    fixture.markerBudget = 16_384
    fixture.moving = false
    fixture.quad = { tile: { x: 0, y: 0 }, x: 0, y: 0, width: 100, height: 100 }
    fixture.paintOpen = false
    fixture.selected = null
    fixture.sceneSelected.clear()
    fixture.sceneLatest = null
    fixture.selectedFade.mockReset().mockImplementation((_id: string, target: number) => ({
      value: target,
      done: true,
    }))
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

    expect(gl.drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, fixture.marks.length)
    expect(gl.uniform1f).toHaveBeenCalledWith(expect.anything(), 0.1)
    markerLayer.onRemove(null, gl)
  })

  it('keeps a visible coordinate cluster near the target inside a clipped tile', async () => {
    fixture.appearance.markMismatch = true
    fixture.markerBudget = 4_096
    fixture.marks = clippedClusterMarks()
    fixture.quad = { tile: { x: 0, y: 0 }, x: -900, y: -900, width: 1_000, height: 1_000 }
    const gl = context()
    const { markerLayer } = await import('./markers.js')
    markerLayer.onAdd(null, gl)

    markerLayer.render(gl)

    expect(gl.uniform1f).toHaveBeenCalledWith(expect.anything(), 0.4096)
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

  it('reuses the source marker buffer across unchanged render transforms', async () => {
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

    expect(gl.drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, fixture.marks.length)
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

  it('reuses the source buffer when the viewport moves', async () => {
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
    vi.mocked(gl.bufferData).mockClear()
    fixture.quad = { ...fixture.quad, x: -120 }
    markerLayer.render(gl)

    expect(gl.bufferData).not.toHaveBeenCalled()
    expect(gl.uniform2f).toHaveBeenCalledWith(expect.anything(), -120, 0)
    markerLayer.onRemove(null, gl)
  })

  it('applies the same viewport budget to selected-colour markers', async () => {
    fixture.appearance.markSelectedColour = true
    fixture.markerBudget = 100
    fixture.paintOpen = true
    fixture.selected = 1
    fixture.marks = new Uint32Array(1_000)
    fixture.unpainted = fixture.marks
    const gl = context()
    const { markerLayer } = await import('./markers.js')
    markerLayer.onAdd(null, gl)

    markerLayer.render(gl)

    expect(fixture.unpaintedIn).toHaveBeenCalledOnce()
    expect(fixture.colourMarksIn).toHaveBeenCalledWith(fixture.unpainted, 1)
    expect(gl.drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, fixture.marks.length)
    expect(gl.uniform1f).toHaveBeenCalledWith(expect.anything(), 0.1)
    markerLayer.onRemove(null, gl)
  })

  it('does not turn wrong-colour mismatches into selected-colour markers', async () => {
    fixture.appearance.markSelectedColour = true
    fixture.paintOpen = true
    fixture.selected = 1
    fixture.marks = new Uint32Array([packMismatchMark(1, 1, 1)])
    const gl = context()
    const { markerLayer } = await import('./markers.js')
    markerLayer.onAdd(null, gl)

    markerLayer.render(gl)

    expect(fixture.colourMarksIn).toHaveBeenCalledWith(fixture.unpainted, 1)
    expect(gl.drawArrays).not.toHaveBeenCalled()
    markerLayer.onRemove(null, gl)
  })

  it('draws selected-colour markers without waiting for full mismatch accounting', async () => {
    fixture.appearance.markSelectedColour = true
    fixture.paintOpen = true
    fixture.selected = 1
    fixture.unpainted = new Uint32Array([packMismatchMark(1, 1, 1)])
    fixture.disagreementsIn.mockReturnValue(null)
    fixture.mismatchesIn.mockReturnValue(null)
    const gl = context()
    const { markerLayer } = await import('./markers.js')
    markerLayer.onAdd(null, gl)

    markerLayer.render(gl)

    expect(gl.drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, fixture.unpainted.length)
    markerLayer.onRemove(null, gl)
  })

  it('cross-fades the outgoing and incoming selected colours', async () => {
    fixture.appearance.markSelectedColour = true
    fixture.paintOpen = true
    fixture.selected = 1
    fixture.unpainted = new Uint32Array([packMismatchMark(1, 1, 1), packMismatchMark(2, 1, 2)])
    const gl = context()
    const { markerLayer } = await import('./markers.js')
    markerLayer.onAdd(null, gl)
    markerLayer.render(gl)

    fixture.selected = 2
    fixture.selectedFade.mockImplementation((id: string, target: number) => ({
      value: id === '1' || id === '2' ? 0.5 : target,
      done: false,
    }))
    fixture.colourMarksIn.mockClear()
    markerLayer.render(gl)

    expect(fixture.selectedFade).toHaveBeenCalledWith('1', 0, expect.any(Number))
    expect(fixture.selectedFade).toHaveBeenCalledWith('2', 1, expect.any(Number))
    expect(fixture.colourMarksIn).toHaveBeenCalledWith(fixture.unpainted, 1)
    expect(fixture.colourMarksIn).toHaveBeenCalledWith(fixture.unpainted, 2)
    expect(gl.uniform1f).toHaveBeenCalledWith('u_fade', 0.5)
    markerLayer.onRemove(null, gl)
  })
})
