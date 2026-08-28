// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('marker device scale', () => {
  it('remeasures when browser zoom changes DPR without resizing the backing buffer', async () => {
    const canvas = document.createElement('canvas')
    let cssWidth = 1_200
    canvas.getBoundingClientRect = () => ({ width: cssWidth }) as DOMRect
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
    const context = { canvas, drawingBufferWidth: 1_200 } as WebGL2RenderingContext
    const { deviceScale } = await import('./markers.js')

    expect(deviceScale(context)).toBe(1)

    cssWidth = 600
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    expect(deviceScale(context)).toBe(2)
  })
})

describe('marker GPU retention', () => {
  it('uploads one immutable buffer per mismatch result', async () => {
    const bufferData = vi.fn()
    const createdBuffer = {}
    const gl = {
      canvas: {},
      drawingBufferWidth: 1_200,
      drawingBufferHeight: 800,
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      COMPILE_STATUS: 3,
      LINK_STATUS: 4,
      ARRAY_BUFFER: 5,
      UNSIGNED_INT: 6,
      STATIC_DRAW: 7,
      POINTS: 8,
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
      createBuffer: vi.fn(() => createdBuffer),
      deleteBuffer: vi.fn(),
      bindBuffer: vi.fn(),
      bufferData,
      vertexAttribIPointer: vi.fn(),
      useProgram: vi.fn(),
      getUniformLocation: vi.fn(() => ({})),
      uniform2f: vi.fn(),
      uniform1f: vi.fn(),
      uniform1ui: vi.fn(),
      uniform3f: vi.fn(),
      drawArrays: vi.fn(),
      deleteVertexArray: vi.fn(),
      deleteProgram: vi.fn(),
    } as unknown as WebGL2RenderingContext
    const { drawMarkers, initMarkers, markerGpuMemoryBytes, releaseMarkers } = await import(
      './markers.js'
    )
    const marks = new Uint32Array([1, 2])
    const tile = { tile: { x: 0, y: 0 }, x: 0, y: 0, width: 1_000, height: 1_000 }
    const style = {
      size: 5,
      thickness: 2,
      colour: [1, 0, 1] as const,
      otherColour: null,
      otherOpacity: 1,
      selected: -1,
    }

    initMarkers(gl)
    drawMarkers(gl, tile, marks, style, 1)
    drawMarkers(gl, tile, marks, style, 1)

    expect(bufferData).toHaveBeenCalledOnce()
    expect(markerGpuMemoryBytes()).toBe(marks.byteLength)
    releaseMarkers(gl)
    expect(gl.deleteBuffer).toHaveBeenCalledWith(createdBuffer)
    expect(markerGpuMemoryBytes()).toBe(0)
  })
})
