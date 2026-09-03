import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import type { NativePixelRegion } from '../native-pixels.js'
import { pageWindow } from '../page-world.js'

export interface HeadquartersPixelGeometry {
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
}

const SNAPSHOT_HEADER_BYTES = 19
const CHANGED_TILE_HEADER_BYTES = 12
const REMOVED_TILE_BYTES = 4
const SNAPSHOT_TYPE = 'application/x-wplace-alliance-hq-snapshot'
const SNAPSHOT_MAGIC = 'WHQS1'
const MAX_SIDE = 2_000

interface TileVersion {
  readonly x: number
  readonly y: number
  readonly version: number
}

interface DecodedTile extends TileVersion {
  readonly pixels: Uint8Array
}

interface DecodedSnapshot {
  readonly tileSize: number
  readonly changed: readonly DecodedTile[]
  readonly removed: readonly { readonly x: number; readonly y: number }[]
}

interface RetainedPixels {
  readonly allianceId: number
  readonly geometry: HeadquartersPixelGeometry
  readonly pixels: Uint8Array
  readonly versions: Map<string, TileVersion>
  tileSize: number | null
  loaded: boolean
  pending: Promise<void> | null
}

let retained: RetainedPixels | null = null
const listeners = new Set<() => void>()

const sameGeometry = (left: HeadquartersPixelGeometry, right: HeadquartersPixelGeometry): boolean =>
  left.originX === right.originX &&
  left.originY === right.originY &&
  left.width === right.width &&
  left.height === right.height

const tileKey = (x: number, y: number): string => `${x}/${y}`

const cacheFor = (allianceId: number, geometry: HeadquartersPixelGeometry): RetainedPixels => {
  if (retained?.allianceId === allianceId && sameGeometry(retained.geometry, geometry))
    return retained
  retained = {
    allianceId,
    geometry: { ...geometry },
    pixels: new Uint8Array(geometry.width * geometry.height).fill(TRANSPARENT_INDEX),
    versions: new Map(),
    tileSize: null,
    loaded: false,
    pending: null,
  }
  return retained
}

const decode = (buffer: ArrayBuffer): DecodedSnapshot => {
  if (buffer.byteLength < SNAPSHOT_HEADER_BYTES) throw new Error('truncated HQ snapshot')
  const bytes = new Uint8Array(buffer)
  if (String.fromCharCode(...bytes.subarray(0, SNAPSHOT_MAGIC.length)) !== SNAPSHOT_MAGIC)
    throw new Error('invalid HQ snapshot magic')
  const view = new DataView(buffer)
  const tileSize = view.getUint16(5, true)
  if (tileSize <= 0 || tileSize > MAX_SIDE) throw new Error('invalid HQ snapshot tile size')
  const changedCount = view.getUint16(15, true)
  const removedCount = view.getUint16(17, true)
  const tilePixels = tileSize * tileSize
  const expectedBytes =
    SNAPSHOT_HEADER_BYTES +
    changedCount * (CHANGED_TILE_HEADER_BYTES + tilePixels) +
    removedCount * REMOVED_TILE_BYTES
  if (buffer.byteLength !== expectedBytes) throw new Error('invalid HQ snapshot length')
  const changed: DecodedTile[] = []
  let at = SNAPSHOT_HEADER_BYTES
  for (let index = 0; index < changedCount; index++) {
    const x = view.getInt16(at, true)
    const y = view.getInt16(at + 2, true)
    const version = Number(view.getBigInt64(at + 4, true))
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('invalid HQ tile version')
    const raw = bytes.subarray(
      at + CHANGED_TILE_HEADER_BYTES,
      at + CHANGED_TILE_HEADER_BYTES + tilePixels,
    )
    const pixels = new Uint8Array(tilePixels)
    for (let pixel = 0; pixel < raw.length; pixel++) {
      const nativeIndex = raw[pixel] ?? 0
      if (nativeIndex > WPLACE_PALETTE.length) throw new Error('invalid HQ palette index')
      pixels[pixel] = nativeIndex === 0 ? TRANSPARENT_INDEX : nativeIndex - 1
    }
    changed.push({ x, y, version, pixels })
    at += CHANGED_TILE_HEADER_BYTES + tilePixels
  }
  const removed: Array<{ readonly x: number; readonly y: number }> = []
  for (let index = 0; index < removedCount; index++) {
    removed.push({ x: view.getInt16(at, true), y: view.getInt16(at + 2, true) })
    at += REMOVED_TILE_BYTES
  }
  return { tileSize, changed, removed }
}

const writeTile = (
  cache: RetainedPixels,
  tileSize: number,
  tileX: number,
  tileY: number,
  pixels: Uint8Array | null,
): void => {
  const startX = Math.max(cache.geometry.originX, tileX * tileSize)
  const startY = Math.max(cache.geometry.originY, tileY * tileSize)
  const farX = Math.min(cache.geometry.originX + cache.geometry.width, (tileX + 1) * tileSize)
  const farY = Math.min(cache.geometry.originY + cache.geometry.height, (tileY + 1) * tileSize)
  if (farX <= startX || farY <= startY) return
  for (let y = startY; y < farY; y++) {
    const sourceAt = (y - tileY * tileSize) * tileSize + startX - tileX * tileSize
    const targetAt =
      (y - cache.geometry.originY) * cache.geometry.width + startX - cache.geometry.originX
    if (pixels === null) {
      cache.pixels.fill(TRANSPARENT_INDEX, targetAt, targetAt + farX - startX)
    } else {
      cache.pixels.set(pixels.subarray(sourceAt, sourceAt + farX - startX), targetAt)
    }
  }
}

const apply = (cache: RetainedPixels, snapshot: DecodedSnapshot): void => {
  if (cache.tileSize !== null && cache.tileSize !== snapshot.tileSize) {
    cache.pixels.fill(TRANSPARENT_INDEX)
    cache.versions.clear()
  }
  cache.tileSize = snapshot.tileSize
  for (const tile of snapshot.changed) {
    writeTile(cache, snapshot.tileSize, tile.x, tile.y, tile.pixels)
    cache.versions.set(tileKey(tile.x, tile.y), {
      x: tile.x,
      y: tile.y,
      version: tile.version,
    })
  }
  for (const tile of snapshot.removed) {
    writeTile(cache, snapshot.tileSize, tile.x, tile.y, null)
    cache.versions.delete(tileKey(tile.x, tile.y))
  }
  cache.loaded = true
}

/** Notify progress, marker, and palette consumers when the complete HQ snapshot changes. */
export const onHeadquartersPixelsChange = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Load or update one alliance's complete bounded headquarters canvas. */
export const refreshHeadquartersPixels = async (
  allianceId: number,
  geometry: HeadquartersPixelGeometry,
): Promise<void> => {
  if (
    geometry.width <= 0 ||
    geometry.height <= 0 ||
    geometry.width > MAX_SIDE ||
    geometry.height > MAX_SIDE
  )
    return
  const cache = cacheFor(allianceId, geometry)
  if (cache.pending !== null) return cache.pending
  const knownTiles = [...cache.versions.values()]
  const pending = (async () => {
    try {
      const response = await pageWindow().fetch(
        `https://backend.wplace.live/alliances/${allianceId}/headquarters/snapshot`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            minX: geometry.originX,
            minY: geometry.originY,
            maxX: geometry.originX + geometry.width - 1,
            maxY: geometry.originY + geometry.height - 1,
            knownTiles,
          }),
        },
      )
      if (!response.ok || !response.headers.get('content-type')?.startsWith(SNAPSHOT_TYPE)) return
      const snapshot = decode(await response.arrayBuffer())
      if (retained !== cache) return
      apply(cache, snapshot)
      for (const listener of listeners) listener()
    } catch {
      // Sparse native canvases remain the truthful fallback until a later editor mount retries.
    }
  })()
  cache.pending = pending
  await pending
  if (cache.pending === pending) cache.pending = null
}

/** Merge mounted native tiles into the retained full canvas and return that complete region. */
export const headquartersPixels = (
  allianceId: number,
  geometry: HeadquartersPixelGeometry,
  visible: readonly NativePixelRegion[],
): NativePixelRegion[] | null => {
  const cache = retained
  if (
    cache === null ||
    !cache.loaded ||
    cache.allianceId !== allianceId ||
    !sameGeometry(cache.geometry, geometry)
  )
    return null
  for (const region of visible) {
    const startX = Math.max(geometry.originX, region.x)
    const startY = Math.max(geometry.originY, region.y)
    const farX = Math.min(geometry.originX + geometry.width, region.x + region.width)
    const farY = Math.min(geometry.originY + geometry.height, region.y + region.height)
    for (let y = startY; y < farY; y++) {
      const sourceAt = (y - region.y) * region.width + startX - region.x
      const targetAt = (y - geometry.originY) * geometry.width + startX - geometry.originX
      cache.pixels.set(region.pixels.subarray(sourceAt, sourceAt + farX - startX), targetAt)
    }
  }
  return [
    {
      x: geometry.originX,
      y: geometry.originY,
      width: geometry.width,
      height: geometry.height,
      pixels: cache.pixels,
      emptyIndex: TRANSPARENT_INDEX,
    },
  ]
}

/** Test-only reset for the retained headquarters snapshot. */
export const resetHeadquartersPixelCache = (): void => {
  retained = null
  listeners.clear()
}
