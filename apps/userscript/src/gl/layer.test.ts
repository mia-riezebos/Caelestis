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
  moving: false,
  completedTileSize: 2_000,
  contrastOutline: true,
  contrastOutlineSize: 0.85,
  visible: true,
  size: 1,
  opacity: 1,
  hiddenColours: [] as number[],
  transitionedSize: null as number | null,
  fade: { value: 0, done: false },
}))

vi.mock('../debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../map-handle.js', () => ({
  getMap: () => harness.map,
}))
vi.mock('../templates/appearance.js', () => ({ isPlain: () => true }))
vi.mock('../templates/colour-filter.js', () => ({
  hiddenColoursFor: () => harness.hiddenColours,
}))
vi.mock('../templates/local-store.js', () => ({
  appearanceOf: () => ({
    size: harness.size,
    radius: 0,
    translateX: 0,
    translateY: 0,
    rotation: 0,
    opacity: harness.opacity,
    contrastOutline: harness.contrastOutline,
    contrastOutlineSize: harness.contrastOutlineSize,
    hiddenColours: [],
  }),
  isTemplateVisible: () => harness.visible,
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
vi.mock('../tile-transform.js', () => ({
  completedQuads: () => [
    {
      tile: { x: 0, y: 0 },
      x: 0,
      y: 0,
      width: harness.completedTileSize,
      height: harness.completedTileSize,
    },
  ],
  currentQuads: () => [{ tile: { x: 0, y: 0 }, x: 0, y: 0, width: 1_000, height: 1_000 }],
  isDrawingTiles: () => true,
}))
vi.mock('./fade.js', () => ({
  colourFades: {
    advance: (_key: string, target: number) => ({ value: target, done: true }),
    prune: vi.fn(),
  },
  templateFades: {
    advance: () => harness.fade,
    value: () => harness.fade.value,
    prune: vi.fn(),
  },
}))
vi.mock('./appearance-transition.js', () => ({
  appearanceTransitions: {
    advance: (_id: string, target: { size: number }) => ({
      appearance: {
        ...target,
        size: harness.transitionedSize ?? target.size,
      },
      done: true,
    }),
    prune: vi.fn(),
  },
  prefersReducedMotion: () => false,
}))
vi.mock('./contrast-outline.js', () => ({ isDarkMapTheme: () => harness.darkTheme }))
vi.mock('./markers.js', () => ({ markerLayer: { id: 'caelestis-markers' } }))
vi.mock('./shaders.js', () => ({
  FRAGMENT_SOURCE: '',
  OUTLINE_FRAGMENT_SOURCE: '',
  VERTEX_SOURCE: '',
}))

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
    deleteProgram: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    deleteBuffer: vi.fn(),
    createVertexArray: vi.fn(() => ({})),
    deleteVertexArray: vi.fn(),
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
  harness.map = {
    triggerRepaint: harness.triggerRepaint,
    isMoving: () => harness.moving,
  }
  harness.fade = { value: 0, done: false }
  harness.indices = new Uint8Array([0])
  harness.width = 1
  harness.height = 1
  harness.originX = 0
  harness.originY = 0
  harness.templateCount = 1
  harness.darkTheme = false
  harness.moving = false
  harness.completedTileSize = 2_000
  harness.contrastOutline = true
  harness.contrastOutlineSize = 0.85
  harness.visible = true
  harness.size = 1
  harness.opacity = 1
  harness.hiddenColours = []
  harness.transitionedSize = null
})

const orderedMap = (order: string[]) => {
  const moveLayer = vi.fn((id: string, before?: string) => {
    const from = order.indexOf(id)
    if (from >= 0) order.splice(from, 1)
    const target = before === undefined ? order.length : order.indexOf(before)
    order.splice(target < 0 ? order.length : target, 0, id)
  })
  const addLayer = vi.fn((layer: { id: string }, before?: string) => {
    const target = before === undefined ? order.length : order.indexOf(before)
    order.splice(target < 0 ? order.length : target, 0, layer.id)
  })
  return {
    moveLayer,
    map: {
      style: { _order: order },
      addLayer,
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
      .mocked(context.texSubImage2D)
      .mock.calls.filter((call) => call[6] === context.RED_INTEGER)
    expect(uploads).toHaveLength(3)
    expect(uploads[0]?.[8]).toEqual(new Uint8Array([63, 63, 63, 63, 63, 0, 1, 2, 63, 63, 63, 63]))
    expect(uploads[1]?.[8]).toEqual(new Uint8Array([63, 63, 63, 63, 1, 2, 3, 4, 63, 63, 63, 63]))
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

  it('draws the outline from the existing GPU textures without another index upload', async () => {
    const { outlineLayer, overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    harness.darkTheme = true
    harness.contrastOutlineSize = 1.25
    const context = gl()
    overlayLayer.onAdd(null, context)
    overlayLayer.draw(context, null)
    outlineLayer.onAdd(null, context)
    vi.mocked(context.texSubImage2D).mockClear()
    vi.mocked(context.drawArrays).mockClear()

    outlineLayer.draw(context, null)

    expect(context.texSubImage2D).not.toHaveBeenCalled()
    expect(context.uniform1i).toHaveBeenCalledWith('u_darkTheme', 1)
    expect(context.uniform1f).toHaveBeenCalledWith('u_outlineSize', 1.25)
    expect(context.drawArrays).toHaveBeenCalledOnce()
  })

  it('refreshes the shared visibility palette before drawing an outline', async () => {
    const { outlineLayer, overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    const context = gl()
    overlayLayer.onAdd(null, context)
    overlayLayer.draw(context, null)
    outlineLayer.onAdd(null, context)
    vi.mocked(context.texImage2D).mockClear()
    vi.mocked(context.drawArrays).mockClear()

    harness.hiddenColours = [0]
    outlineLayer.draw(context, null)

    const paletteUpload = vi
      .mocked(context.texImage2D)
      .mock.calls.find((call) => call[2] === context.RGBA)
    expect(paletteUpload).toBeDefined()
    if (paletteUpload === undefined) throw new Error('visibility palette was not uploaded')
    expect((paletteUpload[8] as Uint8Array)[3]).toBe(0)
    expect(context.drawArrays).toHaveBeenCalledOnce()

    vi.mocked(context.texImage2D).mockClear()
    overlayLayer.draw(context, null)
    expect(context.texImage2D).not.toHaveBeenCalled()
  })

  it('keeps the outline visible while the map moves', async () => {
    const { outlineLayer, overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    const context = gl()
    overlayLayer.onAdd(null, context)
    overlayLayer.draw(context, null)
    outlineLayer.onAdd(null, context)
    vi.mocked(context.drawArrays).mockClear()

    harness.moving = true
    outlineLayer.draw(context, null)
    expect(context.drawArrays).toHaveBeenCalledOnce()

    vi.mocked(context.drawArrays).mockClear()
    harness.moving = false
    harness.contrastOutline = false
    outlineLayer.draw(context, null)
    expect(context.drawArrays).not.toHaveBeenCalled()
  })

  it('omits the outline when there is not enough room to draw its ring', async () => {
    const { outlineLayer, overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    const context = gl()
    overlayLayer.onAdd(null, context)
    overlayLayer.draw(context, null)
    outlineLayer.onAdd(null, context)
    vi.mocked(context.drawArrays).mockClear()

    harness.completedTileSize = 1_000
    outlineLayer.draw(context, null)
    expect(context.drawArrays).not.toHaveBeenCalled()
  })

  it('keeps the outline aligned with a fading and transitioning overlay', async () => {
    const { outlineLayer, overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    const context = gl()
    overlayLayer.onAdd(null, context)
    overlayLayer.draw(context, null)
    outlineLayer.onAdd(null, context)
    vi.mocked(context.uniform1f).mockClear()
    vi.mocked(context.drawArrays).mockClear()

    harness.visible = false
    harness.fade = { value: 0.5, done: false }
    harness.transitionedSize = 0.65
    outlineLayer.draw(context, null)

    expect(context.uniform1f).toHaveBeenCalledWith('u_fade', 0.5)
    expect(context.uniform1f).toHaveBeenCalledWith('u_stampSize', 0.65)
    expect(context.drawArrays).toHaveBeenCalledOnce()
  })

  it('shares a frame upload budget across every pending visible template', async () => {
    const { overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    harness.width = 800
    harness.height = 500
    harness.indices = new Uint8Array(harness.width * harness.height)
    harness.templateCount = 2
    const context = gl()
    overlayLayer.onAdd(null, context)

    overlayLayer.draw(context, null)
    expect(
      vi
        .mocked(context.texSubImage2D)
        .mock.calls.reduce((total, call) => total + (call[8] as Uint8Array).byteLength, 0),
    ).toBe(512 * 1024)
    expect(
      vi.mocked(context.texSubImage2D).mock.calls.filter((call) => call[6] === context.RED_INTEGER),
    ).toHaveLength(4)
    expect(context.drawArrays).not.toHaveBeenCalled()
    expect(harness.triggerRepaint).toHaveBeenCalledOnce()

    overlayLayer.draw(context, null)
    expect(context.drawArrays).toHaveBeenCalledTimes(2)
  })

  it('requests a pre-art follow-up after the final delayed upload', async () => {
    const { OVERLAY_UPLOAD_PIXELS_PER_FRAME, overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    harness.width = OVERLAY_UPLOAD_PIXELS_PER_FRAME + 1
    harness.indices = new Uint8Array(harness.width)
    const context = gl()
    overlayLayer.onAdd(null, context)

    overlayLayer.draw(context, null)
    overlayLayer.draw(context, null)
    overlayLayer.draw(context, null)
    vi.mocked(harness.triggerRepaint).mockClear()
    overlayLayer.draw(context, null)

    expect(context.drawArrays).toHaveBeenCalledOnce()
    expect(harness.triggerRepaint).toHaveBeenCalledOnce()
  })

  it('does not let one large template bypass the per-frame upload budget', async () => {
    const { OVERLAY_UPLOAD_PIXELS_PER_FRAME, overlayLayer } = await import('./layer.js')
    harness.fade = { value: 1, done: true }
    harness.width = 1_024
    harness.height = Math.floor(OVERLAY_UPLOAD_PIXELS_PER_FRAME / harness.width) + 1
    harness.indices = new Uint8Array(harness.width * harness.height)
    const context = gl()
    overlayLayer.onAdd(null, context)

    overlayLayer.draw(context, null)

    const uploadedArrays = [
      ...vi
        .mocked(context.texImage2D)
        .mock.calls.filter((call) => call[2] === context.R8UI && call[8] instanceof Uint8Array)
        .map((call) => call[8] as Uint8Array),
      ...vi
        .mocked(context.texSubImage2D)
        .mock.calls.filter(
          (call) => call[6] === context.RED_INTEGER && call[8] instanceof Uint8Array,
        )
        .map((call) => call[8] as Uint8Array),
    ]
    const largestIndexUpload = uploadedArrays.reduce(
      (largest, pixels) => Math.max(largest, pixels.byteLength),
      0,
    )
    const uploadedThisFrame = uploadedArrays.reduce((total, pixels) => total + pixels.byteLength, 0)
    expect(largestIndexUpload).toBeLessThanOrEqual(OVERLAY_UPLOAD_PIXELS_PER_FRAME)
    expect(uploadedThisFrame).toBe(OVERLAY_UPLOAD_PIXELS_PER_FRAME)
    expect(harness.triggerRepaint).toHaveBeenCalledOnce()
  })

  it('restores custom layers around pixel art after a basemap style change', async () => {
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
      'caelestis-outline',
      'pixel-art-layer',
      'caelestis-overlay',
      'paint-preview-1-2',
      'caelestis-markers',
      'pixel-hover',
    ])
    expect(moveLayer).toHaveBeenNthCalledWith(1, 'caelestis-outline', 'pixel-art-layer')
    expect(moveLayer).toHaveBeenNthCalledWith(2, 'caelestis-overlay', 'paint-preview-1-2')
    expect(moveLayer).toHaveBeenNthCalledWith(3, 'caelestis-markers', 'pixel-hover')
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
      'caelestis-outline',
      'pixel-art-layer',
      'caelestis-overlay',
      'caelestis-markers',
      'pixel-hover',
    ])
    expect(moveLayer).toHaveBeenNthCalledWith(1, 'caelestis-outline', 'pixel-art-layer')
    expect(moveLayer).toHaveBeenNthCalledWith(2, 'caelestis-overlay', 'pixel-hover')
    expect(moveLayer).toHaveBeenNthCalledWith(3, 'caelestis-markers', 'pixel-hover')
  })

  it('does not move layers that are already in render order', async () => {
    const order = [
      'caelestis-outline',
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

  it('inserts the outline immediately below pixel art', async () => {
    const order = ['background', 'pixel-art-layer', 'pixel-hover']
    const { map } = orderedMap(order)
    harness.map = map
    const { installOverlayLayer } = await import('./layer.js')

    expect(installOverlayLayer()).toBe(true)
    expect(order).toEqual([
      'background',
      'caelestis-outline',
      'pixel-art-layer',
      'caelestis-overlay',
      'caelestis-markers',
      'pixel-hover',
    ])
  })
})
