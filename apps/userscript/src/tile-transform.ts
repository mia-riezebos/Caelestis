/**
 * Where is each wplace tile on screen, right now?
 *
 * MapLibre already knows, and uploads the answer to the GPU every frame. Rather than reimplement
 * the projection — which drifts, and which the URL cannot supply because it does not update during
 * cursor interaction — this reads MapLibre's own matrix back out of the WebGL context.
 *
 * The hook that makes it legible is `getUniformLocation`: it takes the uniform's *name* as a
 * string, so recording those turns `uniformMatrix4fv` from an anonymous sixteen floats into a
 * named `u_projection_matrix`.
 *
 * Everything here must be installed before MapLibre calls `getContext`, so this module has to be
 * imported at `document-start`.
 */

/** MapLibre's tile coordinate extent. Tile-local `(0,0)`..`(EXTENT,EXTENT)` spans one whole tile. */
const MAPLIBRE_TILE_EXTENT = 8192

/** wplace's tiles are the only 1000x1000 textures the map uploads, which is how we spot them. */
const WPLACE_TILE_TEXTURE_SIZE = 1000

export interface TileQuad {
  /** Screen position of the tile's top-left corner, in canvas device pixels. */
  readonly x: number
  readonly y: number
  /** Screen size of the whole tile, in canvas device pixels. Negative if the axis is flipped. */
  readonly width: number
  readonly height: number
}

export interface TileFrame {
  readonly canvas: HTMLCanvasElement
  readonly quads: readonly TileQuad[]
}

type FrameListener = (frame: TileFrame) => void

const listeners: FrameListener[] = []
let mapCanvas: HTMLCanvasElement | null = null
let pending: TileQuad[] = []
let scheduled = false

/** Column-major 4x4, the layout WebGL uses. */
const project = (m: ArrayLike<number>, x: number, y: number): readonly [number, number] => {
  const at = (index: number): number => m[index] ?? 0
  const clipX = at(0) * x + at(4) * y + at(12)
  const clipY = at(1) * x + at(5) * y + at(13)
  const clipW = at(3) * x + at(7) * y + at(15)
  return [clipX / clipW, clipY / clipW]
}

const quadFromMatrix = (m: ArrayLike<number>, canvas: HTMLCanvasElement): TileQuad | null => {
  const [x0, y0] = project(m, 0, 0)
  const [x1, y1] = project(m, MAPLIBRE_TILE_EXTENT, MAPLIBRE_TILE_EXTENT)
  // Clip space is -1..1 with y up; the canvas is 0..size with y down.
  const toScreenX = (clip: number) => (clip * 0.5 + 0.5) * canvas.width
  const toScreenY = (clip: number) => (1 - (clip * 0.5 + 0.5)) * canvas.height
  const left = toScreenX(x0)
  const top = toScreenY(y0)
  const width = toScreenX(x1) - left
  const height = toScreenY(y1) - top
  // A degenerate or absurd quad means we caught a matrix that was not a whole tile's. Requiring
  // the quad to be square filters those out: the first version of this only bounded the width, and
  // a stray non-tile draw put one undersized square on screen.
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (Math.abs(width) < 4 || Math.abs(width) > 1e5) return null
  if (Math.abs(Math.abs(height) - Math.abs(width)) > Math.abs(width) * 0.02) return null
  return { x: left, y: top, width, height }
}

const flush = (): void => {
  scheduled = false
  if (!mapCanvas || pending.length === 0) return
  const frame: TileFrame = { canvas: mapCanvas, quads: pending }
  pending = []
  for (const listener of listeners) listener(frame)
}

/** Notified once per MapLibre frame, with every wplace tile drawn in that frame. */
export const onTileFrame = (listener: FrameListener): void => {
  listeners.push(listener)
}

export const install = (): void => {
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
    const tileTextures = new WeakSet<WebGLTexture>()
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
    gl.texImage2D = ((...args: any[]) => {
      const source = args[args.length - 1]
      if (
        boundTexture !== null &&
        source instanceof ImageBitmap &&
        source.width === WPLACE_TILE_TEXTURE_SIZE &&
        source.height === WPLACE_TILE_TEXTURE_SIZE
      ) {
        tileTextures.add(boundTexture)
      }
      return (nativeTexImage2D as (...a: unknown[]) => void)(...args)
    }) as typeof gl.texImage2D

    const recordDraw = (): void => {
      if (boundTexture === null || projection === null) return
      if (!tileTextures.has(boundTexture)) return
      const quad = quadFromMatrix(projection, this)
      if (quad === null) return
      pending.push(quad)
      if (!scheduled) {
        scheduled = true
        // After MapLibre's frame, not during it: the overlay is a separate canvas, so there is no
        // need to interleave, and drawing mid-frame would fight its GL state.
        requestAnimationFrame(flush)
      }
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
