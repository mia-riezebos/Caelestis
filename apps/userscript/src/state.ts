import { PALETTE_SIZE } from '@wts/shared'
import { log, warn } from './debug.js'
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
}

export interface TreeNode {
  readonly id: string
  readonly parentId: string | null
  readonly path: string
  readonly name: string
}

export type ProgressPlacement = 'inline' | 'expanded' | 'hidden'
export type ColourPreset = 'all' | 'free' | 'premium' | 'owned'

export interface State {
  readonly servers: readonly ConnectedServer[]
  /** Row keys in the user's own order. Keys absent from this list sort after those present. */
  readonly customOrder: readonly string[]
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
  panelWidth: 320,
  sort: DEFAULT_SORT,
  progress: 'inline',
  hiddenColours: [],
  reportPaints: false,
  shareTiles: false,
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NODE_PATH = /^(\/[\p{L}\p{N}][\p{L}\p{N}\p{M}. -]*)+$/u
const MAX_TREE_NODES = 100_000
const MAX_CUSTOM_ORDER = 200_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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

const treeNodesFrom = (value: unknown): readonly TreeNode[] | null => {
  if (!Array.isArray(value) || value.length > MAX_TREE_NODES) return null
  const nodes: TreeNode[] = []
  const ids = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !UUID_V7.test(raw.id) || ids.has(raw.id)) return null
    if (
      raw.parentId !== null &&
      (typeof raw.parentId !== 'string' || !UUID_V7.test(raw.parentId))
    ) {
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
    ids.add(raw.id)
    nodes.push({ id: raw.id, parentId: raw.parentId, path: raw.path, name: raw.name })
  }
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const foldPath = (path: string): string =>
    path.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const foldedPaths = nodes.map((node) => foldPath(node.path))
  if (new Set(foldedPaths).size !== foldedPaths.length) return null
  const validated = new Set<string>()
  for (const node of nodes) {
    if (validated.has(node.id)) continue
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

const manifestProbeFrom = (
  value: unknown,
  expected: ServerInfo,
): { season: number; server: ServerInfo } | null => {
  if (
    !isRecord(value) ||
    typeof value.version !== 'string' ||
    value.version.length < 1 ||
    value.version.length > 256
  )
    return null
  if (!Number.isSafeInteger(value.season) || Number(value.season) < 0) return null
  const server = serverInfoFrom(value.server)
  if (server === null || server.id !== expected.id) return null
  if (
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.templates) ||
    !Array.isArray(value.tiles)
  ) {
    return null
  }
  return { season: Number(value.season), server }
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
        servers.push({
          url,
          info: serverInfoFrom(candidate.info),
          token: typeof candidate.token === 'string' ? candidate.token : null,
          status: 'unreachable',
          error: 'Checking connection…',
          isAdmin: false,
          season: null,
        })
      }
    }
    const customOrder = Array.isArray(stored.customOrder)
      ? [
          ...new Set(stored.customOrder.filter((key): key is string => typeof key === 'string')),
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
      panelWidth,
      sort,
      progress,
      hiddenColours,
      reportPaints: stored.reportPaints === true,
      shareTiles: stored.shareTiles === true,
    }
    log('install', 'state loaded', { servers: state.servers.length })
  } catch (error) {
    warn('install', 'stored state was unreadable; starting fresh', String(error))
  }
  return state
}

export const getState = (): State => state

export const setState = (patch: Partial<State>): State => {
  state = { ...state, ...patch }
  writeRaw(JSON.stringify(state))
  for (const listener of listeners) listener(state)
  return state
}

export const onStateChange = (listener: (next: State) => void): void => {
  listeners.push(listener)
}

/** Replace one server in place, keyed by url, preserving the order of the rest. */
export const upsertServer = (server: ConnectedServer): void => {
  const servers = getState().servers
  const index = servers.findIndex((s) => s.url === server.url)
  setState({
    servers:
      index === -1 ? [...servers, server] : servers.map((s, i) => (i === index ? server : s)),
  })
}

export const removeServer = (url: string): void => {
  const key = `server:${url}`
  setState({
    servers: getState().servers.filter((s) => s.url !== url),
    customOrder: getState().customOrder.filter((candidate) => candidate !== key),
  })
}

export const removeCustomOrderKeys = (keys: ReadonlySet<string>): void => {
  const current = getState().customOrder
  const next = current.filter((key) => !keys.has(key))
  if (next.length !== current.length) setState({ customOrder: next })
}

/** Can this code administer the server? The only way to know is to ask it to do something admin. */
const probeAdmin = async (base: string, token: string | null, season: number): Promise<boolean> => {
  try {
    const response = await fetch(`${base}/admin/nodes?season=${season}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Ask a server who it is.
 *
 * `GET /server` is deliberately public and always answers, so a client can learn whether a token is
 * needed *before* asking anyone for one. Asking for a code up front is the likeliest way to lose
 * someone on first run — most servers will not want one.
 */
export const probeServer = async (url: string, token: string | null): Promise<ConnectedServer> => {
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
  try {
    const response = await fetch(`${base}/server`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    })
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
    const info = serverInfoFrom(await response.json())
    if (info === null) throw new TypeError('server returned invalid metadata')
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
    const authed = await fetch(`${base}/manifest`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    })
    if (authed.status === 401 || authed.status === 403) {
      log('install', `${base} rejected the code`, { status: authed.status })
      return {
        url: base,
        info,
        token: null,
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
    const manifest = manifestProbeFrom(await authed.json(), info)
    if (manifest === null) throw new TypeError('server returned an invalid manifest')
    return {
      url: base,
      info,
      token,
      status: 'connected',
      isAdmin: await probeAdmin(base, token, manifest.season),
      season: manifest.season,
    }
  } catch (error) {
    // A bad hostname, a refused connection, or a server without CORS all land here, and the
    // distinction is not visible to us — the browser withholds it deliberately.
    return {
      url: base,
      info: null,
      token,
      status: 'unreachable',
      error: String(error),
      isAdmin: false,
      season: null,
    }
  }
}

/** Revalidate persisted identity, auth and scope without allowing stale requests to resurrect rows. */
export const refreshStoredServers = async (): Promise<void> => {
  const snapshot = [...getState().servers]
  await Promise.all(
    snapshot.map(async (server) => {
      const refreshed = await probeServer(server.url, server.token)
      if (getState().servers.find((candidate) => candidate.url === server.url) !== server) return
      upsertServer(refreshed)
    }),
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
): Promise<{ ok: true; node: TreeNode } | { ok: false; message: string }> => {
  if (server.season === null)
    return { ok: false, message: 'Refresh this server before editing it.' }
  try {
    const response = await fetch(`${server.url}/admin/nodes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(server.token === null ? {} : { authorization: `Bearer ${server.token}` }),
      },
      body: JSON.stringify({ season: server.season, parentId, name }),
    })
    if (response.ok) return { ok: true, node: (await response.json()) as TreeNode }
    if (response.status === 401 || response.status === 403) {
      noteAuthFailure(server)
      return { ok: false, message: 'That code cannot create folders — it needs admin access.' }
    }
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    return { ok: false, message: body?.error ?? `Server said ${response.status}.` }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

const adminHeaders = (server: ConnectedServer): Record<string, string> => ({
  'content-type': 'application/json',
  ...(server.token === null ? {} : { authorization: `Bearer ${server.token}` }),
})

const noteAuthFailure = (server: ConnectedServer): void => {
  if (getState().servers.find((candidate) => candidate.url === server.url) !== server) return
  const needsToken = server.info?.auth === 'access_token'
  upsertServer({
    ...server,
    token: needsToken ? null : server.token,
    status: needsToken ? 'needs-token' : 'connected',
    error: 'authorization expired',
    isAdmin: false,
  })
}

const failure = (response: Response, body: { error?: string } | null): string =>
  response.status === 401 || response.status === 403
    ? 'That code cannot change this server — it needs admin access.'
    : (body?.error ?? `Server said ${response.status}.`)

export const renameNode = async (
  server: ConnectedServer,
  nodeId: string,
  name: string,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    const response = await fetch(`${server.url}/admin/nodes/${nodeId}`, {
      method: 'PATCH',
      headers: adminHeaders(server),
      body: JSON.stringify({ name }),
    })
    if (response.ok) return { ok: true }
    if (response.status === 401 || response.status === 403) noteAuthFailure(server)
    return { ok: false, message: failure(response, await response.json().catch(() => null)) }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

export const deleteNode = async (
  server: ConnectedServer,
  nodeId: string,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    const response = await fetch(`${server.url}/admin/nodes/${nodeId}`, {
      method: 'DELETE',
      headers: adminHeaders(server),
    })
    if (response.ok) return { ok: true }
    if (response.status === 401 || response.status === 403) noteAuthFailure(server)
    return { ok: false, message: failure(response, await response.json().catch(() => null)) }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

/** Existing sibling names, so a new folder can pick one that is free without asking. */
export const listNodes = async (
  server: ConnectedServer,
  signal?: AbortSignal,
): Promise<readonly TreeNode[]> => {
  if (server.season === null) return []
  try {
    const response = await fetch(`${server.url}/admin/nodes?season=${server.season}`, {
      headers: server.token === null ? {} : { authorization: `Bearer ${server.token}` },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) noteAuthFailure(server)
      return []
    }
    const body: unknown = await response.json()
    const raw = isRecord(body) && 'nodes' in body ? body.nodes : body
    return treeNodesFrom(raw) ?? []
  } catch {
    return []
  }
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
): Promise<{ ok: true; id: string } | { ok: false; message: string }> => {
  try {
    const form = new FormData()
    form.set('png', input.png, `${input.name}.png`)
    form.set('nodeId', input.nodeId)
    form.set('name', input.name)
    form.set('originX', String(input.originX))
    form.set('originY', String(input.originY))
    const response = await fetch(`${server.url}/admin/templates`, {
      method: 'POST',
      headers: server.token === null ? {} : { authorization: `Bearer ${server.token}` },
      body: form,
    })
    if (response.ok) {
      const body = (await response.json()) as { id?: string }
      return { ok: true, id: body.id ?? '' }
    }
    if (response.status === 401 || response.status === 403) {
      noteAuthFailure(server)
      return { ok: false, message: 'That code cannot upload templates — it needs admin access.' }
    }
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    return { ok: false, message: body?.error ?? `Server said ${response.status}.` }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}
