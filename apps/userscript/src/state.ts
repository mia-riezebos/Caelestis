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
}

export type ProgressPlacement = 'inline' | 'expanded' | 'hidden'
export type ColourFilter = 'all' | 'free' | 'premium' | 'owned'

export interface State {
  readonly servers: readonly ConnectedServer[]
  readonly sort: SortOrder
  readonly progress: ProgressPlacement
  readonly colours: ColourFilter
  readonly reportPaints: boolean
  readonly shareTiles: boolean
}

const DEFAULT_STATE: State = {
  servers: [],
  sort: DEFAULT_SORT,
  progress: 'inline',
  colours: 'all',
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
      }
    }
    const info = (await response.json()) as ServerInfo
    const needsToken = info.auth === 'access_token' && token === null
    log('install', `probed ${base}`, { name: info.name, auth: info.auth, needsToken })
    return {
      url: base,
      info,
      token,
      status: needsToken ? 'needs-token' : 'connected',
    }
  } catch (error) {
    // A bad hostname, a refused connection, or a server without CORS all land here, and the
    // distinction is not visible to us — the browser withholds it deliberately.
    return { url: base, info: null, token, status: 'unreachable', error: String(error) }
  }
}
