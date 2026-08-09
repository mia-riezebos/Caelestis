import { decodePng } from '@wts/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { counters } from './debug.js'
import {
  blobPartsForAttribution,
  captureFetchUrlGetters,
  consumeBySize,
  enqueueBySize,
  install,
  isGetFetch,
  normalizeMissingTileResponse,
  onTileFrame,
  project,
  quadFromMatrix,
  resetQueues,
  runObservedCall,
  type TileFrame,
  takeBySize,
  takeBySizeForBitmap,
  tileFromUrl,
  urlForFetchInput,
} from './tile-transform.js'

/**
 * The parts of the overlay that are arithmetic rather than browser.
 *
 * This package shipped with `--passWithNoTests` while a thousand lines of projection and attribution
 * landed in it, so the column-major indexing, the corner derivation and every drop predicate could
 * be broken without anything going red. None of this needs a browser: a matrix is sixteen numbers
 * and a canvas is two of them.
 */
const MAPLIBRE_TILE_EXTENT = 8192

/**
 * Column-major, the layout WebGL wants: scale then translate, no rotation.
 *
 * `m[5]` is negated because tile space counts y downward and clip space counts it upward, which is
 * the flip a real MapLibre matrix carries. Without it the tile's own origin projects to the bottom
 * of the screen quad rather than the top.
 */
const matrix = (scale: number, translateX: number, translateY: number): number[] => {
  const m = new Array<number>(16).fill(0)
  m[0] = scale
  m[5] = -scale
  m[10] = 1
  m[12] = translateX
  m[13] = translateY
  m[15] = 1
  return m
}

/** A matrix that maps the tile's own extent onto a square of `size` clip units at the origin. */
const tileMatrix = (clipSize: number, clipX = -clipSize / 2, clipY = clipSize / 2): number[] =>
  matrix(clipSize / MAPLIBRE_TILE_EXTENT, clipX, clipY)

const canvas = (width: number, height = width) => ({ width, height }) as HTMLCanvasElement

const tile = { x: 3, y: 4 }

afterEach(() => vi.unstubAllGlobals())

describe('tileFromUrl', () => {
  it.each([
    ['https://backend.wplace.live/files/s0/tiles/12/34.png', { x: 12, y: 34 }],
    ['https://backend.wplace.live/files/s99/tiles/0/0.png', { x: 0, y: 0 }],
    ['https://backend.wplace.live/files/s1/tiles/1023/2047.png?v=2', { x: 1023, y: 2047 }],
  ])('reads the coordinates out of %s', (url, expected) => {
    expect(tileFromUrl(url)).toEqual(expected)
  })

  it.each([
    ['a different extension', 'https://backend.wplace.live/files/s0/tiles/12/34.webp'],
    ['no shard', 'https://backend.wplace.live/files/tiles/12/34.png'],
    ['one coordinate', 'https://backend.wplace.live/files/s0/tiles/12.png'],
    ['another route entirely', 'https://backend.wplace.live/api/pixel/12/34'],
    // Unanchored, all three of these matched — and matching means buffering the whole body and
    // putting the coordinates it found into the attribution queue.
    ['another origin', 'https://evil.example/x/files/s0/tiles/1/2.png'],
    ['another origin with the exact path', 'https://evil.example/files/s0/tiles/1/2.png'],
    ['the page origin', 'https://wplace.live/files/s0/tiles/1/2.png'],
    [
      'the pattern in a query string',
      'https://backend.wplace.live/api/report?u=/files/s0/tiles/9/9.png',
    ],
    ['a suffix past the extension', 'https://backend.wplace.live/files/s0/tiles/1/2.png.exe'],
    ['an out-of-range tile', 'https://backend.wplace.live/files/s0/tiles/2048/1.png'],
    ['not a URL at all', 'http://['],
  ])('refuses %s', (_label, url) => {
    expect(tileFromUrl(url)).toBeNull()
  })
})

describe('project', () => {
  it('reads the matrix column-major, the way WebGL wrote it', () => {
    // Row-major indexing would read the translation out of 3/7 instead of 12/13 and put every tile
    // at the origin.
    expect(project(matrix(1, 0.25, -0.5), 0, 0)).toEqual([0.25, -0.5])
  })

  it('divides through by w so a perspective matrix is not read as an affine one', () => {
    const m = matrix(1, 0, 0)
    m[15] = 2
    expect(project(m, 0, 0)).toEqual([0, 0])
    expect(project(m, 1, 0)).toEqual([0.5, 0])
  })
})

describe('quadFromMatrix', () => {
  it('turns a centred tile into a screen rectangle', () => {
    // Half the clip space, centred: a 1000-pixel canvas gives a 500-pixel quad at (250, 250).
    const quad = quadFromMatrix(tileMatrix(1), tile, canvas(1000))

    expect(quad).toEqual({ tile, x: 250, y: 250, width: 500, height: 500 })
  })

  it('scales each axis by its own canvas dimension', () => {
    // A square tile over the same clip extent on a 1000x600 canvas is 500x300 on screen — which is
    // not square, and is rejected for it. That is the intended answer: MapLibre scales both axes
    // alike, so a tile that arrives non-square in screen pixels is not a whole-tile draw.
    expect(quadFromMatrix(tileMatrix(1), tile, canvas(1000, 600))).toBeNull()

    // Compensating the matrix for the canvas gives a square quad again, and the height comes from
    // the canvas height rather than its width.
    const m = tileMatrix(1)
    m[5] = -((m[0] ?? 0) * (1000 / 600))
    const quad = quadFromMatrix(m, tile, canvas(1000, 600))
    expect(quad?.width).toBe(500)
    expect(quad?.height).toBeCloseTo(500, 6)
  })

  it('flips y, because clip space counts up and the canvas counts down', () => {
    // A tile placed high in clip space must land high on the canvas, not low.
    const high = quadFromMatrix(tileMatrix(0.5, -0.25, 0.75), tile, canvas(1000))
    const low = quadFromMatrix(tileMatrix(0.5, -0.25, -0.25), tile, canvas(1000))

    expect(high?.y).toBeLessThan(low?.y ?? 0)
  })

  it.each([
    ['rotated', 0.02],
    ['barely skewed past tolerance', 1e-4],
  ])('rejects a %s matrix', (_label, skew) => {
    const m = tileMatrix(1)
    m[1] = (m[0] ?? 0) * skew
    expect(quadFromMatrix(m, tile, canvas(1000))).toBeNull()
  })

  it('rejects a pitched matrix whose diagonal still measures square', () => {
    // The reason all four corners are projected. This trapezoid has matching diagonal width and
    // height, so a diagonal-only check accepts it and paints an axis-aligned rectangle over pixels
    // that are not axis-aligned.
    const m = tileMatrix(1)
    m[3] = 1 / MAPLIBRE_TILE_EXTENT / 8
    expect(quadFromMatrix(m, tile, canvas(1000))).toBeNull()
  })

  it('rejects a shear that only moves the bottom edge', () => {
    // The other reason all four corners are projected: this leaves the top edge exactly where an
    // unsheared tile would put it, so any check that looks at one edge — or at the diagonal — sees
    // nothing wrong while the tile is a parallelogram.
    const m = tileMatrix(1)
    m[4] = (m[0] ?? 0) * 0.05
    expect(quadFromMatrix(m, tile, canvas(1000))).toBeNull()
  })

  it('rejects a y-inverted quad instead of normalising it', () => {
    // `Math.abs` on the height used to hide this: `y` still reported the top-left corner, so the
    // overlay was drawn a whole tile below the tile it names, and entirely off it.
    const m = tileMatrix(1)
    m[5] = -(m[5] ?? 0)
    expect(quadFromMatrix(m, tile, canvas(1000))).toBeNull()
  })

  it('rejects a non-finite matrix rather than drawing at NaN', () => {
    const m = tileMatrix(1)
    m[15] = 0
    expect(quadFromMatrix(m, tile, canvas(1000))).toBeNull()
  })

  it('rejects a quad too small to be a whole-tile draw', () => {
    expect(quadFromMatrix(tileMatrix(0.002), tile, canvas(1000))).toBeNull()
  })

  it('rejects a quad that is not square', () => {
    const m = tileMatrix(1)
    m[5] = -(m[0] ?? 0) * 0.5
    expect(quadFromMatrix(m, tile, canvas(1000))).toBeNull()
  })

  it('accepts a quad inside the squareness tolerance', () => {
    const m = tileMatrix(1)
    m[5] = -(m[0] ?? 0) * 1.01
    expect(quadFromMatrix(m, tile, canvas(1000))).not.toBeNull()
  })
})

describe('byte-length attribution queue', () => {
  it('expires stale entries before a later fallback can consume them', () => {
    resetQueues()
    enqueueBySize(73, { x: 1, y: 2 }, 1_000)

    expect(takeBySize(73, 31_000)).toBeUndefined()
  })

  it('caps one compressed size and consumes an exact identity match', () => {
    resetQueues()
    for (let x = 0; x < 9; x += 1) enqueueBySize(73, { x, y: 0 }, 1_000)
    consumeBySize(73, { x: 4, y: 0 })

    expect(takeBySize(73, 1_001)).toEqual({ x: 1, y: 0 })
    expect(Array.from({ length: 6 }, () => takeBySize(73, 1_001))).not.toContainEqual({
      x: 4,
      y: 0,
    })
    expect(takeBySize(73, 1_001)).toBeUndefined()
  })

  it('retires every duplicate fallback for an exact tile', () => {
    resetQueues()
    enqueueBySize(73, { x: 4, y: 5 }, 1_000)
    enqueueBySize(73, { x: 4, y: 5 }, 1_000)
    enqueueBySize(73, { x: 6, y: 7 }, 1_000)

    consumeBySize(73, { x: 4, y: 5 })

    expect(takeBySize(73, 1_001)).toEqual({ x: 6, y: 7 })
    expect(takeBySize(73, 1_001)).toBeUndefined()
  })

  it('does not consume a tile fallback for a non-tile bitmap', () => {
    resetQueues()
    enqueueBySize(73, { x: 4, y: 5 }, 1_000)

    expect(takeBySizeForBitmap(73, 512, 512, 1_001)).toBeUndefined()
    expect(takeBySize(73, 1_001)).toEqual({ x: 4, y: 5 })
  })

  it('declines an ambiguous same-size bitmap fallback', () => {
    resetQueues()
    enqueueBySize(73, { x: 4, y: 5 }, 1_000)
    enqueueBySize(73, { x: 6, y: 7 }, 1_000)

    expect(takeBySizeForBitmap(73, 1_000, 1_000, 1_001)).toBeUndefined()
    expect(takeBySize(73, 1_001)).toEqual({ x: 4, y: 5 })
    expect(takeBySize(73, 1_001)).toEqual({ x: 6, y: 7 })
  })
})

describe('transparent browser hooks', () => {
  it('reads URL and Request inputs through snapshotted native getters', () => {
    const realm = globalThis as unknown as Window & typeof globalThis
    const getters = captureFetchUrlGetters(realm)
    const url = new URL('https://backend.wplace.live/files/s0/tiles/1/2.png')
    const request = new Request('https://backend.wplace.live/files/s0/tiles/3/4.png')
    expect(urlForFetchInput(url, realm, getters)).toBe(url.href)
    Object.defineProperty(url, 'toString', {
      value: () => {
        return '/not-a-tile'
      },
    })

    expect(urlForFetchInput(url, realm, getters)).toBeNull()
    expect(urlForFetchInput(request, realm, getters)).toBe(request.url)
  })

  it('keeps using the captured URL getters if page prototypes change later', () => {
    class FakeRequest {
      constructor(readonly nativeUrl: string) {}
    }
    class FakeUrl {
      constructor(readonly nativeHref: string) {}
      toString(): string {
        return this.nativeHref
      }
    }
    Object.defineProperty(FakeRequest.prototype, 'url', {
      configurable: true,
      get(this: FakeRequest) {
        return this.nativeUrl
      },
    })
    Object.defineProperty(FakeUrl.prototype, 'href', {
      configurable: true,
      get(this: FakeUrl) {
        return this.nativeHref
      },
    })
    const realm = {
      Object,
      Request: FakeRequest,
      URL: FakeUrl,
    } as unknown as Window & typeof globalThis
    const getters = captureFetchUrlGetters(realm)
    const request = new FakeRequest('https://backend.wplace.live/files/s0/tiles/5/6.png')
    const url = new FakeUrl('https://backend.wplace.live/files/s0/tiles/7/8.png')
    Object.defineProperty(FakeRequest.prototype, 'url', {
      configurable: true,
      get: () => 'https://evil.example/files/s0/tiles/5/6.png',
    })
    Object.defineProperty(FakeUrl.prototype, 'href', {
      configurable: true,
      get: () => 'https://evil.example/files/s0/tiles/7/8.png',
    })

    expect(urlForFetchInput(request, realm, getters)).toBe(request.nativeUrl)
    expect(urlForFetchInput(url, realm, getters)).toBe(url.nativeHref)
  })

  it('recognizes only safely observable GET requests for 404 normalization', () => {
    const realm = globalThis as unknown as Window & typeof globalThis
    const getters = captureFetchUrlGetters(realm)
    const url = 'https://backend.wplace.live/files/s0/tiles/1/2.png'
    const undefinedMethod: RequestInit = {}
    Object.defineProperty(undefinedMethod, 'method', { value: undefined, enumerable: true })

    expect(isGetFetch(url, undefined, realm, getters)).toBe(true)
    expect(isGetFetch(new Request(url), undefined, realm, getters)).toBe(true)
    expect(isGetFetch(url, { headers: { accept: 'image/png' } }, realm, getters)).toBe(true)
    expect(isGetFetch(url, undefinedMethod, realm, getters)).toBe(true)
    expect(isGetFetch(url, { method: 'HEAD' }, realm, getters)).toBe(false)
    expect(isGetFetch(new Request(url, { method: 'POST' }), undefined, realm, getters)).toBe(false)

    Object.defineProperty(Object.prototype, 'method', {
      configurable: true,
      value: 'POST',
      writable: true,
    })
    try {
      expect(isGetFetch(url, {}, realm, getters)).toBe(false)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'method')
    }
  })

  it('normalizes an origin 404 to a decodable transparent PNG', async () => {
    const realm = globalThis as unknown as Window & typeof globalThis
    const original = new Response('missing', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    })

    const normalized = normalizeMissingTileResponse(original, realm)
    const decoded = await decodePng(new Uint8Array(await normalized.arrayBuffer()))

    expect(normalized.status).toBe(200)
    expect(normalized.headers.get('content-type')).toBe('image/png')
    expect({ width: decoded.width, height: decoded.height, pixels: [...decoded.pixels] }).toEqual({
      width: 1,
      height: 1,
      pixels: [0, 0, 0, 0],
    })
  })

  it('leaves non-404 failures untouched instead of queuing their bodies', () => {
    const realm = globalThis as unknown as Window & typeof globalThis
    const failed = new Response('unavailable', { status: 503 })

    expect(normalizeMissingTileResponse(failed, realm)).toBe(failed)
  })

  it('deactivates a provisional WebGL context after retargeting to the map', async () => {
    const fakeGl = () => ({
      TEXTURE0: 0x84c0,
      TEXTURE_2D: 0x0de1,
      FRAMEBUFFER: 0x8d40,
      DRAW_FRAMEBUFFER: 0x8ca9,
      COLOR_BUFFER_BIT: 0x4000,
      DEPTH_BUFFER_BIT: 0x0100,
      STENCIL_BUFFER_BIT: 0x0400,
      SCISSOR_TEST: 0x0c11,
      getUniformLocation: vi.fn(() => null),
      useProgram: vi.fn(),
      uniform1i: vi.fn(),
      uniformMatrix4fv: vi.fn(),
      activeTexture: vi.fn(),
      bindTexture: vi.fn(),
      texSubImage2D: vi.fn(),
      texImage2D: vi.fn(),
      drawArrays: vi.fn(),
      drawElements: vi.fn(),
      bindFramebuffer: vi.fn(),
      deleteFramebuffer: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      colorMask: vi.fn(),
      clear: vi.fn(),
    })
    class FakeCanvas {
      width = 100
      height = 100
      constructor(readonly context: ReturnType<typeof fakeGl>) {}
      getContext(_type?: string): ReturnType<typeof fakeGl> {
        return this.context
      }
    }
    const realm = {
      fetch: globalThis.fetch,
      Blob: globalThis.Blob,
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer: globalThis.ArrayBuffer,
    } as unknown as Window & typeof globalThis
    let mapCanvas: FakeCanvas | null = null
    const mapHandle = () =>
      mapCanvas === null
        ? null
        : {
            flyTo: () => undefined,
            easeTo: () => undefined,
            jumpTo: () => undefined,
            getZoom: () => 1,
            getCenter: () => ({ lng: 0, lat: 0 }),
            getCanvas: () => mapCanvas as unknown as HTMLCanvasElement,
          }

    install(realm, mapHandle)
    const provisional = new FakeCanvas(fakeGl())
    provisional.getContext('webgl2')
    mapCanvas = new FakeCanvas(fakeGl())
    mapCanvas.getContext('webgl2')
    counters.clear()

    provisional.context.drawArrays(0, 0, 1)
    await Promise.resolve()
    expect(counters.get('draw:no-texture-or-matrix')).toBeUndefined()

    mapCanvas.context.drawArrays(0, 0, 1)
    await Promise.resolve()
    expect(counters.get('draw:not-raster-program')).toBe(1)
  })

  it('does not let a later unrelated context steal an uncaptured map canvas', async () => {
    const fakeGl = () => ({
      TEXTURE0: 0x84c0,
      TEXTURE_2D: 0x0de1,
      FRAMEBUFFER: 0x8d40,
      DRAW_FRAMEBUFFER: 0x8ca9,
      COLOR_BUFFER_BIT: 0x4000,
      DEPTH_BUFFER_BIT: 0x0100,
      STENCIL_BUFFER_BIT: 0x0400,
      SCISSOR_TEST: 0x0c11,
      getUniformLocation: vi.fn(() => null),
      useProgram: vi.fn(),
      uniform1i: vi.fn(),
      uniformMatrix4fv: vi.fn(),
      activeTexture: vi.fn(),
      bindTexture: vi.fn(),
      texSubImage2D: vi.fn(),
      texImage2D: vi.fn(),
      drawArrays: vi.fn(),
      drawElements: vi.fn(),
      bindFramebuffer: vi.fn(),
      deleteFramebuffer: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      colorMask: vi.fn(),
      clear: vi.fn(),
    })
    class FakeCanvas {
      width = 100
      height = 100
      readonly classList: { contains: (name: string) => boolean }
      constructor(
        readonly context: ReturnType<typeof fakeGl>,
        isMap: boolean,
      ) {
        this.classList = { contains: (name) => isMap && name === 'maplibregl-canvas' }
      }
      getContext(_type?: string): ReturnType<typeof fakeGl> {
        return this.context
      }
    }
    const realm = {
      fetch: globalThis.fetch,
      Blob: globalThis.Blob,
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer: globalThis.ArrayBuffer,
    } as unknown as Window & typeof globalThis
    install(realm, () => null)
    const map = new FakeCanvas(fakeGl(), true)
    const unrelated = new FakeCanvas(fakeGl(), false)
    map.getContext('webgl2')
    unrelated.getContext('webgl2')
    counters.clear()

    map.context.drawArrays(0, 0, 1)
    await Promise.resolve()

    expect(counters.get('draw:not-raster-program')).toBe(1)
  })

  it('preserves receivers for every wrapped WebGL method', () => {
    const receivers: Array<{ method: string; receiver: unknown }> = []
    const native = (method: string, result?: unknown) =>
      vi.fn(function (this: unknown) {
        if (this === undefined || this === null) throw new TypeError('invalid WebGL receiver')
        receivers.push({ method, receiver: this })
        return result
      })
    const fakeGl = {
      TEXTURE0: 0x84c0,
      TEXTURE_2D: 0x0de1,
      FRAMEBUFFER: 0x8d40,
      DRAW_FRAMEBUFFER: 0x8ca9,
      COLOR_BUFFER_BIT: 0x4000,
      DEPTH_BUFFER_BIT: 0x0100,
      STENCIL_BUFFER_BIT: 0x0400,
      SCISSOR_TEST: 0x0c11,
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
      getParameter: vi.fn(() => 2),
      getUniformLocation: native('getUniformLocation', 1),
      useProgram: native('useProgram'),
      uniform1i: native('uniform1i'),
      uniformMatrix4fv: native('uniformMatrix4fv'),
      activeTexture: native('activeTexture'),
      bindTexture: native('bindTexture'),
      texSubImage2D: native('texSubImage2D'),
      texImage2D: native('texImage2D'),
      drawArrays: native('drawArrays'),
      drawElements: native('drawElements'),
      bindFramebuffer: native('bindFramebuffer'),
      deleteFramebuffer: native('deleteFramebuffer'),
      enable: native('enable'),
      disable: native('disable'),
      colorMask: native('colorMask'),
      clear: native('clear'),
    }
    class FakeCanvas {
      width = 100
      height = 100
      getContext(_type?: string): typeof fakeGl {
        return fakeGl
      }
    }
    const realm = {
      ...globalThis,
      fetch: globalThis.fetch,
      Blob: globalThis.Blob,
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer: globalThis.ArrayBuffer,
    } as unknown as Window & typeof globalThis
    install(realm, () => null)
    const gl = new FakeCanvas().getContext('webgl2') as unknown as WebGL2RenderingContext
    expect(gl.getUniformLocation({} as WebGLProgram, 'hostile-shim')).toBe(
      1 as unknown as WebGLUniformLocation,
    )
    receivers.length = 0
    const other = {} as WebGL2RenderingContext
    const calls: Array<[keyof WebGL2RenderingContext, unknown[]]> = [
      ['getUniformLocation', [{}, 'name']],
      ['useProgram', [null]],
      ['uniform1i', [null, 0]],
      ['uniformMatrix4fv', [null, false, new Float32Array(16)]],
      ['activeTexture', [gl.TEXTURE0]],
      ['bindTexture', [gl.TEXTURE_2D, null]],
      ['texSubImage2D', [gl.TEXTURE_2D]],
      ['texImage2D', [gl.TEXTURE_2D]],
      ['drawArrays', [0, 0, 0]],
      ['drawElements', [0, 0, 0, 0]],
      ['bindFramebuffer', [gl.FRAMEBUFFER, null]],
      ['deleteFramebuffer', [null]],
      ['enable', [gl.SCISSOR_TEST]],
      ['disable', [gl.SCISSOR_TEST]],
      ['colorMask', [true, true, true, true]],
      ['clear', [gl.COLOR_BUFFER_BIT]],
    ]

    for (const [method, args] of calls) {
      Reflect.apply(gl[method] as (...args: unknown[]) => unknown, other, args)
    }
    expect(receivers).toEqual(calls.map(([method]) => ({ method, receiver: other })))

    for (const [method, args] of calls) {
      expect(() =>
        Reflect.apply(gl[method] as (...args: unknown[]) => unknown, undefined, args),
      ).toThrow(TypeError)
    }
  })

  it('does not reread sequence elements after a matrix upload', () => {
    let reads = 0
    const location = {} as WebGLUniformLocation
    const fakeGl = {
      TEXTURE0: 0x84c0,
      TEXTURE_2D: 0x0de1,
      FRAMEBUFFER: 0x8d40,
      DRAW_FRAMEBUFFER: 0x8ca9,
      COLOR_BUFFER_BIT: 0x4000,
      DEPTH_BUFFER_BIT: 0x0100,
      STENCIL_BUFFER_BIT: 0x0400,
      SCISSOR_TEST: 0x0c11,
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
      getParameter: vi.fn(() => 2),
      getUniformLocation: vi.fn(() => location),
      useProgram: vi.fn(),
      uniform1i: vi.fn(),
      uniformMatrix4fv: vi.fn((_location, _transpose, value: ArrayLike<number>) => {
        for (let index = 0; index < 16; index += 1) void value[index]
      }),
      activeTexture: vi.fn(),
      bindTexture: vi.fn(),
      texSubImage2D: vi.fn(),
      texImage2D: vi.fn(),
      drawArrays: vi.fn(),
      drawElements: vi.fn(),
      bindFramebuffer: vi.fn(),
      deleteFramebuffer: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      colorMask: vi.fn(),
      clear: vi.fn(),
    }
    class FakeCanvas {
      width = 100
      height = 100
      getContext(_type?: string): typeof fakeGl {
        return fakeGl
      }
    }
    const realm = {
      ...globalThis,
      fetch: globalThis.fetch,
      Blob: globalThis.Blob,
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer: globalThis.ArrayBuffer,
    } as unknown as Window & typeof globalThis
    const sequence: number[] = []
    for (let index = 0; index < 16; index += 1) {
      Object.defineProperty(sequence, index, {
        configurable: true,
        get() {
          reads += 1
          return index
        },
      })
    }
    sequence.length = 16

    install(realm, () => null)
    const gl = new FakeCanvas().getContext('webgl2') as unknown as WebGL2RenderingContext
    const program = {} as WebGLProgram
    gl.useProgram(program)
    gl.getUniformLocation(program, 'u_projection_matrix')
    gl.uniformMatrix4fv(location, false, sequence)

    expect(reads).toBe(16)
  })

  it('keeps raster identity and projection scoped to their WebGL state', async () => {
    const locations = new WeakMap<object, Map<string, object>>()
    let nativeProgram: object | null = null
    const rejectedProgram = {}
    const fakeGl = {
      TEXTURE0: 0x84c0,
      TEXTURE1: 0x84c1,
      TEXTURE_2D: 0x0de1,
      TEXTURE_CUBE_MAP: 0x8513,
      FRAMEBUFFER: 0x8d40,
      DRAW_FRAMEBUFFER: 0x8ca9,
      COLOR_BUFFER_BIT: 0x4000,
      DEPTH_BUFFER_BIT: 0x0100,
      STENCIL_BUFFER_BIT: 0x0400,
      SCISSOR_TEST: 0x0c11,
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
      CURRENT_PROGRAM: 0x8b8d,
      getParameter: vi.fn((parameter: number) => {
        if (parameter === 0x8b4d) return 2
        if (parameter === 0x8b8d) return nativeProgram
        return null
      }),
      getUniformLocation: vi.fn((program: object, name: string) => {
        const programLocations = locations.get(program) ?? new Map<string, object>()
        locations.set(program, programLocations)
        const location = programLocations.get(name) ?? {}
        programLocations.set(name, location)
        return location
      }),
      useProgram: vi.fn((program: object | null) => {
        if (program !== rejectedProgram) nativeProgram = program
      }),
      uniform1i: vi.fn(),
      uniformMatrix4fv: vi.fn(),
      activeTexture: vi.fn(),
      bindTexture: vi.fn(),
      texSubImage2D: vi.fn(),
      texImage2D: vi.fn(),
      drawArrays: vi.fn(),
      drawElements: vi.fn(),
      bindFramebuffer: vi.fn(),
      deleteFramebuffer: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      colorMask: vi.fn(),
      clear: vi.fn(),
    }
    class FakeCanvas extends EventTarget {
      width = 1_000
      height = 1_000
      getContext(_type?: string): typeof fakeGl {
        return fakeGl
      }
    }
    class FakeImageBitmap {
      width = 1_000
      height = 1_000
    }
    const realm = {
      ...globalThis,
      Object,
      Request,
      URL,
      Response,
      fetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
      Blob,
      ImageBitmap: FakeImageBitmap,
      createImageBitmap: vi.fn(async () => new FakeImageBitmap()),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer,
      Float32Array,
    } as unknown as Window & typeof globalThis
    const canvas = new FakeCanvas()
    install(realm, () => null)
    canvas.getContext('webgl2')
    const gl = fakeGl as unknown as WebGL2RenderingContext
    const rasterProgram = {} as WebGLProgram
    const otherProgram = {} as WebGLProgram
    gl.useProgram(rasterProgram)
    const image0 = gl.getUniformLocation(rasterProgram, 'u_image0')
    const projection = gl.getUniformLocation(rasterProgram, 'u_projection_matrix')
    if (image0 === null || projection === null) throw new Error('fake raster locations must exist')
    gl.uniform1i(image0, 0)

    const bitmapFor = async (x: number): Promise<ImageBitmap> => {
      const response = await realm.fetch(`https://backend.wplace.live/files/s0/tiles/${x}/4.png`)
      const buffer = await response.arrayBuffer()
      const blob = new realm.Blob([buffer])
      return realm.createImageBitmap(blob)
    }
    const upload = async (unit: number, texture: WebGLTexture, x: number): Promise<void> => {
      const bitmap = await bitmapFor(x)
      gl.activeTexture(unit)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      // Another target on the same unit must not steal a 2D upload's attribution.
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, {} as WebGLTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, bitmap)
    }

    counters.clear()
    await upload(gl.TEXTURE0, {} as WebGLTexture, 3)
    await upload(gl.TEXTURE1, {} as WebGLTexture, 1)
    // Uploading another target must not delete the active unit's 2D tile attribution.
    gl.activeTexture(gl.TEXTURE0)
    gl.texImage2D(gl.TEXTURE_CUBE_MAP, 0, 0, 0, 0, new FakeImageBitmap() as unknown as ImageBitmap)
    gl.uniformMatrix4fv(projection, false, new Float32Array(tileMatrix(1)))
    const frames: TileFrame[] = []
    onTileFrame((frame) => frames.push(frame))
    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()

    expect(frames).toHaveLength(1)
    expect(frames[0]?.quads[0]?.tile).toEqual({ x: 3, y: 4 })

    gl.useProgram(otherProgram)
    const otherProjection = gl.getUniformLocation(otherProgram, 'u_projection_matrix')
    if (otherProjection === null) throw new Error('fake secondary location must exist')
    gl.uniformMatrix4fv(otherProjection, false, new Float32Array(tileMatrix(0.5, 0.5, 0.5)))
    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()
    expect(frames).toHaveLength(2)
    expect(frames[1]?.quads).toEqual([])

    gl.useProgram(rasterProgram)
    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()

    expect(frames).toHaveLength(3)
    expect(frames[2]?.quads[0]).toEqual(frames[0]?.quads[0])

    // INVALID_ENUM leaves the native active unit unchanged. The mirror must not drift onto an
    // unbounded bogus key and attribute the following valid bind/upload to the wrong unit.
    const replacement = {} as WebGLTexture
    gl.activeTexture(gl.TEXTURE0 + 99)
    gl.bindTexture(gl.TEXTURE_2D, replacement)
    gl.texImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, await bitmapFor(7))
    gl.uniform1i(image0, 0)
    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()
    expect(frames).toHaveLength(4)
    expect(frames[3]?.quads[0]?.tile).toEqual({ x: 7, y: 4 })

    // A frame can clear the default framebuffer without issuing any draw calls. That must clear a
    // previously painted overlay, while an offscreen framebuffer clear must not become a map frame.
    gl.clear(gl.COLOR_BUFFER_BIT)
    await Promise.resolve()
    expect(frames).toHaveLength(5)
    expect(frames[4]?.quads).toEqual([])

    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()
    expect(frames).toHaveLength(6)
    const offscreen = {} as WebGLFramebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, offscreen)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()
    expect(frames).toHaveLength(6)
    gl.deleteFramebuffer(offscreen)
    gl.clear(gl.COLOR_BUFFER_BIT)
    await Promise.resolve()
    expect(frames).toHaveLength(7)
    expect(frames[6]?.quads).toEqual([])

    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()
    expect(frames).toHaveLength(8)
    gl.drawElements(0, 1, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    await Promise.resolve()
    expect(frames).toHaveLength(9)
    expect(frames[8]?.quads).toEqual([])

    gl.drawElements(0, 0, 0, 0)
    await Promise.resolve()
    expect(frames).toHaveLength(9)

    gl.enable(gl.SCISSOR_TEST)
    gl.drawElements(0, 1, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.disable(gl.SCISSOR_TEST)
    await Promise.resolve()
    expect(frames).toHaveLength(10)
    expect(frames[9]?.quads[0]?.tile).toEqual({ x: 7, y: 4 })

    gl.drawElements(0, 1, 0, 0)
    gl.colorMask(true, false, true, true)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.colorMask(true, true, true, true)
    await Promise.resolve()
    expect(frames).toHaveLength(11)
    expect(frames[10]?.quads[0]?.tile).toEqual({ x: 7, y: 4 })

    gl.drawElements(0, 1, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | 0x80000000)
    await Promise.resolve()
    expect(frames).toHaveLength(12)
    expect(frames[11]?.quads[0]?.tile).toEqual({ x: 7, y: 4 })

    gl.useProgram(rejectedProgram as WebGLProgram)
    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()
    expect(frames).toHaveLength(13)
    expect(frames[12]?.quads[0]?.tile).toEqual({ x: 7, y: 4 })

    canvas.dispatchEvent(new Event('webglcontextlost'))
    await Promise.resolve()
    expect(frames).toHaveLength(14)
    expect(frames[13]?.quads).toEqual([])
  })

  it('preserves native Blob construction contracts', () => {
    class FakeCanvas {
      getContext(): null {
        return null
      }
    }
    const realm = {
      ...globalThis,
      Object,
      Request,
      URL,
      Response,
      fetch: globalThis.fetch,
      Blob,
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer,
    } as unknown as Window & typeof globalThis

    install(realm, () => null)
    const callWithoutNew = realm.Blob as unknown as () => Blob
    class ExtendedBlob extends realm.Blob {}

    expect(() => callWithoutNew()).toThrow(TypeError)
    expect(() => new realm.Blob(null as never)).toThrow(TypeError)
    expect(new ExtendedBlob([])).toBeInstanceOf(ExtendedBlob)
    expect(new realm.Blob([])).toBeInstanceOf(realm.Blob)
  })

  it('retires exact byte-length fallback before bitmap decoding settles', async () => {
    resetQueues()
    let resolveBitmap: ((bitmap: ImageBitmap) => void) | undefined
    class FakeCanvas {
      getContext(): null {
        return null
      }
    }
    const realm = {
      ...globalThis,
      Object,
      Request,
      URL,
      Response,
      fetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
      Blob,
      createImageBitmap: vi.fn(
        () =>
          new Promise<ImageBitmap>((resolve) => {
            resolveBitmap = resolve
          }),
      ),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer,
    } as unknown as Window & typeof globalThis

    install(realm, () => null)
    const response = await realm.fetch('https://backend.wplace.live/files/s0/tiles/1/2.png')
    const blob = await response.blob()
    const decoding = realm.createImageBitmap(blob)

    expect(takeBySize(blob.size)).toBeUndefined()
    resolveBitmap?.({ width: 1_000, height: 1_000 } as ImageBitmap)
    await decoding
  })

  it('does not consume an arbitrary Blob-parts iterable a second time', () => {
    let iterations = 0
    const parts = {
      *[Symbol.iterator]() {
        iterations += 1
        if (iterations > 1) throw new Error('iterated twice')
        yield new Uint8Array([1, 2, 3])
      },
    }

    new Blob(parts as unknown as BlobPart[])
    expect(() => blobPartsForAttribution(parts)).not.toThrow()
    expect(iterations).toBe(1)
  })

  it('inspects ordinary Blob-part arrays without invoking accessors', () => {
    const first = new Uint8Array([1])
    const second = new Uint8Array([2])
    const parts: BlobPart[] = [first, second]
    let accessorReads = 0
    Object.defineProperty(parts, '2', {
      enumerable: true,
      get() {
        accessorReads += 1
        return new Uint8Array([3])
      },
    })

    expect(blobPartsForAttribution(parts)).toEqual([first, second])
    expect(accessorReads).toBe(0)
  })

  it('does not commit observations when the native call fails', () => {
    let observed = false

    expect(() =>
      runObservedCall(
        () => {
          throw new DOMException('tainted', 'SecurityError')
        },
        () => {
          observed = true
        },
      ),
    ).toThrowError(DOMException)
    expect(observed).toBe(false)
  })

  it('does not expose an instrumentation failure after the native call succeeds', () => {
    expect(
      runObservedCall(
        () => 'native result',
        () => {
          throw new Error('observer failed')
        },
      ),
    ).toBe('native result')
  })

  it('does not coerce a non-standard fetch input outside the native call', async () => {
    let conversions = 0
    const input = {
      toString() {
        conversions += 1
        return 'https://backend.wplace.live/files/s0/tiles/1/2.png'
      },
    }
    class FakeCanvas {
      getContext(): null {
        return null
      }
    }
    const realm = {
      fetch: vi.fn(async (value: unknown) => {
        String(value)
        return new Response()
      }),
      Request: globalThis.Request,
      Blob: globalThis.Blob,
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer: globalThis.ArrayBuffer,
    } as unknown as Window & typeof globalThis

    install(realm, () => null)
    await realm.fetch(input as unknown as RequestInfo)

    expect(conversions).toBe(1)
  })

  it('does not clone or buffer a tile before the page reads its body', async () => {
    resetQueues()
    const nativeResponse = new Response(new Uint8Array([1, 2, 3]))
    const clone = vi.spyOn(nativeResponse, 'clone')
    class FakeCanvas {
      getContext(): null {
        return null
      }
    }
    const realm = {
      ...globalThis,
      Object,
      Request,
      URL,
      Response,
      fetch: vi.fn(async () => nativeResponse),
      Blob,
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer,
    } as unknown as Window & typeof globalThis

    install(realm, () => null)
    const response = await realm.fetch('https://backend.wplace.live/files/s0/tiles/1/2.png')

    expect(response).toBe(nativeResponse)
    expect(clone).not.toHaveBeenCalled()
    expect(takeBySize(3)).toBeUndefined()

    await response.arrayBuffer()
    expect(takeBySize(3)).toEqual({ x: 1, y: 2 })
  })

  it('snapshots mutable fetch metadata before the caller can change it', async () => {
    resetQueues()
    let resolveFetch: ((response: Response) => void) | undefined
    class FakeCanvas {
      getContext(): null {
        return null
      }
    }
    const realm = {
      ...globalThis,
      Object,
      Request,
      URL,
      Response,
      fetch: vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve
          }),
      ),
      Blob,
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer,
    } as unknown as Window & typeof globalThis
    const url = new URL('https://backend.wplace.live/files/s0/tiles/1/2.png')
    const init = { method: 'GET' }

    install(realm, () => null)
    const pending = realm.fetch(url, init)
    url.pathname = '/files/s0/tiles/8/9.png'
    init.method = 'HEAD'
    resolveFetch?.(new Response('missing', { status: 404 }))
    const response = await pending
    const bytes = await response.arrayBuffer()

    expect(response.status).toBe(200)
    expect(takeBySize(bytes.byteLength)).toEqual({ x: 1, y: 2 })
  })

  it('does not infer GET after native fetch consumes a self-deleting method getter', async () => {
    class FakeCanvas {
      getContext(): null {
        return null
      }
    }
    const init: RequestInit = {}
    Object.defineProperty(init, 'method', {
      configurable: true,
      get() {
        Reflect.deleteProperty(init, 'method')
        return 'HEAD'
      },
    })
    const realm = {
      ...globalThis,
      Object,
      Request,
      URL,
      Response,
      fetch: vi.fn(async (_input: RequestInfo | URL, nativeInit?: RequestInit) => {
        void nativeInit?.method
        return new Response('missing', { status: 404 })
      }),
      Blob,
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer,
    } as unknown as Window & typeof globalThis

    install(realm, () => null)
    const response = await realm.fetch('https://backend.wplace.live/files/s0/tiles/1/2.png', init)

    expect(response.status).toBe(404)
  })

  it('preserves the receiver semantics of tapped response body methods', async () => {
    resetQueues()
    const tileResponse = new Response(new Uint8Array([1, 2, 3]))
    const otherResponse = new Response(new Uint8Array([4, 5]))
    class FakeCanvas {
      getContext(): null {
        return null
      }
    }
    const realm = {
      ...globalThis,
      Object,
      Request,
      URL,
      Response,
      fetch: vi.fn(async () => tileResponse),
      Blob,
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer,
    } as unknown as Window & typeof globalThis

    install(realm, () => null)
    const response = await realm.fetch('https://backend.wplace.live/files/s0/tiles/1/2.png')
    const buffer = await response.arrayBuffer.call(otherResponse)
    const arrayBufferDescriptor = Object.getOwnPropertyDescriptor(response, 'arrayBuffer')
    const blobDescriptor = Object.getOwnPropertyDescriptor(response, 'blob')

    expect([...new Uint8Array(buffer)]).toEqual([4, 5])
    expect(response.bodyUsed).toBe(false)
    expect(otherResponse.bodyUsed).toBe(true)
    expect(takeBySize(2)).toBeUndefined()
    expect(arrayBufferDescriptor?.writable).toBe(true)
    expect(blobDescriptor?.writable).toBe(true)
    await expect(response.blob.call(undefined as unknown as Response)).rejects.toThrow()
  })

  it('does not coerce a non-string context id after the native call', () => {
    let conversions = 0
    const id = {
      toString() {
        conversions += 1
        return 'webgl2'
      },
    }
    class FakeCanvas {
      getContext(value: unknown): null {
        String(value)
        return null
      }
    }
    const realm = {
      fetch: globalThis.fetch,
      Request: globalThis.Request,
      Blob: globalThis.Blob,
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer: globalThis.ArrayBuffer,
    } as unknown as Window & typeof globalThis

    install(realm, () => null)
    new FakeCanvas().getContext(id)

    expect(conversions).toBe(1)
  })
})
