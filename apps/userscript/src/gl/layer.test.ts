import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  triggerRepaint: vi.fn(),
}))

vi.mock('../debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../map-handle.js', () => ({
  getMap: () => ({ triggerRepaint: harness.triggerRepaint }),
}))
vi.mock('../templates/appearance.js', () => ({ isPlain: () => true }))
vi.mock('../templates/colour-filter.js', () => ({ hiddenColoursFor: () => [] }))
vi.mock('../templates/local-store.js', () => ({
  appearanceOf: () => ({
    size: 1,
    radius: 0,
    translateX: 0,
    translateY: 0,
    rotation: 0,
    opacity: 1,
    hiddenColours: [],
  }),
  isTemplateVisible: () => true,
  localTemplates: () => [
    {
      id: 'visible-template',
      originX: 0,
      originY: 0,
      width: 1,
      height: 1,
      indices: new Uint8Array([0]),
      appearance: null,
    },
  ],
}))
vi.mock('../tile-transform.js', () => ({
  currentQuads: () => [{ tile: { x: 0, y: 0 }, x: 0, y: 0, width: 1_000, height: 1_000 }],
  isDrawingTiles: () => true,
}))
vi.mock('./fade.js', () => ({
  colourFades: { advance: vi.fn(), prune: vi.fn() },
  templateFades: {
    advance: () => ({ value: 0, done: false }),
    prune: vi.fn(),
  },
}))
vi.mock('./markers.js', () => ({ markerLayer: { id: 'caelestis-markers' } }))
vi.mock('./shaders.js', () => ({ FRAGMENT_SOURCE: '', VERTEX_SOURCE: '' }))

const gl = () =>
  ({
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    DYNAMIC_DRAW: 6,
    FLOAT: 7,
    drawingBufferWidth: 1_000,
    drawingBufferHeight: 1_000,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    createVertexArray: vi.fn(() => ({})),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
  }) as unknown as WebGL2RenderingContext

beforeEach(() => {
  vi.clearAllMocks()
})

describe('overlay layer', () => {
  it('requests the next frame when a visible template begins at zero fade', async () => {
    const { overlayLayer } = await import('./layer.js')
    const context = gl()
    overlayLayer.onAdd(null, context)

    overlayLayer.draw(context, null)

    expect(harness.triggerRepaint).toHaveBeenCalledOnce()
  })
})
