import { parseTileKey, TILE_SIZE, type TileCoord } from '@wts/shared'
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

/** The same transparent pixel shape wplace's service worker substitutes for an absent tile. */
const TRANSPARENT_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
  0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 96, 96, 0, 0, 0, 3, 0, 1, 43, 9, 77,
  132, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
])

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
  return parseTileKey(`${match[1]}/${match[2]}`)
}

interface FetchUrlGetters {
  readonly requestUrl: ((this: Request) => string) | undefined
  readonly requestMethod: ((this: Request) => string) | undefined
  readonly urlHref: ((this: URL) => string) | undefined
}

/** Snapshot native URL readers before page code or another userscript can replace them. */
export const captureFetchUrlGetters = (realm: Window & typeof globalThis): FetchUrlGetters => {
  try {
    return {
      requestUrl: realm.Object.getOwnPropertyDescriptor(realm.Request.prototype, 'url')?.get,
      requestMethod: realm.Object.getOwnPropertyDescriptor(realm.Request.prototype, 'method')?.get,
      urlHref: realm.Object.getOwnPropertyDescriptor(realm.URL.prototype, 'href')?.get,
    }
  } catch {
    return { requestUrl: undefined, requestMethod: undefined, urlHref: undefined }
  }
}

/** Observe a fetch input without repeating its generic string conversion. */
export const urlForFetchInput = (
  input: unknown,
  realm: Window & typeof globalThis,
  getters: FetchUrlGetters,
): string | null => {
  if (typeof input === 'string') return input
  try {
    if (isPageInstance(input, 'Request', realm as unknown as Record<string, unknown>)) {
      return getters.requestUrl?.call(input as Request) ?? null
    }
    if (isPageInstance(input, 'URL', realm as unknown as Record<string, unknown>)) {
      return getters.urlHref?.call(input as URL) ?? null
    }
  } catch {
    // A proxy or a replaced constructor can refuse its native slot. Attribution is optional.
  }
  return null
}

/** Whether fetch used GET, observed without repeating an accessor or generic string conversion. */
export const isGetFetch = (
  input: unknown,
  init: RequestInit | null | undefined,
  realm: Window & typeof globalThis,
  getters: FetchUrlGetters,
): boolean => {
  let method: string | null = null
  try {
    if (typeof input === 'string') method = 'GET'
    else if (isPageInstance(input, 'URL', realm as unknown as Record<string, unknown>))
      method = 'GET'
    else if (isPageInstance(input, 'Request', realm as unknown as Record<string, unknown>)) {
      method = getters.requestMethod?.call(input as Request) ?? null
    }
    if (method === null || init === undefined || init === null) return method === 'GET'

    let descriptor = realm.Object.getOwnPropertyDescriptor(init, 'method')
    if (descriptor === undefined) {
      const prototype = realm.Object.getPrototypeOf(init)
      if (prototype === null) return method === 'GET'
      // WebIDL reads inherited dictionary members too. Inspect a plain Object prototype's data
      // property without invoking it again; an accessor or exotic prototype is not safely known.
      if (prototype !== realm.Object.prototype) return false
      descriptor = realm.Object.getOwnPropertyDescriptor(prototype, 'method')
      if (descriptor === undefined) return method === 'GET'
    }
    if (!('value' in descriptor)) return false
    if (descriptor.value === undefined) return method === 'GET'
    return typeof descriptor.value === 'string' && descriptor.value.toUpperCase() === 'GET'
  } catch {
    return false
  }
}

/** Make an origin 404 decodable, matching the service worker's transparent-tile behavior. */
export const normalizeMissingTileResponse = (
  response: Response,
  realm: Window & typeof globalThis,
): Response => {
  if (response.status !== 404) return response
  return new realm.Response(TRANSPARENT_PNG, {
    status: 200,
    headers: { 'content-type': 'image/png' },
  })
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

/** Consume a byte-length fallback for a decoded bitmap. */
export const takeBySizeForBitmap = (
  bytes: number,
  width: number,
  height: number,
  now = Date.now(),
): TileCoord | undefined => {
  if (width !== TILE_SIZE || height !== TILE_SIZE) return undefined
  expireQueues(now)
  // Same-size decodes can resolve out of order. Missing an overlay tile is visible and
  // self-correcting; confidently swapping two coordinates is not.
  if (tilesByByteLength.get(bytes)?.length !== 1) return undefined
  return takeBySize(bytes, now)
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
  const urlGetters = captureFetchUrlGetters(realm)
  realm.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const input = args[0]
    // Snapshot only safely observable metadata before native fetch consumes mutable RequestInit
    // dictionaries. An accessor may delete itself while WebIDL reads it; inspecting afterward would
    // then mistake a HEAD request for the default GET.
    let tile: TileCoord | null = null
    let shouldNormalizeMissing = false
    try {
      const url = urlForFetchInput(input, realm, urlGetters)
      if (url !== null) {
        tile = tileFromUrl(url)
        if (tile !== null) shouldNormalizeMissing = isGetFetch(input, args[1], realm, urlGetters)
      }
    } catch {
      // An unusual input that cannot be observed safely is simply untapped.
    }
    const pendingResponse = nativeFetch.apply(this as never, args)
    let response = await pendingResponse
    if (tile === null) return response
    const observedTile = tile

    // Real tile pixels are only tapped, never composited with ours: that would make the two layers
    // indistinguishable to per-colour toggles and view modes. The sole rewrite below is an absent
    // origin tile, normalized to the transparent response wplace's service worker ordinarily gives.
    try {
      // With no controlling service worker, the origin returns 404 HTML for an unpainted tile. The
      // service worker normally turns that into a tiny transparent PNG; do the same so first visits
      // still give MapLibre a texture and therefore give the overlay a quad to align against.
      if (shouldNormalizeMissing) {
        response = normalizeMissingTileResponse(response, realm)
      }
      if (!response.ok) return response
      // Hand back a Response whose blob() returns a Blob *we* made, and tag that object. wplace
      // then calls createImageBitmap on the very object we tagged, so identity is exact rather than
      // inferred. Overriding blob()/arrayBuffer() as own properties shadows Response.prototype;
      // without that the platform mints a fresh Blob on every call and the tag is lost, which is
      // the whole reason the first attempt at this matched zero tiles.
      // The native response is handed back, with only its two read methods shadowed. Replacing it
      // with a freshly constructed `Response` lost `url`, `redirected` and `type`, and gave it an
      // `arrayBuffer` that never set `bodyUsed` and never rejected on a second read — so any wplace
      // code that consults ordinary response metadata got the wrong answer from a tap that claims to
      // be transparent. Own properties shadow `Response.prototype`, which is what makes wplace call
      // these and receive the objects this tagged, rather than fresh ones the platform mints.
      const tappedResponse = response
      const nativeArrayBuffer = response.arrayBuffer
      const nativeBlob = response.blob
      const recordRead = (bytes: number): void => {
        // The size queue is only a last resort. Queue when the page actually consumes the body,
        // rather than delaying fetch to duplicate every response pre-emptively.
        enqueueBySize(bytes, observedTile)
        log('fetch', `tile ${observedTile.x}/${observedTile.y}`, {
          bytes,
          status: response.status,
          sizesWaiting: tilesByByteLength.size,
        })
      }
      Object.defineProperty(response, 'arrayBuffer', {
        configurable: true,
        writable: true,
        value: async function (this: Response) {
          const own = await nativeArrayBuffer.call(this)
          if (this === tappedResponse) {
            tileOfBuffer.set(own, observedTile)
            recordRead(own.byteLength)
          }
          return own
        },
      })
      Object.defineProperty(response, 'blob', {
        configurable: true,
        writable: true,
        value: async function (this: Response) {
          const blob = await nativeBlob.call(this)
          if (this === tappedResponse) {
            tileOfBlob.set(blob, observedTile)
            recordRead(blob.size)
          }
          return blob
        },
      })
      return response
    } catch (error) {
      // A body we cannot read is a tile we cannot attribute; it simply goes undrawn.
      warn('fetch', `could not read body for ${observedTile.x}/${observedTile.y}`, String(error))
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
    const pendingBitmap = (nativeCreateImageBitmap as (...a: unknown[]) => Promise<ImageBitmap>)(
      ...args,
    )
    let sourceBlob: Blob | undefined
    let sourceBytes: number | undefined
    let exact: TileCoord | undefined
    try {
      const source = args[0]
      if (isPageInstance(source, 'Blob', realm as unknown as Record<string, unknown>)) {
        sourceBlob = source as Blob
        sourceBytes = sourceBlob.size
        exact = tileOfBlob.get(sourceBlob)
        if (exact !== undefined) {
          // Reserve exact attribution before decode yields. Otherwise an untagged same-size bitmap
          // can settle first and steal this tile's sole byte-length fallback entry.
          consumeBySize(sourceBytes, exact)
        }
      }
    } catch {
      // Native decoding has started. Attribution must not change its eventual result.
    }
    const bitmap = await pendingBitmap
    try {
      if (sourceBlob !== undefined && sourceBytes !== undefined) {
        if (exact !== undefined) {
          tileOfBitmap.set(bitmap, exact)
          log('bitmap', `matched ${exact.x}/${exact.y} by identity`, { bytes: sourceBytes })
          return bitmap
        }
        count('bitmap:fell-back-to-byte-length')
        const tile = takeBySizeForBitmap(sourceBytes, bitmap.width, bitmap.height)
        if (tile !== undefined) {
          tileOfBitmap.set(bitmap, tile)
          log('bitmap', `matched ${tile.x}/${tile.y}`, { bytes: sourceBytes })
        } else if (bitmap.width === 1000 && bitmap.height === 1000) {
          // A tile-shaped image we cannot name. This is the shape of the bug where the overlay
          // thins out: it will overwrite a texture's identity below.
          warn('bitmap', 'unmatched 1000x1000 bitmap — no tile queued at this byte length', {
            bytes: sourceBytes,
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

  const looksLikeMapCanvas = (canvas: HTMLCanvasElement | null): boolean => {
    try {
      return canvas?.classList.contains('maplibregl-canvas') === true
    } catch {
      // A hostile canvas shim must not change a successful native getContext call.
      return false
    }
  }

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
    // a later canvas carrying MapLibre's measured class correct it.
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
    if (wrapped && mapOwned === undefined) {
      const currentLooksLikeMap = looksLikeMapCanvas(mapCanvas)
      const candidateLooksLikeMap = looksLikeMapCanvas(this)
      // Keep the first provisional context until there is positive evidence that a later canvas is
      // MapLibre's. Once the measured map class is wrapped, an unrelated context cannot steal it.
      if (currentLooksLikeMap || !candidateLooksLikeMap) return context
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
    interface UniformIdentity {
      readonly program: WebGLProgram
      readonly name: string
    }
    const uniforms = new WeakMap<WebGLUniformLocation, UniformIdentity>()
    const primarySamplerUnits = new WeakMap<WebGLProgram, number>()
    const projectionByProgram = new WeakMap<WebGLProgram, ArrayLike<number>>()
    const tileOfTexture = new WeakMap<WebGLTexture, TileCoord>()
    const texture2DByUnit = new Map<number, WebGLTexture | null>()
    let activeProgram: WebGLProgram | null = null
    let activeTextureUnit: number = gl.TEXTURE0
    let maxTextureUnits = Number.POSITIVE_INFINITY
    try {
      const measured = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS)
      if (typeof measured === 'number' && Number.isInteger(measured) && measured > 0) {
        maxTextureUnits = measured
      }
    } catch {
      // The real context answers this. A partial test double or hostile shim leaves validation at
      // the enum's non-negative/integer baseline instead of breaking installation.
    }

    const nativeGetUniformLocation = gl.getUniformLocation
    gl.getUniformLocation = function (this: WebGL2RenderingContext, program, name) {
      let location: WebGLUniformLocation | null = null
      return runObservedCall(
        () => {
          location = nativeGetUniformLocation.call(this, program, name)
          return location
        },
        () => {
          if (this !== gl || location === null) return
          uniforms.set(location, { program, name })
          // WebGL sampler uniforms default to texture unit zero. Remember that before the first
          // explicit upload too: wrappers such as MapLibre cache uniforms and may not set one again.
          if (name === 'u_image0' && !primarySamplerUnits.has(program)) {
            primarySamplerUnits.set(program, gl.TEXTURE0)
          }
        },
      )
    }

    const nativeUseProgram = gl.useProgram
    gl.useProgram = function (this: WebGL2RenderingContext, program) {
      return runObservedCall(
        () => nativeUseProgram.call(this, program),
        () => {
          if (this !== gl) return
          activeProgram = program
        },
      )
    }

    const nativeUniform1i = gl.uniform1i
    gl.uniform1i = function (this: WebGL2RenderingContext, location, value) {
      return runObservedCall(
        () => nativeUniform1i.call(this, location, value),
        () => {
          if (this !== gl || location === null || typeof value !== 'number') return
          const uniform = uniforms.get(location)
          if (uniform?.name !== 'u_image0' || uniform.program !== activeProgram) return
          primarySamplerUnits.set(uniform.program, gl.TEXTURE0 + value)
        },
      )
    }

    const nativeUniformMatrix4fv = gl.uniformMatrix4fv
    gl.uniformMatrix4fv = function (
      this: WebGL2RenderingContext,
      location: WebGLUniformLocation | null,
      transpose: GLboolean,
      value: Float32List,
      ...rest: [srcOffset?: number, srcLength?: number]
    ) {
      return runObservedCall(
        () => Reflect.apply(nativeUniformMatrix4fv, this, [location, transpose, value, ...rest]),
        () => {
          if (this !== gl || location === null || transpose !== false) return
          const uniform = uniforms.get(location)
          if (uniform?.name !== 'u_projection_matrix' || uniform.program !== activeProgram) return
          // Plain sequences have already had every element converted by WebIDL. Reading them again
          // can invoke accessors twice and capture different values, so only page-realm typed arrays
          // are safe to snapshot.
          if (
            !isPageInstance(value, 'Float32Array', realm as unknown as Record<string, unknown>) ||
            !realm.ArrayBuffer.isView(value)
          )
            return
          const offset = rest.length === 0 ? 0 : rest[0]
          if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return
          const source = value as Float32Array
          const suppliedLength = rest[1]
          if (
            suppliedLength !== undefined &&
            (typeof suppliedLength !== 'number' ||
              !Number.isInteger(suppliedLength) ||
              suppliedLength < 0 ||
              (suppliedLength !== 0 && suppliedLength < MATRIX_LENGTH))
          )
            return
          if (source.length - offset < MATRIX_LENGTH) return
          const snapshot = new Float32Array(MATRIX_LENGTH)
          for (let index = 0; index < MATRIX_LENGTH; index += 1) {
            snapshot[index] = source[offset + index] ?? 0
          }
          projectionByProgram.set(uniform.program, snapshot)
        },
      )
    } as typeof gl.uniformMatrix4fv

    const nativeActiveTexture = gl.activeTexture
    gl.activeTexture = function (this: WebGL2RenderingContext, texture) {
      return runObservedCall(
        () => nativeActiveTexture.call(this, texture),
        () => {
          if (this !== gl || typeof texture !== 'number') return
          const index = texture - gl.TEXTURE0
          if (!Number.isInteger(index) || index < 0 || index >= maxTextureUnits) return
          activeTextureUnit = texture
        },
      )
    }

    const nativeBindTexture = gl.bindTexture
    gl.bindTexture = function (this: WebGL2RenderingContext, target, texture) {
      return runObservedCall(
        () => nativeBindTexture.call(this, target, texture),
        () => {
          if (this === gl && target === gl.TEXTURE_2D) {
            texture2DByUnit.set(activeTextureUnit, texture)
          }
        },
      )
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
    const attributeUpload = (target: number, source: unknown): void => {
      if (target !== gl.TEXTURE_2D) return
      const texture = texture2DByUnit.get(activeTextureUnit) ?? null
      if (
        texture === null ||
        !isPageInstance(source, 'ImageBitmap', realm as unknown as Record<string, unknown>)
      ) {
        if (texture !== null && tileOfTexture.has(texture)) {
          const had = tileOfTexture.get(texture)
          warn('texture', `DROPPED attribution ${had?.x}/${had?.y} — re-uploaded from non-bitmap`, {
            sourceKind:
              source === null ? 'null' : ((source as object)?.constructor?.name ?? typeof source),
          })
          tileOfTexture.delete(texture)
        }
        return
      }
      const bitmap = source as ImageBitmap
      const tile = tileOfBitmap.get(bitmap)
      if (tile !== undefined) {
        const had = tileOfTexture.get(texture)
        tileOfTexture.set(texture, tile)
        log('texture', `attributed ${tile.x}/${tile.y}`, {
          size: `${bitmap.width}x${bitmap.height}`,
          replaced: had ? `${had.x}/${had.y}` : null,
        })
        return
      }
      const had = tileOfTexture.get(texture)
      if (had !== undefined) {
        warn('texture', `DROPPED attribution ${had.x}/${had.y} — re-uploaded unattributed`, {
          size: `${bitmap.width}x${bitmap.height}`,
        })
        tileOfTexture.delete(texture)
      }
    }

    const nativeTexSubImage2D = gl.texSubImage2D
    // biome-ignore lint/suspicious/noExplicitAny: texSubImage2D has as many overloads as texImage2D
    gl.texSubImage2D = function (this: WebGL2RenderingContext, ...subArgs: any[]) {
      return runObservedCall(
        () => Reflect.apply(nativeTexSubImage2D, this, subArgs),
        () => {
          if (this === gl) attributeUpload(subArgs[0], subArgs[subArgs.length - 1])
        },
      )
    } as typeof gl.texSubImage2D

    const nativeTexImage2D = gl.texImage2D
    // biome-ignore lint/suspicious/noExplicitAny: texImage2D has ten overloads
    gl.texImage2D = function (this: WebGL2RenderingContext, ...texArgs: any[]) {
      return runObservedCall(
        () => Reflect.apply(nativeTexImage2D, this, texArgs),
        () => {
          if (this === gl) attributeUpload(texArgs[0], texArgs[texArgs.length - 1])
        },
      )
    } as typeof gl.texImage2D

    let drawFramebuffer: WebGLFramebuffer | null = null
    const scheduleFrameFlush = (): boolean => {
      // A provisional context remains wrapped after the real map context appears. Its later draws
      // must not schedule a flush against the new map canvas or clear/corrupt the live overlay.
      if (contextGeneration !== activeContextGeneration) return false
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
      return true
    }

    const nativeBindFramebuffer = gl.bindFramebuffer
    gl.bindFramebuffer = function (this: WebGL2RenderingContext, target, framebuffer) {
      return runObservedCall(
        () => nativeBindFramebuffer.call(this, target, framebuffer),
        () => {
          if (this !== gl) return
          if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) {
            drawFramebuffer = framebuffer
          }
        },
      )
    }

    const nativeDeleteFramebuffer = gl.deleteFramebuffer
    gl.deleteFramebuffer = function (this: WebGL2RenderingContext, framebuffer) {
      return runObservedCall(
        () => nativeDeleteFramebuffer.call(this, framebuffer),
        () => {
          if (this === gl && framebuffer !== null && framebuffer === drawFramebuffer) {
            // WebGL automatically restores the default draw framebuffer when the bound object is
            // deleted; keep the mirror on the same transition.
            drawFramebuffer = null
          }
        },
      )
    }

    const nativeClear = gl.clear
    gl.clear = function (this: WebGL2RenderingContext, mask) {
      return runObservedCall(
        () => nativeClear.call(this, mask),
        () => {
          if (
            this === gl &&
            drawFramebuffer === null &&
            typeof mask === 'number' &&
            (mask & gl.COLOR_BUFFER_BIT) !== 0
          ) {
            if (scheduleFrameFlush()) {
              // The GPU discarded every earlier default-framebuffer draw in this task. Do the same
              // to quads accumulated for the pending microtask.
              pending = []
              frameDraws = 0
              frameTileDraws = 0
            }
          }
        },
      )
    }

    const recordDraw = (): void => {
      // Scheduled on every draw, not only tile draws, so a frame that renders the map with no
      // wplace tiles in it still reaches the listener. A default-framebuffer colour clear above
      // covers the rarer frame that contains no draw call at all.
      if (drawFramebuffer !== null) return
      if (!scheduleFrameFlush()) return
      frameDraws++
      if (activeProgram === null) {
        count('draw:not-raster-program')
        return
      }
      const primaryUnit = primarySamplerUnits.get(activeProgram)
      if (primaryUnit === undefined) {
        count('draw:not-raster-program')
        return
      }
      // Raster crossfades bind the child/current tile to u_image0, then bind the parent to
      // u_image1. The last bind is therefore the wrong identity for the child's projection matrix.
      const drawnTexture = texture2DByUnit.get(primaryUnit) ?? null
      const drawnProjection = projectionByProgram.get(activeProgram) ?? null
      if (drawnTexture === null || drawnProjection === null) {
        count('draw:no-texture-or-matrix')
        return
      }
      const tile = tileOfTexture.get(drawnTexture)
      if (tile === undefined) {
        count('draw:texture-not-a-known-tile')
        return
      }
      frameTileDraws++
      const quad = quadFromMatrix(drawnProjection, tile, this)
      if (quad !== null) pending.push(quad)
    }

    const nativeDrawArrays = gl.drawArrays
    gl.drawArrays = function (this: WebGL2RenderingContext, mode, first, count) {
      return runObservedCall(
        () => nativeDrawArrays.call(this, mode, first, count),
        () => {
          if (this === gl) recordDraw()
        },
      )
    }
    const nativeDrawElements = gl.drawElements
    gl.drawElements = function (this: WebGL2RenderingContext, mode, count, elementType, offset) {
      return runObservedCall(
        () => nativeDrawElements.call(this, mode, count, elementType, offset),
        () => {
          if (this === gl) recordDraw()
        },
      )
    }

    return gl
  }
}
