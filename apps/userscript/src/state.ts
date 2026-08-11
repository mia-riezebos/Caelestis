import { PALETTE_SIZE, TILE_SIZE, WORLD_PIXELS, WORLD_TILES } from '@wts/shared'
import { log, warn } from './debug.js'
import { discardResponseBody } from './response.js'
import { DEFAULT_SORT, type SortOrder } from './ui/sort.js'

/**
 * Everything the panel remembers between sessions.
 *
 * Stored through the userscript manager when it is there, and `localStorage` when it is not — which
 * is the case under the CDP dev harness, and for a `@grant none` build.
 *
 * **Access tokens are a known weak point.** `localStorage` on wplace.live is readable by wplace's
 * own scripts and by every other userscript on the page. `GM_setValue` is not, which is the whole
 * reason the metadata block asks for it. Treat the fallback as a development convenience and not as
 * somewhere a real alliance token belongs — see the note in `handoff-userscript-browser.md`.
 */

const STORAGE_KEY = 'caelestis.state.v1'

export type ServerAuthMode = 'none' | 'access_token'

export interface ServerInfo {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly auth: ServerAuthMode
}

export interface ConnectedServer {
  /** Origin as the user typed it, normalised — the identity of the connection. */
  readonly url: string
  readonly info: ServerInfo | null
  readonly token: string | null
  readonly status: 'connected' | 'needs-token' | 'unreachable'
  readonly error?: string
  /**
   * Whether our code can administer this server.
   *
   * Nothing in `GET /server` reports scope, so this is established by calling an admin endpoint and
   * seeing what comes back. It gates the create and import controls: offering them to someone who
   * will only ever get a 403 is worse than not offering them.
   */
  readonly isAdmin: boolean
  /** Non-negative season advertised by the validated manifest. */
  readonly season: number | null
  /** Last manifest identity proven for this URL, retained only to validate render-only cache data. */
  readonly lastVerified?: {
    readonly serverId: string
    readonly season: number
  } | null
}

export interface TreeNode {
  readonly id: string
  readonly parentId: string | null
  readonly path: string
  readonly name: string
  readonly createdAt: number
}

export type ProgressPlacement = 'inline' | 'expanded' | 'hidden'
export type ColourPreset = 'all' | 'free' | 'premium' | 'owned'

export interface State {
  readonly servers: readonly ConnectedServer[]
  /** Row keys in the user's own order. Keys absent from this list sort after those present. */
  readonly customOrder: readonly string[]
  /** Containers the user explicitly collapsed. Search may reveal them without changing this. */
  readonly collapsed: readonly string[]
  /** Panel width in pixels, dragged by the handle on its left edge. */
  readonly panelWidth: number
  readonly sort: SortOrder
  readonly progress: ProgressPlacement
  /** Palette indices deliberately hidden. Empty means every colour draws. */
  readonly hiddenColours: readonly number[]
  readonly reportPaints: boolean
  readonly shareTiles: boolean
}

const DEFAULT_STATE: State = {
  servers: [],
  customOrder: [],
  collapsed: [],
  panelWidth: 320,
  sort: DEFAULT_SORT,
  progress: 'inline',
  hiddenColours: [],
  reportPaints: false,
  shareTiles: false,
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const NODE_PATH = /^(\/[\p{L}\p{N}][\p{L}\p{N}\p{M}. -]*)+$/u
export const MAX_TREE_NODES = 100_000
const MAX_MANIFEST_TEMPLATES = 100_000
const MAX_MANIFEST_CHUNKS = 200_000
const MAX_MANIFEST_TILES = WORLD_TILES * WORLD_TILES
const MAX_CUSTOM_ORDER = 200_000
const MIN_EPOCH_MILLISECONDS = 1_577_836_800_000 // 2020-01-01
const MAX_EPOCH_MILLISECONDS = 4_102_444_800_000 // 2100-01-01
export const MAX_CONNECTED_SERVERS = 32
const SERVER_REFRESH_CONCURRENCY = 4
const REMOTE_TIMEOUT_MS = 10_000
const LARGE_TRANSFER_TIMEOUT_MS = 120_000
const SERVER_JSON_BYTES = 16 * 1024
const TREE_JSON_BYTES = 64 * 1024 * 1024
const MUTATION_JSON_BYTES = 64 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const plausibleMillis = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= MIN_EPOCH_MILLISECONDS &&
  value < MAX_EPOCH_MILLISECONDS

const readBoundedJson = async (response: Response, maxBytes: number): Promise<unknown> => {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardResponseBody(response)
    throw new RangeError(`response exceeds ${maxBytes} bytes`)
  }
  if (response.body === null) return null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw new RangeError(`response exceeds ${maxBytes} bytes`)
      }
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  return text === '' ? null : JSON.parse(text)
}

const remoteJson = async (
  input: string,
  init: RequestInit = {},
  maxBytes = MUTATION_JSON_BYTES,
  timeoutMs = REMOTE_TIMEOUT_MS,
): Promise<{ response: Response; body: unknown }> => {
  const controller = new AbortController()
  const external = init.signal
  const forwardAbort = (): void => controller.abort(external?.reason)
  if (external?.aborted) forwardAbort()
  else external?.addEventListener('abort', forwardAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs)
  try {
    const response = await fetch(input, { ...init, signal: controller.signal })
    return { response, body: await readBoundedJson(response, maxBytes) }
  } finally {
    clearTimeout(timeout)
    external?.removeEventListener('abort', forwardAbort)
  }
}

const serverInfoFrom = (value: unknown): ServerInfo | null => {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || !UUID_V7.test(value.id)) return null
  if (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 256)
    return null
  if (value.auth !== 'none' && value.auth !== 'access_token') return null
  if (
    value.description !== undefined &&
    (typeof value.description !== 'string' ||
      value.description.length < 1 ||
      value.description.length > 4_096)
  )
    return null
  return {
    id: value.id,
    name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    auth: value.auth,
  }
}

export const canonicalServerUrl = (value: string): string => {
  const parsed = new URL(value.trim())
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('server URL must use HTTP or HTTPS')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('server URL must not contain credentials')
  }
  parsed.search = ''
  parsed.hash = ''
  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${path}`
}

const treeNodeFrom = (raw: unknown): TreeNode | null => {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !UUID_V7.test(raw.id)) return null
  if (raw.parentId !== null && (typeof raw.parentId !== 'string' || !UUID_V7.test(raw.parentId))) {
    return null
  }
  if (
    typeof raw.path !== 'string' ||
    raw.path.length < 1 ||
    raw.path.length > 256 ||
    !NODE_PATH.test(raw.path)
  )
    return null
  if (typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > 256) return null
  if (!plausibleMillis(raw.createdAt)) return null
  return {
    id: raw.id,
    parentId: raw.parentId,
    path: raw.path,
    name: raw.name,
    createdAt: raw.createdAt,
  }
}

const treeNodesFrom = (value: unknown): readonly TreeNode[] | null => {
  if (!Array.isArray(value) || value.length > MAX_TREE_NODES) return null
  const nodes: TreeNode[] = []
  const ids = new Set<string>()
  for (const raw of value) {
    const node = treeNodeFrom(raw)
    if (node === null || ids.has(node.id)) return null
    ids.add(node.id)
    nodes.push(node)
  }
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const foldPath = (path: string): string =>
    path.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const foldedPaths = nodes.map((node) => foldPath(node.path))
  if (new Set(foldedPaths).size !== foldedPaths.length) return null
  const validated = new Set<string>()
  for (const node of nodes) {
    if (node.parentId === null) {
      if (node.path.indexOf('/', 1) !== -1) return null
    } else {
      const parent = byId.get(node.parentId)
      if (parent === undefined) return null
      const path = foldPath(node.path)
      const parentPath = foldPath(parent.path)
      if (!path.startsWith(parentPath)) return null
      const suffix = path.slice(parentPath.length)
      if (!suffix.startsWith('/') || suffix.indexOf('/', 1) !== -1) return null
    }
    if (validated.has(node.id)) continue
    const path = new Set<string>()
    let cursor: TreeNode | undefined = node
    while (cursor !== undefined && !validated.has(cursor.id)) {
      if (path.has(cursor.id)) return null
      path.add(cursor.id)
      if (cursor.parentId !== null && !byId.has(cursor.parentId)) return null
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
    }
    for (const id of path) validated.add(id)
  }
  return nodes
}

export const validateTreeNodes = (value: unknown): readonly TreeNode[] | null =>
  treeNodesFrom(value)

const manifestTileKey = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const match = /^(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(value)
  if (match === null) return false
  return Number(match[1]) < WORLD_TILES && Number(match[2]) < WORLD_TILES
}

type ManifestBbox = {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

const manifestXSpans = (bbox: ManifestBbox): ReadonlyArray<{ start: number; end: number }> =>
  bbox.minX < bbox.maxX
    ? [{ start: bbox.minX, end: bbox.maxX }]
    : [
        { start: bbox.minX, end: WORLD_PIXELS },
        { start: 0, end: bbox.maxX },
      ]

const tileCoordinates = (tile: string): { x: number; y: number } => {
  const separator = tile.indexOf('/')
  return { x: Number(tile.slice(0, separator)), y: Number(tile.slice(separator + 1)) }
}

const chunkIntersectionArea = (tile: string, bbox: ManifestBbox): number => {
  const { x, y } = tileCoordinates(tile)
  const tileMinX = x * TILE_SIZE
  const tileMinY = y * TILE_SIZE
  const height = Math.min(tileMinY + TILE_SIZE, bbox.maxY) - Math.max(tileMinY, bbox.minY)
  if (height <= 0) return 0
  const width = manifestXSpans(bbox).reduce(
    (total, span) =>
      total +
      Math.max(0, Math.min(tileMinX + TILE_SIZE, span.end) - Math.max(tileMinX, span.start)),
    0,
  )
  return width * height
}

/**
 * Validate the manifest payload before calling a connection verified.
 *
 * The userscript deliberately keeps Effect out of its browser bundle, so this mirrors the wire
 * boundary with the limits and relationships that protect its later tree/render consumers.
 */
const manifestContentsValid = (
  value: Record<string, unknown>,
  nodes: readonly TreeNode[],
): boolean => {
  const rawNodes = value.nodes as readonly unknown[]
  if (
    rawNodes.some(
      (raw) =>
        !isRecord(raw) ||
        !plausibleMillis(raw.createdAt) ||
        (raw.description !== undefined &&
          (typeof raw.description !== 'string' ||
            raw.description.length < 1 ||
            raw.description.length > 4_096)),
    )
  ) {
    return false
  }

  if (
    !Array.isArray(value.tiles) ||
    value.tiles.length > MAX_MANIFEST_TILES ||
    value.tiles.length > MAX_MANIFEST_CHUNKS
  )
    return false
  const declaredTiles = new Set<string>()
  for (const tile of value.tiles) {
    if (!manifestTileKey(tile) || declaredTiles.has(tile)) return false
    declaredTiles.add(tile)
  }

  if (!Array.isArray(value.templates) || value.templates.length > MAX_MANIFEST_TEMPLATES) {
    return false
  }
  const nodeIds = new Set(nodes.map((node) => node.id))
  const templateIds = new Set<string>()
  const referencedTiles = new Set<string>()
  let chunks = 0
  for (const raw of value.templates) {
    if (!isRecord(raw)) return false
    if (typeof raw.id !== 'string' || !UUID_V7.test(raw.id) || templateIds.has(raw.id)) return false
    templateIds.add(raw.id)
    if (typeof raw.nodeId !== 'string' || !nodeIds.has(raw.nodeId)) return false
    if (typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > 256) return false
    if (typeof raw.version !== 'string' || !UUID_V7.test(raw.version)) return false
    if (!Number.isSafeInteger(raw.totalPixels) || Number(raw.totalPixels) <= 0) return false
    if (typeof raw.published !== 'boolean' || !plausibleMillis(raw.createdAt)) return false
    if (!isRecord(raw.bbox)) return false
    const { minX, minY, maxX, maxY } = raw.bbox
    if (
      ![minX, minY, maxX, maxY].every(Number.isSafeInteger) ||
      Number(minX) < 0 ||
      Number(minX) >= WORLD_PIXELS ||
      Number(maxX) < 1 ||
      Number(maxX) > WORLD_PIXELS ||
      Number(minX) === Number(maxX) ||
      Number(minY) < 0 ||
      Number(minY) >= WORLD_PIXELS ||
      Number(maxY) < 1 ||
      Number(maxY) > WORLD_PIXELS ||
      Number(minY) >= Number(maxY)
    ) {
      return false
    }
    if (!Array.isArray(raw.chunks) || raw.chunks.length === 0) return false
    chunks += raw.chunks.length
    if (chunks > MAX_MANIFEST_CHUNKS) return false
    const ownTiles = new Set<string>()
    let capacity = 0
    const bbox = {
      minX: Number(minX),
      minY: Number(minY),
      maxX: Number(maxX),
      maxY: Number(maxY),
    }
    for (const chunk of raw.chunks) {
      if (
        !isRecord(chunk) ||
        !manifestTileKey(chunk.tile) ||
        typeof chunk.hash !== 'string' ||
        !SHA256_HEX.test(chunk.hash) ||
        ownTiles.has(chunk.tile)
      ) {
        return false
      }
      const intersection = chunkIntersectionArea(chunk.tile, bbox)
      if (intersection === 0) return false
      capacity += intersection
      ownTiles.add(chunk.tile)
      referencedTiles.add(chunk.tile)
    }
    if (Number(raw.totalPixels) > capacity) return false
  }
  return (
    referencedTiles.size === declaredTiles.size &&
    [...referencedTiles].every((tile) => declaredTiles.has(tile))
  )
}

const manifestProbeFrom = (
  value: unknown,
  expected: ServerInfo,
): { season: number; server: ServerInfo; nodes: readonly TreeNode[] } | null => {
  if (
    !isRecord(value) ||
    typeof value.version !== 'string' ||
    value.version.length < 1 ||
    value.version.length > 64
  )
    return null
  if (!Number.isSafeInteger(value.season) || Number(value.season) < 0) return null
  const server = serverInfoFrom(value.server)
  if (server === null || server.id !== expected.id) return null
  const nodes = treeNodesFrom(value.nodes)
  if (nodes === null || !manifestContentsValid(value, nodes)) return null
  return { season: Number(value.season), server, nodes }
}

// biome-ignore lint/suspicious/noExplicitAny: the GM_* API only exists under a userscript manager
const gm = globalThis as any

const readRaw = (): string | null => {
  try {
    if (typeof gm.GM_getValue === 'function') return gm.GM_getValue(STORAGE_KEY, null)
    return localStorage.getItem(STORAGE_KEY)
  } catch (error) {
    warn('install', 'could not read stored state', String(error))
    return null
  }
}

const writeRaw = (value: string): void => {
  try {
    if (typeof gm.GM_setValue === 'function') gm.GM_setValue(STORAGE_KEY, value)
    else localStorage.setItem(STORAGE_KEY, value)
  } catch (error) {
    warn('install', 'could not persist state', String(error))
  }
}

let state: State = DEFAULT_STATE
const listeners: Array<(next: State) => void> = []

const notifyStateListeners = (): void => {
  for (const listener of listeners) {
    try {
      listener(state)
    } catch (error) {
      try {
        warn('install', 'state observer failed', String(error))
      } catch {
        // An observer must never turn an already-applied state change into a reported failure.
      }
    }
  }
}

export const loadState = (): State => {
  const raw = readRaw()
  if (raw === null) return state
  try {
    // Spread over the defaults rather than trusting the stored shape: a build that adds a field
    // must not be broken by state written before it existed.
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) throw new TypeError('stored state is not an object')
    const stored = parsed as Partial<State>
    const servers: ConnectedServer[] = []
    const seenServers = new Set<string>()
    if (Array.isArray(stored.servers)) {
      for (const candidate of stored.servers) {
        if (!isRecord(candidate) || typeof candidate.url !== 'string') continue
        let url: string
        try {
          url = canonicalServerUrl(candidate.url)
        } catch {
          continue
        }
        if (seenServers.has(url)) continue
        seenServers.add(url)
        const info = serverInfoFrom(candidate.info)
        const storedSeason =
          Number.isSafeInteger(candidate.season) && Number(candidate.season) >= 0
            ? Number(candidate.season)
            : null
        const storedIdentity = isRecord(candidate.lastVerified) ? candidate.lastVerified : null
        const lastVerified =
          typeof storedIdentity?.serverId === 'string' &&
          storedIdentity.serverId === info?.id &&
          Number.isSafeInteger(storedIdentity.season) &&
          Number(storedIdentity.season) >= 0
            ? {
                serverId: storedIdentity.serverId,
                season: Number(storedIdentity.season),
              }
            : info !== null && storedSeason !== null
              ? { serverId: info.id, season: storedSeason }
              : null
        servers.push({
          url,
          info,
          token: typeof candidate.token === 'string' ? candidate.token : null,
          status: 'unreachable',
          error: 'Checking connection…',
          isAdmin: false,
          season: null,
          lastVerified,
        })
        if (servers.length >= MAX_CONNECTED_SERVERS) break
      }
    }
    const customOrder = Array.isArray(stored.customOrder)
      ? [
          ...new Set(
            stored.customOrder.filter(
              (key): key is string =>
                typeof key === 'string' && !(key.startsWith('node:') && UUID_V7.test(key.slice(5))),
            ),
          ),
        ].slice(0, MAX_CUSTOM_ORDER)
      : []
    const collapsed = Array.isArray(stored.collapsed)
      ? [
          ...new Set(stored.collapsed.filter((key): key is string => typeof key === 'string')),
        ].slice(0, MAX_CUSTOM_ORDER)
      : []
    const sort: SortOrder =
      stored.sort?.field === 'name'
        ? { field: 'name', direction: stored.sort.direction === 'desc' ? 'desc' : 'asc' }
        : DEFAULT_SORT
    const hiddenColours = Array.isArray(stored.hiddenColours)
      ? [
          ...new Set(
            stored.hiddenColours.filter(
              (index): index is number =>
                Number.isSafeInteger(index) && index >= 0 && index < PALETTE_SIZE,
            ),
          ),
        ]
      : []
    const panelWidth =
      typeof stored.panelWidth === 'number' && Number.isFinite(stored.panelWidth)
        ? Math.min(720, Math.max(260, stored.panelWidth))
        : DEFAULT_STATE.panelWidth
    const progress: ProgressPlacement =
      stored.progress === 'expanded' || stored.progress === 'hidden' ? stored.progress : 'inline'
    state = {
      ...DEFAULT_STATE,
      servers,
      customOrder,
      collapsed,
      panelWidth,
      sort,
      progress,
      hiddenColours,
      reportPaints: stored.reportPaints === true,
      shareTiles: stored.shareTiles === true,
    }
    log('install', 'state loaded', { servers: state.servers.length })
    notifyStateListeners()
  } catch (error) {
    warn('install', 'stored state was unreadable; starting fresh', String(error))
  }
  return state
}

export const getState = (): State => state

export const setState = (patch: Partial<State>): State => {
  state = { ...state, ...patch }
  writeRaw(JSON.stringify(state))
  notifyStateListeners()
  return state
}

export const onStateChange = (listener: (next: State) => void): void => {
  listeners.push(listener)
}

/** Replace one server in place, keyed by url, preserving the order of the rest. */
export const upsertServer = (server: ConnectedServer): boolean => {
  const servers = getState().servers
  const index = servers.findIndex((s) => s.url === server.url)
  if (index === -1 && servers.length >= MAX_CONNECTED_SERVERS) return false
  const current = index === -1 ? undefined : servers[index]
  const canRetainIdentity =
    server.lastVerified == null &&
    current?.lastVerified != null &&
    (server.info === null || server.info.id === current.lastVerified.serverId)
  const next = canRetainIdentity ? { ...server, lastVerified: current.lastVerified } : server
  setState({
    servers: index === -1 ? [...servers, next] : servers.map((s, i) => (i === index ? next : s)),
  })
  return true
}

export const removeServer = (url: string): void => {
  const key = `server:${url}`
  setState({
    servers: getState().servers.filter((s) => s.url !== url),
    customOrder: getState().customOrder.filter((candidate) => candidate !== key),
  })
}

export const removeTreeStateKeys = (keys: ReadonlySet<string>): void => {
  const currentOrder = getState().customOrder
  const currentCollapsed = getState().collapsed
  const customOrder = currentOrder.filter((key) => !keys.has(key))
  const collapsed = currentCollapsed.filter((key) => !keys.has(key))
  if (customOrder.length !== currentOrder.length || collapsed.length !== currentCollapsed.length) {
    setState({ customOrder, collapsed })
  }
}

export type NodeListResult =
  | { readonly ok: true; readonly nodes: readonly TreeNode[] }
  | { readonly ok: false; readonly message: string; readonly status?: number }

const nodeListFrom = (body: unknown): readonly TreeNode[] | null => {
  const raw = isRecord(body) && 'nodes' in body ? body.nodes : body
  return treeNodesFrom(raw)
}

const fetchNodes = async (
  base: string,
  token: string | null,
  season: number,
  signal?: AbortSignal,
): Promise<NodeListResult> => {
  try {
    const { response, body } = await remoteJson(
      `${base}/admin/nodes?season=${season}`,
      {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        ...(signal === undefined ? {} : { signal }),
      },
      TREE_JSON_BYTES,
      LARGE_TRANSFER_TIMEOUT_MS,
    )
    if (!response.ok)
      return { ok: false, status: response.status, message: `Server said ${response.status}.` }
    const nodes = nodeListFrom(body)
    return nodes === null
      ? { ok: false, message: 'Server returned an invalid folder list.' }
      : { ok: true, nodes }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

/** Establish admin scope without downloading the same tree a second time after the manifest. */
const probeAdminScope = async (
  base: string,
  token: string | null,
  season: number,
  signal?: AbortSignal,
): Promise<boolean> => {
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) forwardAbort()
  else signal?.addEventListener('abort', forwardAbort, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new Error('request timed out')),
    LARGE_TRANSFER_TIMEOUT_MS,
  )
  try {
    const response = await fetch(`${base}/admin/nodes?season=${season}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    await discardResponseBody(response)
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

const probedNodes = new WeakMap<ConnectedServer, readonly TreeNode[]>()

/** Consume the node collection already downloaded while verifying admin scope. */
export const takeProbedNodes = (server: ConnectedServer): readonly TreeNode[] | undefined => {
  const nodes = probedNodes.get(server)
  probedNodes.delete(server)
  return nodes
}

/** Inspect a probe snapshot without changing its owner; forced refresh keeps it as a fallback. */
export const peekProbedNodes = (server: ConnectedServer): readonly TreeNode[] | undefined =>
  probedNodes.get(server)

/**
 * Ask a server who it is.
 *
 * `GET /server` is deliberately public and always answers, so a client can learn whether a token is
 * needed *before* asking anyone for one. Asking for a code up front is the likeliest way to lose
 * someone on first run — most servers will not want one.
 */
export const probeServer = async (
  url: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<ConnectedServer> => {
  let base: string
  try {
    base = canonicalServerUrl(url)
  } catch (error) {
    return {
      url: url.trim(),
      info: null,
      token,
      status: 'unreachable',
      error: String(error),
      isAdmin: false,
      season: null,
    }
  }
  let observedInfo: ServerInfo | null = null
  try {
    const { response, body } = await remoteJson(
      `${base}/server`,
      {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        ...(signal === undefined ? {} : { signal }),
      },
      SERVER_JSON_BYTES,
    )
    if (!response.ok) {
      return {
        url: base,
        info: null,
        token,
        status: 'unreachable',
        error: `HTTP ${response.status}`,
        isAdmin: false,
        season: null,
      }
    }
    const info = serverInfoFrom(body)
    if (info === null) throw new TypeError('server returned invalid metadata')
    observedInfo = info
    log('install', `probed ${base}`, { name: info.name, auth: info.auth })

    if (info.auth === 'access_token' && token === null) {
      return {
        url: base,
        info,
        token: null,
        status: 'needs-token',
        isAdmin: false,
        season: null,
      }
    }

    // `GET /server` is public and never looks at the Authorization header, so reaching it proves
    // nothing about a code. Without this second call any non-empty string read as "connected" and
    // every later request failed with 401 — caught by typing a deliberately wrong code.
    const fetchManifest = (credential: string | null) =>
      remoteJson(
        `${base}/manifest`,
        {
          headers: credential === null ? {} : { authorization: `Bearer ${credential}` },
          ...(signal === undefined ? {} : { signal }),
        },
        TREE_JSON_BYTES,
        LARGE_TRANSFER_TIMEOUT_MS,
      )
    let effectiveToken = token
    let { response: authed, body: manifestBody } = await fetchManifest(effectiveToken)
    if (
      info.auth === 'none' &&
      effectiveToken !== null &&
      (authed.status === 401 || authed.status === 403)
    ) {
      log('install', `${base} rejected the stored code; retrying open access`)
      effectiveToken = null
      const anonymous = await fetchManifest(null)
      authed = anonymous.response
      manifestBody = anonymous.body
    }
    if (authed.status === 401 || authed.status === 403) {
      log('install', `${base} rejected the code`, { status: authed.status })
      return {
        url: base,
        info,
        token,
        status: 'needs-token',
        error: 'rejected',
        isAdmin: false,
        season: null,
      }
    }
    if (!authed.ok) {
      return {
        url: base,
        info,
        token,
        status: 'unreachable',
        error: `HTTP ${authed.status}`,
        isAdmin: false,
        season: null,
      }
    }
    const manifest = manifestProbeFrom(manifestBody, info)
    if (manifest === null) throw new TypeError('server returned an invalid manifest')
    const isAdmin = await probeAdminScope(base, effectiveToken, manifest.season, signal)
    const connected: ConnectedServer = {
      url: base,
      info,
      token: effectiveToken,
      status: 'connected',
      isAdmin,
      season: manifest.season,
      lastVerified: { serverId: info.id, season: manifest.season },
    }
    probedNodes.set(connected, manifest.nodes)
    return connected
  } catch (error) {
    // A bad hostname, a refused connection, or a server without CORS all land here, and the
    // distinction is not visible to us — the browser withholds it deliberately.
    return {
      url: base,
      info: observedInfo,
      token,
      status: 'unreachable',
      error: String(error),
      isAdmin: false,
      season: null,
    }
  }
}

/** Revalidate persisted identity, auth and scope without allowing stale requests to resurrect rows. */
export const refreshStoredServers = async (onRefreshed?: () => void): Promise<void> => {
  const snapshot = [...getState().servers]
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < snapshot.length) {
      const server = snapshot[cursor++]
      if (server === undefined) return
      const refreshed = await probeServer(server.url, server.token)
      if (getState().servers.find((candidate) => candidate.url === server.url) !== server) continue
      upsertServer(refreshed)
      try {
        onRefreshed?.()
      } catch (error) {
        warn('install', 'server refresh observer failed', String(error))
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SERVER_REFRESH_CONCURRENCY, snapshot.length) }, worker),
  )
}

/**
 * Create a folder on a server.
 *
 * `POST /admin/nodes` needs admin scope, and nothing in `GET /server` says whether the code we hold
 * has it — so the only honest way to find out is to try and report what comes back. A 403 means the
 * code is a read code, which is a different problem from the server being down.
 */
export const createNode = async (
  server: ConnectedServer,
  name: string,
  parentId: string | null,
  signal?: AbortSignal,
): Promise<{ ok: true; node: TreeNode } | { ok: false; message: string }> => {
  if (server.season === null)
    return { ok: false, message: 'Refresh this server before editing it.' }
  try {
    const { response, body } = await remoteJson(`${server.url}/admin/nodes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(server.token === null ? {} : { authorization: `Bearer ${server.token}` }),
      },
      body: JSON.stringify({ season: server.season, parentId, name }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.ok) {
      const node = treeNodeFrom(body)
      if (node === null || node.parentId !== parentId) {
        return { ok: false, message: 'Server returned an invalid folder.' }
      }
      return { ok: true, node }
    }
    if (response.status === 401 || response.status === 403) {
      noteAuthFailure(server, response.status)
      return { ok: false, message: 'That code cannot create folders — it needs admin access.' }
    }
    return {
      ok: false,
      message:
        isRecord(body) && typeof body.error === 'string'
          ? body.error
          : `Server said ${response.status}.`,
    }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

const adminHeaders = (server: ConnectedServer): Record<string, string> => ({
  'content-type': 'application/json',
  ...(server.token === null ? {} : { authorization: `Bearer ${server.token}` }),
})

const noteAuthFailure = (server: ConnectedServer, status: number): void => {
  if (getState().servers.find((candidate) => candidate.url === server.url) !== server) return
  const needsToken = status === 401
  const replacement: ConnectedServer = {
    ...server,
    token: server.token,
    status: needsToken ? 'needs-token' : 'connected',
    error: needsToken ? 'authorization expired' : 'admin access required',
    isAdmin: false,
  }
  const pendingNodes = takeProbedNodes(server)
  if (pendingNodes !== undefined) probedNodes.set(replacement, pendingNodes)
  upsertServer(replacement)
}

const failure = (response: Response, body: Record<string, unknown> | null): string =>
  response.status === 401 || response.status === 403
    ? 'That code cannot change this server — it needs admin access.'
    : typeof body?.error === 'string'
      ? body.error
      : `Server said ${response.status}.`

export const renameNode = async (
  server: ConnectedServer,
  nodeId: string,
  name: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    const { response, body } = await remoteJson(`${server.url}/admin/nodes/${nodeId}`, {
      method: 'PATCH',
      headers: adminHeaders(server),
      body: JSON.stringify({ name }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.ok) return { ok: true }
    if (response.status === 401 || response.status === 403) noteAuthFailure(server, response.status)
    return { ok: false, message: failure(response, isRecord(body) ? body : null) }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

export const deleteNode = async (
  server: ConnectedServer,
  nodeId: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    const { response, body } = await remoteJson(`${server.url}/admin/nodes/${nodeId}`, {
      method: 'DELETE',
      headers: adminHeaders(server),
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.ok) return { ok: true }
    if (response.status === 401 || response.status === 403) noteAuthFailure(server, response.status)
    return { ok: false, message: failure(response, isRecord(body) ? body : null) }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

/** Existing sibling names, so a new folder can pick one that is free without asking. */
export const listNodes = async (
  server: ConnectedServer,
  signal?: AbortSignal,
): Promise<NodeListResult> => {
  if (server.season === null) return { ok: false, message: 'Refresh this server first.' }
  const result = await fetchNodes(server.url, server.token, server.season, signal)
  if (!result.ok && (result.status === 401 || result.status === 403)) {
    noteAuthFailure(server, result.status)
  }
  return result
}

/**
 * Publish a local template to a server.
 *
 * `POST /admin/templates` is multipart and wants an indexed PNG plus the origin in canvas pixels,
 * which is exactly what a local template already holds — so this is a move rather than a
 * conversion, and the placement someone got right locally is the placement the server stores.
 */
export const uploadTemplate = async (
  server: ConnectedServer,
  input: {
    nodeId: string
    name: string
    originX: number
    originY: number
    png: Blob
  },
  signal?: AbortSignal,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> => {
  try {
    const form = new FormData()
    form.set('png', input.png, `${input.name}.png`)
    form.set('nodeId', input.nodeId)
    form.set('name', input.name)
    form.set('originX', String(input.originX))
    form.set('originY', String(input.originY))
    const { response, body } = await remoteJson(
      `${server.url}/admin/templates`,
      {
        method: 'POST',
        headers: server.token === null ? {} : { authorization: `Bearer ${server.token}` },
        body: form,
        ...(signal === undefined ? {} : { signal }),
      },
      MUTATION_JSON_BYTES,
      LARGE_TRANSFER_TIMEOUT_MS,
    )
    if (response.ok) {
      const id = isRecord(body) ? body.templateId : undefined
      return typeof id === 'string' && UUID_V7.test(id)
        ? { ok: true, id }
        : { ok: false, message: 'Server returned an invalid uploaded template.' }
    }
    if (response.status === 401 || response.status === 403) {
      noteAuthFailure(server, response.status)
      return { ok: false, message: 'That code cannot upload templates — it needs admin access.' }
    }
    return {
      ok: false,
      message:
        isRecord(body) && typeof body.error === 'string'
          ? body.error
          : `Server said ${response.status}.`,
    }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}
