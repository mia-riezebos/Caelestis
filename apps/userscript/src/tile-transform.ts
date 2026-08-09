import type { TileCoord } from '@wts/shared'
import { count, log, warn } from './debug.js'
import { getMap } from './map-handle.js'
import { isPageInstance, pageWindow } from './page-world.js'

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

const TILE_PATH = /^\/files\/s\d+\/tiles\/(\d+)\/(\d+)\.png$/
const TILE_ORIGIN = 'https://backend.wplace.live'

/**
 * The tile this URL names, or null.
 *
 * Anchored, and matched against a parsed origin and pathname rather than anywhere in the string. The
 * unanchored version matched a query parameter that merely contained the shape — so an API call to
 * `?u=/files/s0/tiles/9999/9999.png` had its whole body buffered and put tile 9999/9999 into the
 * attribution queue, where a later same-sized bitmap picked it up and drew a template in the wrong
 * place. It also matched any other origin's URL, meaning this tap read bodies that were none of its
 * business.
 */
export const tileFromUrl = (url: string): TileCoord | null => {
  let parsed: URL
  try {
    parsed = new URL(url, typeof location === 'undefined' ? TILE_ORIGIN : location.href)
  } catch {
    return null
  }
  if (parsed.origin !== TILE_ORIGIN) return null
  const match = TILE_PATH.exec(parsed.pathname)
  if (match === null) return null
  return { x: Number(match[1]), y: Number(match[2]) }
}

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
interface QueuedTile {
  readonly tile: TileCoord
  readonly at: number
}

const tilesByByteLength = new Map<number, QueuedTile[]>()

const expireQueues = (now: number): void => {
  for (const [bytes, queue] of tilesByByteLength) {
    const live = queue.filter((entry) => now - entry.at < MAX_QUEUE_AGE_MS)
    if (live.length === 0) tilesByByteLength.delete(bytes)
    else if (live.length !== queue.length) tilesByByteLength.set(bytes, live)
  }
}

/**
 * How many unattributed tiles of one size to remember.
 *
 * The queue only answers the case where a bitmap arrives with no tagged object behind it, which is
 * rare. Unbounded, a long pan filled it with tiles that were attributed by identity and never
 * consumed, and the oldest of those eventually answered for a completely different tile.
 */
const MAX_QUEUED_PER_SIZE = 8

/**
 * How long an unattributed tile stays in the size queue.
 *
 * A tile's fetch-to-decode gap is milliseconds. Anything older than this was fetched and never
 * decoded — MapLibre dropped it from the viewport mid-pan — and keeping it does not help a later
 * bitmap, it mislabels one: a stale entry answers for any unrelated tile that happens to be the same
 * number of bytes. Bounding the depth per size bounded how many; nothing bounded how long, or how
 * many distinct sizes accumulated over a session.
 */
const MAX_QUEUE_AGE_MS = 30_000

export const consumeBySize = (bytes: number, tile: TileCoord): void => {
  const queue = tilesByByteLength.get(bytes)
  if (queue === undefined) return
  const at = queue.findIndex((entry) => entry.tile.x === tile.x && entry.tile.y === tile.y)
  if (at !== -1) queue.splice(at, 1)
  if (queue.length === 0) tilesByByteLength.delete(bytes)
}

export const enqueueBySize = (bytes: number, tile: TileCoord, now = Date.now()): void => {
  expireQueues(now)
  const queue = tilesByByteLength.get(bytes) ?? []
  queue.push({ tile, at: now })
  if (queue.length > MAX_QUEUED_PER_SIZE) queue.shift()
  tilesByByteLength.set(bytes, queue)
}

/** The oldest tile still queued at this size, removed. Exported for tests. */
export const takeBySize = (bytes: number, now = Date.now()): TileCoord | undefined => {
  expireQueues(now)
  const queue = tilesByByteLength.get(bytes)
  const entry = queue?.shift()
  if (queue !== undefined && queue.length === 0) tilesByByteLength.delete(bytes)
  return entry?.tile
}

/** Test seam: the queue is module state, and a test needs to start from a known one. */
export const resetQueues = (): void => tilesByByteLength.clear()
const tileOfBitmap = new WeakMap<ImageBitmap, TileCoord>()

/**
 * Blob parts worth inspecting for tagged buffers. Kept separate because the Blob constructor has
 * already consumed the input once before attribution gets a look at it.
 */
export const blobPartsForAttribution = (parts: unknown): readonly unknown[] => {
  if (!Array.isArray(parts)) return []
  try {
    const descriptors = Object.getOwnPropertyDescriptors(parts)
    const values: unknown[] = []
    for (const [property, descriptor] of Object.entries(descriptors)) {
      if (!/^\d+$/.test(property)) continue
      // Do not invoke accessors a second time. Native Blob already observed them once.
      if ('value' in descriptor) values.push(descriptor.value)
    }
    return values
  } catch {
    // Proxies can trap descriptor reads. Attribution is not worth another observable failure.
    return []
  }
}

/** Run instrumentation around a native call without changing the native call's contract. */
export const runObservedCall = <Result>(native: () => Result, observe: () => void): Result => {
  const result = native()
  try {
    observe()
  } catch {
    // The page already got a successful native operation. Instrumentation cannot change that fact.
  }
  return result
}

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
  // Refused, not normalised. `Math.abs` here hid a y-inverted quad: `y` still reported the top-left
  // corner, so the rectangle was drawn a whole tile below the tile it names. A negative width is
  // already rejected by the width bounds; the two axes now agree.
  if (height <= 0) return reject('y-inverted', { height })
  if (Math.abs(height - width) > width * SQUARENESS_TOLERANCE)
    return reject('not square', { width, height })
  return { tile, x, y, width, height }
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

const installFetchTap = (realm: Window & typeof globalThis): void => {
  const nativeFetch = realm.fetch
  realm.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const input = args[0]
    const response = await nativeFetch.apply(this as never, args)
    let tile: TileCoord | null = null
    try {
      if (typeof input === 'string') {
        tile = tileFromUrl(input)
      } else if (isPageInstance(input, 'Request', realm as unknown as Record<string, unknown>)) {
        // Read the native slot after fetch has succeeded. An own `url` getter or a second generic
        // stringification could run page code twice and either throw or describe a different fetch.
        const getter = realm.Object.getOwnPropertyDescriptor(realm.Request.prototype, 'url')?.get
        const url = getter?.call(input)
        if (typeof url === 'string') tile = tileFromUrl(url)
      }
    } catch {
      // Fetch already succeeded. An unusual input that cannot be observed safely is simply untapped.
      return response
    }
    if (tile === null) return response

    // A tap, not a rewrite: the response is handed back untouched. Compositing into wplace's own
    // tiles would make our pixels indistinguishable from theirs, which is exactly what per-colour
    // toggles and view modes need to be able to tell apart.
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

const installBlobTap = (realm: Window & typeof globalThis): void => {
  const NativeBlob = realm.Blob
  // Built through `Reflect.construct` with the caller's `new.target`, so `Blob()` without `new`
  // still throws and `class X extends Blob {}` still produces an `X`. A plain `new NativeBlob(...)`
  // changed both.
  //
  // `blob.constructor` still answers `NativeBlob` rather than this wrapper, because the wrapper
  // borrows the native prototype rather than building its own. Replacing the prototype to fix that
  // would put an object in the chain that no page-realm Blob has, which is the worse trade.
  // biome-ignore lint/suspicious/noExplicitAny: standing in for the Blob constructor overloads
  const Wrapped = function (this: unknown, ...args: any[]) {
    if (new.target === undefined) {
      throw new TypeError("Failed to construct 'Blob': Please use the 'new' operator.")
    }
    // A direct `new Blob(...)` targets the wrapper, which has no native slots — hand the native
    // constructor to `Reflect.construct` in that case, and the subclass otherwise.
    const target = new.target as unknown as typeof Blob
    // Arguments forwarded exactly as given, arity included: defaulting them turned an explicit
    // `new Blob(null)` — which the platform rejects — into an empty 0-byte Blob.
    const blob = Reflect.construct(
      NativeBlob,
      args,
      (target as unknown) === (Wrapped as unknown) ? NativeBlob : target,
    ) as Blob
    try {
      for (const part of blobPartsForAttribution(args[0])) {
        const buffer = isPageInstance(
          part,
          'ArrayBuffer',
          realm as unknown as Record<string, unknown>,
        )
          ? (part as ArrayBuffer)
          : realm.ArrayBuffer.isView(part)
            ? part.buffer
            : undefined
        const tile = buffer === undefined ? undefined : tileOfBuffer.get(buffer)
        if (tile !== undefined) {
          tileOfBlob.set(blob, tile)
          log('bitmap', `blob built from tagged buffer ${tile.x}/${tile.y}`, { bytes: blob.size })
          break
        }
      }
    } catch {
      // Native construction already succeeded. Attribution must not change that observable result.
    }
    return blob
  } as unknown as typeof Blob
  Wrapped.prototype = NativeBlob.prototype
  Object.defineProperty(Wrapped, 'name', { value: NativeBlob.name, configurable: true })
  realm.Blob = Wrapped
}

const installBitmapTap = (realm: Window & typeof globalThis): void => {
  const nativeCreateImageBitmap = realm.createImageBitmap
  // biome-ignore lint/suspicious/noExplicitAny: createImageBitmap has two overload shapes
  realm.createImageBitmap = (async (...args: any[]) => {
    const bitmap = await (nativeCreateImageBitmap as (...a: unknown[]) => Promise<ImageBitmap>)(
      ...args,
    )
    try {
      const source = args[0]
      if (isPageInstance(source, 'Blob', realm as unknown as Record<string, unknown>)) {
        // Exact first: this is the Blob we handed back from the fetch tap.
        const exact = tileOfBlob.get(source as Blob)
        if (exact !== undefined) {
          tileOfBitmap.set(bitmap, exact)
          // Retire the size entry this tile queued: it has been attributed exactly and must not stay
          // behind to answer for some later blob that merely happens to be the same length.
          consumeBySize((source as Blob).size, exact)
          log('bitmap', `matched ${exact.x}/${exact.y} by identity`, {
            bytes: (source as Blob).size,
          })
          return bitmap
        }
        count('bitmap:fell-back-to-byte-length')
        const tile = takeBySize((source as Blob).size)
        if (tile !== undefined) {
          tileOfBitmap.set(bitmap, tile)
          log('bitmap', `matched ${tile.x}/${tile.y}`, { bytes: (source as Blob).size })
        } else if (bitmap.width === 1000 && bitmap.height === 1000) {
          // A tile-shaped image we cannot name. This is the shape of the bug where the overlay
          // thins out: it will overwrite a texture's identity below.
          warn('bitmap', 'unmatched 1000x1000 bitmap — no tile queued at this byte length', {
            bytes: (source as Blob).size,
            sizesWaiting: [...tilesByByteLength.keys()].slice(0, 8).join(' '),
          })
        }
      }
    } catch {
      // Native decoding already succeeded. A diagnostic or hostile object cannot reject its promise.
    }
    return bitmap
  }) as typeof globalThis.createImageBitmap
}

export const install = (
  realm: Window & typeof globalThis = pageWindow(),
  mapHandle: () => ReturnType<typeof getMap> = getMap,
): void => {
  installFetchTap(realm)
  installBlobTap(realm)
  installBitmapTap(realm)

  const nativeGetContext = realm.HTMLCanvasElement.prototype.getContext
  let wrapped = false
  // Whether the wrapped context is one the map has confirmed as its own, rather than a guess.
  let wrappedIsMapOwned = false
  let activeContextGeneration = 0

  realm.HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    // biome-ignore lint/suspicious/noExplicitAny: matching the DOM overload set is not worth it
    ...args: any[]
    // biome-ignore lint/suspicious/noExplicitAny: the return type follows the overload set too
  ): any {
    const context = nativeGetContext.apply(this, args as never)
    // MapLibre uses literal context ids. Avoid repeating WebIDL's string conversion for unusual
    // callers: instrumentation must not invoke their conversion hooks after native success.
    if (typeof args[0] !== 'string') return context
    const type = args[0]
    if (!type.startsWith('webgl') || context === null) return context
    // Latched only once the map has confirmed this canvas is its own. Before capture the map cannot
    // answer, so an earlier WebGL context — a fingerprinting probe, an effect, another userscript —
    // was instrumented and the latch closed behind it, leaving MapLibre's real context untouched for
    // the rest of the session. Provisional instrumentation stays open to being replaced.
    if (wrapped && wrappedIsMapOwned) return context
    // The first WebGL context in the document is not necessarily the map's. wplace may well make one
    // for something else first — a fingerprinting probe, an effect — and instrumenting that one and
    // then refusing every context after it means the overlay simply never receives a frame. If the
    // map has already been captured, only its own canvas counts; before that, take the first and let
    // a later match correct it.
    let mapOwned: HTMLCanvasElement | undefined
    try {
      mapOwned = mapHandle()?.getCanvas?.()
    } catch {
      // A map mid-construction may not answer yet; treat that as no opinion.
    }
    if (mapOwned !== undefined && mapOwned !== this) {
      log('install', 'skipped a WebGL context that is not the map canvas', { type })
      return context
    }
    if (wrapped) log('install', 're-targeting onto the map canvas', { type })
    wrapped = true
    wrappedIsMapOwned = mapOwned !== undefined
    const contextGeneration = ++activeContextGeneration
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
    gl.uniformMatrix4fv = ((location: any, transpose: any, value: any, ...rest: any[]) =>
      runObservedCall(
        () => nativeUniformMatrix4fv(location, transpose, value, ...rest),
        () => {
          if (location === null || uniformNames.get(location) !== 'u_projection_matrix') return
          // A copy of exactly the values WebGL accepted. MapLibre reuses a scratch array and WebGL2
          // lets an upload start at an offset, so retaining the caller's array reads another matrix.
          const offset = typeof rest[0] === 'number' ? rest[0] : 0
          const source = value as ArrayLike<number>
          const snapshot = new Float32Array(MATRIX_LENGTH)
          for (let index = 0; index < MATRIX_LENGTH; index += 1) {
            snapshot[index] = source[offset + index] ?? 0
          }
          projection = snapshot
        },
      )) as typeof gl.uniformMatrix4fv

    const nativeBindTexture = gl.bindTexture.bind(gl)
    gl.bindTexture = (target, texture) =>
      runObservedCall(
        () => nativeBindTexture(target, texture),
        () => {
          boundTexture = texture
        },
      )

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
      if (boundTexture === null || !isPageInstance(source, 'ImageBitmap')) {
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
      const bitmap = source as ImageBitmap
      const tile = tileOfBitmap.get(bitmap)
      if (tile !== undefined) {
        const had = tileOfTexture.get(boundTexture)
        tileOfTexture.set(boundTexture, tile)
        log('texture', `attributed ${tile.x}/${tile.y}`, {
          size: `${bitmap.width}x${bitmap.height}`,
          replaced: had ? `${had.x}/${had.y}` : null,
        })
        return
      }
      const had = tileOfTexture.get(boundTexture)
      if (had !== undefined) {
        warn('texture', `DROPPED attribution ${had.x}/${had.y} — re-uploaded unattributed`, {
          size: `${bitmap.width}x${bitmap.height}`,
        })
        tileOfTexture.delete(boundTexture)
      }
    }

    const nativeTexSubImage2D = gl.texSubImage2D.bind(gl)
    // biome-ignore lint/suspicious/noExplicitAny: texSubImage2D has as many overloads as texImage2D
    gl.texSubImage2D = ((...subArgs: any[]) => {
      return runObservedCall(
        () => (nativeTexSubImage2D as (...a: unknown[]) => void)(...subArgs),
        () => attributeUpload(subArgs[subArgs.length - 1]),
      )
    }) as typeof gl.texSubImage2D

    const nativeTexImage2D = gl.texImage2D.bind(gl)
    // biome-ignore lint/suspicious/noExplicitAny: texImage2D has ten overloads
    gl.texImage2D = ((...texArgs: any[]) => {
      return runObservedCall(
        () => (nativeTexImage2D as (...a: unknown[]) => void)(...texArgs),
        () => attributeUpload(texArgs[texArgs.length - 1]),
      )
    }) as typeof gl.texImage2D

    const recordDraw = (): void => {
      // A provisional context remains wrapped after the real map context appears. Its later draws
      // must not schedule a flush against the new map canvas or clear/corrupt the live overlay.
      if (contextGeneration !== activeContextGeneration) return
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
    gl.drawArrays = (mode, first, count) =>
      runObservedCall(() => nativeDrawArrays(mode, first, count), recordDraw)
    const nativeDrawElements = gl.drawElements.bind(gl)
    gl.drawElements = (mode, count, elementType, offset) =>
      runObservedCall(() => nativeDrawElements(mode, count, elementType, offset), recordDraw)

    return gl
  }
}
