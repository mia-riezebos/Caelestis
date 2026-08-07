import { parseTileKey, TILE_SIZE, type TileCoord, tileKey, WPLACE_PALETTE } from '@wts/shared'
import { count, isEnabled, log, warn } from './debug.js'
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

const MATRIX_LENGTH = 16
/** MapLibre's tile coordinate extent. Tile-local `(0,0)`..`(EXTENT,EXTENT)` spans one whole tile. */
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
  readonly urlPrototype: object | undefined
  readonly urlToString: ((this: URL) => string) | undefined
}

/** Snapshot native URL readers before page code or another userscript can replace them. */
export const captureFetchUrlGetters = (realm: Window & typeof globalThis): FetchUrlGetters => {
  try {
    return {
      requestUrl: realm.Object.getOwnPropertyDescriptor(realm.Request.prototype, 'url')?.get,
      requestMethod: realm.Object.getOwnPropertyDescriptor(realm.Request.prototype, 'method')?.get,
      urlHref: realm.Object.getOwnPropertyDescriptor(realm.URL.prototype, 'href')?.get,
      urlPrototype: realm.URL.prototype,
      urlToString: realm.Object.getOwnPropertyDescriptor(realm.URL.prototype, 'toString')?.value,
    }
  } catch {
    return {
      requestUrl: undefined,
      requestMethod: undefined,
      urlHref: undefined,
      urlPrototype: undefined,
      urlToString: undefined,
    }
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
      // Fetch converts URL objects through their stringifier. Reading `href` is equivalent only
      // while neither the instance nor its prototype has replaced that coercion path.
      if (getters.urlPrototype === undefined || getters.urlToString === undefined) return null
      if (realm.Object.getPrototypeOf(input) !== getters.urlPrototype) return null
      if (realm.Object.getOwnPropertyDescriptor(input, 'toString') !== undefined) return null
      if (realm.Object.getOwnPropertyDescriptor(input, Symbol.toPrimitive) !== undefined)
        return null
      if (
        realm.Object.getOwnPropertyDescriptor(getters.urlPrototype, Symbol.toPrimitive) !==
        undefined
      )
        return null
      if (
        realm.Object.getOwnPropertyDescriptor(getters.urlPrototype, 'toString')?.value !==
        getters.urlToString
      )
        return null
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
  const substitute = new realm.Response(TRANSPARENT_PNG, {
    status: 200,
    headers: { 'content-type': 'image/png' },
  })
  try {
    void response.body?.cancel().catch(() => undefined)
  } catch {
    // The substitute is independent; a hostile or locked original stream is disposable.
  }
  return substitute
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
  const remaining = queue.filter((entry) => entry.tile.x !== tile.x || entry.tile.y !== tile.y)
  if (remaining.length === 0) tilesByByteLength.delete(bytes)
  else if (remaining.length !== queue.length) tilesByByteLength.set(bytes, remaining)
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

/** Mirror WebIDL's unsigned-long conversion without re-running user-controlled object coercion. */
const sideEffectFreeUnsignedLong = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
    return undefined
  }
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric === 0) return 0
  const integer = Math.trunc(numeric)
  const range = 2 ** 32
  return ((integer % range) + range) % range
}

interface InstalledValueHook {
  restore(): void
}

/** Install an own hook without inheriting another script's non-writable prototype descriptor. */
const installValueHook = (
  target: object,
  property: PropertyKey,
  value: unknown,
): InstalledValueHook | null => {
  let previous: PropertyDescriptor | undefined
  try {
    previous = Object.getOwnPropertyDescriptor(target, property)
    let inherited: PropertyDescriptor | undefined
    if (previous === undefined) {
      let prototype = Object.getPrototypeOf(target)
      while (prototype !== null && inherited === undefined) {
        inherited = Object.getOwnPropertyDescriptor(prototype, property)
        prototype = Object.getPrototypeOf(prototype)
      }
    }
    const replaced = previous ?? inherited
    if (typeof value === 'function' && typeof replaced?.value === 'function') {
      for (const metadata of ['name', 'length'] as const) {
        const metadataDescriptor = Object.getOwnPropertyDescriptor(replaced.value, metadata)
        if (metadataDescriptor !== undefined && 'value' in metadataDescriptor) {
          Object.defineProperty(value, metadata, {
            value: metadataDescriptor.value,
            configurable: true,
          })
        }
      }
    }
    const descriptor =
      previous?.configurable === false
        ? { value }
        : {
            value,
            writable: true,
            configurable: true,
            enumerable: previous?.enumerable ?? inherited?.enumerable ?? false,
          }
    Object.defineProperty(target, property, descriptor)
  } catch {
    return null
  }
  return {
    restore() {
      try {
        if (Object.getOwnPropertyDescriptor(target, property)?.value !== value) return
        if (previous === undefined) Reflect.deleteProperty(target, property)
        else Object.defineProperty(target, property, previous)
      } catch {
        // A later owner changed the surface; restoring ours is no longer safe or necessary.
      }
    },
  }
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

let drawingTiles = false

/**
 * Whether wplace drew any canvas tiles on the last frame.
 *
 * Zoom out far enough and they stop serving them entirely. Anything drawing over their canvas has to
 * stop at the same point, or it floats above a map that is no longer showing the thing it annotates.
 */
export const isDrawingTiles = (): boolean => drawingTiles

const emit = (quads: readonly TileQuad[]): void => {
  if (mapCanvas === null) return
  drawingTiles = quads.length > 0
  const frame: TileFrame = { canvas: mapCanvas, quads }
  for (const listener of listeners) {
    try {
      listener(frame)
    } catch {
      count('frame:listener-failed')
    }
  }
}

/**
 * The texture wplace last drew each tile from, keyed by `tileKey`.
 *
 * Not a WeakMap on purpose — this is the reverse lookup, from a tile we care about to the GPU copy
 * of its pixels. Entries go stale when MapLibre recycles a texture, which is harmless: the value is
 * only ever read during a frame in which that tile was drawn, and drawing it rewrites the entry
 * first.
 */
const textureOfTile = new Map<string, WebGLTexture>()

/** The GPU copy of a tile's placed pixels, if wplace has drawn that tile. */
export const textureForTile = (tile: TileCoord): WebGLTexture | null =>
  textureOfTile.get(tileKey(tile)) ?? null

let lastQuads: readonly TileQuad[] = []

/**
 * Where wplace is drawing each tile *right now*, in canvas device pixels.
 *
 * This is the frame currently being built, not the last one that finished. Their raster layer draws
 * before ours in the same frame, so by the time anything in the layer stack below `pixel-hover`
 * renders, every tile quad for this frame has already been recorded.
 *
 * Anything drawing over their tiles wants these rather than a projection of its own. MapLibre snaps
 * raster tiles to whole device pixels when the map is still — `align = !painter.options.moving` —
 * and does not snap while it moves, so a separately projected overlay agrees during a pan and drifts
 * a fraction of a pixel the instant it settles. Taking the placement from their own draw calls makes
 * that unknowable and irrelevant: we land where they landed, aligned or not.
 */
export const currentQuads = (): readonly TileQuad[] => (pending.length > 0 ? pending : lastQuads)

const flush = (): void => {
  scheduled = false
  if (mapCanvas === null) return
  const quads = pending
  pending = []
  if (quads.length > 0) lastQuads = quads

  log(
    'frame',
    'rendered',
    isEnabled()
      ? {
          draws: frameDraws,
          tileTextureDraws: frameTileDraws,
          quads: quads.length,
          tiles: quads.map((q) => `${q.tile.x}/${q.tile.y}`).join(' ') || '(none)',
        }
      : undefined,
  )
  const drewAnything = frameDraws > 0
  frameDraws = 0
  frameTileDraws = 0

  // "No tiles" only means wplace has stopped serving them when they actually rendered a frame and
  // no tile was in it. A frame that drew nothing at all says nothing either way — MapLibre skips
  // work constantly — and treating that as the cutoff switched the overlay off while sitting still.
  if (quads.length > 0) drawingTiles = true
  else if (drewAnything) drawingTiles = false

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
  log('clear', 'no tiles this frame — clearing now')
  emit([])
  overlayHasContent = false
}

/**
 * Notified once per MapLibre frame with every wplace tile drawn in it — including frames that draw
 * none, so a listener can clear rather than leaving a stale overlay behind.
 */
export const onTileFrame = (listener: FrameListener): void => {
  listeners.push(listener)
}

/** Clear module-owned listeners between isolated installs. Exported for tests. */
export const resetTileFrameListeners = (): void => {
  listeners.length = 0
}

const installFetchTap = (realm: Window & typeof globalThis): InstalledValueHook | null => {
  const nativeFetch = realm.fetch
  const urlGetters = captureFetchUrlGetters(realm)
  const wrappedFetch = {
    fetch(this: unknown, ...args: Parameters<typeof fetch>) {
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
          if (tile !== null) {
            tileUrlShape = url.replace(`/${tile.x}/${tile.y}.png`, '/{x}/{y}.png')
            shouldNormalizeMissing = isGetFetch(input, args[1], realm, urlGetters)
          }
        }
      } catch {
        // An unusual input that cannot be observed safely is simply untapped.
      }
      const pendingResponse = nativeFetch.apply(this as never, args)
      if (tile === null) return pendingResponse
      const observedTile = tile
      return pendingResponse.then((response) => {
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
          const wrappedArrayBuffer = {
            arrayBuffer(this: Response): Promise<ArrayBuffer> {
              return nativeArrayBuffer.call(this).then((own) => {
                try {
                  if (this === tappedResponse) {
                    tileOfBuffer.set(own, observedTile)
                    recordRead(own.byteLength)
                  }
                } catch {
                  // The native read already consumed the body successfully; observation cannot reject it.
                }
                return own
              })
            },
          }.arrayBuffer
          const wrappedBlob = {
            blob(this: Response): Promise<Blob> {
              return nativeBlob.call(this).then((blob) => {
                try {
                  if (this === tappedResponse) {
                    tileOfBlob.set(blob, observedTile)
                    recordRead(blob.size)
                  }
                } catch {
                  // The native read already consumed the body successfully; observation cannot reject it.
                }
                return blob
              })
            },
          }.blob
          const arrayBufferHook = installValueHook(response, 'arrayBuffer', wrappedArrayBuffer)
          if (arrayBufferHook === null) return response
          const blobHook = installValueHook(response, 'blob', wrappedBlob)
          if (blobHook === null) {
            arrayBufferHook.restore()
            return response
          }
          return response
        } catch (error) {
          // A body we cannot read is a tile we cannot attribute; it simply goes undrawn.
          warn(
            'fetch',
            `could not read body for ${observedTile.x}/${observedTile.y}`,
            String(error),
          )
          return response
        }
      })
    },
  }.fetch as typeof globalThis.fetch
  return installValueHook(realm, 'fetch', wrappedFetch)
}

const installBlobTap = (realm: Window & typeof globalThis): InstalledValueHook | null => {
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
      // Delegate the invalid call too: the browser supplies both the native message and a page-realm
      // TypeError, while throwing here would manufacture the error in the userscript sandbox.
      return Reflect.apply(NativeBlob, this, args)
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
  const nativePrototype = Object.getOwnPropertyDescriptor(NativeBlob, 'prototype')
  if (nativePrototype === undefined) return null
  Object.defineProperty(Wrapped, 'prototype', nativePrototype)
  Object.defineProperty(Wrapped, 'name', { value: NativeBlob.name, configurable: true })
  return installValueHook(realm, 'Blob', Wrapped)
}

const pixelsOfTile = new Map<string, Uint8Array>()

/**
 * How many tiles' pixels to keep.
 *
 * A megabyte each, and nothing ever dropped them: panning across a canvas with the markers on grew
 * this without limit until the tab ran out of memory and died. Sixty-four is comfortably more than
 * fits on screen at any zoom — the worst case measured is 28 — so the ones being looked at are never
 * the ones evicted.
 */
const KEEP_TILES = 64

/** Drop the least recently touched tiles once there are too many of them. */
const evict = (): void => {
  while (pixelsOfTile.size > KEEP_TILES) {
    // Map iterates in insertion order, and every read re-inserts, so the first key is the oldest.
    const oldest = pixelsOfTile.keys().next().value
    if (oldest === undefined) return
    pixelsOfTile.delete(oldest)
    overridesOfTile.delete(oldest)
    chased.delete(oldest)
    count('pixels:evicted a tile')
  }
}
let capturePixels = false

/** Index meaning "nobody has painted here". Distinct from every palette entry. */
export const UNPAINTED = 255

/**
 * Bumped every time capture is switched on, so everything already on screen is read again.
 *
 * Without this, turning the feature on only caught tiles wplace happened to decode *afterwards* —
 * so a screenful that had finished loading stayed unanswered until something made it re-fetch, which
 * is most of the wait anyone would notice. The preview canvases are already on screen and already
 * hold the answer; this is what makes us go and read them.
 */
let captureGeneration = 0

/**
 * Turn tile pixel capture on or off.
 *
 * Switching off keeps what was captured. Throwing it away made toggling the setting cost a full
 * re-read every time, which is the one thing anyone does repeatedly while deciding whether they want
 * the markers on — and the data is not wasted by being briefly unwatched, because switching back on
 * re-reads everything visible anyway. The kept copy is what shows instantly while that happens.
 */
export const captureTilePixels = (on: boolean): void => {
  if (capturePixels === on) return
  capturePixels = on
  if (on) captureGeneration++
  log('install', `tile pixel capture ${on ? 'on' : 'off'}`)
}

/** The placed pixels of a tile as palette indices, or null if it has not been captured. */
export const tilePixels = (tile: TileCoord): Uint8Array | null => {
  const key = tileKey(tile)
  const pixels = pixelsOfTile.get(key)
  if (pixels === undefined) return null
  // Re-inserted so it counts as recently used: eviction takes from the front.
  pixelsOfTile.delete(key)
  pixelsOfTile.set(key, pixels)
  return pixels
}

/** Whatever tile URL wplace last used, with the coordinates blanked out. */
let tileUrlShape: string | null = null
let captureRealm: (Window & typeof globalThis) | null = null

/** Tiles we have already gone and asked for, so a miss is chased once and not every frame. */
const chased = new Set<string>()
let chasing = 0

/**
 * Fetch a tile we never saw decoded, rather than waiting for wplace to fetch it again.
 *
 * Capture can only catch a tile at the moment it is decoded, so anything already on screen when the
 * feature switches on — the entire viewport, on a page load — was missed. Those tiles then sat
 * unanswered until wplace happened to re-fetch them, which is on their schedule and about ten
 * seconds: markers appeared almost at once for a tile panned to, and took ten seconds for the ones
 * that had been there all along.
 *
 * One request per tile, at most a few at a time, and only for tiles something is actually asking
 * about. That is the same request their own client makes, at a fraction of the rate.
 */
const CHASE_LIMIT = 4

export const ensureTilePixels = (tile: TileCoord): void => {
  if (!capturePixels || tileUrlShape === null) return
  const key = tileKey(tile)
  if (pixelsOfTile.has(key) || chased.has(key) || chasing >= CHASE_LIMIT) return
  chased.add(key)
  chasing++
  const url = tileUrlShape.replace('{x}', String(tile.x)).replace('{y}', String(tile.y))
  void (async () => {
    try {
      const realm = captureRealm
      if (realm === null) return
      const response = await realm.fetch.call(realm, url)
      if (!response.ok) return
      const bitmap = await realm.createImageBitmap.call(realm, await response.blob())
      capture(tile, bitmap)
      count('pixels:chased a tile we missed')
    } catch (error) {
      warn('fetch', `could not chase tile ${tile.x}/${tile.y}`, String(error))
    } finally {
      chasing--
    }
  })()
}

/**
 * RGB to palette index, as a flat table.
 *
 * Sixteen megabytes to avoid a hash lookup a million times per tile, allocated the first time a tile
 * is converted and never again. A `Map` measured slower by enough to matter on a conversion that
 * blocks the main thread.
 */
let rgbToIndex: Uint8Array | null = null

const indexTable = (): Uint8Array => {
  if (rgbToIndex !== null) return rgbToIndex
  const table = new Uint8Array(1 << 24).fill(UNPAINTED)
  for (const colour of WPLACE_PALETTE) {
    const [r, g, b] = colour.rgb
    table[(r << 16) | (g << 8) | b] = colour.index
  }
  rgbToIndex = table
  return table
}

/**
 * Canvases whose pixels have changed since they were last read.
 *
 * wplace redraws a paint-preview tile only when a pixel changes, but MapLibre *draws* it every
 * frame. Without this the capture below would run on every frame of every tile on screen.
 */
const dirtyCanvases = new WeakSet<object>()

/** Note that a tile-sized canvas has been written to, so the next draw re-reads it. */
export const markCanvasDirty = (canvas: object): void => {
  dirtyCanvases.add(canvas)
}

/** Which tile a paint-preview canvas belongs to, once a draw has told us. */
const tileOfPaintCanvas = new WeakMap<object, TileCoord>()

/**
 * What the client knows that the server has not confirmed, per tile: pixel offset to palette index.
 *
 * The preview canvas is **not** a copy of the tile, which is the thing that made every marker in a
 * tile vanish the moment a pixel was painted into it. Their tile manager allocates on demand:
 *
 *     O.pixels || (O.pixels = new Uint8Array(this.tileSize * this.tileSize)), O.pixels[u] = g
 *
 * so painting into a tile it has not loaded produces an all-zero array with one pixel set, and a
 * canvas that is transparent everywhere except there. Read as a tile, that says the whole tile is
 * unpainted — and unpainted is not a mismatch unless asked for, so every marker went.
 *
 * So the preview contributes pixels and never absences, and those pixels are kept separately. The
 * PNG remains the base, which is what stops a re-fetch from reverting a pixel that has been placed
 * and not yet submitted: the base is replaced and the overrides go back on top.
 */
const overridesOfTile = new Map<string, Map<number, number>>()

/**
 * Writes that arrived before we knew which tile the canvas was, as flat `x, y, index` in tile-local
 * coordinates.
 *
 * A canvas is named the first time a draw places it, which is normally well before anyone paints
 * into it — but not always, and a write is cheap to hold and impossible to reconstruct. The pixels
 * are in the argument, so they are kept rather than recovered later by reading the tile back.
 */
const queuedWrites = new WeakMap<object, number[]>()

/** Register the tile identity that wplace exposes in a draft layer's style id. */
export const registerDraftCanvas = (canvas: object, tile: TileCoord): void => {
  const known = tileOfPaintCanvas.get(canvas)
  if (known !== undefined && known.x === tile.x && known.y === tile.y) return
  tileOfPaintCanvas.set(canvas, tile)
  count('paint:named a draft canvas')
  const held = queuedWrites.get(canvas)
  if (held !== undefined && applyWrite(tile, held)) queuedWrites.delete(canvas)
}

type PixelListener = (tile: TileCoord, x: number, y: number, index: number) => void
const pixelListeners: PixelListener[] = []

/** Notified when a single placed pixel changes, in canvas coordinates. */
export const onTilePixel = (listener: PixelListener): void => {
  pixelListeners.push(listener)
}

/**
 * The largest write that is worth patching a pixel at a time.
 *
 * A pending paint is a 1x1, so this is really "is this a pixel or a repaint". Anything bigger falls
 * back to re-reading the tile, which is the right trade at that size and the wrong one at this.
 */
const PATCH_LIMIT = 32

/**
 * Apply a small canvas write straight into the captured indices.
 *
 * The write says exactly which pixels moved and to what. Re-reading the whole tile to discover that
 * is a million `getImageData` bytes and a million table lookups to learn something the argument
 * already contained — and it happens on every pixel placed, which is the one moment the map has to
 * stay responsive.
 */
const readWrite = (image: ImageData, dx: number, dy: number): number[] => {
  const table = indexTable()
  const { data, width, height } = image
  const triples: number[] = []
  for (let j = 0; j < height; j++) {
    const y = dy + j
    if (y < 0 || y >= TILE_SIZE) continue
    for (let i = 0; i < width; i++) {
      const x = dx + i
      if (x < 0 || x >= TILE_SIZE) continue
      const at = (j * width + i) * 4
      triples.push(
        x,
        y,
        data[at + 3] === 0
          ? UNPAINTED
          : (table[((data[at] ?? 0) << 16) | ((data[at + 1] ?? 0) << 8) | (data[at + 2] ?? 0)] ??
              UNPAINTED),
      )
    }
  }
  return triples
}

const applyWrite = (tile: TileCoord, triples: readonly number[]): boolean => {
  const key = tileKey(tile)
  const indices = pixelsOfTile.get(key)
  if (indices === undefined) return false
  const overrides = overridesOfTile.get(key) ?? new Map<number, number>()
  let changed = 0
  for (let i = 0; i < triples.length; i += 3) {
    const x = triples[i] as number
    const y = triples[i + 1] as number
    const index = triples[i + 2] as number
    const p = y * TILE_SIZE + x
    // Remembered as well as applied. A pixel placed and not yet submitted is not in the tile the
    // server will serve, so without this the next fetch would quietly revert it.
    if (index !== UNPAINTED) overrides.set(p, index)
    if (indices[p] === index) continue
    indices[p] = index
    changed++
    for (const listener of pixelListeners) {
      try {
        listener(tile, tile.x * TILE_SIZE + x, tile.y * TILE_SIZE + y, index)
      } catch {
        count('pixels:listener-failed')
      }
    }
  }
  if (overrides.size > 0) overridesOfTile.set(key, overrides)
  if (changed > 0) count('pixels:patched a write')
  return true
}

/**
 * Move `into` to match `from`, announcing each pixel that moves.
 *
 * The array itself is kept. Anything holding an answer derived from this tile keys it on the array's
 * identity, so replacing it says "all of this is stale" — and recomputing a tile because one pixel
 * moved is what made every marker in it disappear and come back.
 */
const apply = (
  tile: TileCoord,
  into: Uint8Array,
  from: Uint8Array | Map<number, number>,
): number => {
  let moved = 0
  const at = (p: number, index: number): void => {
    if (into[p] === index) return
    into[p] = index
    moved++
    const x = p % TILE_SIZE
    const y = (p - x) / TILE_SIZE
    for (const listener of pixelListeners) {
      try {
        listener(tile, tile.x * TILE_SIZE + x, tile.y * TILE_SIZE + y, index)
      } catch {
        count('pixels:listener-failed')
      }
    }
  }
  if (from instanceof Map) for (const [p, index] of from) at(p, index)
  else for (let p = 0; p < from.length; p++) at(p, from[p] as number)
  if (moved > 0) count('pixels:changed', moved)
  return moved
}

/** Read a tile into palette indices, from whatever wplace last drew it from. */
const capture = (
  tile: TileCoord,
  bitmap: CanvasImageSource & { width: number; height: number },
  from: 'tile' | 'preview' = 'tile',
): void => {
  if (!capturePixels) return
  if (bitmap.width !== TILE_SIZE || bitmap.height !== TILE_SIZE) return
  try {
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return
    context.drawImage(bitmap, 0, 0)
    const { data } = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE)
    const table = indexTable()
    const indices = new Uint8Array(TILE_SIZE * TILE_SIZE)
    let painted = 0
    for (let i = 0, p = 0; p < indices.length; i += 4, p++) {
      // Fully transparent is unpainted. Their canvas is otherwise exact palette colours, so a colour
      // that is not in the table can only be something we do not model — treated as unpainted rather
      // than guessed at.
      const index =
        data[i + 3] === 0
          ? UNPAINTED
          : (table[((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0)] ??
            UNPAINTED)
      indices[p] = index
      if (index !== UNPAINTED) painted++
    }

    const key = tileKey(tile)
    const overrides = overridesOfTile.get(key) ?? new Map<number, number>()

    if (from === 'preview') {
      // Pixels only. A transparent pixel in a preview means "the client has nothing here", not
      // "nobody has painted here" — see `overridesOfTile`.
      if (painted === 0) {
        count('pixels:preview had nothing to add')
        return
      }
      for (let p = 0; p < indices.length; p++) {
        const index = indices[p] as number
        if (index !== UNPAINTED) overrides.set(p, index)
      }
      overridesOfTile.set(key, overrides)
      const base = pixelsOfTile.get(key)
      // Nothing to lay them over yet. The base has to come from the tile itself, and asking for it
      // is what `ensureTilePixels` is for.
      if (base === undefined) {
        count('pixels:preview held until the tile arrives')
        return
      }
      apply(tile, base, overrides)
      count('pixels:preview merged')
      return
    }

    // The server's answer, which is the base. Anything it now agrees with is no longer an override:
    // that pixel has been submitted and confirmed, and keeping it would pin a stale value forever.
    for (const [p, index] of overrides) {
      if (indices[p] === index) overrides.delete(p)
    }
    if (overrides.size > 0) overridesOfTile.set(key, overrides)
    else overridesOfTile.delete(key)

    /**
     * A re-read of a tile we already hold becomes a diff, not a replacement.
     *
     * Replacing the array is what made a whole tile's answers evaporate. Anything holding a result
     * for this tile keys it on the array's identity — that is how a re-read is meant to invalidate
     * a stale answer — so handing over a *new* array said "everything about this tile has changed"
     * when what had actually changed was one pixel someone painted.
     */
    const existing = pixelsOfTile.get(key)
    if (existing === undefined || existing.length !== indices.length) {
      for (const [p, index] of overrides) indices[p] = index
      pixelsOfTile.set(key, indices)
      evict()
      count('pixels:captured')
      return
    }
    for (const [p, index] of overrides) indices[p] = index
    apply(tile, existing, indices)
    count('pixels:re-read as a diff')
  } catch (error) {
    warn('bitmap', 'could not read tile pixels', String(error))
  }
}

const installBitmapTap = (realm: Window & typeof globalThis): InstalledValueHook | null => {
  const nativeCreateImageBitmap = realm.createImageBitmap
  const wrappedCreateImageBitmap = {
    // biome-ignore lint/suspicious/noExplicitAny: createImageBitmap has two overload shapes
    createImageBitmap(this: unknown, ...args: any[]): Promise<ImageBitmap> {
      const pendingBitmap = Reflect.apply(
        nativeCreateImageBitmap as (...a: unknown[]) => Promise<ImageBitmap>,
        this,
        args,
      )
      let sourceBlob: Blob | undefined
      let sourceBytes: number | undefined
      let exact: TileCoord | undefined
      let sourceIsPageBlob = false
      try {
        const source = args[0]
        if (isPageInstance(source, 'Blob', realm as unknown as Record<string, unknown>)) {
          sourceIsPageBlob = true
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
      if (!sourceIsPageBlob) return pendingBitmap
      return pendingBitmap.then((bitmap) => {
        try {
          if (sourceBlob !== undefined && sourceBytes !== undefined) {
            if (exact !== undefined) {
              tileOfBitmap.set(bitmap, exact)
              capture(exact, bitmap)
              log('bitmap', `matched ${exact.x}/${exact.y} by identity`, { bytes: sourceBytes })
              return bitmap
            }
            count('bitmap:fell-back-to-byte-length')
            const tile = takeBySizeForBitmap(sourceBytes, bitmap.width, bitmap.height)
            if (tile !== undefined) {
              tileOfBitmap.set(bitmap, tile)
              capture(tile, bitmap)
              log('bitmap', `matched ${tile.x}/${tile.y}`, { bytes: sourceBytes })
            } else if (bitmap.width === 1000 && bitmap.height === 1000) {
              // A tile-shaped image we cannot name. This is the shape of the bug where the overlay
              // thins out: it will overwrite a texture's identity below.
              log('bitmap', 'unmatched 1000x1000 bitmap — no tile queued at this byte length', {
                bytes: sourceBytes,
                sizesWaiting: [...tilesByByteLength.keys()].slice(0, 8).join(' '),
              })
            }
          }
        } catch {
          // Native decoding already succeeded. A diagnostic or hostile object cannot reject its promise.
        }
        return bitmap
      })
    },
  }.createImageBitmap as typeof globalThis.createImageBitmap
  return installValueHook(realm, 'createImageBitmap', wrappedCreateImageBitmap)
}

const installPutImageDataTaps = (
  realm: Window & typeof globalThis,
): InstalledValueHook[] | null => {
  const offscreenPrototype = (
    realm as typeof realm & {
      OffscreenCanvasRenderingContext2D?: { prototype: CanvasRenderingContext2D }
    }
  ).OffscreenCanvasRenderingContext2D?.prototype
  const prototypes = [realm.CanvasRenderingContext2D.prototype, offscreenPrototype].filter(
    (prototype): prototype is CanvasRenderingContext2D => prototype !== undefined,
  )
  const hooks: InstalledValueHook[] = []
  try {
    for (const prototype of prototypes) {
      const nativePutImageData = prototype.putImageData
      const wrappedPutImageData = function (
        this: CanvasRenderingContext2D,
        ...args: Parameters<CanvasRenderingContext2D['putImageData']>
      ): void {
        return runObservedCall(
          () => Reflect.apply(nativePutImageData, this, args),
          () => {
            const canvas = this.canvas as { width?: number; height?: number }
            if (!capturePixels || canvas.width !== TILE_SIZE || canvas.height !== TILE_SIZE) return
            const [image, dx, dy] = args
            if (image.width > PATCH_LIMIT || image.height > PATCH_LIMIT) {
              markCanvasDirty(this.canvas)
              return
            }
            const triples = readWrite(image, dx, dy)
            const tile = tileOfPaintCanvas.get(this.canvas)
            if (tile === undefined || !applyWrite(tile, triples)) {
              const queue = queuedWrites.get(this.canvas)
              if (queue === undefined) queuedWrites.set(this.canvas, triples)
              else queue.push(...triples)
            }
          },
        )
      }
      const hook = installValueHook(prototype, 'putImageData', wrappedPutImageData)
      if (hook === null) throw new Error('putImageData is not hookable')
      hooks.push(hook)
    }
    return hooks
  } catch {
    for (const hook of hooks.reverse()) hook.restore()
    return null
  }
}

export const install = (
  realm: Window & typeof globalThis = pageWindow(),
  mapHandle: () => ReturnType<typeof getMap> = getMap,
): void => {
  captureRealm = realm
  const browserHooks: InstalledValueHook[] = []
  const addBrowserHook = (installer: () => InstalledValueHook | null): boolean => {
    try {
      const hook = installer()
      if (hook === null) return false
      browserHooks.push(hook)
      return true
    } catch {
      return false
    }
  }
  const abandonBrowserHooks = (): void => {
    for (const hook of browserHooks.reverse()) hook.restore()
  }
  if (!addBrowserHook(() => installFetchTap(realm))) return
  if (!addBrowserHook(() => installBlobTap(realm))) {
    abandonBrowserHooks()
    return
  }
  if (!addBrowserHook(() => installBitmapTap(realm))) {
    abandonBrowserHooks()
    return
  }
  const putImageDataHooks = installPutImageDataTaps(realm)
  if (putImageDataHooks === null) {
    abandonBrowserHooks()
    return
  }
  browserHooks.push(...putImageDataHooks)

  let nativeGetContext: typeof realm.HTMLCanvasElement.prototype.getContext
  try {
    nativeGetContext = realm.HTMLCanvasElement.prototype.getContext
  } catch {
    abandonBrowserHooks()
    return
  }
  let wrapped = false
  let activeContextGeneration = 0
  let restoreActiveContextHooks: (() => void) | null = null

  const looksLikeMapCanvas = (canvas: HTMLCanvasElement | null): boolean => {
    try {
      return canvas?.classList.contains('maplibregl-canvas') === true
    } catch {
      // A hostile canvas shim must not change a successful native getContext call.
      return false
    }
  }

  const wrappedGetContextImplementation = function (
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
    // The first WebGL context in the document is not necessarily the map's. wplace may well make one
    // for something else first — a fingerprinting probe, an effect — and instrumenting that one and
    // then refusing every context after it means the overlay simply never receives a frame. If the
    // map has already been captured, only its own canvas counts; before that, take the first and let
    // a later canvas carrying MapLibre's measured class correct it. A measured map canvas also
    // yields to the next measured one so overlapping or repeated SPA remounts do not strand the
    // overlay waiting for a getContext retry that never comes.
    let mapOwned: HTMLCanvasElement | undefined
    try {
      mapOwned = mapHandle()?.getCanvas?.()
    } catch {
      // A map mid-construction may not answer yet; treat that as no opinion.
    }
    // Repeated getContext calls on the active canvas return its already-wrapped context. A different
    // canvas confirmed by the live Map handle is a replacement and must be allowed to retarget.
    if (wrapped && mapCanvas === this) return context
    const candidateLooksLikeMap = looksLikeMapCanvas(this)
    const replacingMeasuredMapCanvas =
      wrapped && candidateLooksLikeMap && looksLikeMapCanvas(mapCanvas)
    if (mapOwned !== undefined && mapOwned !== this) {
      if (!replacingMeasuredMapCanvas) {
        log('install', 'skipped a WebGL context that is not the map canvas', { type })
        return context
      }
      // The captured Map belongs to a previous SPA mount. Its canvas cannot veto the next measured
      // MapLibre canvas: overlapping mounts create the new context before detaching the old one.
      mapOwned = undefined
    }
    if (wrapped && mapOwned === undefined && !replacingMeasuredMapCanvas) {
      const currentLooksLikeMap = looksLikeMapCanvas(mapCanvas)
      // Keep the first provisional context until there is positive evidence that a later canvas is
      // MapLibre's. Once the measured map class is wrapped, an unrelated context cannot steal it.
      if (currentLooksLikeMap || !candidateLooksLikeMap) return context
    }
    if (wrapped) log('install', 're-targeting onto the map canvas', { type })
    const previousWrapped = wrapped
    const previousContextGeneration = activeContextGeneration
    const previousMapCanvas = mapCanvas
    const previousActiveContextRestore = restoreActiveContextHooks
    wrapped = true
    const contextGeneration = ++activeContextGeneration
    mapCanvas = this

    const gl = context as WebGL2RenderingContext
    const glHooks: InstalledValueHook[] = []
    let glHookFailed = false
    let detachContextLossListener = (): void => undefined
    const restoreGlHooks = (): void => {
      for (let index = glHooks.length - 1; index >= 0; index -= 1) glHooks[index]?.restore()
    }
    const abandonGlHooks = (): typeof context => {
      detachContextLossListener()
      restoreGlHooks()
      wrapped = previousWrapped
      activeContextGeneration = previousContextGeneration
      mapCanvas = previousMapCanvas
      return context
    }
    try {
      // The empty proxy keeps assignment's contextual WebGL types without inheriting the real
      // context's property invariants. Its setter installs own properties through defineProperty,
      // which safely bypasses a co-installed script's inherited non-writable method.
      const hookedGl = new Proxy({} as WebGL2RenderingContext, {
        set(_target, property, value) {
          if (glHookFailed) return true
          const hook = installValueHook(gl, property, value)
          if (hook === null) glHookFailed = true
          else glHooks.push(hook)
          return true
        },
      })
      // Weak: a long session rebuilds programs, and this only ever needs object identity.
      interface UniformIdentity {
        readonly program: WebGLProgram
        readonly name: string
      }
      const uniforms = new WeakMap<WebGLUniformLocation, UniformIdentity>()
      const primarySamplerUnits = new WeakMap<WebGLProgram, number>()
      const projectionByProgram = new WeakMap<WebGLProgram, ArrayLike<number>>()
      let programs = new WeakSet<WebGLProgram>()
      const tileOfTexture = new WeakMap<WebGLTexture, TileCoord>()
      const canvasOfTexture = new WeakMap<
        WebGLTexture,
        CanvasImageSource & { width: number; height: number }
      >()
      const capturedAt = new WeakMap<WebGLTexture, number>()
      let textures = new WeakSet<WebGLTexture>()
      const texture2DByUnit = new Map<number, WebGLTexture | null>()
      let activeProgram: WebGLProgram | null = null
      let activeTextureUnit: number = gl.TEXTURE0
      const nativeGetParameter = gl.getParameter
      let maxTextureUnits = Number.POSITIVE_INFINITY
      try {
        const measured = nativeGetParameter.call(gl, gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS)
        if (typeof measured === 'number' && Number.isInteger(measured) && measured > 0) {
          maxTextureUnits = measured
        }
      } catch {
        // The real context answers this. A partial test double or hostile shim leaves validation at
        // the enum's non-negative/integer baseline instead of breaking installation.
      }
      const nativeGetUniformLocation = gl.getUniformLocation
      hookedGl.getUniformLocation = {
        getUniformLocation(this: WebGL2RenderingContext, program: WebGLProgram, name: string) {
          let location: WebGLUniformLocation | null = null
          return runObservedCall(
            () => {
              location = nativeGetUniformLocation.call(this, program, name)
              return location
            },
            () => {
              if (this !== gl || location === null) return
              // A successful location proves the program belongs to this context. This also covers
              // programs created before instrumentation without adding a synchronous query later.
              programs.add(program)
              uniforms.set(location, { program, name })
              // WebGL sampler uniforms default to texture unit zero. Remember that before the first
              // explicit upload too: wrappers such as MapLibre cache uniforms and may not set one again.
              if (name === 'u_image0' && !primarySamplerUnits.has(program)) {
                primarySamplerUnits.set(program, gl.TEXTURE0)
              }
            },
          )
        },
      }.getUniformLocation

      const nativeCreateProgram = gl.createProgram
      if (typeof nativeCreateProgram === 'function') {
        hookedGl.createProgram = {
          createProgram(this: WebGL2RenderingContext): WebGLProgram {
            let created: WebGLProgram | undefined
            return runObservedCall(
              () => {
                created = nativeCreateProgram.call(this)
                return created
              },
              () => {
                if (this === gl && created !== undefined) programs.add(created)
              },
            )
          },
        }.createProgram
      }

      const nativeUseProgram = gl.useProgram
      hookedGl.useProgram = {
        useProgram(this: WebGL2RenderingContext, program: WebGLProgram | null) {
          return runObservedCall(
            () => nativeUseProgram.call(this, program),
            () => {
              if (this !== gl) return
              if (program === null || program === undefined) {
                activeProgram = null
                return
              }
              if (programs.has(program)) {
                activeProgram = program
                return
              }
              // Only pre-hook, foreign, or deleted objects need a synchronous state query. Programs
              // created or successfully inspected on this context stay on the WeakSet fast path.
              const accepted = nativeGetParameter.call(gl, gl.CURRENT_PROGRAM)
              if (accepted === null || typeof accepted === 'object') {
                activeProgram = accepted as WebGLProgram | null
              }
            },
          )
        },
      }.useProgram

      const nativeDeleteProgram = gl.deleteProgram
      if (typeof nativeDeleteProgram === 'function') {
        hookedGl.deleteProgram = {
          deleteProgram(this: WebGL2RenderingContext, program: WebGLProgram | null) {
            return runObservedCall(
              () => nativeDeleteProgram.call(this, program),
              () => {
                if (this === gl && program !== null) programs.delete(program)
              },
            )
          },
        }.deleteProgram
      }

      const nativeUniform1i = gl.uniform1i
      hookedGl.uniform1i = {
        uniform1i(
          this: WebGL2RenderingContext,
          location: WebGLUniformLocation | null,
          value: GLint,
        ) {
          return runObservedCall(
            () => nativeUniform1i.call(this, location, value),
            () => {
              if (this !== gl || location === null || typeof value !== 'number') return
              const uniform = uniforms.get(location)
              if (uniform?.name !== 'u_image0' || uniform.program !== activeProgram) return
              primarySamplerUnits.set(uniform.program, gl.TEXTURE0 + value)
            },
          )
        },
      }.uniform1i

      const nativeUniformMatrix4fv = gl.uniformMatrix4fv
      hookedGl.uniformMatrix4fv = {
        uniformMatrix4fv(
          this: WebGL2RenderingContext,
          location: WebGLUniformLocation | null,
          transpose: GLboolean,
          value: Float32List,
          ...rest: [srcOffset?: number, srcLength?: number]
        ) {
          return runObservedCall(
            () =>
              Reflect.apply(nativeUniformMatrix4fv, this, [location, transpose, value, ...rest]),
            () => {
              if (this !== gl || location === null || transpose) return
              const uniform = uniforms.get(location)
              if (uniform?.name !== 'u_projection_matrix' || uniform.program !== activeProgram)
                return
              // Plain sequences have already had every element converted by WebIDL. Reading them again
              // can invoke accessors twice and capture different values, so only page-realm typed arrays
              // are safe to snapshot.
              if (
                !isPageInstance(
                  value,
                  'Float32Array',
                  realm as unknown as Record<string, unknown>,
                ) ||
                !realm.ArrayBuffer.isView(value)
              )
                return
              const offset = sideEffectFreeUnsignedLong(rest[0])
              if (offset === undefined) return
              const source = value as Float32Array
              const suppliedLength = sideEffectFreeUnsignedLong(rest[1])
              if (
                suppliedLength === undefined ||
                (suppliedLength !== 0 &&
                  (suppliedLength < MATRIX_LENGTH || offset + suppliedLength > source.length))
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
        },
      }.uniformMatrix4fv as typeof gl.uniformMatrix4fv

      const nativeActiveTexture = gl.activeTexture
      hookedGl.activeTexture = {
        activeTexture(this: WebGL2RenderingContext, texture: GLenum) {
          return runObservedCall(
            () => nativeActiveTexture.call(this, texture),
            () => {
              if (this !== gl || typeof texture !== 'number') return
              const index = texture - gl.TEXTURE0
              if (!Number.isInteger(index) || index < 0 || index >= maxTextureUnits) return
              activeTextureUnit = texture
            },
          )
        },
      }.activeTexture

      const nativeCreateTexture = gl.createTexture
      hookedGl.createTexture = {
        createTexture(this: WebGL2RenderingContext): WebGLTexture {
          let created: WebGLTexture | undefined
          return runObservedCall(
            () => {
              created = nativeCreateTexture.call(this)
              return created
            },
            () => {
              if (this === gl && created !== undefined) textures.add(created)
            },
          )
        },
      }.createTexture

      const nativeBindTexture = gl.bindTexture
      hookedGl.bindTexture = {
        bindTexture(this: WebGL2RenderingContext, target: GLenum, texture: WebGLTexture | null) {
          return runObservedCall(
            () => nativeBindTexture.call(this, target, texture),
            () => {
              if (this === gl && target === gl.TEXTURE_2D) {
                if (texture === null || texture === undefined) {
                  texture2DByUnit.set(activeTextureUnit, null)
                } else if (textures.has(texture)) {
                  texture2DByUnit.set(activeTextureUnit, texture)
                } else {
                  // Same strategy as framebuffers below: only pre-hook or foreign objects need a
                  // synchronous query. MapLibre-created textures stay on the WeakSet fast path.
                  const accepted = nativeGetParameter.call(gl, gl.TEXTURE_BINDING_2D)
                  if (accepted === null || typeof accepted === 'object') {
                    texture2DByUnit.set(activeTextureUnit, accepted as WebGLTexture | null)
                    if (accepted === texture) textures.add(texture)
                  }
                }
              }
            },
          )
        },
      }.bindTexture

      const nativeDeleteTexture = gl.deleteTexture
      hookedGl.deleteTexture = {
        deleteTexture(this: WebGL2RenderingContext, texture: WebGLTexture | null) {
          return runObservedCall(
            () => nativeDeleteTexture.call(this, texture),
            () => {
              if (this !== gl || texture === null || !textures.delete(texture)) return
              tileOfTexture.delete(texture)
              canvasOfTexture.delete(texture)
              for (const [unit, bound] of texture2DByUnit) {
                if (bound === texture) texture2DByUnit.set(unit, null)
              }
            },
          )
        },
      }.deleteTexture

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
      const isPageCanvasSource = (
        source: unknown,
      ): source is CanvasImageSource & { width: number; height: number } => {
        if (typeof source !== 'object' || source === null) return false
        const constructors = realm as unknown as Record<string, unknown>
        return (
          isPageInstance(source, 'HTMLCanvasElement', constructors) ||
          isPageInstance(source, 'OffscreenCanvas', constructors)
        )
      }

      const attributeUpload = (target: number, source: unknown): void => {
        if (target !== gl.TEXTURE_2D) return
        const texture = texture2DByUnit.get(activeTextureUnit) ?? null
        if (
          texture !== null &&
          isPageCanvasSource(source) &&
          source.width === TILE_SIZE &&
          source.height === TILE_SIZE
        ) {
          canvasOfTexture.set(texture, source)
          tileOfTexture.delete(texture)
          return
        }
        if (
          texture === null ||
          !isPageInstance(source, 'ImageBitmap', realm as unknown as Record<string, unknown>)
        ) {
          if (texture !== null && tileOfTexture.has(texture)) {
            const had = tileOfTexture.get(texture)
            log(
              'texture',
              `DROPPED attribution ${had?.x}/${had?.y} — re-uploaded from non-bitmap`,
              {
                sourceKind:
                  source === null
                    ? 'null'
                    : ((source as object)?.constructor?.name ?? typeof source),
              },
            )
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
          log('texture', `DROPPED attribution ${had.x}/${had.y} — re-uploaded unattributed`, {
            size: `${bitmap.width}x${bitmap.height}`,
          })
          tileOfTexture.delete(texture)
        }
      }

      const nativeTexSubImage2D = gl.texSubImage2D
      hookedGl.texSubImage2D = {
        // biome-ignore lint/suspicious/noExplicitAny: texSubImage2D has as many overloads as texImage2D
        texSubImage2D(this: WebGL2RenderingContext, ...subArgs: any[]) {
          return runObservedCall(
            () => Reflect.apply(nativeTexSubImage2D, this, subArgs),
            () => {
              if (this === gl) attributeUpload(subArgs[0], subArgs[subArgs.length - 1])
            },
          )
        },
      }.texSubImage2D as typeof gl.texSubImage2D

      const nativeTexImage2D = gl.texImage2D
      hookedGl.texImage2D = {
        // biome-ignore lint/suspicious/noExplicitAny: texImage2D has ten overloads
        texImage2D(this: WebGL2RenderingContext, ...texArgs: any[]) {
          return runObservedCall(
            () => Reflect.apply(nativeTexImage2D, this, texArgs),
            () => {
              if (this === gl) attributeUpload(texArgs[0], texArgs[texArgs.length - 1])
            },
          )
        },
      }.texImage2D as typeof gl.texImage2D

      let framebuffers = new WeakSet<WebGLFramebuffer>()
      const nativeCreateFramebuffer = gl.createFramebuffer
      hookedGl.createFramebuffer = {
        createFramebuffer(this: WebGL2RenderingContext): WebGLFramebuffer {
          let created: WebGLFramebuffer | undefined
          return runObservedCall(
            () => {
              created = nativeCreateFramebuffer.call(this)
              return created
            },
            () => {
              if (this === gl && created !== undefined) framebuffers.add(created)
            },
          )
        },
      }.createFramebuffer

      let drawFramebuffer: WebGLFramebuffer | null = null
      const drawFramebufferTarget =
        typeof gl.DRAW_FRAMEBUFFER === 'number' ? gl.DRAW_FRAMEBUFFER : null
      const drawFramebufferBinding =
        typeof gl.DRAW_FRAMEBUFFER_BINDING === 'number'
          ? gl.DRAW_FRAMEBUFFER_BINDING
          : gl.FRAMEBUFFER_BINDING
      let scissorEnabled = false
      let colorWriteMask: [boolean, boolean, boolean, boolean] = [true, true, true, true]
      const validClearMask = gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT
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
          queueMicrotask(() => {
            if (contextGeneration !== activeContextGeneration) return
            flush()
          })
        }
        return true
      }

      const nativeBindFramebuffer = gl.bindFramebuffer
      hookedGl.bindFramebuffer = {
        bindFramebuffer(
          this: WebGL2RenderingContext,
          target: GLenum,
          framebuffer: WebGLFramebuffer | null,
        ) {
          return runObservedCall(
            () => nativeBindFramebuffer.call(this, target, framebuffer),
            () => {
              if (this !== gl) return
              if (
                target === gl.FRAMEBUFFER ||
                (drawFramebufferTarget !== null && target === drawFramebufferTarget)
              ) {
                // WebIDL treats an explicit undefined as null. Known same-context objects are the
                // ordinary MapLibre path and need no synchronous state query.
                if (framebuffer === null || framebuffer === undefined) {
                  drawFramebuffer = null
                } else if (framebuffers.has(framebuffer)) {
                  drawFramebuffer = framebuffer
                } else {
                  // An object created before instrumentation may be valid; a foreign or deleted one
                  // is rejected without throwing. Query only this unusual path so normal frame binds
                  // never pay for a synchronous getParameter call.
                  const accepted = nativeGetParameter.call(gl, drawFramebufferBinding)
                  if (accepted === null || typeof accepted === 'object') {
                    drawFramebuffer = accepted as WebGLFramebuffer | null
                    if (accepted === framebuffer) framebuffers.add(framebuffer)
                  }
                }
              }
            },
          )
        },
      }.bindFramebuffer

      const nativeDeleteFramebuffer = gl.deleteFramebuffer
      hookedGl.deleteFramebuffer = {
        deleteFramebuffer(this: WebGL2RenderingContext, framebuffer: WebGLFramebuffer | null) {
          return runObservedCall(
            () => nativeDeleteFramebuffer.call(this, framebuffer),
            () => {
              if (
                this === gl &&
                framebuffer !== null &&
                framebuffers.delete(framebuffer) &&
                framebuffer === drawFramebuffer
              ) {
                // WebGL automatically restores the default draw framebuffer when the bound object is
                // deleted; keep the mirror on the same transition.
                drawFramebuffer = null
              }
            },
          )
        },
      }.deleteFramebuffer

      const nativeEnable = gl.enable
      hookedGl.enable = {
        enable(this: WebGL2RenderingContext, cap: GLenum) {
          return runObservedCall(
            () => nativeEnable.call(this, cap),
            () => {
              if (this === gl && cap === gl.SCISSOR_TEST) scissorEnabled = true
            },
          )
        },
      }.enable

      const nativeDisable = gl.disable
      hookedGl.disable = {
        disable(this: WebGL2RenderingContext, cap: GLenum) {
          return runObservedCall(
            () => nativeDisable.call(this, cap),
            () => {
              if (this === gl && cap === gl.SCISSOR_TEST) scissorEnabled = false
            },
          )
        },
      }.disable

      const nativeColorMask = gl.colorMask
      hookedGl.colorMask = {
        colorMask(
          this: WebGL2RenderingContext,
          red: GLboolean,
          green: GLboolean,
          blue: GLboolean,
          alpha: GLboolean,
        ) {
          return runObservedCall(
            () => nativeColorMask.call(this, red, green, blue, alpha),
            () => {
              if (this === gl) {
                colorWriteMask = [Boolean(red), Boolean(green), Boolean(blue), Boolean(alpha)]
              }
            },
          )
        },
      }.colorMask

      const nativeClear = gl.clear
      hookedGl.clear = {
        clear(this: WebGL2RenderingContext, mask: GLbitfield) {
          return runObservedCall(
            () => nativeClear.call(this, mask),
            () => {
              if (
                this === gl &&
                drawFramebuffer === null &&
                typeof mask === 'number' &&
                Number.isInteger(mask) &&
                mask >= 0 &&
                mask <= 0xffffffff &&
                (mask & gl.COLOR_BUFFER_BIT) !== 0 &&
                (mask & ~validClearMask) === 0 &&
                !scissorEnabled &&
                colorWriteMask.every(Boolean)
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
        },
      }.clear

      const refreshDraft = (texture: WebGLTexture): void => {
        if (!capturePixels) return
        const source = canvasOfTexture.get(texture)
        if (source === undefined) return
        const tile = tileOfPaintCanvas.get(source)
        if (tile === undefined) return
        const stale = capturedAt.get(texture) !== captureGeneration
        if (!stale && !dirtyCanvases.has(source)) return
        dirtyCanvases.delete(source)
        capturedAt.set(texture, captureGeneration)
        capture(tile, source, 'preview')
        queuedWrites.delete(source)
      }

      const recordDraw = (drawCount: number): void => {
        // Scheduled on every draw, not only tile draws, so a frame that renders the map with no
        // wplace tiles in it still reaches the listener. A default-framebuffer colour clear above
        // covers the rarer frame that contains no draw call at all.
        if (drawFramebuffer !== null) return
        if (!scheduleFrameFlush()) return
        // WebGL accepts a zero count as a no-op. It may still delimit a tile-less map frame, but it
        // cannot reuse the last program/texture/matrix state to manufacture a quad that was not drawn.
        if (!Number.isFinite(drawCount) || !Number.isInteger(drawCount) || drawCount <= 0) return
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
          refreshDraft(drawnTexture)
          count('draw:texture-not-a-known-tile')
          return
        }
        frameTileDraws++
        textureOfTile.set(tileKey(tile), drawnTexture)
        const quad = quadFromMatrix(drawnProjection, tile, this)
        if (quad !== null) pending.push(quad)
      }

      const nativeDrawArrays = gl.drawArrays
      hookedGl.drawArrays = {
        drawArrays(this: WebGL2RenderingContext, mode: GLenum, first: GLint, count: GLsizei) {
          return runObservedCall(
            () => nativeDrawArrays.call(this, mode, first, count),
            () => {
              if (this === gl) recordDraw(count)
            },
          )
        },
      }.drawArrays
      const nativeDrawElements = gl.drawElements
      hookedGl.drawElements = {
        drawElements(
          this: WebGL2RenderingContext,
          mode: GLenum,
          count: GLsizei,
          elementType: GLenum,
          offset: GLintptr,
        ) {
          return runObservedCall(
            () => nativeDrawElements.call(this, mode, count, elementType, offset),
            () => {
              if (this === gl) recordDraw(count)
            },
          )
        },
      }.drawElements

      if (glHookFailed) return abandonGlHooks()
      log('install', 'wrapped the map WebGL context', {
        type,
        canvas: `${this.width}x${this.height}`,
      })

      try {
        const nativeAddEventListener = this.addEventListener
        const nativeRemoveEventListener = this.removeEventListener
        const onContextLost = (): void => {
          try {
            if (contextGeneration !== activeContextGeneration) return
            pending = []
            frameDraws = 0
            frameTileDraws = 0
            activeProgram = null
            programs = new WeakSet<WebGLProgram>()
            activeTextureUnit = gl.TEXTURE0
            textures = new WeakSet<WebGLTexture>()
            texture2DByUnit.clear()
            framebuffers = new WeakSet<WebGLFramebuffer>()
            drawFramebuffer = null
            scissorEnabled = false
            colorWriteMask = [true, true, true, true]
            scheduleFrameFlush()
          } catch {
            // Context-loss bookkeeping is observational and must never escape into page event code.
          }
        }
        nativeAddEventListener.call(this, 'webglcontextlost', onContextLost)
        detachContextLossListener = () => {
          try {
            nativeRemoveEventListener.call(this, 'webglcontextlost', onContextLost)
          } catch {
            // Retiring observation must not disturb the replacement context that already committed.
          }
        }
      } catch {
        // A hostile or partial canvas shim must not break a successfully created WebGL context.
      }

      previousActiveContextRestore?.()
      // A queued microtask from the retired context must neither paint its quads onto this canvas
      // nor consume draws this context records before that stale callback runs.
      pending = []
      frameDraws = 0
      frameTileDraws = 0
      scheduled = false
      restoreActiveContextHooks = () => {
        detachContextLossListener()
        restoreGlHooks()
      }
      return gl
    } catch {
      return abandonGlHooks()
    }
  }
  const wrappedGetContext = {
    getContext(
      this: HTMLCanvasElement,
      // biome-ignore lint/suspicious/noExplicitAny: matching the DOM overload set is not worth it
      ...args: any[]
      // biome-ignore lint/suspicious/noExplicitAny: the return type follows the overload set too
    ): any {
      return wrappedGetContextImplementation.apply(this, args)
    },
  }.getContext
  if (
    !addBrowserHook(() =>
      installValueHook(realm.HTMLCanvasElement.prototype, 'getContext', wrappedGetContext),
    )
  ) {
    abandonBrowserHooks()
  }
}
