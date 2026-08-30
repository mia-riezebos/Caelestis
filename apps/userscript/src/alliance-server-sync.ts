import { sameTemplateSurface, type TemplateSurface, templateSurfaceKey } from '@caelestis/shared'
import { activeAllianceSurface, onActiveAllianceSurfaceChange } from './alliance-surface.js'
import { count } from './debug.js'
import type { ServerManifest } from './server-manifest.js'
import { parseServerManifest } from './server-manifest.js'
import { serverEndpoint } from './server-url.js'
import {
  activeServerToken,
  type ConnectedServer,
  getState,
  isCurrentServerConnection,
  onStateChange,
  type State,
  sameServerConnection,
} from './state.js'
import { forgetServerSurfaceTemplates } from './templates/local-store.js'
import { forgetSurfaceNodes, rememberNodes } from './templates/server-nodes.js'
import { syncServerTemplates } from './templates/server-sync.js'

const MANIFEST_TIMEOUT_MS = 15_000
const POLL_MS = 60_000

let installed = false
let generation = 0
let controller: AbortController | null = null
let selected: TemplateSurface | null = null
let readyGeneration = -1
let transition = Promise.resolve()
let lastConnectedServers: readonly ConnectedServer[] = []
const manifests = new Map<
  string,
  { readonly owner: ConnectedServer; readonly manifest: ServerManifest }
>()
const requestSequences = new Map<string, number>()
const manifestListeners = new Set<() => void>()

const manifestKey = (serverUrl: string, surface: TemplateSurface): string =>
  `${serverUrl}\n${templateSurfaceKey(surface)}`

const notifyManifestChange = (): void => {
  for (const listener of manifestListeners) listener()
}

/** The scoped rows behind the alliance panel; absent until that exact manifest has arrived. */
export const allianceManifestFor = (
  server: ConnectedServer,
  surface: TemplateSurface,
): ServerManifest | null => {
  const admitted = manifests.get(manifestKey(server.url, surface))
  return admitted !== undefined &&
    isCurrentServerConnection(server) &&
    isCurrentServerConnection(admitted.owner)
    ? admitted.manifest
    : null
}

export const onAllianceManifestChange = (listener: () => void): (() => void) => {
  manifestListeners.add(listener)
  return () => manifestListeners.delete(listener)
}

/** Refresh one server after an alliance-surface edit instead of waiting for the next poll. */
export const refreshAllianceManifest = async (
  server: ConnectedServer,
  surface: TemplateSurface,
): Promise<void> => {
  const ownGeneration = generation
  const signal = controller?.signal
  if (
    signal === undefined ||
    readyGeneration !== ownGeneration ||
    selected === null ||
    !sameTemplateSurface(selected, surface)
  )
    return
  const current = getState().servers.find((candidate) => candidate.url === server.url)
  if (current === undefined || !isCurrentServerConnection(current)) return
  await readServer(current, surface, ownGeneration, signal)
}

const currentSurface = (surface: TemplateSurface, ownGeneration: number): boolean => {
  const active = activeAllianceSurface()
  return (
    generation === ownGeneration && active !== null && sameTemplateSurface(active.surface, surface)
  )
}

const readServer = async (
  server: ConnectedServer,
  surface: TemplateSurface,
  ownGeneration: number,
  signal: AbortSignal,
): Promise<void> => {
  count('alliance-sync:server considered')
  if (server.status !== 'connected') {
    count('alliance-sync:server not connected')
    return
  }
  if (server.info === null || server.season === null) {
    count('alliance-sync:server identity unavailable')
    return
  }
  if (!isCurrentServerConnection(server)) {
    count('alliance-sync:server superseded')
    return
  }
  if (!currentSurface(surface, ownGeneration)) {
    count('alliance-sync:surface superseded')
    return
  }
  const query = new URLSearchParams({
    season: String(server.season),
    surface: surface.kind,
    allianceId: String(surface.allianceId),
  })
  const key = manifestKey(server.url, surface)
  const requestSequence = (requestSequences.get(key) ?? 0) + 1
  requestSequences.set(key, requestSequence)
  const requestCurrent = (): boolean =>
    requestSequences.get(key) === requestSequence &&
    currentSurface(surface, ownGeneration) &&
    isCurrentServerConnection(server)
  try {
    count('alliance-sync:manifest requested')
    const token = activeServerToken(server)
    const response = await fetch(serverEndpoint(server.url, `/manifest?${query}`), {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(MANIFEST_TIMEOUT_MS)]),
    })
    if (!response.ok || !requestCurrent()) {
      count('alliance-sync:manifest refused')
      return
    }
    const manifest = parseServerManifest(await response.json(), server.info, surface)
    if (manifest === null || manifest.season !== server.season || !requestCurrent()) {
      count('alliance-sync:manifest invalid')
      return
    }
    count('alliance-sync:manifest admitted')
    manifests.set(key, { owner: server, manifest })
    rememberNodes(server.url, manifest.nodes, surface)
    notifyManifestChange()
    await syncServerTemplates(server, manifest.templates, requestCurrent, surface)
  } catch {
    count('alliance-sync:manifest failed')
    // A failed alliance poll keeps the last admitted overlay, like the world manifest poll.
  }
}

const syncSelected = (): void => {
  const surface = selected
  if (surface === null) {
    count('alliance-sync:no selected surface')
    return
  }
  const ownGeneration = generation
  if (readyGeneration !== ownGeneration) {
    count('alliance-sync:surface retiring')
    return
  }
  const signal = controller?.signal
  if (signal === undefined) {
    count('alliance-sync:no controller')
    return
  }
  count('alliance-sync:sweep')
  for (const server of getState().servers) void readServer(server, surface, ownGeneration, signal)
}

const retire = async (surface: TemplateSurface): Promise<void> => {
  let changed = false
  const removals: Promise<void>[] = []
  for (const server of getState().servers) {
    changed = manifests.delete(manifestKey(server.url, surface)) || changed
    forgetSurfaceNodes(server.url, surface)
    if (server.status === 'connected') {
      removals.push(syncServerTemplates(server, [], undefined, surface))
    }
  }
  if (changed) notifyManifestChange()
  await Promise.all(removals)
}

const selectActiveSurface = (): void => {
  const next = activeAllianceSurface()?.surface ?? null
  if (
    selected === next ||
    (selected !== null && next !== null && sameTemplateSurface(selected, next))
  )
    return
  const previous = selected
  selected = next
  generation++
  readyGeneration = -1
  const ownGeneration = generation
  controller?.abort()
  controller = next === null ? null : new AbortController()
  transition = transition
    .catch(() => undefined)
    .then(async () => {
      if (previous !== null) await retire(previous)
      if (generation !== ownGeneration) return
      readyGeneration = ownGeneration
      syncSelected()
    })
  void transition.catch(() => undefined)
}

const connectedServers = (state: State): readonly ConnectedServer[] =>
  state.servers.filter((server) => server.status === 'connected')

const connectionsChanged = (next: readonly ConnectedServer[]): boolean =>
  next.length !== lastConnectedServers.length ||
  lastConnectedServers.some((previous) => !isCurrentServerConnection(previous)) ||
  next.some(
    (server) => !lastConnectedServers.some((previous) => sameServerConnection(previous, server)),
  )

const stateChanged = (next: State): void => {
  const connected = connectedServers(next)
  if (!connectionsChanged(connected)) return
  const surface = selected
  let changed = false
  if (surface !== null) {
    for (const previous of lastConnectedServers) {
      if (isCurrentServerConnection(previous)) continue
      const key = manifestKey(previous.url, surface)
      changed = manifests.delete(key) || changed
      requestSequences.delete(key)
      forgetSurfaceNodes(previous.url, surface)
      void forgetServerSurfaceTemplates(previous.url, surface)
    }
  }
  lastConnectedServers = connected
  if (changed) notifyManifestChange()
  syncSelected()
}

/** Poll exact alliance surface manifests only while that Wplace editor is active. */
export const installAllianceServerSync = (): void => {
  if (installed) return
  installed = true
  lastConnectedServers = connectedServers(getState())
  onActiveAllianceSurfaceChange(selectActiveSurface)
  onStateChange(stateChanged)
  selectActiveSurface()
  setInterval(syncSelected, POLL_MS)
}

/** Stable diagnostic key for the currently selected alliance manifest scope. */
export const selectedAllianceManifestScope = (): string | null =>
  selected === null ? null : templateSurfaceKey(selected)
