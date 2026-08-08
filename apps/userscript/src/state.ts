import { log, warn } from './debug.js'
import type { ServerTemplate } from './server-cache.js'
import { type Appearance, DEFAULT_APPEARANCE, normaliseAppearance } from './templates/appearance.js'
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

/**
 * A folder inside the Local category.
 *
 * Kept in state rather than IndexedDB, unlike the templates themselves: a folder is a name and a
 * parent, which is exactly the kind of small metadata the rest of state holds, and it has to be
 * readable synchronously while the tree renders. The templates are in IndexedDB because they are
 * megabytes of pixels; this is not.
 */
export interface LocalFolder {
  readonly id: string
  /** Null means directly under Local. */
  readonly parentId: string | null
  readonly name: string
  /**
   * Whether this folder draws, like a group in an image editor.
   *
   * Hiding it hides everything beneath it — templates and nested folders alike — without touching
   * what any of them say about themselves. Turning it back on restores exactly the arrangement that
   * was there before, which is the whole point of a group toggle over switching each layer off.
   */
  readonly visible: boolean
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
  /**
   * Show only the colour wplace has selected, while its paint drawer is open.
   *
   * A mode rather than a preset: it is held separately from `hiddenColours` so that turning it off
   * gives back whatever was switched off by hand, instead of leaving the palette however the mode
   * left it.
   */
  readonly onlySelectedColour: boolean
  readonly localFolders: readonly LocalFolder[]
  /**
   * Categories switched off wholesale, by tree key: `local`, or `server:<url>`.
   *
   * The same rule as a folder, one level up. A category is the outermost group, so turning it off
   * takes everything under it off the canvas without editing any of it — and turning it back on
   * restores exactly what was there. Kept as the hidden set rather than a flag per server so a
   * server that is added later starts visible without needing a migration.
   */
  readonly hiddenScopes: readonly string[]
  /**
   * How overlays are drawn unless they say otherwise.
   *
   * A default rather than an override: a template that has never had its own appearance touched
   * follows this, and one that has keeps what was set on it. Making it an override would mean
   * changing a global slider silently discarded per-overlay work, which is the one thing a default
   * must never do.
   */
  readonly appearance: Appearance
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
  onlySelectedColour: false,
  localFolders: [],
  hiddenScopes: [],
  appearance: DEFAULT_APPEARANCE,
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
    const stored = JSON.parse(raw) as Partial<State>
    // The spread only rescues *top-level* fields. `appearance` is an object, so a stored one
    // replaces the default whole, missing fields and all — which is how `undefined` reaches the
    // renderer and comes back out as NaN.
    state = {
      ...DEFAULT_STATE,
      ...stored,
      appearance: normaliseAppearance(stored.appearance ?? null) ?? DEFAULT_APPEARANCE,
      // Same trap as `appearance`, one level down: a folder stored before `visible` existed has no
      // such field, and `!undefined` is true — so every folder made before this shipped would have
      // been treated as hidden, taking its whole subtree off the canvas.
      localFolders: (stored.localFolders ?? []).map((folder) => ({
        ...folder,
        visible: folder.visible !== false,
      })),
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

const localFolderId = (): string =>
  `lf-${Math.random().toString(36).slice(2, 10)}-${getState().localFolders.length}`

export const createLocalFolder = (parentId: string | null, name: string): LocalFolder => {
  const folder: LocalFolder = { id: localFolderId(), parentId, name, visible: true }
  setState({ localFolders: [...getState().localFolders, folder] })
  return folder
}

/** Whether a whole category draws. Unknown keys are visible, so anything new starts on. */
export const isScopeVisible = (key: string): boolean => !getState().hiddenScopes.includes(key)

export const setScopeVisible = (key: string, visible: boolean): void => {
  const hidden = getState().hiddenScopes
  if (visible === !hidden.includes(key)) return
  setState({
    hiddenScopes: visible ? hidden.filter((candidate) => candidate !== key) : [...hidden, key],
  })
}

export const setLocalFolderVisible = (id: string, visible: boolean): void => {
  setState({
    localFolders: getState().localFolders.map((folder) =>
      folder.id === id ? { ...folder, visible } : folder,
    ),
  })
}

/**
 * Whether a folder and every folder above it are showing.
 *
 * Recursive rather than a single flag, because hiding a group must hide what is nested inside it
 * even though those rows still say they are visible — they are, within a group that is not.
 */
export const localFolderChainVisible = (folderId: string | null): boolean => {
  // The Local category itself is the outermost group in the chain.
  if (!isScopeVisible('local')) return false
  const folders = getState().localFolders
  let walk = folderId
  const seen = new Set<string>()
  while (walk !== null) {
    // A cycle should be impossible, but a render loop is a bad place to find out otherwise.
    if (seen.has(walk)) return true
    seen.add(walk)
    const folder = folders.find((candidate) => candidate.id === walk)
    if (folder === undefined) return true
    // Explicitly against false: anything stored before this field existed is showing, not hidden.
    if (folder.visible === false) return false
    walk = folder.parentId
  }
  return true
}

export const renameLocalFolder = (id: string, name: string): void => {
  const trimmed = name.trim()
  if (trimmed === '') return
  setState({
    localFolders: getState().localFolders.map((folder) =>
      folder.id === id ? { ...folder, name: trimmed } : folder,
    ),
  })
}

/**
 * Remove a folder, lifting whatever was inside it to where the folder was.
 *
 * Deleting a container must not destroy what it holds. A template is someone's imported artwork and
 * a folder is only a label on it, so the label goes and the contents move up one level — which is
 * also recoverable by simply making the folder again.
 */
export const removeLocalFolder = (id: string): void => {
  const folders = getState().localFolders
  const folder = folders.find((candidate) => candidate.id === id)
  if (folder === undefined) return
  setState({
    localFolders: folders
      .filter((candidate) => candidate.id !== id)
      .map((candidate) =>
        candidate.parentId === id ? { ...candidate, parentId: folder.parentId } : candidate,
      ),
  })
}

export const moveLocalFolder = (id: string, parentId: string | null): void => {
  // A folder cannot be moved inside itself or its own descendants, which would detach the branch
  // from the tree and make it unreachable.
  if (id === parentId) return
  let walk = parentId
  const folders = getState().localFolders
  while (walk !== null) {
    if (walk === id) return
    walk = folders.find((candidate) => candidate.id === walk)?.parentId ?? null
  }
  setState({
    localFolders: folders.map((folder) => (folder.id === id ? { ...folder, parentId } : folder)),
  })
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

/**
 * Move a folder to a different parent on the same server.
 *
 * Server-backed, unlike the order rows sit in: where a folder *lives* is structure everyone shares,
 * so it has to be the server's answer, while what order you like to see things in is yours alone and
 * never leaves this browser.
 *
 * Null puts it at the top level of the server.
 */
export const moveNode = async (
  server: ConnectedServer,
  nodeId: string,
  parentId: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    const response = await fetch(`${server.url}/admin/nodes/${nodeId}`, {
      method: 'PATCH',
      headers: adminHeaders(server),
      body: JSON.stringify({ parentId }),
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
  cascade = false,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    const response = await fetch(
      `${server.url}/admin/nodes/${nodeId}${cascade ? '?cascade=true' : ''}`,
      { method: 'DELETE', headers: adminHeaders(server) },
    )
    if (response.ok) return { ok: true }
    return { ok: false, message: failure(response, await response.json().catch(() => null)) }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

/**
 * How much a folder is holding, so a delete can say what it is about to take with it.
 *
 * Asked of the server rather than counted from the tree, because the tree only knows what it has
 * fetched: a collapsed folder's contents may never have been listed, and "delete 1 folder" for
 * something holding forty templates is the kind of wrong that only shows up afterwards.
 */
export const countNodeSubtree = async (
  server: ConnectedServer,
  nodeId: string,
): Promise<{ nodes: number; templates: number } | null> => {
  try {
    const response = await fetch(`${server.url}/admin/nodes/${nodeId}/subtree`, {
      headers: adminHeaders(server),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { nodes?: unknown; templates?: unknown }
    if (typeof body.nodes !== 'number' || typeof body.templates !== 'number') return null
    return { nodes: body.nodes, templates: body.templates }
  } catch {
    return null
  }
}

/**
 * Everything a server is publishing: the folder tree and the templates hanging off it.
 *
 * One fetch, from `/manifest`, and that endpoint is the right one for **both** — the structure is
 * not privileged information. Anyone with a read code is meant to see the tree; the admin boundary
 * is *changing* it, which lives on the `/admin` routes. Reading the tree from `GET /admin/nodes`
 * put the boundary in the wrong place and left every read-scope member staring at a server with no
 * folders, and therefore no templates, since a template row is drawn under its folder.
 *
 * Answers empty on any failure rather than throwing. A tree that has drawn a stale row is better
 * than a tree that has thrown, and the cached copy is what it falls back to.
 */
export const listServerContents = async (
  server: ConnectedServer,
): Promise<{ nodes: readonly TreeNode[]; templates: readonly ServerTemplate[] } | null> => {
  try {
    const response = await fetch(`${server.url}/manifest?season=0`, {
      headers: server.token === null ? {} : { authorization: `Bearer ${server.token}` },
    })
    if (!response.ok) return null
    const body = (await response.json()) as {
      nodes?: ReadonlyArray<Partial<TreeNode>>
      templates?: ReadonlyArray<
        Partial<ServerTemplate> & { chunks?: ReadonlyArray<{ tile?: unknown; hash?: unknown }> }
      >
    }
    const nodes = (body.nodes ?? []).flatMap((node) =>
      typeof node.id === 'string'
        ? [
            {
              id: node.id,
              parentId: typeof node.parentId === 'string' ? node.parentId : null,
              path: node.path ?? '',
              name: node.name ?? 'Untitled',
            },
          ]
        : [],
    )
    const templates = (body.templates ?? []).flatMap((template) => {
      const bbox = template.bbox
      if (typeof template.id !== 'string' || typeof template.nodeId !== 'string') return []
      if (bbox === undefined) return []
      return [
        {
          id: template.id,
          nodeId: template.nodeId,
          name: template.name ?? 'Untitled',
          version: template.version ?? '',
          published: template.published === true,
          // Absent on a server older than the field. Zero reads as "never edited", which is a
          // better lie than `Date.now()` — it cannot make a stale row look freshly changed.
          updatedAt: typeof template.updatedAt === 'number' ? template.updatedAt : 0,
          bbox,
          chunks: (template.chunks ?? []).filter(
            (chunk): chunk is { tile: string; hash: string } =>
              typeof chunk?.tile === 'string' && typeof chunk?.hash === 'string',
          ),
        },
      ]
    })
    return { nodes, templates }
  } catch {
    return null
  }
}

/** The folder tree alone, for the admin flows that need somewhere to put something. */
export const listNodes = async (server: ConnectedServer): Promise<readonly TreeNode[]> =>
  (await listServerContents(server))?.nodes ?? []

/**
 * The templates alone, or null when the server could not be asked.
 *
 * Null and empty are kept apart on purpose. A failed fetch used to answer with an empty list, and
 * the sync read that as "this server publishes nothing" — so one blip, or a server restarting, took
 * every template off the canvas and the next success put them back as if they were new.
 */
export const listServerTemplates = async (
  server: ConnectedServer,
): Promise<readonly ServerTemplate[] | null> =>
  (await listServerContents(server))?.templates ?? null

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
      // `templateId`, not `id` — the upload answers with the whole stored template, and reading the
      // wrong field here handed back an empty string that every caller then treated as a real id.
      const body = (await response.json()) as { templateId?: string }
      return { ok: true, id: body.templateId ?? '' }
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

/**
 * Edit a published template: its name, which folder it sits in, or whether it is published.
 *
 * One call for all three because the server takes one patch, and because they are the same kind of
 * change — everything here leaves the pixels alone. Replacing those is `uploadTemplateVersion`.
 */
export const patchTemplate = async (
  server: ConnectedServer,
  templateId: string,
  patch: { name?: string; nodeId?: string; published?: boolean },
): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    const response = await fetch(`${server.url}/admin/templates/${templateId}`, {
      method: 'PATCH',
      headers: adminHeaders(server),
      body: JSON.stringify(patch),
    })
    if (response.ok) return { ok: true }
    return { ok: false, message: failure(response, await response.json().catch(() => null)) }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

/**
 * Rename a server — the name every member sees, not a label local to this browser.
 *
 * Worth being explicit about, because the row it is edited from looks exactly like the Local one
 * above it, and that one *is* local. This writes to the server, and the next member to open their
 * panel sees the new name.
 *
 * The local copy is updated from the answer rather than re-probed: the tree is labelled from
 * `info.name`, and leaving it stale until the next probe would make a rename look like it failed.
 */
export const renameServer = async (
  server: ConnectedServer,
  name: string,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const trimmed = name.trim()
  if (trimmed === '') return { ok: false, message: 'A server needs a name.' }
  try {
    const response = await fetch(`${server.url}/admin/server`, {
      method: 'PATCH',
      headers: adminHeaders(server),
      body: JSON.stringify({ name: trimmed }),
    })
    if (!response.ok) {
      return { ok: false, message: failure(response, await response.json().catch(() => null)) }
    }
    if (server.info !== null) {
      upsertServer({ ...server, info: { ...server.info, name: trimmed } })
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

export const deleteTemplate = async (
  server: ConnectedServer,
  templateId: string,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    const response = await fetch(`${server.url}/admin/templates/${templateId}`, {
      method: 'DELETE',
      headers: adminHeaders(server),
    })
    if (response.ok) return { ok: true }
    return { ok: false, message: failure(response, await response.json().catch(() => null)) }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

/**
 * Replace a published template's pixels, keeping everything else about it.
 *
 * The origin travels with the image because a new version is a new slicing — moving artwork on the
 * canvas is a different picture as far as the chunk index is concerned, not an edit to the old one.
 */
export const uploadTemplateVersion = async (
  server: ConnectedServer,
  templateId: string,
  input: { originX: number; originY: number; png: Blob; name: string },
): Promise<{ ok: true; versionId: string } | { ok: false; message: string }> => {
  try {
    const form = new FormData()
    form.set('png', input.png, `${input.name}.png`)
    form.set('originX', String(input.originX))
    form.set('originY', String(input.originY))
    const response = await fetch(`${server.url}/admin/templates/${templateId}/versions`, {
      method: 'POST',
      headers: server.token === null ? {} : { authorization: `Bearer ${server.token}` },
      body: form,
    })
    if (response.ok) {
      const body = (await response.json()) as { versionId?: string }
      return { ok: true, versionId: body.versionId ?? '' }
    }
    return { ok: false, message: failure(response, await response.json().catch(() => null)) }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}
