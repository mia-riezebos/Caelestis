import { decodeMismatchMask, type MismatchMask, TILE_SIZE, type TileCoord } from '@caelestis/shared'
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
}

interface HeldMiss {
  readonly server: ConnectedServer
  readonly at: number
}

const masks = new Map<string, HeldMask>()
const misses = new Map<string, HeldMiss>()
const pending = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
const tileInvalidationListeners = new Set<(serverUrl: string, tile: TileCoord) => void>()
let requestedThisFrame: Set<string> | null = null

const keyFor = (
  server: ConnectedServer,
  templateId: string,
  version: string,
  tile: TileCoord,
): string => `${server.url}\u0000${templateId}\u0000${version}\u0000${tile.x}/${tile.y}`

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
  let response: Response
  try {
    response = await fetch(
      serverEndpoint(
        server.url,
        `/telemetry/templates/${templateId}/versions/${version}/tiles/${tile.x}/${tile.y}/mismatches?season=${server.season}`,
      ),
      {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    )
  } catch {
    misses.set(key, { server, at: Date.now() })
    return
  }
  if (!isCurrentServerConnection(server)) return
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
  masks.set(key, { server, mask })
  notify()
}

/** Called around one marker frame so offscreen server masks do not accumulate. */
export const beginServerMismatchFrame = (): void => {
  requestedThisFrame = new Set()
}

export const endServerMismatchFrame = (): void => {
  const requested = requestedThisFrame
  requestedThisFrame = null
  if (requested === null) return
  for (const key of [...masks.keys()]) if (!requested.has(key)) masks.delete(key)
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
  requestedThisFrame?.add(key)
  const held = masks.get(key)
  if (held !== undefined && isCurrentServerConnection(held.server)) return held.mask
  const miss = misses.get(key)
  if (
    pending.has(key) ||
    (miss !== undefined &&
      isCurrentServerConnection(miss.server) &&
      Date.now() - miss.at < RETRY_AFTER_MS)
  )
    return null
  const request = readMask(
    server,
    template.serverTemplateId,
    template.serverVersion,
    tile,
    key,
  ).finally(() => {
    if (pending.get(key) === request) pending.delete(key)
  })
  pending.set(key, request)
  return null
}

/** A successful tile upload makes every mask for that server tile stale. */
export const invalidateServerMismatchTile = (serverUrl: string, tile: TileCoord): void => {
  const prefix = `${serverUrl}\u0000`
  const suffix = `\u0000${tile.x}/${tile.y}`
  let changed = false
  for (const key of [...masks.keys()]) {
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
    masks.delete(key)
    changed = true
  }
  for (const key of [...misses.keys()]) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) misses.delete(key)
  }
  for (const listener of tileInvalidationListeners) listener(serverUrl, tile)
  if (changed) notify()
}

/** A successful tile upload makes a subsequent server mask authoritative again. */
export const onServerMismatchTileInvalidated = (
  listener: (serverUrl: string, tile: TileCoord) => void,
): (() => void) => {
  tileInvalidationListeners.add(listener)
  return () => tileInvalidationListeners.delete(listener)
}

export const onServerMismatchesChanged = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
