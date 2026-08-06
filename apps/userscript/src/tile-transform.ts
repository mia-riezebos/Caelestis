import type { TileCoord } from '@wts/shared'

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
 * How long the map must render with no tile in it before the overlay is cleared.
 *
 * A single tile-less frame is not evidence that no tiles are on screen: MapLibre renders the
 * basemap before any tile texture exists, and measured over a load, 5 of 120 frames drew 11-14
 * times with no tile among them while tiles were plainly visible. Clearing on those made the
 * overlay flicker out. Sustained absence is real — zooming out past the point where wplace serves
 * tiles at all — so absence is believed only once it persists.
 */
const CLEAR_AFTER_TILELESS_MILLISECONDS = 250

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

const TILE_URL = /\/files\/s\d+\/tiles\/(\d+)\/(\d+)\.png/

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
const tileOfBitmap = new WeakMap<ImageBitmap, TileCoord>()

/** Column-major 4x4, the layout WebGL uses. */
const project = (m: ArrayLike<number>, x: number, y: number): readonly [number, number] => {
  const at = (index: number): number => m[index] ?? 0
  const clipX = at(0) * x + at(4) * y + at(12)
  const clipY = at(1) * x + at(5) * y + at(13)
  const clipW = at(3) * x + at(7) * y + at(15)
  return [clipX / clipW, clipY / clipW]
}

const quadFromMatrix = (
  m: ArrayLike<number>,
  tile: TileCoord,
  canvas: HTMLCanvasElement,
): TileQuad | null => {
  const [x0, y0] = project(m, 0, 0)
  const [x1, y1] = project(m, MAPLIBRE_TILE_EXTENT, MAPLIBRE_TILE_EXTENT)
  // Clip space is -1..1 with y up; the canvas is 0..size with y down.
  const toScreenX = (clip: number) => (clip * 0.5 + 0.5) * canvas.width
  const toScreenY = (clip: number) => (1 - (clip * 0.5 + 0.5)) * canvas.height
  const x = toScreenX(x0)
  const y = toScreenY(y0)
  const width = toScreenX(x1) - x
  const height = toScreenY(y1) - y
  // Not every draw that binds a tile texture is a whole-tile draw. Requiring the quad to be square
  // rejects the others; bounding the width alone let one undersized rectangle through.
  const at = (index: number): number => m[index] ?? 0
  const scale = Math.max(Math.abs(at(0)), Math.abs(at(5))) || 1
  if (Math.max(Math.abs(at(1)), Math.abs(at(4))) / scale > ROTATION_TOLERANCE) return null
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width < MIN_TILE_SCREEN_WIDTH || width > MAX_TILE_SCREEN_WIDTH) return null
  if (Math.abs(Math.abs(height) - width) > width * SQUARENESS_TOLERANCE) return null
  return { tile, x, y, width, height: Math.abs(height) }
}

let clearTimer: ReturnType<typeof setTimeout> | null = null

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

  if (quads.length > 0) {
    if (clearTimer !== null) {
      clearTimeout(clearTimer)
      clearTimer = null
    }
    emit(quads)
    return
  }

  // No tiles in this frame. Leave the overlay showing what it already has, and only believe the
  // absence if it lasts — see CLEAR_AFTER_TILELESS_MILLISECONDS.
  if (clearTimer === null) {
    clearTimer = setTimeout(() => {
      clearTimer = null
      emit([])
    }, CLEAR_AFTER_TILELESS_MILLISECONDS)
  }
}

/**
 * Notified once per MapLibre frame with every wplace tile drawn in it — including frames that draw
 * none, so a listener can clear rather than leaving a stale overlay behind.
 */
export const onTileFrame = (listener: FrameListener): void => {
  listeners.push(listener)
}

const installFetchTap = (): void => {
  const nativeFetch = window.fetch
  window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const input = args[0]
    const url =
      typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    const match = TILE_URL.exec(url)
    const response = await nativeFetch.apply(this as never, args)
    if (match === null) return response

    // A tap, not a rewrite: the response is handed back untouched. Compositing into wplace's own
    // tiles would make our pixels indistinguishable from theirs, which is exactly what per-colour
    // toggles and view modes need to be able to tell apart.
    try {
      const bytes = (await response.clone().arrayBuffer()).byteLength
      const tile: TileCoord = { x: Number(match[1]), y: Number(match[2]) }
      const queue = tilesByByteLength.get(bytes)
      if (queue === undefined) tilesByByteLength.set(bytes, [tile])
      else queue.push(tile)
    } catch {
      // A body that cannot be read is one we cannot attribute; that tile simply goes undrawn.
    }
    return response
  } as typeof window.fetch
}

const installBitmapTap = (): void => {
  const nativeCreateImageBitmap = window.createImageBitmap
  // biome-ignore lint/suspicious/noExplicitAny: createImageBitmap has two overload shapes
  window.createImageBitmap = (async (...args: any[]) => {
    const bitmap = await (nativeCreateImageBitmap as (...a: unknown[]) => Promise<ImageBitmap>)(
      ...args,
    )
    const source = args[0]
    if (source instanceof Blob) {
      const queue = tilesByByteLength.get(source.size)
      const tile = queue?.shift()
      if (tile !== undefined) {
        tileOfBitmap.set(bitmap, tile)
        if (queue !== undefined && queue.length === 0) tilesByByteLength.delete(source.size)
      }
    }
    return bitmap
  }) as typeof window.createImageBitmap
}

export const install = (): void => {
  installFetchTap()
  installBitmapTap()

  const nativeGetContext = HTMLCanvasElement.prototype.getContext
  let wrapped = false

  // biome-ignore lint/suspicious/noExplicitAny: matching the DOM overload set is not worth it here
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: any[]): any {
    const context = nativeGetContext.apply(this, args as never)
    const type = String(args[0])
    if (wrapped || !type.startsWith('webgl') || context === null) return context
    wrapped = true
    mapCanvas = this

    const gl = context as WebGL2RenderingContext
    const uniformNames = new Map<WebGLUniformLocation, string>()
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
        projection = value
      }
      return nativeUniformMatrix4fv(location, transpose, value, ...rest)
    }) as typeof gl.uniformMatrix4fv

    const nativeBindTexture = gl.bindTexture.bind(gl)
    gl.bindTexture = (target, texture) => {
      boundTexture = texture
      return nativeBindTexture(target, texture)
    }

    const nativeTexImage2D = gl.texImage2D.bind(gl)
    // biome-ignore lint/suspicious/noExplicitAny: texImage2D has ten overloads
    gl.texImage2D = ((...texArgs: any[]) => {
      const source = texArgs[texArgs.length - 1]
      if (boundTexture !== null && source instanceof ImageBitmap) {
        const tile = tileOfBitmap.get(source)
        if (tile !== undefined) tileOfTexture.set(boundTexture, tile)
        // MapLibre pools textures. If one we had attributed is re-uploaded with an image we cannot
        // attribute, the old coordinate is now a lie, and keeping it would draw a template on
        // whatever tile inherited that texture. Forget it instead — a tile we cannot name is a tile
        // we decline to draw on.
        else tileOfTexture.delete(boundTexture)
      }
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
      if (boundTexture === null || projection === null) return
      const tile = tileOfTexture.get(boundTexture)
      if (tile === undefined) return
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
