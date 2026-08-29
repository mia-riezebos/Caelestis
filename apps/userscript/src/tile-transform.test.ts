import { decodePng } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { counters } from './debug.js'
import {
  captureDraftPixels,
  captureTilePixels,
  clearDraftPixels,
  consumeBySize,
  currentQuads,
  draftPixels,
  enqueueBySize,
  ensureTilePixels,
  install,
  livePixelArtQuads,
  loadTilePixels,
  onAcceptedPaint,
  onFetchedTile,
  onTileFrame,
  onTilePixels,
  project,
  quadFromMatrix,
  resetQueues,
  resetTileFrameListeners,
  type TileFrame,
  takeBySize,
  takeBySizeForBitmap,
  UNPAINTED,
} from './tile-transform.js'
import {
  captureFetchUrlGetters,
  isGetFetch,
  normalizeMissingTileResponse,
  tileFromUrl,
  urlForFetchInput,
} from './wplace-raster.js'

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

afterEach(() => {
  resetTileFrameListeners()
  vi.unstubAllGlobals()
})

describe('tileFromUrl', () => {
  it.each([['https://backend.wplace.live/files/s0/tiles/12/34.png', { x: 12, y: 34 }]])(
    'reads the coordinates out of %s',
    (url, expected) => {
      expect(tileFromUrl(url)).toEqual(expected)
    },
  )

  it.each([
    ['a different extension', 'https://backend.wplace.live/files/s0/tiles/12/34.webp'],
    ['another route entirely', 'https://backend.wplace.live/api/pixel/12/34'],
    // Unanchored, all three of these matched — and matching means buffering the whole body and
    // putting the coordinates it found into the attribution queue.
    ['another origin', 'https://evil.example/x/files/s0/tiles/1/2.png'],
    ['an out-of-range tile', 'https://backend.wplace.live/files/s0/tiles/2048/1.png'],
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

  it('rejects a quad too small to be a whole-tile draw', () => {
    expect(quadFromMatrix(tileMatrix(0.002), tile, canvas(1000))).toBeNull()
  })

  it('accepts the 131,072-pixel tile size observed at zoom 19', () => {
    const quad = quadFromMatrix(tileMatrix(262.144), tile, canvas(1000))

    expect(quad?.width).toBeCloseTo(131_072, 6)
    expect(quad?.height).toBeCloseTo(131_072, 6)
  })
})

describe('livePixelArtQuads', () => {
  it('uses MapLibre current tile coordinates and its moving alignment mode', () => {
    const coordinate = {
      key: 'current',
      canonical: { z: 11, x: 3, y: 4 },
      overscaledZ: 11,
      wrap: 0,
    }
    const calculatePosMatrix = vi.fn(() => new Float32Array(tileMatrix(1)))
    const map = {
      painter: {
        options: { moving: true },
        transform: { calculatePosMatrix },
      },
      style: {
        tileManagers: {
          'pixel-art-layer': {
            getVisibleCoordinates: () => [coordinate],
          },
        },
      },
    }

    expect(livePixelArtQuads(map, canvas(1_000))).toEqual([
      { tile: { x: 3, y: 4 }, x: 250, y: 250, width: 500, height: 500 },
    ])
    expect(calculatePosMatrix).toHaveBeenCalledWith(coordinate, false, true)
  })

  it('uses aligned raster matrices when the map is settled', () => {
    const coordinate = { canonical: { x: 3, y: 4 } }
    const calculatePosMatrix = vi.fn(() => new Float32Array(tileMatrix(1)))
    const map = {
      painter: {
        options: { moving: false },
        transform: { calculatePosMatrix },
      },
      style: {
        tileManagers: {
          'pixel-art-layer': {
            getVisibleCoordinates: () => [coordinate],
          },
        },
      },
    }

    expect(livePixelArtQuads(map, canvas(1_000))).toHaveLength(1)
    expect(calculatePosMatrix).toHaveBeenCalledWith(coordinate, true, true)
  })

  it('accepts a map-like tile-manager collection from another JavaScript realm', () => {
    const coordinate = { canonical: { x: 3, y: 4 } }
    const manager = { getVisibleCoordinates: () => [coordinate] }
    const get = vi.fn((key: string) => (key === 'pixel-art-layer' ? manager : undefined))
    const map = {
      painter: {
        options: { moving: true },
        transform: { calculatePosMatrix: () => new Float32Array(tileMatrix(1)) },
      },
      style: { tileManagers: { get } },
    }

    expect(livePixelArtQuads(map, canvas(1_000))).toHaveLength(1)
    expect(get).toHaveBeenCalledWith('pixel-art-layer')
  })

  it('reports unavailable private MapLibre state for the compatibility fallback', () => {
    expect(livePixelArtQuads({}, canvas(1_000))).toBeNull()
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
    const cancel = vi.spyOn(original.body as ReadableStream, 'cancel')

    const normalized = normalizeMissingTileResponse(original, realm)
    const decoded = await decodePng(new Uint8Array(await normalized.arrayBuffer()))

    expect(normalized.status).toBe(200)
    expect(normalized.headers.get('content-type')).toBe('image/png')
    expect(cancel).toHaveBeenCalledOnce()
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

  it('waits for an in-flight tile chase instead of treating it as unavailable', async () => {
    let fetchCount = 0
    let resolveChase: ((response: Response) => void) | undefined
    class FakeCanvas {
      getContext(): null {
        return null
      }
    }
    class FakeImageBitmap {
      width = 1
      height = 1
      close = vi.fn()
    }
    const realm = {
      ...globalThis,
      Object,
      Request,
      URL,
      Response,
      fetch: vi.fn(() => {
        fetchCount++
        if (fetchCount === 1) return Promise.resolve(new Response(new Uint8Array([1])))
        return new Promise<Response>((resolve) => {
          resolveChase = resolve
        })
      }),
      Blob,
      createImageBitmap: vi.fn(async () => new FakeImageBitmap()),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer,
    } as unknown as Window & typeof globalThis
    const wanted = { x: 817, y: 613 }

    install(realm, () => null)
    await realm.fetch('https://backend.wplace.live/files/s0/tiles/1/2.png')
    captureTilePixels(true)
    try {
      expect(ensureTilePixels(wanted)).toBe(true)
      const joined = loadTilePixels(wanted, 500)

      await Promise.resolve()
      if (resolveChase === undefined) throw new Error('the chase did not reach fetch')
      resolveChase(new Response(new Uint8Array([1])))

      const pixels = await joined
      expect(pixels?.[0]).toBe(UNPAINTED)
    } finally {
      captureTilePixels(false)
    }
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
    class FakeCanvas extends EventTarget {
      width = 100
      height = 100
      isConnected = true
      readonly classList = { contains: (name: string) => name === 'maplibregl-canvas' }
      constructor(readonly context: ReturnType<typeof fakeGl>) {
        super()
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
    const locked = new FakeCanvas(fakeGl())
    Object.defineProperty(locked.context, 'getUniformLocation', {
      value: locked.context.getUniformLocation,
      writable: false,
      configurable: false,
    })
    expect(() => locked.getContext('webgl2')).not.toThrow()

    const throwingSetup = new FakeCanvas(fakeGl())
    const originalThrowingGetUniformLocation = throwingSetup.context.getUniformLocation
    Object.defineProperty(throwingSetup.context, 'getParameter', {
      configurable: true,
      get() {
        throw new Error('a co-installed WebGL getter failed')
      },
    })
    expect(() => throwingSetup.getContext('webgl2')).not.toThrow()
    expect(throwingSetup.context.getUniformLocation).toBe(originalThrowingGetUniformLocation)

    const provisional = new FakeCanvas(fakeGl())
    const originalProvisionalDrawArrays = provisional.context.drawArrays
    const removeProvisionalListener = vi.spyOn(provisional, 'removeEventListener')
    provisional.getContext('webgl2')
    const firstMap = new FakeCanvas(fakeGl())
    const originalFirstMapDrawArrays = firstMap.context.drawArrays
    const removeFirstMapListener = vi.spyOn(firstMap, 'removeEventListener')
    mapCanvas = firstMap
    firstMap.getContext('webgl2')
    expect(provisional.context.drawArrays).toBe(originalProvisionalDrawArrays)
    expect(removeProvisionalListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function))
    counters.clear()

    locked.context.drawArrays(0, 0, 1)
    throwingSetup.context.drawArrays(0, 0, 1)
    provisional.context.drawArrays(0, 0, 1)
    await Promise.resolve()
    expect(counters.get('draw:no-texture-or-matrix')).toBeUndefined()

    firstMap.context.drawArrays(0, 0, 1)
    await Promise.resolve()
    expect(counters.get('draw:not-raster-program')).toBe(1)

    const replacement = new FakeCanvas(fakeGl())
    const originalReplacementDrawArrays = replacement.context.drawArrays
    // The one-shot map capture still points at the first Map instance after an SPA remount. Its
    // detached canvas must not veto the new measured MapLibre canvas.
    firstMap.isConnected = false
    replacement.getContext('webgl2')
    expect(firstMap.context.drawArrays).toBe(originalFirstMapDrawArrays)
    expect(removeFirstMapListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function))
    counters.clear()
    replacement.context.drawArrays(0, 0, 1)
    await Promise.resolve()
    expect(counters.get('draw:not-raster-program')).toBe(1)

    const secondReplacement = new FakeCanvas(fakeGl())
    // SPA mounts can overlap: the replacement context is created before the old canvas disconnects.
    secondReplacement.getContext('webgl2')
    expect(replacement.context.drawArrays).toBe(originalReplacementDrawArrays)
    counters.clear()
    secondReplacement.context.drawArrays(0, 0, 1)
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
      isConnected = true
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
    const originalMapDrawArrays = map.context.drawArrays
    const unrelated = new FakeCanvas(fakeGl(), false)
    map.getContext('webgl2')
    unrelated.getContext('webgl2')
    counters.clear()

    map.context.drawArrays(0, 0, 1)
    await Promise.resolve()

    expect(counters.get('draw:not-raster-program')).toBe(1)

    const replacement = new FakeCanvas(fakeGl(), true)
    map.isConnected = false
    replacement.getContext('webgl2')
    expect(map.context.drawArrays).toBe(originalMapDrawArrays)
    counters.clear()
    replacement.context.drawArrays(0, 0, 1)
    await Promise.resolve()
    expect(counters.get('draw:not-raster-program')).toBe(1)
  })

  it('preserves WebGL1 framebuffer state after an invalid undefined target', async () => {
    let nativeFramebuffer: object | null = null
    let invalidBindingQueries = 0
    const nativeFramebuffers = new WeakSet<object>()
    const fakeGl = {
      TEXTURE0: 0x84c0,
      TEXTURE_2D: 0x0de1,
      TEXTURE_BINDING_2D: 0x8069,
      FRAMEBUFFER: 0x8d40,
      FRAMEBUFFER_BINDING: 0x8ca6,
      COLOR_BUFFER_BIT: 0x4000,
      DEPTH_BUFFER_BIT: 0x0100,
      STENCIL_BUFFER_BIT: 0x0400,
      SCISSOR_TEST: 0x0c11,
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
      CURRENT_PROGRAM: 0x8b8d,
      getParameter: vi.fn((parameter: number | undefined) => {
        if (parameter === undefined) {
          invalidBindingQueries++
          return null
        }
        if (parameter === 0x8b4d) return 2
        if (parameter === 0x8ca6) return nativeFramebuffer
        return null
      }),
      getUniformLocation: vi.fn(() => null),
      useProgram: vi.fn(),
      uniform1i: vi.fn(),
      uniformMatrix4fv: vi.fn(),
      activeTexture: vi.fn(),
      createTexture: vi.fn(() => ({})),
      bindTexture: vi.fn(),
      deleteTexture: vi.fn(),
      texSubImage2D: vi.fn(),
      texImage2D: vi.fn(),
      drawArrays: vi.fn(),
      drawElements: vi.fn(),
      createFramebuffer: vi.fn(() => {
        const framebuffer = {}
        nativeFramebuffers.add(framebuffer)
        return framebuffer
      }),
      bindFramebuffer: vi.fn((target: number, framebuffer?: object | null) => {
        if (target !== 0x8d40) return
        const normalized = framebuffer ?? null
        if (normalized === null || nativeFramebuffers.has(normalized))
          nativeFramebuffer = normalized
      }),
      deleteFramebuffer: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      colorMask: vi.fn(),
      clear: vi.fn(),
    }
    class FakeCanvas extends EventTarget {
      width = 1_000
      height = 1_000
      isConnected = true
      readonly classList = { contains: (name: string) => name === 'maplibregl-canvas' }
      getContext(_type?: string): typeof fakeGl {
        return fakeGl
      }
    }
    const realm = {
      Object,
      Request,
      URL,
      Response,
      fetch: globalThis.fetch,
      Blob,
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer,
      Float32Array,
    } as unknown as Window & typeof globalThis
    const frames: TileFrame[] = []
    onTileFrame((frame) => frames.push(frame))
    const nativeBindFramebuffer = fakeGl.bindFramebuffer
    install(realm, () => null)
    const gl = new FakeCanvas().getContext('webgl') as unknown as WebGLRenderingContext
    expect(gl.bindFramebuffer).not.toBe(nativeBindFramebuffer)
    const framebuffer = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)

    counters.clear()
    Reflect.apply(gl.bindFramebuffer, gl, [undefined, null])
    gl.drawArrays(0, 0, 1)
    await Promise.resolve()

    expect(invalidBindingQueries).toBe(0)
    expect(counters.get('draw:not-raster-program')).toBeUndefined()
    expect(frames).toEqual([])
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
      createProgram: native('createProgram', {}),
      useProgram: native('useProgram'),
      deleteProgram: native('deleteProgram'),
      uniform1i: native('uniform1i'),
      uniformMatrix4fv: native('uniformMatrix4fv'),
      activeTexture: native('activeTexture'),
      createTexture: native('createTexture', {}),
      bindTexture: native('bindTexture'),
      deleteTexture: native('deleteTexture'),
      texSubImage2D: native('texSubImage2D'),
      texImage2D: native('texImage2D'),
      drawArrays: native('drawArrays'),
      drawElements: native('drawElements'),
      createFramebuffer: native('createFramebuffer', {}),
      bindFramebuffer: native('bindFramebuffer'),
      deleteFramebuffer: native('deleteFramebuffer'),
      enable: native('enable'),
      disable: native('disable'),
      colorMask: native('colorMask'),
      clear: native('clear'),
    }
    const nativeTexImage2D = fakeGl.texImage2D
    Reflect.deleteProperty(fakeGl, 'texImage2D')
    const inheritedHooks = Object.create(Object.getPrototypeOf(fakeGl)) as object
    Object.defineProperty(inheritedHooks, 'texImage2D', {
      value: nativeTexImage2D,
      writable: false,
      configurable: false,
      enumerable: true,
    })
    Object.setPrototypeOf(fakeGl, inheritedHooks)
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
    const installedGetContext = realm.HTMLCanvasElement.prototype.getContext
    const texImage2DDescriptor = Object.getOwnPropertyDescriptor(gl, 'texImage2D')
    expect(Object.hasOwn(installedGetContext, 'prototype')).toBe(false)
    expect(() => Reflect.construct(Object, [], installedGetContext)).toThrow(TypeError)
    expect(Object.hasOwn(gl.drawArrays, 'prototype')).toBe(false)
    expect(() => Reflect.construct(Object, [], gl.drawArrays)).toThrow(TypeError)
    expect(gl.texImage2D.name).toBe(nativeTexImage2D.name)
    expect(gl.texImage2D.length).toBe(nativeTexImage2D.length)
    expect(texImage2DDescriptor?.enumerable).toBe(true)
    expect(gl.getUniformLocation({} as WebGLProgram, 'hostile-shim')).toBe(
      1 as unknown as WebGLUniformLocation,
    )
    receivers.length = 0
    const other = {} as WebGL2RenderingContext
    const calls: Array<[keyof WebGL2RenderingContext, unknown[]]> = [
      ['getUniformLocation', [{}, 'name']],
      ['createProgram', []],
      ['useProgram', [null]],
      ['deleteProgram', [null]],
      ['uniform1i', [null, 0]],
      ['uniformMatrix4fv', [null, false, new Float32Array(16)]],
      ['activeTexture', [gl.TEXTURE0]],
      ['createTexture', []],
      ['bindTexture', [gl.TEXTURE_2D, null]],
      ['deleteTexture', [null]],
      ['texSubImage2D', [gl.TEXTURE_2D]],
      ['texImage2D', [gl.TEXTURE_2D]],
      ['drawArrays', [0, 0, 0]],
      ['drawElements', [0, 0, 0, 0]],
      ['createFramebuffer', []],
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

  it('keeps raster identity and projection scoped to their WebGL state', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const locations = new WeakMap<object, Map<string, object>>()
    let nativeProgram: object | null = null
    const nativePrograms = new WeakSet<object>()
    let nativeDrawFramebuffer: object | null = null
    let nativeFramebuffers = new WeakSet<object>()
    let nativeActiveTexture = 0x84c0
    let nativeTextures = new WeakSet<object>()
    const nativeTexture2DByUnit = new Map<number, object | null>()
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
      DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
      TEXTURE_BINDING_2D: 0x8069,
      getParameter: vi.fn((parameter: number) => {
        if (parameter === 0x8b4d) return 2
        if (parameter === 0x8b8d) return nativeProgram
        if (parameter === 0x8ca6) return nativeDrawFramebuffer
        if (parameter === 0x8069) return nativeTexture2DByUnit.get(nativeActiveTexture) ?? null
        return null
      }),
      getUniformLocation: vi.fn((program: object, name: string) => {
        const programLocations = locations.get(program) ?? new Map<string, object>()
        locations.set(program, programLocations)
        const location = programLocations.get(name) ?? {}
        programLocations.set(name, location)
        return location
      }),
      createProgram: vi.fn(() => {
        const program = {}
        nativePrograms.add(program)
        return program
      }),
      useProgram: vi.fn((program: object | null) => {
        if (program === null || (program !== rejectedProgram && nativePrograms.has(program))) {
          nativeProgram = program
        }
      }),
      deleteProgram: vi.fn((program: object | null) => {
        if (program !== null) nativePrograms.delete(program)
      }),
      uniform1i: vi.fn(),
      uniformMatrix4fv: vi.fn(),
      activeTexture: vi.fn((texture: number) => {
        if (texture === 0x84c0 || texture === 0x84c1) nativeActiveTexture = texture
      }),
      createTexture: vi.fn(() => {
        const texture = {}
        nativeTextures.add(texture)
        return texture
      }),
      bindTexture: vi.fn((target: number, texture?: object | null) => {
        if (target !== 0x0de1) return
        const normalized = texture ?? null
        if (normalized === null || nativeTextures.has(normalized)) {
          nativeTexture2DByUnit.set(nativeActiveTexture, normalized)
        }
      }),
      deleteTexture: vi.fn((texture: object | null) => {
        if (texture === null || !nativeTextures.delete(texture)) return
        for (const [unit, bound] of nativeTexture2DByUnit) {
          if (bound === texture) nativeTexture2DByUnit.set(unit, null)
        }
      }),
      texSubImage2D: vi.fn(),
      texImage2D: vi.fn(),
      drawArrays: vi.fn(),
      drawElements: vi.fn(),
      createFramebuffer: vi.fn(() => {
        const framebuffer = {}
        nativeFramebuffers.add(framebuffer)
        return framebuffer
      }),
      bindFramebuffer: vi.fn((_target: number, framebuffer?: object | null) => {
        const normalized = framebuffer ?? null
        if (normalized === null || nativeFramebuffers.has(normalized)) {
          nativeDrawFramebuffer = normalized
        }
      }),
      deleteFramebuffer: vi.fn((framebuffer: object | null) => {
        if (framebuffer === null || !nativeFramebuffers.delete(framebuffer)) return
        if (nativeDrawFramebuffer === framebuffer) nativeDrawFramebuffer = null
      }),
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
    canvas.addEventListener('webglcontextlost', () => {
      nativeDrawFramebuffer = null
      nativeFramebuffers = new WeakSet<object>()
      nativeActiveTexture = 0x84c0
      nativeTextures = new WeakSet<object>()
      nativeTexture2DByUnit.clear()
    })
    install(realm, () => null)
    canvas.getContext('webgl2')
    const gl = fakeGl as unknown as WebGL2RenderingContext
    const rasterProgram = gl.createProgram()
    const otherProgram = gl.createProgram()
    if (rasterProgram === null || otherProgram === null) {
      throw new Error('fake program creation must succeed')
    }
    const image0 = gl.getUniformLocation(rasterProgram, 'u_image0')
    const projection = gl.getUniformLocation(rasterProgram, 'u_projection_matrix')
    if (image0 === null || projection === null) throw new Error('fake raster locations must exist')
    const currentProgramQueries = (): number =>
      fakeGl.getParameter.mock.calls.filter(([parameter]) => parameter === fakeGl.CURRENT_PROGRAM)
        .length
    const queriesBeforeRasterBind = currentProgramQueries()
    gl.useProgram(rasterProgram)
    expect(currentProgramQueries()).toBe(queriesBeforeRasterBind)
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
    await upload(gl.TEXTURE0, gl.createTexture(), 3)
    await upload(gl.TEXTURE1, gl.createTexture(), 1)
    // Uploading another target must not delete the active unit's 2D tile attribution.
    gl.activeTexture(gl.TEXTURE0)
    gl.texImage2D(gl.TEXTURE_CUBE_MAP, 0, 0, 0, 0, new FakeImageBitmap() as unknown as ImageBitmap)
    Reflect.apply(gl.uniformMatrix4fv, gl, [
      projection,
      0,
      new Float32Array(tileMatrix(1)),
      null,
      null,
    ])
    const frames: TileFrame[] = []
    let listenerFailures = 0
    onTileFrame(() => {
      listenerFailures++
      throw new Error('one frame listener must not abort the rest')
    })
    onTileFrame((frame) => frames.push(frame))
    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()

    expect(frames).toHaveLength(1)
    expect(frames[0]?.quads[0]?.tile).toEqual({ x: 3, y: 4 })

    const otherProjection = gl.getUniformLocation(otherProgram, 'u_projection_matrix')
    if (otherProjection === null) throw new Error('fake secondary location must exist')
    const queriesBeforeOtherBind = currentProgramQueries()
    gl.useProgram(otherProgram)
    expect(currentProgramQueries()).toBe(queriesBeforeOtherBind)
    gl.uniformMatrix4fv(otherProjection, false, new Float32Array(tileMatrix(0.5, 0.5, 0.5)))
    gl.drawElements(0, 1, 0, 0)
    // This is still the same MapLibre task, before the queued flush. The active frame has no raster
    // tiles, so GL layers must see an empty current frame rather than the prior frame's tile.
    expect(currentQuads()).toEqual([])
    await Promise.resolve()
    expect(frames).toHaveLength(2)
    expect(frames[1]?.quads).toEqual([])

    gl.useProgram(rasterProgram)
    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()

    expect(frames).toHaveLength(3)
    expect(frames[2]?.quads[0]).toEqual(frames[0]?.quads[0])

    gl.deleteProgram(otherProgram)
    const queriesBeforeDeletedBind = currentProgramQueries()
    gl.useProgram(otherProgram)
    expect(currentProgramQueries()).toBe(queriesBeforeDeletedBind + 1)

    // INVALID_ENUM leaves the native active unit unchanged. The mirror must not drift onto an
    // unbounded bogus key and attribute the following valid bind/upload to the wrong unit.
    const replacement = gl.createTexture()
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
    const offscreen = gl.createFramebuffer()
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

    const queriesBeforeRejectedBind = currentProgramQueries()
    gl.useProgram(rejectedProgram as WebGLProgram)
    expect(currentProgramQueries()).toBe(queriesBeforeRejectedBind + 1)
    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()
    expect(frames).toHaveLength(13)
    expect(frames[12]?.quads[0]?.tile).toEqual({ x: 7, y: 4 })

    gl.deleteTexture(replacement)
    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()
    expect(frames).toHaveLength(14)
    expect(frames[13]?.quads).toEqual([])

    await upload(gl.TEXTURE0, gl.createTexture(), 7)
    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()
    expect(frames).toHaveLength(15)
    expect(frames[14]?.quads[0]?.tile).toEqual({ x: 7, y: 4 })

    const beforeFramebufferEdges = frames.length
    const secondOffscreen = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, secondOffscreen)
    Reflect.apply(gl.bindFramebuffer, gl, [gl.FRAMEBUFFER, undefined])
    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()
    expect(frames).toHaveLength(beforeFramebufferEdges + 1)
    expect(frames.at(-1)?.quads[0]?.tile).toEqual({ x: 7, y: 4 })

    // Native WebGL rejects a framebuffer from another context without throwing. The observer must
    // retain the accepted default binding instead of treating subsequent visible draws as offscreen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, {} as WebGLFramebuffer)
    gl.drawElements(0, 1, 0, 0)
    await Promise.resolve()
    expect(frames).toHaveLength(beforeFramebufferEdges + 2)
    expect(frames.at(-1)?.quads[0]?.tile).toEqual({ x: 7, y: 4 })

    const staleFramebuffer = gl.createFramebuffer()
    const staleTexture = gl.createTexture()
    canvas.dispatchEvent(new Event('webglcontextlost'))
    await Promise.resolve()
    expect(frames).toHaveLength(beforeFramebufferEdges + 3)
    expect(frames.at(-1)?.quads).toEqual([])
    expect(listenerFailures).toBe(beforeFramebufferEdges + 3)
    const bindingQueriesBeforeStaleBinds = fakeGl.getParameter.mock.calls.filter(
      ([parameter]) => parameter === fakeGl.DRAW_FRAMEBUFFER_BINDING || parameter === 0x8069,
    ).length
    gl.bindFramebuffer(gl.FRAMEBUFFER, staleFramebuffer)
    gl.bindTexture(gl.TEXTURE_2D, staleTexture)
    const bindingQueriesAfterStaleBinds = fakeGl.getParameter.mock.calls.filter(
      ([parameter]) => parameter === fakeGl.DRAW_FRAMEBUFFER_BINDING || parameter === 0x8069,
    ).length
    expect(bindingQueriesAfterStaleBinds).toBe(bindingQueriesBeforeStaleBinds + 2)
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('DROPPED attribution'),
      expect.anything(),
    )
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
    expect(Object.getOwnPropertyDescriptor(realm.Blob, 'prototype')).toEqual(
      Object.getOwnPropertyDescriptor(Blob, 'prototype'),
    )
    expect(Reflect.set(realm.Blob, 'prototype', {})).toBe(false)
  })

  it('returns page-realm promises from every asynchronous browser hook', async () => {
    class PagePromise<Value> extends Promise<Value> {}
    class FakeCanvas {
      getContext(): null {
        return null
      }
    }
    const response = {
      ok: true,
      status: 200,
      arrayBuffer: () => PagePromise.resolve(new Uint8Array([1, 2, 3]).buffer),
      blob: () => PagePromise.resolve(new Blob([new Uint8Array([1, 2, 3])])),
    } as Response
    const bitmap = { width: 1, height: 1 } as ImageBitmap
    const tileFetchPromise = PagePromise.resolve(response)
    const ordinaryFetchPromise = PagePromise.resolve(response)
    const blobBitmapPromise = PagePromise.resolve(bitmap)
    const ordinaryBitmapPromise = PagePromise.resolve(bitmap)
    const realm = {
      ...globalThis,
      Object,
      Request,
      URL,
      Response,
      Promise: PagePromise,
      fetch: vi.fn((input: RequestInfo | URL) =>
        String(input).includes('/tiles/') ? tileFetchPromise : ordinaryFetchPromise,
      ),
      Blob,
      createImageBitmap: vi.fn((source: unknown) =>
        source instanceof Blob ? blobBitmapPromise : ordinaryBitmapPromise,
      ),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer,
    } as unknown as Window & typeof globalThis

    install(realm, () => null)
    const fetchPromise = realm.fetch('https://backend.wplace.live/files/s0/tiles/1/2.png')
    expect(fetchPromise).toBeInstanceOf(PagePromise)
    const tapped = await fetchPromise
    const arrayBufferPromise = tapped.arrayBuffer()
    const blobPromise = tapped.blob()
    const bitmapPromise = realm.createImageBitmap(new realm.Blob([]))

    expect(arrayBufferPromise).toBeInstanceOf(PagePromise)
    expect(blobPromise).toBeInstanceOf(PagePromise)
    expect(bitmapPromise).toBeInstanceOf(PagePromise)
    expect(realm.fetch('https://wplace.live/api/me')).toBe(ordinaryFetchPromise)
    expect(realm.createImageBitmap({} as ImageData)).toBe(ordinaryBitmapPromise)
    await Promise.all([arrayBufferPromise, blobPromise, bitmapPromise])
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

  it('reports exact tile bytes only after the page reads the response body', async () => {
    const observed = vi.fn()
    onFetchedTile(observed)
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
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer,
    } as unknown as Window & typeof globalThis

    install(realm, () => null)
    const response = await realm.fetch('https://backend.wplace.live/files/s0/tiles/1/2.png')
    expect(observed).not.toHaveBeenCalled()

    await response.arrayBuffer()

    expect(observed).toHaveBeenCalledOnce()
    const [coord, bytes, observedAt] = observed.mock.calls[0] ?? []
    expect(coord).toEqual({ x: 1, y: 2 })
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(observedAt).toEqual(expect.any(Number))
  })

  it('reports a paint only after wplace accepts it', async () => {
    const observed = vi.fn()
    onAcceptedPaint(observed)
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
        async () =>
          new Response(JSON.stringify({ painted: 1 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
      Blob,
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer,
    } as unknown as Window & typeof globalThis
    const body = {
      season: 0,
      tiles: [{ x: 1, y: 2, pixels: { x: [3], y: [4], colors: [5] } }],
    }

    install(realm, () => null)
    await realm.fetch('https://backend.wplace.live/paint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    await vi.waitFor(() => expect(observed).toHaveBeenCalledOnce())

    expect(observed.mock.calls[0]?.[0]).toMatchObject({ ...body, painted: 1 })
    expect(observed.mock.calls[0]?.[0].observedAt).toEqual(expect.any(Number))
  })

  it('does not report a rejected paint', async () => {
    const observed = vi.fn()
    onAcceptedPaint(observed)
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
      fetch: vi.fn(async () => new Response(null, { status: 429 })),
      Blob,
      createImageBitmap: vi.fn(),
      HTMLCanvasElement: FakeCanvas,
      ArrayBuffer,
    } as unknown as Window & typeof globalThis

    install(realm, () => null)
    await realm.fetch('https://backend.wplace.live/paint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        season: 0,
        tiles: [{ x: 1, y: 2, pixels: { x: [3], y: [4], colors: [5] } }],
      }),
    })
    await Promise.resolve()

    expect(observed).not.toHaveBeenCalled()
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
    const nativeArrayBuffer = Response.prototype.arrayBuffer
    const nativeBlob = Response.prototype.blob

    expect([...new Uint8Array(buffer)]).toEqual([4, 5])
    expect(response.bodyUsed).toBe(false)
    expect(otherResponse.bodyUsed).toBe(true)
    expect(takeBySize(2)).toBeUndefined()
    expect(arrayBufferDescriptor?.writable).toBe(true)
    expect(blobDescriptor?.writable).toBe(true)
    expect(response.arrayBuffer.name).toBe(nativeArrayBuffer.name)
    expect(response.arrayBuffer.length).toBe(nativeArrayBuffer.length)
    expect(arrayBufferDescriptor?.enumerable).toBe(
      Object.getOwnPropertyDescriptor(Response.prototype, 'arrayBuffer')?.enumerable,
    )
    expect(response.blob.name).toBe(nativeBlob.name)
    expect(response.blob.length).toBe(nativeBlob.length)
    expect(blobDescriptor?.enumerable).toBe(
      Object.getOwnPropertyDescriptor(Response.prototype, 'blob')?.enumerable,
    )
    await expect(response.blob.call(undefined as unknown as Response)).rejects.toThrow()
  })

  it('announces pixels already present in the first captured draft frame', () => {
    const observed = vi.fn()
    onTilePixels(observed)
    const first = new Uint8Array(1_000 * 1_000).fill(UNPAINTED)
    first[0] = 4
    first[1] = 5

    captureDraftPixels({ x: 8, y: 9 }, first)

    expect(observed).toHaveBeenCalledWith({ x: 8, y: 9 }, [0, 0, 4, 1, 0, 5])
    expect(draftPixels({ x: 8, y: 9 })?.slice(0, 2)).toEqual(new Uint8Array([4, 5]))
  })

  it('announces canonical server fallback when the paint drawer discards its draft', () => {
    const observed = vi.fn()
    onTilePixels(observed)
    const draft = new Uint8Array(1_000 * 1_000).fill(UNPAINTED)
    draft[7] = 4
    draft[1_003] = 5
    captureDraftPixels({ x: 10, y: 11 }, draft)
    observed.mockClear()

    clearDraftPixels()

    expect(draftPixels({ x: 10, y: 11 })).toBeNull()
    expect(observed).toHaveBeenCalledWith({ x: 10, y: 11 }, [7, 0, UNPAINTED, 3, 1, UNPAINTED])
  })
})
