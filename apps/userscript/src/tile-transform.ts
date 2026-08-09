import type { TileCoord } from '@wts/shared'
import { count, log, warn } from './debug.js'
import { getMap } from './map-handle.js'
import { pageWindow } from './page-world.js'

/**
 * Which wplace tile is on screen, where, right now?
 *
 * MapLibre already knows where, and uploads the answer to the GPU every frame. Rather than
 * reimplement the projection — which drifts, and which the URL cannot supply because it does not
 * update during cursor interaction — this reads MapLibre's own matrix back out of the WebGL
 * context. Nothing is recomputed, so there is nothing to drift.
 *
 * The hook that makes the matrix legible is `getUniformLocation`: it takes the uniform's *name* as
 * a string, so recording those turns `uniformMatrix4fv` from an anonymous sixteen floats into a
 * named `u_projection_matrix`.
 *
 * Recovering *which* tile is harder, because a draw call knows only a texture. The chain from URL
 * to texture is `fetch → Blob → ImageBitmap → texImage2D`, and object identity does not survive the
 * first step: `Response.blob()` hands back a fresh `Blob`, so a `WeakMap` keyed on the blob seen in
 * the shim never matches — measured, zero attributions. Byte length does survive, and is what
 * carries the tile coordinate across that gap.
 *
 * Everything here must be installed before MapLibre calls `getContext`, so it has to run at
 * `document-start`.
 */

/** MapLibre's tile coordinate extent. Tile-local `(0,0)`..`(EXTENT,EXTENT)` spans one whole tile. */
const MATRIX_LENGTH = 16
const MAPLIBRE_TILE_EXTENT = 8192

/** How square a quad must be to be believed, as a fraction of its width. */
const SQUARENESS_TOLERANCE = 0.02

/**
 * Bounds on a believable tile, in device pixels.
 *
 * The upper one is a sanity check against a nonsense matrix and nothing more, which is why it is so
 * loose. An earlier version guessed 1e5, which is smaller than a real tile from zoom 19 up —
 * measured, one tile spans 131,072 px at zoom 19 and 514,976 px at zoom 21 — so the overlay vanished
 * exactly when the user zoomed in far enough to want it most. The real filtering is done by
 * requiring the texture to be a tile we attributed and the quad to be square.
 */
const MIN_TILE_SCREEN_WIDTH = 4
const MAX_TILE_SCREEN_WIDTH = 1e9

/**
 * There is no grace period before clearing, deliberately.
 *
 * The frame in which MapLibre stops drawing tiles *is* the frame in which wplace's pixels vanish,
 * and the flush is a microtask, so clearing there composites in the same browser frame. Any delay
 * added here is delay the user sees the overlay hanging over a map that no longer has tiles under
 * it — this started at 250ms, went to 50ms, and is now none.
 *
 * The grace was originally there to absorb a stray tile-less frame. Two things retired it: the
 * texSubImage2D attribution bug turned out to be what it was really hiding, and a measurement over
 * 703 frames of heavy panning and zooming produced no stray frames at all. If one ever does occur
 * the cost is a single frame of missing overlay — about 16ms, and self-correcting — which is
 * cheaper than making every genuine clear late.
 */

/**
 * How much rotation in the projection matrix is tolerated before a quad is refused.
 *
 * A `TileQuad` is an axis-aligned rectangle, which cannot describe a rotated tile — so if wplace
 * ever enables rotation, drawing one would put the overlay somewhere confidently wrong. wplace has
 * rotation off today: measured across 234,574 matrix uploads, including a two-finger twist under
 * touch emulation, the off-diagonal terms were exactly zero. That is a product decision of theirs,
 * not a guarantee, so it is checked rather than assumed. Failing the check draws nothing, which is
 * a visible absence rather than a silent misplacement.
 */
const ROTATION_TOLERANCE = 1e-6

export const TILE_URL = /\/files\/s\d+\/tiles\/(\d+)\/(\d+)\.png/

export interface TileQuad {
  readonly tile: TileCoord
  /** Screen position of the tile's top-left corner, in canvas device pixels. */
  readonly x: number
  readonly y: number
  /** Screen size of the whole tile, in canvas device pixels. */
  readonly width: number
  readonly height: number
}

export interface TileFrame {
  readonly canvas: HTMLCanvasElement
  /**
   * Every wplace tile drawn this frame. Empty when the map is showing none — zoomed out past the
   * point where wplace serves them, for instance — which is the signal to clear the overlay rather
   * than leave the last frame's squares stranded on screen.
   */
  readonly quads: readonly TileQuad[]
}

type FrameListener = (frame: TileFrame) => void

const listeners: FrameListener[] = []
let mapCanvas: HTMLCanvasElement | null = null
let pending: TileQuad[] = []
let scheduled = false

/**
 * Tiles whose bytes have been seen but whose `ImageBitmap` has not been built yet, keyed by
 * response byte length. A queue per length, because two tiles can compress to the same size — every
 * empty tile is 73 bytes — so same-size tiles are matched first-in, first-out.
 */
const tilesByByteLength = new Map<number, TileCoord[]>()

/**
 * How many unattributed tiles of one size to remember.
 *
 * The queue only answers the case where a bitmap arrives with no tagged object behind it, which is
 * rare. Unbounded, a long pan filled it with tiles that were attributed by identity and never
 * consumed, and the oldest of those eventually answered for a completely different tile.
 */
const MAX_QUEUED_PER_SIZE = 8

const consumeBySize = (bytes: number, tile: TileCoord): void => {
  const queue = tilesByByteLength.get(bytes)
  if (queue === undefined) return
  const at = queue.findIndex((candidate) => candidate.x === tile.x && candidate.y === tile.y)
  if (at !== -1) queue.splice(at, 1)
  if (queue.length === 0) tilesByByteLength.delete(bytes)
}

const enqueueBySize = (bytes: number, tile: TileCoord): void => {
  const queue = tilesByByteLength.get(bytes) ?? []
  queue.push(tile)
  if (queue.length > MAX_QUEUED_PER_SIZE) queue.shift()
  tilesByByteLength.set(bytes, queue)
}
const tileOfBitmap = new WeakMap<ImageBitmap, TileCoord>()

/**
 * The exact route, in two hops.
 *
 * wplace reads a tile with `arrayBuffer()` — measured, 16 calls and not one `blob()` — and builds
 * its own `Blob` from the bytes, so handing back a tagged `Blob` achieves nothing. Instead the
 * *buffer* is tagged, and the `Blob` constructor is wrapped to carry the tag onto whatever `Blob`
 * gets built from it. Byte length stays only as a fallback for anything reaching
 * `createImageBitmap` by another path.
 */
const tileOfBlob = new WeakMap<Blob, TileCoord>()
const tileOfBuffer = new WeakMap<ArrayBufferLike, TileCoord>()

/** Column-major 4x4, the layout WebGL uses. */
export const project = (m: ArrayLike<number>, x: number, y: number): readonly [number, number] => {
  const at = (index: number): number => m[index] ?? 0
  const clipX = at(0) * x + at(4) * y + at(12)
  const clipY = at(1) * x + at(5) * y + at(13)
  const clipW = at(3) * x + at(7) * y + at(15)
  return [clipX / clipW, clipY / clipW]
}

export const quadFromMatrix = (
  m: ArrayLike<number>,
  tile: TileCoord,
  canvas: HTMLCanvasElement,
): TileQuad | null => {
  const e = MAPLIBRE_TILE_EXTENT
  // Clip space is -1..1 with y up; the canvas is 0..size with y down.
  const toScreenX = (clip: number) => (clip * 0.5 + 0.5) * canvas.width
  const toScreenY = (clip: number) => (1 - (clip * 0.5 + 0.5)) * canvas.height
  const corner = (u: number, v: number): readonly [number, number] => {
    const [cx, cy] = project(m, u, v)
    return [toScreenX(cx), toScreenY(cy)]
  }
  // All four, not just the diagonal. A pitched or perspective transform turns a tile into a
  // trapezoid whose diagonal still measures square, and an axis-aligned rectangle drawn over it
  // lands on pixels that are not where the overlay thinks they are.
  const [topLeft, topRight, bottomLeft, bottomRight] = [
    corner(0, 0),
    corner(e, 0),
    corner(0, e),
    corner(e, e),
  ]
  const x = topLeft[0]
  const y = topLeft[1]
  const width = topRight[0] - x
  const height = bottomLeft[1] - y

  const reject = (why: string, data: unknown): null => {
    log('quad', `rejected ${tile.x}/${tile.y}: ${why}`, data)
    return null
  }
  const finite = [topLeft, topRight, bottomLeft, bottomRight].flat().every(Number.isFinite)
  if (!finite) return reject('non-finite', { topLeft, bottomRight })
  // Axis alignment measured on the screen quad itself: opposite edges must be parallel to the axes
  // and to each other, which is what a rotation, a pitch or a skew breaks.
  const span = Math.max(Math.abs(width), Math.abs(height)) || 1
  const skew =
    Math.max(
      Math.abs(topRight[1] - topLeft[1]),
      Math.abs(bottomRight[1] - bottomLeft[1]),
      Math.abs(bottomLeft[0] - topLeft[0]),
      Math.abs(bottomRight[0] - topRight[0]),
    ) / span
  if (skew > ROTATION_TOLERANCE) return reject('map is rotated or pitched', { skew })
  if (width < MIN_TILE_SCREEN_WIDTH) return reject('too small', { width })
  if (width > MAX_TILE_SCREEN_WIDTH) return reject('too large', { width })
  if (Math.abs(Math.abs(height) - width) > width * SQUARENESS_TOLERANCE)
    return reject('not square', { width, height })
  return { tile, x, y, width, height: Math.abs(height) }
}

let frameDraws = 0
let frameTileDraws = 0
/** Whether the overlay currently has anything painted on it, so a clear is worth doing once. */
let overlayHasContent = false

const emit = (quads: readonly TileQuad[]): void => {
  if (mapCanvas === null) return
  const frame: TileFrame = { canvas: mapCanvas, quads }
  for (const listener of listeners) listener(frame)
}

const flush = (): void => {
  scheduled = false
  if (mapCanvas === null) return
  const quads = pending
  pending = []

  log('frame', 'rendered', {
    draws: frameDraws,
    tileTextureDraws: frameTileDraws,
    quads: quads.length,
    tiles: quads.map((q) => `${q.tile.x}/${q.tile.y}`).join(' ') || '(none)',
  })
  frameDraws = 0
  frameTileDraws = 0

  if (quads.length > 0) {
    if (!overlayHasContent) log('clear', 'overlay has content again')
    overlayHasContent = true
    emit(quads)
    return
  }

  // Once cleared, stay cleared until tiles return. Without this the timer re-armed on every
  // tile-less frame and fired again 50ms later, forever — measured, 66 clears in 4.5 seconds of
  // sitting zoomed out, each one repainting an already-empty canvas.
  if (!overlayHasContent) {
    count('clear:already-empty')
    return
  }

  // No tiles this frame, and the overlay has ink on it: clear now, in this same frame.
  overlayHasContent = false
  log('clear', 'no tiles this frame — clearing now')
  emit([])
}

/**
 * Notified once per MapLibre frame with every wplace tile drawn in it — including frames that draw
 * none, so a listener can clear rather than leaving a stale overlay behind.
 */
export const onTileFrame = (listener: FrameListener): void => {
  listeners.push(listener)
}

const installFetchTap = (): void => {
  const nativeFetch = pageWindow().fetch
  pageWindow().fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const input = args[0]
    const url =
      typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    const match = TILE_URL.exec(url)
    const response = await nativeFetch.apply(this as never, args)
    if (match === null) return response

    // A tap, not a rewrite: the response is handed back untouched. Compositing into wplace's own
    // tiles would make our pixels indistinguishable from theirs, which is exactly what per-colour
    // toggles and view modes need to be able to tell apart.
    const tile: TileCoord = { x: Number(match[1]), y: Number(match[2]) }
    try {
      // Hand back a Response whose blob() returns a Blob *we* made, and tag that object. wplace
      // then calls createImageBitmap on the very object we tagged, so identity is exact rather than
      // inferred. Overriding blob()/arrayBuffer() as own properties shadows Response.prototype;
      // without that the platform mints a fresh Blob on every call and the tag is lost, which is
      // the whole reason the first attempt at this matched zero tiles.
      const buffer = await response.clone().arrayBuffer()
      tileOfBuffer.set(buffer, tile)
      // The size queue is the last resort, for a bitmap that arrives with no tagged object behind
      // it. Entries are consumed when it is used; queueing on every fetch and only ever consuming
      // on the fallback path grew these arrays for the whole session and eventually handed a
      // same-sized tile a stale neighbour's coordinates.
      enqueueBySize(buffer.byteLength, tile)
      log('fetch', `tile ${tile.x}/${tile.y}`, {
        bytes: buffer.byteLength,
        status: response.status,
        sizesWaiting: tilesByByteLength.size,
      })

      // The native response is handed back, with only its two read methods shadowed. Replacing it
      // with a freshly constructed `Response` lost `url`, `redirected` and `type`, and gave it an
      // `arrayBuffer` that never set `bodyUsed` and never rejected on a second read — so any wplace
      // code that consults ordinary response metadata got the wrong answer from a tap that claims to
      // be transparent. Own properties shadow `Response.prototype`, which is what makes wplace call
      // these and receive the objects this tagged, rather than fresh ones the platform mints.
      const nativeArrayBuffer = response.arrayBuffer.bind(response)
      const nativeBlob = response.blob.bind(response)
      Object.defineProperty(response, 'arrayBuffer', {
        configurable: true,
        value: async () => {
          const own = await nativeArrayBuffer()
          tileOfBuffer.set(own, tile)
          return own
        },
      })
      Object.defineProperty(response, 'blob', {
        configurable: true,
        value: async () => {
          const blob = await nativeBlob()
          tileOfBlob.set(blob, tile)
          return blob
        },
      })
      return response
    } catch (error) {
      // A body we cannot read is a tile we cannot attribute; it simply goes undrawn.
      warn('fetch', `could not read body for ${tile.x}/${tile.y}`, String(error))
      return response
    }
  } as typeof globalThis.fetch
}

const installBlobTap = (): void => {
  const NativeBlob = pageWindow().Blob
  // Built through `Reflect.construct` with the caller's `new.target`, so `Blob()` without `new`
  // still throws, `class X extends Blob {}` still produces an `X`, and `blob.constructor` still
  // matches. A plain `new NativeBlob(...)` quietly changed all three.
  // biome-ignore lint/suspicious/noExplicitAny: standing in for the Blob constructor overloads
  const Wrapped = function (this: unknown, parts?: any[], options?: BlobPropertyBag) {
    if (new.target === undefined) {
      throw new TypeError("Failed to construct 'Blob': Please use the 'new' operator.")
    }
    // A direct `new Blob(...)` targets the wrapper, which has no native slots — hand the native
    // constructor to `Reflect.construct` in that case, and the subclass otherwise.
    const target = new.target as unknown as typeof Blob
    const blob = Reflect.construct(
      NativeBlob,
      [parts ?? [], options],
      (target as unknown) === (Wrapped as unknown) ? NativeBlob : target,
    ) as Blob
    for (const part of parts ?? []) {
      const buffer =
        part instanceof ArrayBuffer ? part : ArrayBuffer.isView(part) ? part.buffer : undefined
      const tile = buffer === undefined ? undefined : tileOfBuffer.get(buffer)
      if (tile !== undefined) {
        tileOfBlob.set(blob, tile)
        log('bitmap', `blob built from tagged buffer ${tile.x}/${tile.y}`, { bytes: blob.size })
        break
      }
    }
    return blob
  } as unknown as typeof Blob
  Wrapped.prototype = NativeBlob.prototype
  Object.defineProperty(Wrapped, 'name', { value: NativeBlob.name, configurable: true })
  pageWindow().Blob = Wrapped
}

const installBitmapTap = (): void => {
  const nativeCreateImageBitmap = pageWindow().createImageBitmap
  // biome-ignore lint/suspicious/noExplicitAny: createImageBitmap has two overload shapes
  pageWindow().createImageBitmap = (async (...args: any[]) => {
    const bitmap = await (nativeCreateImageBitmap as (...a: unknown[]) => Promise<ImageBitmap>)(
      ...args,
    )
    const source = args[0]
    if (source instanceof Blob) {
      // Exact first: this is the Blob we handed back from the fetch tap.
      const exact = tileOfBlob.get(source)
      if (exact !== undefined) {
        tileOfBitmap.set(bitmap, exact)
        // Retire the size entry this tile queued: it has been attributed exactly and must not stay
        // behind to answer for some later blob that merely happens to be the same length.
        consumeBySize(source.size, exact)
        log('bitmap', `matched ${exact.x}/${exact.y} by identity`, { bytes: source.size })
        return bitmap
      }
      count('bitmap:fell-back-to-byte-length')
      const queue = tilesByByteLength.get(source.size)
      const tile = queue?.shift()
      if (tile !== undefined) {
        tileOfBitmap.set(bitmap, tile)
        if (queue !== undefined && queue.length === 0) tilesByByteLength.delete(source.size)
        log('bitmap', `matched ${tile.x}/${tile.y}`, {
          bytes: source.size,
          left: queue?.length ?? 0,
        })
      } else if (bitmap.width === 1000 && bitmap.height === 1000) {
        // A tile-shaped image we cannot name. This is the shape of the bug where the overlay
        // thins out: it will overwrite a texture's identity below.
        warn('bitmap', 'unmatched 1000x1000 bitmap — no tile queued at this byte length', {
          bytes: source.size,
          sizesWaiting: [...tilesByByteLength.keys()].slice(0, 8).join(' '),
        })
      }
    }
    return bitmap
  }) as typeof globalThis.createImageBitmap
}

export const install = (): void => {
  installFetchTap()
  installBlobTap()
  installBitmapTap()

  const nativeGetContext = pageWindow().HTMLCanvasElement.prototype.getContext
  let wrapped = false

  pageWindow().HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    // biome-ignore lint/suspicious/noExplicitAny: matching the DOM overload set is not worth it
    ...args: any[]
    // biome-ignore lint/suspicious/noExplicitAny: the return type follows the overload set too
  ): any {
    const context = nativeGetContext.apply(this, args as never)
    const type = String(args[0])
    if (wrapped || !type.startsWith('webgl') || context === null) return context
    // The first WebGL context in the document is not necessarily the map's. wplace may well make one
    // for something else first — a fingerprinting probe, an effect — and instrumenting that one and
    // then refusing every context after it means the overlay simply never receives a frame. If the
    // map has already been captured, only its own canvas counts; before that, take the first and let
    // a later match correct it.
    let mapOwned: HTMLCanvasElement | undefined
    try {
      mapOwned = getMap()?.getCanvas?.()
    } catch {
      // A map mid-construction may not answer yet; treat that as no opinion.
    }
    if (mapOwned !== undefined && mapOwned !== this) {
      log('install', 'skipped a WebGL context that is not the map canvas', { type })
      return context
    }
    wrapped = true
    mapCanvas = this
    log('install', 'wrapped the map WebGL context', {
      type,
      canvas: `${this.width}x${this.height}`,
    })

    const gl = context as WebGL2RenderingContext
    // Weak: a long session rebuilds programs, and this only ever needs object identity.
    const uniformNames = new WeakMap<WebGLUniformLocation, string>()
    const tileOfTexture = new WeakMap<WebGLTexture, TileCoord>()
    let boundTexture: WebGLTexture | null = null
    let projection: ArrayLike<number> | null = null

    const nativeGetUniformLocation = gl.getUniformLocation.bind(gl)
    gl.getUniformLocation = (program, name) => {
      const location = nativeGetUniformLocation(program, name)
      if (location !== null) uniformNames.set(location, name)
      return location
    }

    const nativeUniformMatrix4fv = gl.uniformMatrix4fv.bind(gl)
    // biome-ignore lint/suspicious/noExplicitAny: the WebGL2 overloads differ from WebGL1's
    gl.uniformMatrix4fv = ((location: any, transpose: any, value: any, ...rest: any[]) => {
      if (location !== null && uniformNames.get(location) === 'u_projection_matrix') {
        // A copy of exactly the values WebGL is about to read. MapLibre reuses a scratch array and
        // WebGL2 lets an upload start at an offset, so keeping the array itself meant reading a
        // different matrix than the GPU got — sixteen values from the wrong place, or the right
        // place after someone else overwrote it.
        const offset = typeof rest[0] === 'number' ? rest[0] : 0
        const source = value as ArrayLike<number>
        const snapshot = new Float32Array(MATRIX_LENGTH)
        for (let index = 0; index < MATRIX_LENGTH; index += 1) {
          snapshot[index] = source[offset + index] ?? 0
        }
        projection = snapshot
      }
      return nativeUniformMatrix4fv(location, transpose, value, ...rest)
    }) as typeof gl.uniformMatrix4fv

    const nativeBindTexture = gl.bindTexture.bind(gl)
    gl.bindTexture = (target, texture) => {
      boundTexture = texture
      return nativeBindTexture(target, texture)
    }

    /**
     * Both upload paths have to be watched, and missing one is not a gap in coverage but a source
     * of wrong answers.
     *
     * MapLibre pools textures: a *new* tile goes in with `texImage2D`, but a tile it already has a
     * texture for is refreshed in place with `texSubImage2D`. wplace serves tiles `no-store` and
     * re-fetches them, so this happens constantly during ordinary use. Watching only `texImage2D`
     * meant the texture kept whatever tile it was first given while the GPU held a different one —
     * so a quad would be labelled `1051/672` while showing `1052/672`, and the tile we were asked
     * to draw on vanished from the list entirely.
     */
    const attributeUpload = (source: unknown): void => {
      if (boundTexture === null || !(source instanceof ImageBitmap)) {
        if (boundTexture !== null && tileOfTexture.has(boundTexture)) {
          const had = tileOfTexture.get(boundTexture)
          warn('texture', `DROPPED attribution ${had?.x}/${had?.y} — re-uploaded from non-bitmap`, {
            sourceKind:
              source === null ? 'null' : ((source as object)?.constructor?.name ?? typeof source),
          })
          tileOfTexture.delete(boundTexture)
        }
        return
      }
      const tile = tileOfBitmap.get(source)
      if (tile !== undefined) {
        const had = tileOfTexture.get(boundTexture)
        tileOfTexture.set(boundTexture, tile)
        log('texture', `attributed ${tile.x}/${tile.y}`, {
          size: `${source.width}x${source.height}`,
          replaced: had ? `${had.x}/${had.y}` : null,
        })
        return
      }
      const had = tileOfTexture.get(boundTexture)
      if (had !== undefined) {
        warn('texture', `DROPPED attribution ${had.x}/${had.y} — re-uploaded unattributed`, {
          size: `${source.width}x${source.height}`,
        })
        tileOfTexture.delete(boundTexture)
      }
    }

    const nativeTexSubImage2D = gl.texSubImage2D.bind(gl)
    // biome-ignore lint/suspicious/noExplicitAny: texSubImage2D has as many overloads as texImage2D
    gl.texSubImage2D = ((...subArgs: any[]) => {
      attributeUpload(subArgs[subArgs.length - 1])
      return (nativeTexSubImage2D as (...a: unknown[]) => void)(...subArgs)
    }) as typeof gl.texSubImage2D

    const nativeTexImage2D = gl.texImage2D.bind(gl)
    // biome-ignore lint/suspicious/noExplicitAny: texImage2D has ten overloads
    gl.texImage2D = ((...texArgs: any[]) => {
      attributeUpload(texArgs[texArgs.length - 1])
      return (nativeTexImage2D as (...a: unknown[]) => void)(...texArgs)
    }) as typeof gl.texImage2D

    const recordDraw = (): void => {
      // Scheduled on every draw, not only tile draws, so a frame that renders the map with no
      // wplace tiles in it still reaches the listener. That empty frame is what clears the overlay
      // when the user zooms out past the point where wplace serves tiles at all.
      if (!scheduled) {
        scheduled = true
        // A microtask, deliberately, not requestAnimationFrame.
        //
        // MapLibre renders from inside its own rAF callback, so an rAF scheduled from here does not
        // run until the *next* frame: the overlay lands one frame behind, and during a pan it visibly
        // swims against the tiles it is supposed to be pinned to. Measured over a real drag, 37 of 57
        // samples were a whole task late that way.
        //
        // A microtask runs at the end of MapLibre's current task — after every draw call in the
        // frame, so the quad set is complete, but before the browser paints. Same frame, 57 of 57.
        // This is also why the overlay needs no motion prediction: there is no lag left to predict
        // away, and predicting would mean reproducing the transform, which is the drift this whole
        // approach exists to avoid.
        queueMicrotask(flush)
      }
      frameDraws++
      if (boundTexture === null || projection === null) {
        count('draw:no-texture-or-matrix')
        return
      }
      const tile = tileOfTexture.get(boundTexture)
      if (tile === undefined) {
        count('draw:texture-not-a-known-tile')
        return
      }
      frameTileDraws++
      const quad = quadFromMatrix(projection, tile, this)
      if (quad !== null) pending.push(quad)
    }

    const nativeDrawArrays = gl.drawArrays.bind(gl)
    gl.drawArrays = (mode, first, count) => {
      recordDraw()
      return nativeDrawArrays(mode, first, count)
    }
    const nativeDrawElements = gl.drawElements.bind(gl)
    gl.drawElements = (mode, count, elementType, offset) => {
      recordDraw()
      return nativeDrawElements(mode, count, elementType, offset)
    }

    return gl
  }
}
