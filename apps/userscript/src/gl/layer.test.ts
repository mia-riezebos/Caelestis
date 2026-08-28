import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  triggerRepaint: vi.fn(),
  map: {} as Record<string, unknown>,
  indices: new Uint8Array([0]),
  width: 1,
  height: 1,
  originX: 0,
  originY: 0,
  templateCount: 1,
  darkTheme: false,
  contrastOutline: true,
  contrastOutlineSize: 0.85,
  unpainted: new Uint32Array(0) as Uint32Array | null,
  unpaintedIn: vi.fn<() => Uint32Array | null>(),
  retainUnpainted: vi.fn(),
  mismatchRevision: 0,
  fade: { value: 0, done: false },
}))

vi.mock('../debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../map-handle.js', () => ({
  getMap: () => harness.map,
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
    contrastOutline: harness.contrastOutline,
    contrastOutlineSize: harness.contrastOutlineSize,
    hiddenColours: [],
  }),
  isTemplateVisible: () => true,
  displayTemplates: () =>
    Array.from({ length: harness.templateCount }, (_, index) => ({
      id: `visible-template-${index}`,
      originX: harness.originX,
      originY: harness.originY,
      width: harness.width,
      height: harness.height,
      indices: harness.indices,
      appearance: null,
    })),
}))
vi.mock('../templates/mismatch.js', () => ({
  beginUnpaintedFrame: vi.fn(),
  endUnpaintedFrame: vi.fn(),
  mismatchRevision: () => harness.mismatchRevision,
  retainUnpainted: harness.retainUnpainted,
  unpaintedIn: harness.unpaintedIn,
}))
vi.mock('../tile-transform.js', () => ({
  currentQuads: () => [{ tile: { x: 0, y: 0 }, x: 0, y: 0, width: 1_000, height: 1_000 }],
  isDrawingTiles: () => true,
}))
vi.mock('./fade.js', () => ({
  colourFades: { advance: () => ({ value: 1, done: true }), prune: vi.fn() },
  templateFades: {
    advance: () => harness.fade,
    prune: vi.fn(),
  },
}))
vi.mock('./contrast-outline.js', () => ({ isDarkMapTheme: () => harness.darkTheme }))
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
    BLEND: 8,
    DEPTH_TEST: 9,
    BLEND_SRC_RGB: 10,
    BLEND_DST_RGB: 11,
    BLEND_SRC_ALPHA: 12,
    BLEND_DST_ALPHA: 13,
    CURRENT_PROGRAM: 14,
    ARRAY_BUFFER_BINDING: 15,
    VERTEX_ARRAY_BINDING: 16,
    ONE: 17,
    ONE_MINUS_SRC_ALPHA: 18,
    TEXTURE_2D: 19,
    R8UI: 20,
    RED_INTEGER: 21,
    UNSIGNED_BYTE: 22,
    TEXTURE_MIN_FILTER: 23,
    TEXTURE_MAG_FILTER: 24,
    NEAREST: 25,
    TEXTURE_WRAP_S: 26,
    TEXTURE_WRAP_T: 27,
    CLAMP_TO_EDGE: 28,
    UNPACK_ALIGNMENT: 29,
    RGBA: 30,
    TEXTURE0: 31,
    TEXTURE1: 32,
    TRIANGLE_STRIP: 33,
    MAX_TEXTURE_SIZE: 34,
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
    createTexture: vi.fn(() => ({})),
    deleteTexture: vi.fn(),
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    texSubImage2D: vi.fn(),
    texParameteri: vi.fn(),
    isEnabled: vi.fn(() => false),
    getParameter: vi.fn(() => null),
    useProgram: vi.fn(),
    enable: vi.fn(),
    blendFunc: vi.fn(),
    disable: vi.fn(),
    activeTexture: vi.fn(),
    getUniformLocation: vi.fn((_program: WebGLProgram, name: string) => name),
    uniform1i: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    bufferSubData: vi.fn(),
    drawArrays: vi.fn(),
    blendFuncSeparate: vi.fn(),
  }) as unknown as WebGL2RenderingContext

beforeEach(() => {
  vi.clearAllMocks()
  harness.map = { triggerRepaint: harness.triggerRepaint }
  harness.fade = { value: 0, done: false }
  harness.indices = new Uint8Array([0])
  harness.width = 1
  harness.height = 1
  harness.originX = 0
  harness.originY = 0
  harness.templateCount = 1
  harness.darkTheme = false
  harness.contrastOutline = true
  harness.contrastOutlineSize = 0.85
  harness.unpainted = new Uint32Array(0)
  harness.unpaintedIn.mockImplementation(() => harness.unpainted)
  harness.retainUnpainted.mockClear()
  harness.mismatchRevision = 0
})

const orderedMap = (order: string[]) => {
  const moveLayer = vi.fn((id: string, before?: string) => {
    const from = order.indexOf(id)
    if (from >= 0) order.splice(from, 1)
    const target = before === undefined ? order.length : order.indexOf(before)
    order.splice(target < 0 ? order.length : target, 0, id)
  })
  return {
    moveLayer,
    map: {
      style: { _order: order },
      addLayer: vi.fn(),
      getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
      moveLayer,
    },
  }
}

describe('overlay layer', () => {
  it('requests the next frame when a visible template begins at zero fade', async () => {
    const { overlayLayer } = await import('./layer.js')
    const context = gl()
    overlayLayer.onAdd(null, context)

    overlayLayer.draw(context, null)

    expect(harness.triggerRepaint).toHaveBeenCalledOnce()
  })

  it('uploads templates again when added to a replacement WebGL context', async () => {
    const { overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    const first = gl()
    overlayLayer.onAdd(null, first)
    overlayLayer.draw(first, null)
    expect(first.texImage2D).toHaveBeenCalledTimes(2)

    const replacement = gl()
    overlayLayer.onAdd(null, replacement)
    overlayLayer.draw(replacement, null)

    expect(replacement.texImage2D).toHaveBeenCalledTimes(2)
  })

  it('tiles an accepted template across the device texture limit', async () => {
    const { overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    harness.indices = new Uint8Array([0, 1, 2])
    harness.width = 3
    harness.height = 1
    const context = gl()
    vi.mocked(context.getParameter).mockImplementation((parameter) =>
      parameter === context.MAX_TEXTURE_SIZE ? 2 : null,
    )
    overlayLayer.onAdd(null, context)

    overlayLayer.draw(context, null)

    expect(context.texImage2D).toHaveBeenCalledTimes(3)
    expect(context.drawArrays).toHaveBeenCalledTimes(2)
  })

  it('uploads one-pixel neighbour halos across device texture splits', async () => {
    const { overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    harness.indices = new Uint8Array([0, 1, 2, 3, 4])
    harness.width = 5
    const context = gl()
    vi.mocked(context.getParameter).mockImplementation((parameter) =>
      parameter === context.MAX_TEXTURE_SIZE ? 4 : null,
    )
    overlayLayer.onAdd(null, context)

    overlayLayer.draw(context, null)

    const uploads = vi
      .mocked(context.texImage2D)
      .mock.calls.filter((call) => call[2] === context.R8UI)
    expect(uploads).toHaveLength(3)
    expect(uploads[0]?.[8]).toEqual(new Uint8Array([63, 63, 63, 63, 63, 0, 1, 2, 63, 63, 63, 63]))
    expect(uploads[1]?.[8]).toEqual(new Uint8Array([63, 63, 63, 63, 1, 2, 3, 4, 63, 63, 63, 63]))
  })

  it('updates duplicate halo cells when an outline bit changes at a texture split', async () => {
    const { overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    harness.indices = new Uint8Array([0, 0, 0, 0, 0])
    harness.width = 5
    harness.unpainted = new Uint32Array([1])
    const context = gl()
    vi.mocked(context.getParameter).mockImplementation((parameter) =>
      parameter === context.MAX_TEXTURE_SIZE ? 4 : null,
    )
    overlayLayer.onAdd(null, context)

    overlayLayer.draw(context, null)

    expect(context.texSubImage2D).toHaveBeenCalledTimes(2)
    expect(
      vi
        .mocked(context.texSubImage2D)
        .mock.calls.map((call) => call[8])
        .every((pixels) => pixels instanceof Uint8Array && pixels.includes(0x80)),
    ).toBe(true)
  })

  it('does not upload or draw a template outside the current tile frame', async () => {
    const { overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    harness.originX = 10_000
    harness.originY = 10_000
    const context = gl()
    overlayLayer.onAdd(null, context)

    overlayLayer.draw(context, null)

    expect(context.texImage2D).not.toHaveBeenCalled()
    expect(context.drawArrays).not.toHaveBeenCalled()
  })

  it('does not synchronously read WebGL state on a warm render', async () => {
    const { overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    const context = gl()
    overlayLayer.onAdd(null, context)
    overlayLayer.draw(context, null)
    vi.mocked(context.getParameter).mockClear()

    overlayLayer.draw(context, null)

    expect(context.getParameter).not.toHaveBeenCalled()
  })

  it('does not revisit unchanged unpainted answers on every map frame', async () => {
    const { overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    const context = gl()
    overlayLayer.onAdd(null, context)
    overlayLayer.draw(context, null)
    harness.unpaintedIn.mockClear()
    harness.retainUnpainted.mockClear()

    overlayLayer.draw(context, null)
    expect(harness.unpaintedIn).not.toHaveBeenCalled()
    expect(harness.retainUnpainted).toHaveBeenCalledOnce()

    harness.mismatchRevision++
    overlayLayer.draw(context, null)
    expect(harness.unpaintedIn).toHaveBeenCalledOnce()
  })

  it('updates the contrast-outline theme uniform without rebuilding the layer', async () => {
    const { overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    const context = gl()
    overlayLayer.onAdd(null, context)

    harness.darkTheme = true
    overlayLayer.draw(context, null)
    expect(context.uniform1i).toHaveBeenCalledWith('u_darkTheme', 1)

    vi.mocked(context.uniform1i).mockClear()
    harness.darkTheme = false
    overlayLayer.draw(context, null)
    expect(context.uniform1i).toHaveBeenCalledWith('u_darkTheme', 0)
  })

  it('encodes only unpainted cells and passes each template outline preference to the shader', async () => {
    const { overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    harness.contrastOutlineSize = 1.25
    harness.unpainted = new Uint32Array([0])
    const context = gl()
    overlayLayer.onAdd(null, context)

    overlayLayer.draw(context, null)

    expect(context.uniform1i).toHaveBeenCalledWith('u_contrastOutline', 1)
    expect(context.uniform1f).toHaveBeenCalledWith('u_contrastOutlineSize', 1.25)
    expect(context.texSubImage2D).toHaveBeenCalledWith(
      context.TEXTURE_2D,
      0,
      0,
      0,
      1,
      1,
      context.RED_INTEGER,
      context.UNSIGNED_BYTE,
      new Uint8Array([0x80]),
    )

    harness.unpainted = new Uint32Array(0)
    harness.mismatchRevision++
    overlayLayer.draw(context, null)
    expect(vi.mocked(context.texSubImage2D).mock.calls.at(-1)?.at(-1)).toEqual(new Uint8Array([0]))
  })

  it('drops outline bits from the old placement when a template moves within one host tile', async () => {
    const { overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    harness.unpainted = new Uint32Array([0])
    const context = gl()
    overlayLayer.onAdd(null, context)
    overlayLayer.draw(context, null)
    expect(vi.mocked(context.texSubImage2D).mock.calls.at(-1)?.at(-1)).toEqual(
      new Uint8Array([0x80]),
    )

    // Placement finalisation can move a freshly imported template without crossing a 1000px tile
    // boundary. Its mismatch signature changes, but the old outline key used only that host tile.
    harness.originX = 1
    harness.unpainted = new Uint32Array(0)
    harness.unpaintedIn.mockClear()
    vi.mocked(context.texSubImage2D).mockClear()
    overlayLayer.draw(context, null)

    expect(harness.unpaintedIn).toHaveBeenCalledOnce()
    expect(vi.mocked(context.texSubImage2D).mock.calls.at(-1)?.at(-1)).toEqual(new Uint8Array([0]))
  })

  it('retries moved outline state that was unavailable on the first synchronization', async () => {
    const { overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    harness.unpainted = new Uint32Array([0])
    const context = gl()
    overlayLayer.onAdd(null, context)
    overlayLayer.draw(context, null)

    harness.originX = 1
    harness.unpainted = null
    harness.unpaintedIn.mockClear()
    vi.mocked(context.texSubImage2D).mockClear()
    overlayLayer.draw(context, null)
    expect(harness.unpaintedIn).toHaveBeenCalledOnce()

    harness.unpainted = new Uint32Array(0)
    harness.unpaintedIn.mockClear()
    overlayLayer.draw(context, null)

    expect(harness.unpaintedIn).toHaveBeenCalledOnce()
    expect(vi.mocked(context.texSubImage2D).mock.calls.at(-1)?.at(-1)).toEqual(new Uint8Array([0]))
  })

  it('spreads a burst of large visible uploads across frames', async () => {
    const { overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    harness.width = 2_100_000
    harness.indices = new Uint8Array(harness.width)
    harness.templateCount = 2
    const context = gl()
    overlayLayer.onAdd(null, context)

    overlayLayer.draw(context, null)
    expect(context.texImage2D).toHaveBeenCalledTimes(2)
    expect(harness.triggerRepaint).toHaveBeenCalledOnce()

    overlayLayer.draw(context, null)
    expect(context.texImage2D).toHaveBeenCalledTimes(4)
  })

  it('restores custom layers above pixel art after a basemap style change', async () => {
    const order = [
      'background',
      'caelestis-overlay',
      'caelestis-markers',
      'pixel-art-layer',
      'paint-preview-1-2',
      'pixel-hover',
    ]
    const { map, moveLayer } = orderedMap(order)
    harness.map = map
    const { installOverlayLayer } = await import('./layer.js')

    expect(installOverlayLayer()).toBe(true)
    expect(order).toEqual([
      'background',
      'pixel-art-layer',
      'caelestis-overlay',
      'paint-preview-1-2',
      'caelestis-markers',
      'pixel-hover',
    ])
    expect(moveLayer).toHaveBeenNthCalledWith(1, 'caelestis-overlay', 'paint-preview-1-2')
    expect(moveLayer).toHaveBeenNthCalledWith(2, 'caelestis-markers', 'pixel-hover')
  })

  it('uses the crosshair as the recovery anchor when no draft layer exists', async () => {
    const order = [
      'background',
      'caelestis-overlay',
      'caelestis-markers',
      'pixel-art-layer',
      'pixel-hover',
    ]
    const { map, moveLayer } = orderedMap(order)
    harness.map = map
    const { installOverlayLayer } = await import('./layer.js')

    expect(installOverlayLayer()).toBe(true)
    expect(order).toEqual([
      'background',
      'pixel-art-layer',
      'caelestis-overlay',
      'caelestis-markers',
      'pixel-hover',
    ])
    expect(moveLayer).toHaveBeenNthCalledWith(1, 'caelestis-overlay', 'pixel-hover')
    expect(moveLayer).toHaveBeenNthCalledWith(2, 'caelestis-markers', 'pixel-hover')
  })

  it('does not move layers that are already in render order', async () => {
    const order = [
      'pixel-art-layer',
      'caelestis-overlay',
      'paint-preview-1-2',
      'caelestis-markers',
      'pixel-hover',
    ]
    const { map, moveLayer } = orderedMap(order)
    harness.map = map
    const { installOverlayLayer } = await import('./layer.js')

    expect(installOverlayLayer()).toBe(true)
    expect(moveLayer).not.toHaveBeenCalled()
  })
})
