import { decodeMismatchMask, type MismatchMask, TILE_SIZE, type TileCoord } from '@caelestis/shared'
import { userscriptClientHeaders } from './client-metrics.js'
import { nextPixelObservation, recordPixelObservation } from './pixel-observation.js'
import {
  deleteCachedServerMismatch,
  deleteCachedServerMismatches,
  deleteCachedServerMismatchTile,
  readCachedServerMismatch,
  writeCachedServerMismatch,
} from './server-mismatch-cache.js'
import { serverEndpoint } from './server-url.js'
import {
  activeServerToken,
  type ConnectedServer,
  getState,
  isCurrentServerConnection,
} from './state.js'

const REQUEST_TIMEOUT_MS = 15_000
const RETRY_AFTER_MS = 5_000
const MAX_RESPONSE_BYTES = 12 + Math.ceil((TILE_SIZE * TILE_SIZE) / 4)

interface ServerTemplateRef {
  readonly serverUrl?: string
  readonly serverTemplateId?: string
  readonly serverVersion?: string
}

interface HeldMask {
  readonly server: ConnectedServer
  readonly mask: MismatchMask
  lastUsed: number
}

interface HeldMiss {
  readonly server: ConnectedServer
  readonly at: number
}

const masks = new Map<string, HeldMask>()
const misses = new Map<string, HeldMiss>()
const pending = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
let requestedThisFrame: Set<string> | null = null
let useGeneration = 0
const tileInvalidations = new Map<string, number>()
const serverInvalidations = new Map<string, number>()

const MAX_HELD_MASKS = 512
const MAX_HELD_MASK_BYTES = 16 * 1024 * 1024
const MAX_TILE_INVALIDATIONS = 512

export const serverMismatchMemoryBytes = (): number => {
  let bytes = 0
  for (const held of masks.values()) bytes += held.mask.packed.byteLength + 12
  return bytes
}

const keyFor = (
  server: ConnectedServer,
  templateId: string,
  version: string,
  tile: TileCoord,
): string =>
  `${server.url}\u0000${server.info?.id ?? ''}\u0000${server.season}\u0000${templateId}\u0000${version}\u0000${tile.x}/${tile.y}`

const invalidationKeyFor = (serverUrl: string, tile: TileCoord): string =>
  `${serverUrl}\u0000${tile.x}/${tile.y}`

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

const serverFor = (template: ServerTemplateRef): ConnectedServer | null => {
  if (
    template.serverUrl === undefined ||
    template.serverTemplateId === undefined ||
    template.serverVersion === undefined
  )
    return null
  const server = getState().servers.find((candidate) => candidate.url === template.serverUrl)
  return server?.status === 'connected' && server.season !== null ? server : null
}

const notify = (): void => {
  for (const listener of listeners) listener()
}

const readMask = async (
  server: ConnectedServer,
  templateId: string,
  version: string,
  tile: TileCoord,
  key: string,
): Promise<void> => {
  const token = activeServerToken(server)
  const invalidationKey = invalidationKeyFor(server.url, tile)
  const invalidation = tileInvalidations.get(invalidationKey) ?? 0
  const serverInvalidation = serverInvalidations.get(server.url) ?? 0
  const isCurrent = (): boolean =>
    isCurrentServerConnection(server) &&
    (serverInvalidations.get(server.url) ?? 0) === serverInvalidation &&
    (tileInvalidations.get(invalidationKey) ?? 0) === invalidation
  const requested = nextPixelObservation()
  const request = fetch(
    serverEndpoint(
      server.url,
      `/telemetry/templates/${templateId}/versions/${version}/tiles/${tile.x}/${tile.y}/mismatches?season=${server.season}`,
    ),
    {
      headers:
        token === null
          ? userscriptClientHeaders()
          : { ...userscriptClientHeaders(), authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  ).catch(() => null)
  const cachedBytes = await readCachedServerMismatch(key)
  if (cachedBytes !== null && isCurrent()) {
    const cached = decodeMismatchMask(cachedBytes)
    if (cached === null) void deleteCachedServerMismatch(key)
    else {
      masks.set(key, { server, mask: cached, lastUsed: ++useGeneration })
      notify()
    }
  }

  const response = await request
  if (response === null) {
    if (isCurrent()) misses.set(key, { server, at: Date.now() })
    return
  }
  if (!isCurrent()) {
    await response.body?.cancel().catch(() => undefined)
    return
  }
  if (response.status === 204 || response.status === 404) {
    const changed = masks.delete(key)
    void deleteCachedServerMismatch(key)
    misses.set(key, { server, at: Date.now() })
    if (changed) notify()
    return
  }
  const declaredHeader = response.headers.get('content-length')
  const declared = declaredHeader === null ? null : Number(declaredHeader)
  if (
    !response.ok ||
    (declared !== null &&
      Number.isFinite(declared) &&
      (declared < 1 || declared > MAX_RESPONSE_BYTES))
  ) {
    await response.body?.cancel().catch(() => undefined)
    misses.set(key, { server, at: Date.now() })
    return
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  // A paint can land while a large response body is being consumed. The check above then belongs
  // to the old world; reject that body before it can repopulate memory or enqueue a persisted write.
  if (!isCurrent()) return
  if (bytes.length > MAX_RESPONSE_BYTES) {
    misses.set(key, { server, at: Date.now() })
    return
  }
  const mask = decodeMismatchMask(bytes)
  if (mask === null) {
    misses.set(key, { server, at: Date.now() })
    return
  }
  misses.delete(key)
  recordPixelObservation(mask.packed, requested)
  if (cachedBytes === null || !equalBytes(cachedBytes, bytes))
    void writeCachedServerMismatch(key, bytes)
  masks.set(key, { server, mask, lastUsed: ++useGeneration })
  notify()
}

/** Called around one marker frame so the memory cache can retain a bounded offscreen working set. */
export const beginServerMismatchFrame = (): void => {
  requestedThisFrame = new Set()
}

export const endServerMismatchFrame = (): void => {
  const requested = requestedThisFrame
  requestedThisFrame = null
  if (requested === null) return
  let bytes = serverMismatchMemoryBytes()
  const offscreen = [...masks]
    .filter(([key]) => !requested.has(key))
    .sort((left, right) => left[1].lastUsed - right[1].lastUsed)
  for (const [key, held] of offscreen) {
    if (masks.size <= MAX_HELD_MASKS && bytes <= MAX_HELD_MASK_BYTES) break
    masks.delete(key)
    bytes -= held.mask.packed.byteLength + 12
  }
  for (const key of [...misses.keys()]) if (!requested.has(key)) misses.delete(key)
}

/** Latest server classification for one visible template tile. Null starts or awaits the read. */
export const serverMismatchMaskFor = (
  template: ServerTemplateRef,
  tile: TileCoord,
): MismatchMask | null => {
  const server = serverFor(template)
  if (
    server === null ||
    template.serverTemplateId === undefined ||
    template.serverVersion === undefined
  )
    return null
  const key = keyFor(server, template.serverTemplateId, template.serverVersion, tile)
  const invalidationKey = invalidationKeyFor(server.url, tile)
  requestedThisFrame?.add(key)
  const held = masks.get(key)
  if (held !== undefined && isCurrentServerConnection(held.server)) {
    held.lastUsed = ++useGeneration
    return held.mask
  }
  const miss = misses.get(key)
  if (
    pending.has(key) ||
    (miss !== undefined &&
      isCurrentServerConnection(miss.server) &&
      Date.now() - miss.at < RETRY_AFTER_MS)
  )
    return null
  const tileInvalidation = tileInvalidations.get(invalidationKey) ?? 0
  const serverInvalidation = serverInvalidations.get(server.url) ?? 0
  const request = readMask(
    server,
    template.serverTemplateId,
    template.serverVersion,
    tile,
    key,
  ).finally(() => {
    if (pending.get(key) !== request) return
    pending.delete(key)
    if (
      (tileInvalidations.get(invalidationKey) ?? 0) !== tileInvalidation ||
      (serverInvalidations.get(server.url) ?? 0) !== serverInvalidation
    )
      notify()
  })
  pending.set(key, request)
  return null
}

/** A successful tile upload makes every mask for that server tile stale. */
export const invalidateServerMismatchTile = (serverUrl: string, tile: TileCoord): void => {
  const invalidationKey = invalidationKeyFor(serverUrl, tile)
  const generation = (tileInvalidations.get(invalidationKey) ?? 0) + 1
  tileInvalidations.delete(invalidationKey)
  tileInvalidations.set(invalidationKey, generation)
  while (tileInvalidations.size > MAX_TILE_INVALIDATIONS) {
    let removed = false
    for (const candidate of tileInvalidations.keys()) {
      const separator = candidate.lastIndexOf('\u0000')
      const pendingPrefix = `${candidate.slice(0, separator)}\u0000`
      const pendingSuffix = `\u0000${candidate.slice(separator + 1)}`
      let hasPending = false
      for (const key of pending.keys()) {
        if (!key.startsWith(pendingPrefix) || !key.endsWith(pendingSuffix)) continue
        hasPending = true
        break
      }
      if (hasPending) continue
      tileInvalidations.delete(candidate)
      removed = true
      break
    }
    if (!removed) break
  }
  const prefix = `${serverUrl}\u0000`
  const suffix = `\u0000${tile.x}/${tile.y}`
  let changed = false
  for (const key of [...masks.keys()]) {
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
    masks.delete(key)
    changed = true
  }
  for (const key of [...misses.keys()]) {
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
    misses.delete(key)
    changed = true
  }
  void deleteCachedServerMismatchTile(serverUrl, tile)
  if (changed) notify()
}

/** A missed status revision can cover any tile, so discard every derived mask for that server. */
export const invalidateServerMismatches = (serverUrl: string): void => {
  serverInvalidations.set(serverUrl, (serverInvalidations.get(serverUrl) ?? 0) + 1)
  const prefix = `${serverUrl}\u0000`
  let changed = false
  for (const key of [...masks.keys()]) {
    if (!key.startsWith(prefix)) continue
    masks.delete(key)
    changed = true
  }
  for (const key of [...misses.keys()]) {
    if (!key.startsWith(prefix)) continue
    misses.delete(key)
    changed = true
  }
  void deleteCachedServerMismatches(serverUrl)
  if (changed) notify()
}

export const onServerMismatchesChanged = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
