import {
  defaultTemplateSort,
  isTemplateSortField,
  PALETTE_SIZE,
  type ReconciliationReason,
  type SyncTransport,
  type TemplateSurface,
  templateSurface,
  templateSurfaceKey,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { userscriptClientHeaders } from './client-metrics.js'
import { log, warn } from './debug.js'
import { DEFAULT_MARKER_BUDGET, normaliseMarkerBudget } from './marker-budget.js'
import type { ServerTemplate } from './server-cache.js'
import {
  parseServerInfo,
  parseServerManifest,
  parseTreeNode,
  parseTreeNodes,
  type ServerInfo,
  type TreeNode,
} from './server-manifest.js'
import { coalesceServerRead } from './server-read-coalescer.js'
import {
  requestServerManifest,
  requestServerMetadata,
  requestServerMutation,
  requestServerStatus,
  requestServerTree,
  requestServerUpload,
  serverManifestSequence,
} from './server-transport.js'
import {
  canonicalServerUrl,
  rememberServerApiVersion,
  type ServerApiVersion,
  serverEndpoint,
} from './server-url.js'
import {
  APPEARANCE_GROUPS,
  type Appearance,
  type AppearanceGroup,
  DEFAULT_APPEARANCE,
  normaliseAppearance,
} from './templates/appearance.js'
import { remapPaletteColours, remapStoredAppearance } from './templates/palette-migration.js'
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

const STORAGE_KEY = 'caelestis.state.v2'
const LEGACY_STORAGE_KEY = 'caelestis.state.v1'

export interface ConnectedServer {
  /** Host and optional base path as the user typed them, normalised — the connection identity. */
  readonly url: string
  readonly info: ServerInfo | null
  readonly token: string | null
  /** False when the saved token was rejected but an open server remains usable anonymously. */
  readonly tokenUsable?: boolean
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
  /** Runtime-only marker: this probe was deliberately replaced or cancelled, not unreachable. */
  readonly superseded?: true
}

/** Whether two immutable state rows still describe the same remote connection lifetime. */
export const sameServerConnection = (left: ConnectedServer, right: ConnectedServer): boolean =>
  left.url === right.url &&
  left.token === right.token &&
  (left.tokenUsable !== false) === (right.tokenUsable !== false) &&
  left.status === right.status &&
  left.isAdmin === right.isAdmin &&
  left.season === right.season &&
  (left.info === null
    ? right.info === null
    : right.info !== null && left.info.id === right.info.id && left.info.auth === right.info.auth)

/**
 * Runtime identity for one configured connection lifetime.
 *
 * It is deliberately not persisted: removing a server and later probing the same URL starts a new
 * lifetime even when every wire value happens to be equal. Immutable replacements made while the
 * row remains configured inherit the token in {@link upsertServer}.
 */
const serverConnectionLifetimes = new WeakMap<ConnectedServer, object>()
const serverConnectionControllers = new WeakMap<object, AbortController>()

const serverConnectionLifetime = (server: ConnectedServer): object => {
  const existing = serverConnectionLifetimes.get(server)
  if (existing !== undefined) return existing
  const created = {}
  serverConnectionLifetimes.set(server, created)
  return created
}

/** Opaque owner for sharing reads without exposing credentials in a cache key. */
export const serverConnectionIdentity = (server: ConnectedServer): object =>
  serverConnectionLifetime(server)

export const serverConnectionSignal = (server: ConnectedServer): AbortSignal => {
  const lifetime = serverConnectionLifetime(server)
  let controller = serverConnectionControllers.get(lifetime)
  if (controller === undefined) {
    controller = new AbortController()
    serverConnectionControllers.set(lifetime, controller)
  }
  return controller.signal
}

const retireServerConnection = (server: ConnectedServer): void => {
  const lifetime = serverConnectionLifetimes.get(server)
  if (lifetime === undefined) return
  let controller = serverConnectionControllers.get(lifetime)
  if (controller === undefined) {
    controller = new AbortController()
    serverConnectionControllers.set(lifetime, controller)
  }
  controller.abort(new Error('server connection retired'))
}

/** The saved token remains sealed in state; only a currently accepted token leaves in a request. */
export const activeServerToken = (server: ConnectedServer): string | null =>
  server.tokenUsable === false ? null : server.token

/** Whether this immutable connection snapshot is still the configured lifetime for its URL. */
export const isCurrentServerConnection = (server: ConnectedServer): boolean => {
  const current = getState().servers.find((candidate) => candidate.url === server.url)
  if (current === undefined) return false
  if (current === server) return true
  const lifetime = serverConnectionLifetimes.get(server)
  return lifetime !== undefined && serverConnectionLifetimes.get(current) === lifetime
}

/** A browser-local folder; its metadata is small enough to live in userscript state. */
export interface LocalFolder {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
  readonly visible: boolean
  /** Exact drawing surface. Records written before alliance support are world-scoped. */
  readonly surface?: TemplateSurface
}

/** Browser-owned drawing preferences for an overlay whose pixels remain server-owned. */
export interface ServerTemplatePreference {
  readonly id: string
  readonly appearance: Appearance | null
  readonly owns: readonly AppearanceGroup[]
}

/** Browser-owned defaults and view mode for one alliance artboard. */
export interface AllianceSurfaceAppearance {
  readonly surface: Exclude<TemplateSurface, { readonly kind: 'world' }>
  readonly appearance: Appearance
  readonly onlySelectedColour: boolean
}

export type ColourPreset = 'all' | 'free' | 'premium' | 'owned'
export type ColourNavigationOrder = 'unpainted-first' | 'mismatched-first'

export interface State {
  readonly servers: readonly ConnectedServer[]
  /** Row keys in the user's own order. Keys absent from this list sort after those present. */
  readonly customOrder: readonly string[]
  /** Containers the user explicitly collapsed. Search may reveal them without changing this. */
  readonly collapsed: readonly string[]
  /** Panel width in pixels, dragged by the handle on its left edge. */
  readonly panelWidth: number
  readonly sort: SortOrder
  /** Palette indices deliberately hidden. Empty means every colour draws. */
  readonly hiddenColours: readonly number[]
  /** World-canvas selected-colour mode. Alliance canvases keep their own value. */
  readonly onlySelectedColour: boolean
  /** Which kind of remaining work a middle-clicked Wplace colour swatch visits first. */
  readonly colourNavigationOrder: ColourNavigationOrder
  /** Target mismatch or selected-colour markers submitted across one viewport. */
  readonly markerBudget: number
  readonly localFolders: readonly LocalFolder[]
  readonly hiddenScopes: readonly string[]
  readonly serverTemplatePreferences: readonly ServerTemplatePreference[]
  readonly allianceSurfaceAppearances: readonly AllianceSurfaceAppearance[]
  readonly appearance: Appearance
  readonly reportPaints: boolean
  readonly shareTiles: boolean
}

const DEFAULT_STATE: State = {
  servers: [],
  customOrder: [],
  collapsed: [],
  panelWidth: 320,
  sort: DEFAULT_SORT,
  hiddenColours: [],
  onlySelectedColour: false,
  colourNavigationOrder: 'unpainted-first',
  markerBudget: DEFAULT_MARKER_BUDGET,
  localFolders: [],
  hiddenScopes: [],
  serverTemplatePreferences: [],
  allianceSurfaceAppearances: [],
  appearance: DEFAULT_APPEARANCE,
  reportPaints: true,
  shareTiles: true,
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_CUSTOM_ORDER = 200_000
export const MAX_CONNECTED_SERVERS = 32
/** At most every admitted overlay for every configured server may retain a local preference. */
export const MAX_SERVER_TEMPLATE_PREFERENCES = MAX_CONNECTED_SERVERS * 64
export const MAX_ALLIANCE_SURFACE_APPEARANCES = MAX_CONNECTED_SERVERS * 3
/** As many browser-local folders as a reload will restore. Written past, the rest is dropped. */
export const MAX_LOCAL_FOLDERS = 32_000
const SERVER_REFRESH_CONCURRENCY = 4
const SERVER_RETRY_MS = 5_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export { canonicalServerUrl, serverEndpoint } from './server-url.js'

// biome-ignore lint/suspicious/noExplicitAny: the GM_* API only exists under a userscript manager
const gm = globalThis as any

const readRaw = (): {
  readonly value: string
  readonly legacyPalette: boolean
} | null => {
  try {
    const read = (key: string): string | null =>
      typeof gm.GM_getValue === 'function' ? gm.GM_getValue(key, null) : localStorage.getItem(key)
    const current = read(STORAGE_KEY)
    if (current !== null) return { value: current, legacyPalette: false }
    const legacy = read(LEGACY_STORAGE_KEY)
    return legacy === null ? null : { value: legacy, legacyPalette: true }
  } catch (error) {
    warn('install', 'could not read stored state', String(error))
    return null
  }
}

const writeRaw = (value: string): boolean => {
  try {
    if (typeof gm.GM_setValue === 'function') gm.GM_setValue(STORAGE_KEY, value)
    else localStorage.setItem(STORAGE_KEY, value)
    return true
  } catch (error) {
    warn('install', 'could not persist state', String(error))
    return false
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
  const storedRaw = readRaw()
  if (storedRaw === null) return state
  try {
    // Spread over the defaults rather than trusting the stored shape: a build that adds a field
    // must not be broken by state written before it existed.
    const parsed: unknown = JSON.parse(storedRaw.value)
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
        const info = parseServerInfo(candidate.info)
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
      isTemplateSortField(stored.sort?.field) && stored.sort.field !== 'custom'
        ? {
            field: stored.sort.field,
            direction:
              stored.sort.direction === 'asc' || stored.sort.direction === 'desc'
                ? stored.sort.direction
                : defaultTemplateSort(stored.sort.field).direction,
          }
        : DEFAULT_SORT
    const storedHiddenColours = Array.isArray(stored.hiddenColours)
      ? stored.hiddenColours.filter((index): index is number => Number.isSafeInteger(index))
      : []
    const hiddenColours =
      storedHiddenColours.length > 0
        ? [
            ...new Set(
              (storedRaw.legacyPalette
                ? remapPaletteColours(storedHiddenColours)
                : storedHiddenColours
              ).filter(
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
    const localFolders: LocalFolder[] = []
    const folderIds = new Set<string>()
    if (Array.isArray(stored.localFolders)) {
      for (const candidate of stored.localFolders) {
        if (
          !isRecord(candidate) ||
          typeof candidate.id !== 'string' ||
          candidate.id.length > 128 ||
          folderIds.has(candidate.id) ||
          typeof candidate.name !== 'string' ||
          candidate.name.length < 1 ||
          candidate.name.length > 256 ||
          (candidate.parentId !== null && typeof candidate.parentId !== 'string')
        )
          continue
        const surface =
          candidate.surface === undefined
            ? WORLD_TEMPLATE_SURFACE
            : isRecord(candidate.surface)
              ? templateSurface(candidate.surface.kind, candidate.surface.allianceId)
              : null
        if (surface === null) continue
        folderIds.add(candidate.id)
        localFolders.push({
          id: candidate.id,
          parentId: candidate.parentId,
          name: candidate.name,
          // Records written before folder visibility existed were visible.
          visible: candidate.visible !== false,
          surface,
        })
        if (localFolders.length >= MAX_LOCAL_FOLDERS) break
      }
    }
    const storedHiddenScopes = Array.isArray(stored.hiddenScopes)
      ? stored.hiddenScopes.filter(
          (key): key is string => typeof key === 'string' && key.length <= 2_048,
        )
      : []
    const migrateServerTemplateScope = (key: string): string => {
      for (const server of servers) {
        const prefix = `srv:${server.url}:`
        if (!key.startsWith(prefix)) continue
        const templateId = key.slice(prefix.length)
        if (UUID_V7.test(templateId)) {
          return `srv:${encodeURIComponent(server.url)}:${templateId}`
        }
      }
      return key
    }
    const hiddenScopes = [
      ...new Set(
        storedHiddenScopes.flatMap((key) => {
          const legacyNodeId = key.startsWith('node:') ? key.slice('node:'.length) : ''
          if (!UUID_V7.test(legacyNodeId)) return [migrateServerTemplateScope(key)]
          // The old key hid this node id without naming a server. Preserve that meaning for every
          // connection that existed with the setting, then store only the collision-safe form.
          return servers.map((server) => `node:${encodeURIComponent(server.url)}:${legacyNodeId}`)
        }),
      ),
    ].slice(0, MAX_CUSTOM_ORDER)
    const scopesMigrated =
      hiddenScopes.length !== storedHiddenScopes.length ||
      hiddenScopes.some((key, index) => key !== storedHiddenScopes[index])
    const serverTemplatePreferences: ServerTemplatePreference[] = []
    const preferenceIds = new Set<string>()
    if (Array.isArray(stored.serverTemplatePreferences)) {
      for (const candidate of stored.serverTemplatePreferences) {
        if (
          !isRecord(candidate) ||
          typeof candidate.id !== 'string' ||
          !candidate.id.startsWith('srv:') ||
          candidate.id.length > 2_048 ||
          preferenceIds.has(candidate.id) ||
          !Array.isArray(candidate.owns)
        )
          continue
        const appearance =
          candidate.appearance === null
            ? null
            : normaliseAppearance(
                storedRaw.legacyPalette
                  ? remapStoredAppearance(candidate.appearance)
                  : candidate.appearance,
              )
        if (candidate.appearance !== null && appearance === null) continue
        const owns = [
          ...new Set(
            candidate.owns.filter((group): group is AppearanceGroup =>
              APPEARANCE_GROUPS.includes(group as AppearanceGroup),
            ),
          ),
        ]
        preferenceIds.add(candidate.id)
        serverTemplatePreferences.push({ id: candidate.id, appearance, owns })
        if (serverTemplatePreferences.length >= MAX_SERVER_TEMPLATE_PREFERENCES) break
      }
    }
    const allianceSurfaceAppearances: AllianceSurfaceAppearance[] = []
    const appearanceSurfaces = new Set<string>()
    if (Array.isArray(stored.allianceSurfaceAppearances)) {
      for (const candidate of stored.allianceSurfaceAppearances) {
        if (!isRecord(candidate) || !isRecord(candidate.surface)) continue
        const surface = templateSurface(candidate.surface.kind, candidate.surface.allianceId)
        if (surface === null || surface.kind === 'world') continue
        const key = templateSurfaceKey(surface)
        if (appearanceSurfaces.has(key)) continue
        const appearance = normaliseAppearance(candidate.appearance)
        if (appearance === null) continue
        appearanceSurfaces.add(key)
        allianceSurfaceAppearances.push({
          surface,
          appearance,
          onlySelectedColour: candidate.onlySelectedColour === true,
        })
        if (allianceSurfaceAppearances.length >= MAX_ALLIANCE_SURFACE_APPEARANCES) break
      }
    }
    state = {
      ...DEFAULT_STATE,
      servers,
      customOrder,
      collapsed,
      panelWidth,
      sort,
      hiddenColours,
      onlySelectedColour: stored.onlySelectedColour === true,
      colourNavigationOrder:
        stored.colourNavigationOrder === 'mismatched-first'
          ? 'mismatched-first'
          : 'unpainted-first',
      markerBudget: normaliseMarkerBudget(stored.markerBudget),
      localFolders,
      hiddenScopes,
      serverTemplatePreferences,
      allianceSurfaceAppearances,
      appearance:
        normaliseAppearance(
          storedRaw.legacyPalette
            ? remapStoredAppearance(stored.appearance ?? null)
            : (stored.appearance ?? null),
        ) ?? DEFAULT_APPEARANCE,
      // Contribution sharing is opt-out. Missing fields are older saved state, not a decision to
      // disable either feed; an explicit false remains durable across reloads.
      reportPaints: stored.reportPaints !== false,
      shareTiles: stored.shareTiles !== false,
    }
    log('install', 'state loaded', { servers: state.servers.length })
    if (storedRaw.legacyPalette || scopesMigrated) writeRaw(JSON.stringify(state))
    notifyStateListeners()
  } catch (error) {
    warn('install', 'stored state was unreadable; starting fresh', String(error))
  }
  return state
}

export const getState = (): State => state

/** The global appearance currently shown on the map, including an uncommitted slider gesture. */
let globalAppearancePreview: Appearance | null = null
const allianceAppearancePreviews = new Map<string, Appearance>()

export const getGlobalAppearance = (): Appearance => globalAppearancePreview ?? state.appearance

/** Preview a global appearance without serialising or notifying state subscribers. */
export const previewGlobalAppearance = (appearance: Appearance | null): void => {
  globalAppearancePreview = appearance
}

/** The defaults inherited by templates on this exact canvas. */
export const getSurfaceAppearance = (surface: TemplateSurface): Appearance => {
  if (surface.kind === 'world') {
    return { ...getGlobalAppearance(), hiddenColours: state.hiddenColours }
  }
  const key = templateSurfaceKey(surface)
  return (
    allianceAppearancePreviews.get(key) ??
    state.allianceSurfaceAppearances.find(
      (candidate) => templateSurfaceKey(candidate.surface) === key,
    )?.appearance ??
    DEFAULT_APPEARANCE
  )
}

/** Whether this exact canvas follows Wplace's selected paint colour. */
export const onlySelectedColourFor = (surface: TemplateSurface): boolean => {
  if (surface.kind === 'world') return state.onlySelectedColour
  const key = templateSurfaceKey(surface)
  return (
    state.allianceSurfaceAppearances.find(
      (candidate) => templateSurfaceKey(candidate.surface) === key,
    )?.onlySelectedColour ?? false
  )
}

/** Change the selected-colour view mode without leaking it into another canvas. */
export const setOnlySelectedColourFor = (
  surface: TemplateSurface,
  onlySelectedColour: boolean,
): boolean => {
  if (surface.kind === 'world') {
    setState({ onlySelectedColour })
    return true
  }
  const key = templateSurfaceKey(surface)
  const preferences = state.allianceSurfaceAppearances
  const index = preferences.findIndex((candidate) => templateSurfaceKey(candidate.surface) === key)
  if (index === -1 && preferences.length >= MAX_ALLIANCE_SURFACE_APPEARANCES) return false
  const preference = index === -1 ? null : preferences[index]
  return commitState({
    allianceSurfaceAppearances:
      preference === null
        ? [...preferences, { surface, appearance: DEFAULT_APPEARANCE, onlySelectedColour }]
        : preferences.map((candidate, at) =>
            at === index ? { ...candidate, onlySelectedColour } : candidate,
          ),
  })
}

/** Preview one canvas's inherited appearance without leaking it into the world renderer. */
export const previewSurfaceAppearance = (
  surface: TemplateSurface,
  appearance: Appearance | null,
): void => {
  if (surface.kind === 'world') {
    previewGlobalAppearance(appearance)
    return
  }
  const key = templateSurfaceKey(surface)
  if (appearance === null) allianceAppearancePreviews.delete(key)
  else allianceAppearancePreviews.set(key, appearance)
}

/** Persist one alliance canvas's inherited appearance independently of every other canvas. */
export const setSurfaceAppearance = (
  surface: Exclude<TemplateSurface, { readonly kind: 'world' }>,
  appearance: Appearance,
): boolean => {
  const key = templateSurfaceKey(surface)
  const preferences = state.allianceSurfaceAppearances
  const index = preferences.findIndex((candidate) => templateSurfaceKey(candidate.surface) === key)
  if (index === -1 && preferences.length >= MAX_ALLIANCE_SURFACE_APPEARANCES) return false
  allianceAppearancePreviews.delete(key)
  return commitState({
    allianceSurfaceAppearances:
      index === -1
        ? [...preferences, { surface, appearance, onlySelectedColour: false }]
        : preferences.map((candidate, at) =>
            at === index ? { ...candidate, surface, appearance } : candidate,
          ),
  })
}

export const setState = (patch: Partial<State>): State => {
  if (patch.appearance !== undefined) globalAppearancePreview = null
  if (patch.allianceSurfaceAppearances !== undefined) allianceAppearancePreviews.clear()
  state = { ...state, ...patch }
  writeRaw(JSON.stringify(state))
  notifyStateListeners()
  return state
}

/** Commit only if the browser accepts the durable copy; used where the caller reports save status. */
export const commitState = (patch: Partial<State>): boolean => {
  const next = { ...state, ...patch }
  if (!writeRaw(JSON.stringify(next))) return false
  state = next
  notifyStateListeners()
  return true
}

export const onStateChange = (listener: (next: State) => void): void => {
  listeners.push(listener)
}

export const isScopeVisible = (key: string): boolean => !getState().hiddenScopes.includes(key)

export const setScopeVisible = (key: string, visible: boolean): boolean => {
  const hidden = getState().hiddenScopes
  if (visible === !hidden.includes(key)) return true
  return commitState({
    hiddenScopes: visible ? hidden.filter((candidate) => candidate !== key) : [...hidden, key],
  })
}

export const serverTemplatePreference = (id: string): ServerTemplatePreference | undefined =>
  getState().serverTemplatePreferences.find((preference) => preference.id === id)

/** Save browser-owned appearance independently of the server-owned pixels and metadata. */
export const setServerTemplatePreference = (
  id: string,
  appearance: Appearance | null,
  owns: readonly AppearanceGroup[],
): boolean => {
  if (!id.startsWith('srv:') || id.length > 2_048) return false
  const preferences = getState().serverTemplatePreferences
  const index = preferences.findIndex((preference) => preference.id === id)
  if (appearance === null && owns.length === 0) {
    if (index !== -1) {
      return commitState({
        serverTemplatePreferences: preferences.filter((_, at) => at !== index),
      })
    }
    return true
  }
  if (index === -1 && preferences.length >= MAX_SERVER_TEMPLATE_PREFERENCES) return false
  const preference: ServerTemplatePreference = {
    id,
    appearance,
    owns: [...new Set(owns)].filter((group) => APPEARANCE_GROUPS.includes(group)),
  }
  return commitState({
    serverTemplatePreferences:
      index === -1
        ? [...preferences, preference]
        : preferences.map((current, at) => (at === index ? preference : current)),
  })
}

/** Replace one server in place, keyed by url, preserving its saved token and the order of the rest. */
export const upsertServer = (server: ConnectedServer): boolean => {
  const servers = getState().servers
  const index = servers.findIndex((s) => s.url === server.url)
  if (index === -1 && servers.length >= MAX_CONNECTED_SERVERS) return false
  const current = index === -1 ? undefined : servers[index]
  // A probe may decide to continue anonymously, but only an explicit disconnect may erase the
  // credential stored for this URL. A non-empty replacement still lets the user rotate the token.
  const candidate =
    current !== undefined && current.token !== null && server.token === null
      ? { ...server, token: current.token, tokenUsable: false }
      : server
  const canRetainIdentity =
    candidate.lastVerified == null &&
    current?.lastVerified != null &&
    (candidate.info === null || candidate.info.id === current.lastVerified.serverId)
  const next = canRetainIdentity ? { ...candidate, lastVerified: current.lastVerified } : candidate
  const retainsLifetime = current !== undefined && sameServerConnection(current, candidate)
  if (current !== undefined && !retainsLifetime) retireServerConnection(current)
  const lifetime = retainsLifetime ? serverConnectionLifetime(current) : {}
  serverConnectionLifetimes.set(server, lifetime)
  serverConnectionLifetimes.set(candidate, lifetime)
  serverConnectionLifetimes.set(next, lifetime)
  setState({
    servers: index === -1 ? [...servers, next] : servers.map((s, i) => (i === index ? next : s)),
  })
  return true
}

export const removeServer = (url: string): void => {
  const key = `server:${url}`
  const templatePrefix = `srv:${encodeURIComponent(url)}:`
  // Request ids are process-wide and monotonic, so an old response can never tie a request made
  // after this URL reconnects. Only the answer belonging to the ended connection is forgotten.
  latestManifestResponse.delete(url)
  const current = getState().servers.find((server) => server.url === url)
  if (current !== undefined) retireServerConnection(current)
  setState({
    servers: getState().servers.filter((s) => s.url !== url),
    customOrder: getState().customOrder.filter((candidate) => candidate !== key),
    serverTemplatePreferences: getState().serverTemplatePreferences.filter(
      (preference) => !preference.id.startsWith(templatePrefix),
    ),
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

/** Drop visibility state that belongs to a disconnected source. */
export const forgetScopes = (keys: Iterable<string>): void => {
  const drop = new Set(keys)
  const hiddenScopes = getState().hiddenScopes.filter((key) => !drop.has(key))
  if (hiddenScopes.length !== getState().hiddenScopes.length) setState({ hiddenScopes })
}

export type NodeListResult =
  | { readonly ok: true; readonly nodes: readonly TreeNode[] }
  | { readonly ok: false; readonly message: string; readonly status?: number }

const nodeListFrom = (body: unknown): readonly TreeNode[] | null => {
  const raw = isRecord(body) && 'nodes' in body ? body.nodes : body
  return parseTreeNodes(raw)
}

const fetchNodes = async (
  base: string,
  token: string | null,
  season: number,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
  signal?: AbortSignal,
): Promise<NodeListResult> => {
  try {
    const query = new URLSearchParams({ season: String(season), surface: surface.kind })
    if (surface.allianceId !== null) query.set('allianceId', String(surface.allianceId))
    const { response, body } = await requestServerTree(
      serverEndpoint(base, `/admin/nodes?${query}`),
      {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        ...(signal === undefined ? {} : { signal }),
      },
    )
    if (!response.ok)
      return {
        ok: false,
        status: response.status,
        message: `Server said ${response.status}.`,
      }
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
  try {
    // The status is the whole answer, so the body is thrown away unread. Parsing it measured the
    // full folder tree against the 64 KB cap meant for a one-line mutation reply, and any server
    // with a real tree therefore reported that our token could only read it.
    return (
      await requestServerStatus(serverEndpoint(base, `/admin/nodes?season=${season}`), {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        ...(signal === undefined ? {} : { signal }),
      })
    ).ok
  } catch {
    return false
  }
}

const probedNodes = new WeakMap<ConnectedServer, readonly TreeNode[]>()
const activeServerProbes = new Map<string, AbortController>()

export const cancelServerProbe = (serverUrl: string): void => {
  activeServerProbes.get(serverUrl)?.abort(new Error('server probe cancelled'))
  activeServerProbes.delete(serverUrl)
}

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
  options: { readonly supersedeActive?: boolean } = {},
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
  const activeProbe = activeServerProbes.get(base)
  if (activeProbe !== undefined && options.supersedeActive === false) {
    return {
      url: base,
      info: null,
      token,
      status: 'unreachable',
      error: 'superseded by an active foreground server probe',
      isAdmin: false,
      season: null,
      superseded: true,
    }
  }
  activeProbe?.abort(new Error('superseded by a newer server probe'))
  const probeController = new AbortController()
  activeServerProbes.set(base, probeController)
  let observedInfo: ServerInfo | null = null
  try {
    let apiVersion: ServerApiVersion = 'v1'
    let metadata = await requestServerMetadata(serverEndpoint(base, '/server', apiVersion), {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      signal: probeController.signal,
    })
    if (metadata.response.status === 404) {
      apiVersion = 'legacy'
      metadata = await requestServerMetadata(serverEndpoint(base, '/server', apiVersion), {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        signal: probeController.signal,
      })
    }
    const { response, body } = metadata
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
    const info = parseServerInfo(body)
    if (info === null) throw new TypeError('server returned invalid metadata')
    rememberServerApiVersion(base, apiVersion)
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
      requestServerManifest(serverEndpoint(base, '/manifest'), {
        headers: credential === null ? {} : { authorization: `Bearer ${credential}` },
        signal: probeController.signal,
      })
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
    const manifest = parseServerManifest(manifestBody, info)
    if (manifest === null) throw new TypeError('server returned an invalid manifest')
    const isAdmin = await probeAdminScope(
      base,
      effectiveToken,
      manifest.season,
      probeController.signal,
    )
    if (probeController.signal.aborted) throw probeController.signal.reason
    const connected: ConnectedServer = {
      url: base,
      info,
      token,
      ...(effectiveToken === null && token !== null ? { tokenUsable: false as const } : {}),
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
      ...(probeController.signal.aborted ? { superseded: true as const } : {}),
    }
  } finally {
    if (activeServerProbes.get(base) === probeController) activeServerProbes.delete(base)
  }
}

const refreshServers = async (
  snapshot: readonly ConnectedServer[],
  onRefreshed?: () => void,
): Promise<void> => {
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < snapshot.length) {
      const server = snapshot[cursor++]
      if (server === undefined) return
      if (!isCurrentServerConnection(server)) continue
      const refreshed = await probeServer(server.url, server.token, {
        supersedeActive: false,
      })
      if (refreshed.superseded === true) continue
      const current = getState().servers.find((candidate) => candidate.url === server.url)
      if (current === undefined || !isCurrentServerConnection(server)) continue
      // A cosmetic replacement can land while the probe is in flight. Preserve that newer local
      // metadata while still applying the probe's current connectivity, season, and scope result.
      upsertServer(current === server ? refreshed : { ...refreshed, info: current.info })
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

/** Revalidate persisted identity, auth and scope without allowing stale requests to resurrect rows. */
export const refreshStoredServers = async (onRefreshed?: () => void): Promise<void> =>
  refreshServers([...getState().servers], onRefreshed)

let serverRetryTimer: ReturnType<typeof setInterval> | null = null

/** Keep offline rows alive through short server restarts, reusing their persisted credentials. */
export const installServerConnectionRetry = (onRefreshed?: () => void): void => {
  if (serverRetryTimer !== null) clearInterval(serverRetryTimer)
  serverRetryTimer = setInterval(() => {
    const unreachable = getState().servers.filter((server) => server.status === 'unreachable')
    if (unreachable.length > 0) void refreshServers(unreachable, onRefreshed)
  }, SERVER_RETRY_MS)
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
  description?: string,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<{ ok: true; node: TreeNode } | { ok: false; message: string }> => {
  if (server.season === null)
    return { ok: false, message: 'Refresh this server before editing it.' }
  try {
    const { response, body } = await requestServerMutation(
      serverEndpoint(server.url, '/admin/nodes'),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(activeServerToken(server) === null
            ? {}
            : { authorization: `Bearer ${activeServerToken(server)}` }),
        },
        body: JSON.stringify({
          season: server.season,
          surfaceKind: surface.kind,
          ...(surface.allianceId === null ? {} : { allianceId: surface.allianceId }),
          parentId,
          name,
          ...(description === undefined ? {} : { description }),
        }),
      },
    )
    if (response.ok) {
      const node = parseTreeNode(body)
      if (node === null || node.parentId !== parentId) {
        return { ok: false, message: 'Server returned an invalid folder.' }
      }
      return { ok: true, node }
    }
    if (response.status === 401 || response.status === 403) {
      noteAuthFailure(server, response.status)
      return {
        ok: false,
        message: 'That code cannot create folders — it needs admin access.',
      }
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
  ...(activeServerToken(server) === null
    ? {}
    : { authorization: `Bearer ${activeServerToken(server)}` }),
})

const noteAuthFailure = (server: ConnectedServer, status: number): void => {
  const current = getState().servers.find((candidate) => candidate.url === server.url)
  if (current === undefined || !isCurrentServerConnection(server)) return
  const needsToken = status === 401
  const replacement: ConnectedServer = {
    ...current,
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

type UploadFailure = {
  readonly ok: false
  readonly message: string
  readonly ambiguous?: true
}

interface PendingUploadAmbiguity {
  readonly afterManifestRequest: number
}

const pendingUploadAmbiguities = new Map<string, PendingUploadAmbiguity>()
const activeUploads = new Map<string, { readonly token: object }>()

const pendingUploadFailure = (server: ConnectedServer): UploadFailure | null => {
  const pending = pendingUploadAmbiguities.get(server.url)
  if (pending === undefined) return null
  return {
    ok: false,
    message: 'A previous upload may have completed. Refresh this server before uploading again.',
    ambiguous: true,
  }
}

const markUploadAmbiguous = (server: ConnectedServer, message: string): UploadFailure => {
  const existing = pendingUploadAmbiguities.get(server.url)
  pendingUploadAmbiguities.set(server.url, {
    afterManifestRequest: Math.max(existing?.afterManifestRequest ?? 0, serverManifestSequence()),
  })
  return { ok: false, message, ambiguous: true }
}

const clearUploadAmbiguity = (server: ConnectedServer, manifestRequest: number): void => {
  const pending = pendingUploadAmbiguities.get(server.url)
  if (pending !== undefined && manifestRequest > pending.afterManifestRequest) {
    pendingUploadAmbiguities.delete(server.url)
  }
}

const beginUpload = (
  server: ConnectedServer,
): { readonly token: object } | { readonly failure: UploadFailure } => {
  if (!isCurrentServerConnection(server)) {
    return {
      failure: {
        ok: false,
        message: 'The server connection changed before upload.',
      },
    }
  }
  const pending = pendingUploadFailure(server)
  if (pending !== null) return { failure: pending }
  const active = activeUploads.get(server.url)
  if (active !== undefined) {
    return {
      failure: {
        ok: false,
        message: 'Another upload to this server is still running.',
      },
    }
  }
  const token = {}
  activeUploads.set(server.url, { token })
  return { token }
}

const endUpload = (serverUrl: string, token: object): void => {
  if (activeUploads.get(serverUrl)?.token === token) activeUploads.delete(serverUrl)
}

export const renameNode = async (
  server: ConnectedServer,
  nodeId: string,
  name: string,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    const { response, body } = await requestServerMutation(
      serverEndpoint(server.url, `/admin/nodes/${nodeId}`),
      {
        method: 'PATCH',
        headers: adminHeaders(server),
        body: JSON.stringify({ name }),
      },
    )
    if (response.ok) return { ok: true }
    if (response.status === 401 || response.status === 403) noteAuthFailure(server, response.status)
    return {
      ok: false,
      message: failure(response, isRecord(body) ? body : null),
    }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

export const deleteNode = async (
  server: ConnectedServer,
  nodeId: string,
  expected: {
    readonly nodes: number
    readonly templates: number
  } | null = null,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    const cascade =
      expected === null
        ? ''
        : `?cascade=true&expectedNodes=${expected.nodes}&expectedTemplates=${expected.templates}`
    const { response, body } = await requestServerMutation(
      serverEndpoint(server.url, `/admin/nodes/${nodeId}${cascade}`),
      {
        method: 'DELETE',
        headers: adminHeaders(server),
      },
    )
    if (response.ok) return { ok: true }
    if (response.status === 401 || response.status === 403) noteAuthFailure(server, response.status)
    return {
      ok: false,
      message: failure(response, isRecord(body) ? body : null),
    }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

/** Existing sibling names, so a new folder can pick one that is free without asking. */
export const listNodes = async (server: ConnectedServer): Promise<NodeListResult> => {
  if (server.season === null) return { ok: false, message: 'Refresh this server first.' }
  const result = await fetchNodes(
    server.url,
    activeServerToken(server),
    server.season,
    WORLD_TEMPLATE_SURFACE,
  )
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
    nodeId: string | null
    name: string
    originX: number
    originY: number
    png: Blob
    surface?: TemplateSurface
  },
): Promise<{ ok: true; id: string; version: string } | UploadFailure> => {
  const begun = beginUpload(server)
  if ('failure' in begun) return begun.failure
  try {
    const form = new FormData()
    form.set('png', input.png, `${input.name}.png`)
    if (input.nodeId !== null) form.set('nodeId', input.nodeId)
    if (server.season === null) return { ok: false, message: 'Refresh this server first.' }
    form.set('season', String(server.season))
    form.set('name', input.name)
    form.set('originX', String(input.originX))
    form.set('originY', String(input.originY))
    if (input.surface?.kind !== undefined && input.surface.kind !== 'world') {
      form.set('surfaceKind', input.surface.kind)
      form.set('allianceId', String(input.surface.allianceId))
    }
    const { response, body } = await requestServerUpload(
      serverEndpoint(server.url, '/admin/templates'),
      {
        method: 'POST',
        headers:
          activeServerToken(server) === null
            ? {}
            : { authorization: `Bearer ${activeServerToken(server)}` },
        body: form,
      },
    )
    if (response.ok) {
      const id = isRecord(body) ? body.templateId : undefined
      const version = isRecord(body) ? body.versionId : undefined
      return typeof id === 'string' &&
        UUID_V7.test(id) &&
        typeof version === 'string' &&
        UUID_V7.test(version)
        ? { ok: true, id, version }
        : markUploadAmbiguous(server, 'Server returned an invalid uploaded template.')
    }
    if (response.status === 401 || response.status === 403) {
      noteAuthFailure(server, response.status)
      return {
        ok: false,
        message: 'That code cannot upload templates — it needs admin access.',
      }
    }
    const rejected = {
      ok: false,
      message:
        isRecord(body) && typeof body.error === 'string'
          ? body.error
          : `Server said ${response.status}.`,
    } as const
    return response.status >= 500 ? markUploadAmbiguous(server, rejected.message) : rejected
  } catch (error) {
    return markUploadAmbiguous(server, String(error))
  } finally {
    endUpload(server.url, begun.token)
  }
}
export const moveNode = async (
  server: ConnectedServer,
  nodeId: string,
  parentId: string | null,
): Promise<{ ok: true } | { ok: false; message: string; retryable?: true }> => {
  try {
    const { response, body } = await requestServerMutation(
      serverEndpoint(server.url, `/admin/nodes/${nodeId}`),
      {
        method: 'PATCH',
        headers: adminHeaders(server),
        body: JSON.stringify({ parentId }),
      },
    )
    if (response.status === 401 || response.status === 403) noteAuthFailure(server, response.status)
    if (response.ok) return { ok: true }
    return {
      ok: false,
      message: failure(response, isRecord(body) ? body : null),
      ...(response.status === 408 || response.status === 429 || response.status >= 500
        ? { retryable: true as const }
        : {}),
    }
  } catch (error) {
    return { ok: false, message: String(error), retryable: true }
  }
}

export const countNodeSubtree = async (
  server: ConnectedServer,
  nodeId: string,
): Promise<{ nodes: number; templates: number } | null> => {
  try {
    const { response, body } = await requestServerMutation(
      serverEndpoint(server.url, `/admin/nodes/${nodeId}/subtree`),
      {
        headers: adminHeaders(server),
      },
    )
    if (response.status === 401 || response.status === 403) noteAuthFailure(server, response.status)
    if (!response.ok) return null
    const parsed = body as { nodes?: unknown; templates?: unknown }
    if (
      !Number.isSafeInteger(parsed.nodes) ||
      (parsed.nodes as number) < 1 ||
      !Number.isSafeInteger(parsed.templates) ||
      (parsed.templates as number) < 0
    )
      return null
    return {
      nodes: parsed.nodes as number,
      templates: parsed.templates as number,
    }
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
export interface ServerContents {
  /** Opaque manifest revision, retained so the coordinator can back off while it is unchanged. */
  readonly revision?: string
  readonly nodes: readonly TreeNode[]
  readonly templates: readonly ServerTemplate[]
}

const latestManifestResponse = new Map<string, number>()
const manifestResponseOf = new WeakMap<ServerContents, number>()
const admittedServerContents = new Map<
  string,
  { readonly server: ConnectedServer; readonly contents: ServerContents }
>()
const serverContentsListeners = new Set<
  (server: ConnectedServer, contents: ServerContents) => void
>()

/** Observe each newest successful manifest, no matter which UI or poll requested it. */
export const onServerContents = (
  listener: (server: ConnectedServer, contents: ServerContents) => void,
): (() => void) => {
  serverContentsListeners.add(listener)
  return () => serverContentsListeners.delete(listener)
}

/** Whether this snapshot is still the newest successful manifest response for its server. */
export const isLatestServerContents = (serverUrl: string, contents: ServerContents): boolean => {
  const response = manifestResponseOf.get(contents)
  return response === undefined || response === latestManifestResponse.get(serverUrl)
}

/**
 * Mark the newest manifest as safe for every consumer to use.
 *
 * Aggregate admission belongs to the tree snapshot authority because it spans all configured servers.
 * Keeping the winning snapshot here gives admin helpers and the canvas repair path the same answer,
 * while retaining the connection that earned it prevents a same-URL reconnect from inheriting it.
 */
export const admitServerContents = (server: ConnectedServer, contents: ServerContents): boolean => {
  const current = getState().servers.find((candidate) => candidate.url === server.url)
  if (
    current === undefined ||
    !isCurrentServerConnection(server) ||
    !isLatestServerContents(server.url, contents)
  )
    return false
  admittedServerContents.set(server.url, { server: current, contents })
  const request = manifestResponseOf.get(contents)
  if (request !== undefined) clearUploadAmbiguity(server, request)
  return true
}

/** The admitted snapshot belonging to this exact connection lifetime, if one exists. */
export const admittedServerContentsFor = (server: ConnectedServer): ServerContents | null => {
  const admitted = admittedServerContents.get(server.url)
  return admitted !== undefined &&
    isCurrentServerConnection(server) &&
    isCurrentServerConnection(admitted.server)
    ? admitted.contents
    : null
}

export const forgetAdmittedServerContents = (serverUrl: string): void => {
  admittedServerContents.delete(serverUrl)
}

const awaitReadOrAbort = <T>(read: Promise<T>, signal: AbortSignal): Promise<T | null> =>
  new Promise<T | null>((resolve, reject) => {
    const aborted = (): void => {
      cleanup()
      resolve(null)
    }
    const cleanup = (): void => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    void read.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })

export const listServerContents = async (
  server: ConnectedServer,
  signal?: AbortSignal,
  reason: ReconciliationReason = 'unknown',
  transport: SyncTransport = 'compatibility-poll',
): Promise<ServerContents | null> => {
  if (server.info === null || server.season === null) return null
  if (!isCurrentServerConnection(server)) return null
  try {
    const info = server.info
    const season = server.season
    const owner = serverConnectionIdentity(server)
    const read = coalesceServerRead(
      owner,
      `${season}\u0000world\u0000manifest`,
      async (): Promise<ServerContents | null> => {
        const {
          response,
          body,
          sequence: request,
        } = await requestServerManifest(
          serverEndpoint(server.url, `/manifest?season=${season}`),
          {
            headers:
              activeServerToken(server) === null
                ? userscriptClientHeaders({ transport, reason })
                : {
                    ...userscriptClientHeaders({ transport, reason }),
                    authorization: `Bearer ${activeServerToken(server)}`,
                  },
            signal: serverConnectionSignal(server),
          },
          () => isCurrentServerConnection(server),
        )
        if (response.status === 401 || response.status === 403)
          noteAuthFailure(server, response.status)
        if (!response.ok) return null
        const manifest = parseServerManifest(body, info)
        if (manifest === null || manifest.season !== season) return null
        const contents: ServerContents = {
          revision: manifest.version,
          nodes: manifest.nodes,
          templates: manifest.templates,
        }
        manifestResponseOf.set(contents, request)
        const current = getState().servers.find((candidate) => candidate.url === server.url)
        if (
          current !== undefined &&
          isCurrentServerConnection(server) &&
          request > (latestManifestResponse.get(server.url) ?? 0)
        ) {
          latestManifestResponse.set(server.url, request)
          for (const listener of serverContentsListeners) {
            try {
              listener(current, contents)
            } catch (error) {
              warn('install', 'could not publish fresh manifest contents', String(error))
            }
          }
        }
        return contents
      },
    )
    if (signal === undefined) return await read
    if (signal.aborted) return null
    return await awaitReadOrAbort(read, signal)
  } catch {
    return null
  }
}

export type ServerNodesResult =
  | { readonly status: 'ok'; readonly nodes: readonly TreeNode[] }
  | { readonly status: 'unreachable' | 'not-admitted' }

/** The folder tree alone, for the admin flows that need somewhere to put something. */
/**
 * The admitted folders, with network failure kept distinct from a successful unsafe snapshot.
 *
 * Empty is a real server answer. A failed fetch used to answer with an empty list, so Move claimed
 * the server had one folder, Copy said to create one first, and folder naming picked a name as
 * though nothing was there. Aggregate refusal is different again: the server answered, but using
 * rows the tree and canvas refused would let admin actions commit against state the UI cannot show.
 */
export const listServerNodes = async (
  server: ConnectedServer,
  signal?: AbortSignal,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<ServerNodesResult> => {
  if (server.season === null || !isCurrentServerConnection(server)) return { status: 'unreachable' }
  if (surface.kind !== 'world') {
    const listed = await fetchNodes(
      server.url,
      activeServerToken(server),
      server.season,
      surface,
      signal,
    )
    const current = getState().servers.find((candidate) => candidate.url === server.url)
    if (!listed.ok || current === undefined || !isCurrentServerConnection(server))
      return { status: 'unreachable' }
    return { status: 'ok', nodes: listed.nodes }
  }
  const contents = await listServerContents(server, signal)
  const current = getState().servers.find((candidate) => candidate.url === server.url)
  if (contents === null || current === undefined || !isCurrentServerConnection(server))
    return { status: 'unreachable' }
  const admitted = admittedServerContentsFor(current)
  return admitted === null ? { status: 'not-admitted' } : { status: 'ok', nodes: admitted.nodes }
}

/**
 * The templates alone, or null when the server could not be asked.
 *
 * Null and empty are kept apart on purpose. A failed fetch used to answer with an empty list, and
 * the sync read that as "this server publishes nothing" — so one blip, or a server restarting, took
 * every template off the canvas and the next success put them back as if they were new.
 */
export const listServerTemplates = async (
  server: ConnectedServer,
): Promise<readonly ServerTemplate[] | null> => {
  const contents = await listServerContents(server)
  return contents === null || !isLatestServerContents(server.url, contents)
    ? null
    : contents.templates
}

export const patchTemplate = async (
  server: ConnectedServer,
  templateId: string,
  patch: {
    name?: string
    nodeId?: string | null
    published?: boolean
    finished?: boolean
    timelapseFrozen?: boolean
  },
): Promise<{ ok: true } | { ok: false; message: string; retryable?: true }> => {
  try {
    const { response, body } = await requestServerMutation(
      serverEndpoint(server.url, `/admin/templates/${templateId}`),
      {
        method: 'PATCH',
        headers: adminHeaders(server),
        body: JSON.stringify(patch),
      },
    )
    if (response.status === 401 || response.status === 403) noteAuthFailure(server, response.status)
    if (response.ok) return { ok: true }
    return {
      ok: false,
      message: failure(response, isRecord(body) ? body : null),
      ...(response.status === 408 || response.status === 429 || response.status >= 500
        ? { retryable: true as const }
        : {}),
    }
  } catch (error) {
    return { ok: false, message: String(error), retryable: true }
  }
}

/**
 * Rename a server — the name every member sees, not a label local to this browser.
 *
 * Worth being explicit about, because the row it is edited from looks exactly like the Local one
 * above it, and that one *is* local. This writes to the server, and the next member to open their
 * panel sees the new name.
 *
 * The local copy is refreshed from public server metadata after the write. The mutation response
 * has no revision, so applying the submitted name directly could overwrite a newer rename learned
 * by a connection that replaced this one while the response was delayed.
 */
const activeServerRenames = new Set<string>()

export const renameServer = async (
  server: ConnectedServer,
  name: string,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const trimmed = name.trim()
  if (trimmed === '') return { ok: false, message: 'A server needs a name.' }
  if (activeServerRenames.has(server.url)) {
    return {
      ok: false,
      message: 'A rename for this server is already in progress.',
    }
  }
  activeServerRenames.add(server.url)
  try {
    const { response, body } = await requestServerMutation(
      serverEndpoint(server.url, '/admin/server'),
      {
        method: 'PATCH',
        headers: adminHeaders(server),
        body: JSON.stringify({ name: trimmed }),
      },
    )
    if (response.status === 401 || response.status === 403) noteAuthFailure(server, response.status)
    if (!response.ok) {
      return {
        ok: false,
        message: failure(response, isRecord(body) ? body : null),
      }
    }
    const current = getState().servers.find((candidate) => candidate.url === server.url)
    if (current !== undefined && current.info !== null && server.info !== null) {
      let refreshed: ServerInfo | null = null
      try {
        const metadata = await requestServerMetadata(serverEndpoint(current.url, '/server'))
        if (metadata.response.ok) refreshed = parseServerInfo(metadata.body)
      } catch {
        // The PATCH already committed. A failed cosmetic refresh must not turn success into failure.
      }
      const latest = getState().servers.find((candidate) => candidate.url === server.url)
      if (
        latest !== undefined &&
        latest.info !== null &&
        isCurrentServerConnection(current) &&
        latest.info === current.info &&
        refreshed !== null &&
        refreshed.id === server.info.id &&
        latest.info.id === refreshed.id
      ) {
        upsertServer({ ...latest, info: refreshed })
      } else if (
        latest !== undefined &&
        latest.info !== null &&
        isCurrentServerConnection(server) &&
        latest.info === current.info &&
        refreshed === null &&
        latest.info.id === server.info.id
      ) {
        // Preserve the immediate feedback when the metadata read alone failed. This fallback is
        // safe only in the connection lifetime that submitted the write.
        upsertServer({ ...latest, info: { ...latest.info, name: trimmed } })
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, message: String(error) }
  } finally {
    activeServerRenames.delete(server.url)
  }
}

export const deleteTemplate = async (
  server: ConnectedServer,
  templateId: string,
  expected: { readonly version: string; readonly updatedAt: number },
): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    const query = new URLSearchParams({
      expectedVersion: expected.version,
      expectedUpdatedAt: String(expected.updatedAt),
    })
    const { response, body } = await requestServerMutation(
      serverEndpoint(server.url, `/admin/templates/${templateId}?${query}`),
      {
        method: 'DELETE',
        headers: adminHeaders(server),
      },
    )
    if (response.status === 401 || response.status === 403) noteAuthFailure(server, response.status)
    if (response.ok) return { ok: true }
    return {
      ok: false,
      message: failure(response, isRecord(body) ? body : null),
    }
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
): Promise<{ ok: true; versionId: string } | UploadFailure> => {
  const begun = beginUpload(server)
  if ('failure' in begun) return begun.failure
  try {
    const form = new FormData()
    form.set('png', input.png, `${input.name}.png`)
    form.set('originX', String(input.originX))
    form.set('originY', String(input.originY))
    const { response, body } = await requestServerUpload(
      serverEndpoint(server.url, `/admin/templates/${templateId}/versions`),
      {
        method: 'POST',
        headers:
          activeServerToken(server) === null
            ? {}
            : { authorization: `Bearer ${activeServerToken(server)}` },
        body: form,
      },
    )
    if (response.status === 401 || response.status === 403) noteAuthFailure(server, response.status)
    if (response.ok) {
      const versionId = isRecord(body) ? body.versionId : undefined
      // A 2xx with no usable id is not a success we can report: the server never confirmed what it
      // stored. `uploadTemplate` rejects the same shape, and Replace announcing "done" on it told
      // the user their artwork had been replaced on no evidence at all.
      return typeof versionId === 'string' && UUID_V7.test(versionId)
        ? { ok: true, versionId }
        : markUploadAmbiguous(
            server,
            'The server accepted the upload but did not say what it stored.',
          )
    }
    const message = failure(response, isRecord(body) ? body : null)
    return response.status >= 500 ? markUploadAmbiguous(server, message) : { ok: false, message }
  } catch (error) {
    return markUploadAmbiguous(server, String(error))
  } finally {
    endUpload(server.url, begun.token)
  }
}

/**
 * An access token as the server will ever describe it back to us.
 *
 * No secret. The plaintext exists once, in the response to the call that mints it, and is never
 * stored anywhere — the server keeps a hash, so there is nothing to reveal later even if a route
 * wanted to. Which is the point: a list that could show them would turn one leaked admin session
 * into every token the server has.
 */
interface StoredAccessToken {
  readonly tokenHash: string
  readonly label: string
  readonly scope: 'read' | 'report' | 'admin'
  readonly createdWithToken: string
  readonly createdAt: number
  readonly bootstrap?: false
}

/** The operator credential is environment-owned and therefore has no revocable token hash. */
interface BootstrapAccessToken {
  readonly label: string
  readonly scope: 'admin'
  readonly createdAt: number
  readonly bootstrap: true
}

export type AccessToken = StoredAccessToken | BootstrapAccessToken

export interface AccessTokenPage {
  readonly tokens: readonly AccessToken[]
  readonly nextCursor: string | null
}

const SCOPES: readonly string[] = ['read', 'report', 'admin']
const TOKEN_CURSOR = /^(0|[1-9]\d*):[0-9a-f]{64}$/

/**
 * A configured server is someone else's machine, so its token list is checked rather than trusted:
 * the panel renders these rows and hands `tokenHash` straight back as a URL path segment.
 */
const asAccessToken = (value: unknown): AccessToken | null => {
  if (!isRecord(value)) return null
  const { label, scope, createdAt, bootstrap, tokenHash, createdWithToken } = value
  if (typeof label !== 'string' || typeof createdAt !== 'number') return null
  if (typeof scope !== 'string' || !SCOPES.includes(scope)) return null
  if (bootstrap === true) return { label, scope: 'admin', createdAt, bootstrap: true }
  if (typeof tokenHash !== 'string' || !/^[0-9a-f]{1,128}$/.test(tokenHash)) return null
  return {
    tokenHash,
    label,
    scope: scope as StoredAccessToken['scope'],
    createdWithToken: typeof createdWithToken === 'string' ? createdWithToken : '',
    createdAt,
  }
}

export const listAccessTokens = async (
  server: ConnectedServer,
  cursor: string | null = null,
): Promise<AccessTokenPage | null> => {
  try {
    const suffix = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`
    const { response, body } = await requestServerMutation(
      serverEndpoint(server.url, `/admin/tokens${suffix}`),
      {
        headers: adminHeaders(server),
      },
    )
    if (response.status === 401 || response.status === 403) noteAuthFailure(server, response.status)
    if (!response.ok) return null
    const tokens = isRecord(body) ? body.tokens : undefined
    // Pagination was added after the token-list route. Older and third-party servers legitimately
    // omit the field, which means the one page they returned is the last one.
    const nextCursor = isRecord(body) ? (body.nextCursor ?? null) : null
    if (
      !Array.isArray(tokens) ||
      (nextCursor !== null && (typeof nextCursor !== 'string' || !TOKEN_CURSOR.test(nextCursor)))
    )
      return null
    const parsed = tokens.map(asAccessToken)
    if (parsed.some((token) => token === null)) return null
    return { tokens: parsed as AccessToken[], nextCursor }
  } catch {
    // Null rather than empty, so the panel can say "could not ask" instead of "there are none" —
    // the difference between those two is the difference between a blip and a server with no way in.
    return null
  }
}

/** Mint one. The `token` in the result is the only time the plaintext will ever exist here. */
export const createAccessToken = async (
  server: ConnectedServer,
  label: string,
  scope: AccessToken['scope'],
): Promise<{ ok: true; token: string } | { ok: false; message: string }> => {
  try {
    const { response, body } = await requestServerMutation(
      serverEndpoint(server.url, '/admin/tokens'),
      {
        method: 'POST',
        headers: adminHeaders(server),
        body: JSON.stringify({ label, scope }),
      },
    )
    if (response.status === 401 || response.status === 403) noteAuthFailure(server, response.status)
    const token = isRecord(body) ? body.token : undefined
    if (response.ok && typeof token === 'string') return { ok: true, token }
    return {
      ok: false,
      message: failure(response, isRecord(body) ? body : null),
    }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

/**
 * Revoke one, by the hash the list gave us. Revocation deletes the stored token row.
 */
export const revokeAccessToken = async (
  server: ConnectedServer,
  tokenHash: string,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    const { response, body } = await requestServerMutation(
      serverEndpoint(server.url, `/admin/tokens/${encodeURIComponent(tokenHash)}`),
      {
        method: 'DELETE',
        headers: adminHeaders(server),
      },
    )
    if (response.status === 401 || response.status === 403) noteAuthFailure(server, response.status)
    if (response.ok) return { ok: true }
    return {
      ok: false,
      message: failure(response, isRecord(body) ? body : null),
    }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}
