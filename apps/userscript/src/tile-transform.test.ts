import { describe, expect, it, vi } from 'vitest'
import { counters } from './debug.js'
import {
  blobPartsForAttribution,
  consumeBySize,
  enqueueBySize,
  install,
  project,
  quadFromMatrix,
  resetQueues,
  runObservedCall,
  takeBySize,
  tileFromUrl,
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

describe('tileFromUrl', () => {
  it.each([
    ['https://wplace.live/files/s0/tiles/12/34.png', { x: 12, y: 34 }],
    ['https://wplace.live/files/s99/tiles/0/0.png', { x: 0, y: 0 }],
    ['https://wplace.live/files/s1/tiles/1023/2047.png?v=2', { x: 1023, y: 2047 }],
  ])('reads the coordinates out of %s', (url, expected) => {
    expect(tileFromUrl(url)).toEqual(expected)
  })

  it.each([
    ['a different extension', 'https://wplace.live/files/s0/tiles/12/34.webp'],
    ['no shard', 'https://wplace.live/files/tiles/12/34.png'],
    ['one coordinate', 'https://wplace.live/files/s0/tiles/12.png'],
    ['another route entirely', 'https://wplace.live/api/pixel/12/34'],
    // Unanchored, all three of these matched — and matching means buffering the whole body and
    // putting the coordinates it found into the attribution queue.
    ['another origin', 'https://evil.example/x/files/s0/tiles/1/2.png'],
    ['another origin with the exact path', 'https://evil.example/files/s0/tiles/1/2.png'],
    ['the pattern in a query string', 'https://wplace.live/api/report?u=/files/s0/tiles/9/9.png'],
    ['a suffix past the extension', 'https://wplace.live/files/s0/tiles/1/2.png.exe'],
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
})

describe('transparent browser hooks', () => {
  it('deactivates a provisional WebGL context after retargeting to the map', async () => {
    const fakeGl = () => ({
      getUniformLocation: vi.fn(() => null),
      uniformMatrix4fv: vi.fn(),
      bindTexture: vi.fn(),
      texSubImage2D: vi.fn(),
      texImage2D: vi.fn(),
      drawArrays: vi.fn(),
      drawElements: vi.fn(),
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

    provisional.context.drawArrays()
    await Promise.resolve()
    expect(counters.get('draw:no-texture-or-matrix')).toBeUndefined()

    mapCanvas.context.drawArrays()
    await Promise.resolve()
    expect(counters.get('draw:no-texture-or-matrix')).toBe(1)
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
})
