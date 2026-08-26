import { TILE_SIZE, type TileCoord } from '@caelestis/shared'

const CACHE_NAME = 'caelestis-server-mismatches-v1'
const CACHE_PATH = '/__caelestis-cache/server-mismatch/'
const MAX_ENTRIES = 512
const MAX_RESPONSE_BYTES = 12 + Math.ceil((TILE_SIZE * TILE_SIZE) / 4)
const PRUNE_EVERY_WRITES = 16

let writesUntilPrune = PRUNE_EVERY_WRITES

const open = async (): Promise<Cache | null> => {
  try {
    return globalThis.caches === undefined ? null : await globalThis.caches.open(CACHE_NAME)
  } catch {
    return null
  }
}

const requestFor = (key: string): Request =>
  new Request(`${location.origin}${CACHE_PATH}${encodeURIComponent(key)}`)

const keyFrom = (request: Request): string | null => {
  try {
    const path = new URL(request.url).pathname
    if (!path.startsWith(CACHE_PATH)) return null
    return decodeURIComponent(path.slice(CACHE_PATH.length))
  } catch {
    return null
  }
}

const prune = async (cache: Cache): Promise<void> => {
  const requests = await cache.keys()
  const remove = Math.max(0, requests.length - MAX_ENTRIES)
  await Promise.all(requests.slice(0, remove).map((request) => cache.delete(request)))
}

/** A stale mask is enough to draw immediately; the caller still refreshes it from the server. */
export const readCachedServerMismatch = async (key: string): Promise<Uint8Array | null> => {
  const cache = await open()
  if (cache === null) return null
  try {
    const response = await cache.match(requestFor(key))
    if (response === undefined) return null
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.length > 0 && bytes.length <= MAX_RESPONSE_BYTES ? bytes : null
  } catch {
    return null
  }
}

export const writeCachedServerMismatch = async (key: string, bytes: Uint8Array): Promise<void> => {
  if (bytes.length === 0 || bytes.length > MAX_RESPONSE_BYTES) return
  const cache = await open()
  if (cache === null) return
  try {
    const request = requestFor(key)
    // Refresh insertion order so the bounded cache behaves as an LRU across page loads.
    await cache.delete(request)
    await cache.put(
      request,
      new Response(bytes.slice().buffer as ArrayBuffer, {
        headers: { 'content-type': 'application/vnd.caelestis.mismatch-mask' },
      }),
    )
    writesUntilPrune--
    if (writesUntilPrune <= 0) {
      writesUntilPrune = PRUNE_EVERY_WRITES
      await prune(cache)
    }
  } catch {}
}

export const deleteCachedServerMismatch = async (key: string): Promise<void> => {
  const cache = await open()
  if (cache === null) return
  try {
    await cache.delete(requestFor(key))
  } catch {}
}

export const deleteCachedServerMismatchTile = async (
  serverUrl: string,
  tile: TileCoord,
): Promise<void> => {
  const cache = await open()
  if (cache === null) return
  const prefix = `${serverUrl}\u0000`
  const suffix = `\u0000${tile.x}/${tile.y}`
  try {
    const requests = await cache.keys()
    await Promise.all(
      requests.map((request) => {
        const key = keyFrom(request)
        return key?.startsWith(prefix) && key.endsWith(suffix) ? cache.delete(request) : false
      }),
    )
  } catch {}
}
