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
    state = { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<State>) }
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
  setState({ servers: getState().servers.filter((s) => s.url !== url) })
}

/** Can this code administer the server? The only way to know is to ask it to do something admin. */
const probeAdmin = async (base: string, token: string | null): Promise<boolean> => {
  try {
    const response = await fetch(`${base}/admin/nodes?season=0`, {
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
  const base = url.trim().replace(/\/+$/, '')
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
      }
    }
    const info = (await response.json()) as ServerInfo
    log('install', `probed ${base}`, { name: info.name, auth: info.auth })

    if (info.auth !== 'access_token') {
      return { url: base, info, token, status: 'connected', isAdmin: await probeAdmin(base, token) }
    }
    if (token === null) {
      return { url: base, info, token: null, status: 'needs-token', isAdmin: false }
    }

    // `GET /server` is public and never looks at the Authorization header, so reaching it proves
    // nothing about a code. Without this second call any non-empty string read as "connected" and
    // every later request failed with 401 — caught by typing a deliberately wrong code.
    const authed = await fetch(`${base}/manifest`, {
      headers: { authorization: `Bearer ${token}` },
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
      }
    }
    return { url: base, info, token, status: 'connected', isAdmin: await probeAdmin(base, token) }
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
    }
  }
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
  try {
    const response = await fetch(`${server.url}/admin/nodes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(server.token === null ? {} : { authorization: `Bearer ${server.token}` }),
      },
      body: JSON.stringify({ season: 0, parentId, name }),
    })
    if (response.ok) return { ok: true, node: (await response.json()) as TreeNode }
    if (response.status === 401 || response.status === 403) {
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
    return { ok: false, message: failure(response, await response.json().catch(() => null)) }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

/** Existing sibling names, so a new folder can pick one that is free without asking. */
export const listNodes = async (server: ConnectedServer): Promise<readonly TreeNode[]> => {
  try {
    const response = await fetch(`${server.url}/admin/nodes?season=0`, {
      headers: server.token === null ? {} : { authorization: `Bearer ${server.token}` },
    })
    if (!response.ok) return []
    const body = (await response.json()) as { nodes?: TreeNode[] } | TreeNode[]
    return Array.isArray(body) ? body : (body.nodes ?? [])
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
      return { ok: false, message: 'That code cannot upload templates — it needs admin access.' }
    }
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    return { ok: false, message: body?.error ?? `Server said ${response.status}.` }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}
