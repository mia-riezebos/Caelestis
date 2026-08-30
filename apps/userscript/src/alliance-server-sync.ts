import { sameTemplateSurface, type TemplateSurface, templateSurfaceKey } from '@caelestis/shared'
import { activeAllianceSurface, onActiveAllianceSurfaceChange } from './alliance-surface.js'
import { count } from './debug.js'
import type { ServerManifest } from './server-manifest.js'
import { parseServerManifest } from './server-manifest.js'
import { serverEndpoint } from './server-url.js'
import { activeServerToken, type ConnectedServer, getState, onStateChange } from './state.js'
import { syncServerTemplates } from './templates/server-sync.js'

const MANIFEST_TIMEOUT_MS = 15_000
const POLL_MS = 60_000

let installed = false
let generation = 0
let controller: AbortController | null = null
let selected: TemplateSurface | null = null
const manifests = new Map<string, ServerManifest>()
const manifestListeners = new Set<() => void>()

const manifestKey = (serverUrl: string, surface: TemplateSurface): string =>
  `${serverUrl}\n${templateSurfaceKey(surface)}`

const notifyManifestChange = (): void => {
  for (const listener of manifestListeners) listener()
}

/** The scoped rows behind the alliance panel; absent until that exact manifest has arrived. */
export const allianceManifestFor = (
  serverUrl: string,
  surface: TemplateSurface,
): ServerManifest | null => manifests.get(manifestKey(serverUrl, surface)) ?? null

export const onAllianceManifestChange = (listener: () => void): (() => void) => {
  manifestListeners.add(listener)
  return () => manifestListeners.delete(listener)
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
  if (!currentSurface(surface, ownGeneration)) {
    count('alliance-sync:surface superseded')
    return
  }
  const query = new URLSearchParams({
    season: String(server.season),
    surface: surface.kind,
    allianceId: String(surface.allianceId),
  })
  try {
    count('alliance-sync:manifest requested')
    const token = activeServerToken(server)
    const response = await fetch(serverEndpoint(server.url, `/manifest?${query}`), {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(MANIFEST_TIMEOUT_MS)]),
    })
    if (!response.ok || !currentSurface(surface, ownGeneration)) {
      count('alliance-sync:manifest refused')
      return
    }
    const manifest = parseServerManifest(await response.json(), server.info, surface)
    if (manifest === null || !currentSurface(surface, ownGeneration)) {
      count('alliance-sync:manifest invalid')
      return
    }
    count('alliance-sync:manifest admitted')
    manifests.set(manifestKey(server.url, surface), manifest)
    notifyManifestChange()
    await syncServerTemplates(
      server,
      manifest.templates,
      () => currentSurface(surface, ownGeneration),
      surface,
    )
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
  const signal = controller?.signal
  if (signal === undefined) {
    count('alliance-sync:no controller')
    return
  }
  count('alliance-sync:sweep')
  for (const server of getState().servers) void readServer(server, surface, ownGeneration, signal)
}

const retire = (surface: TemplateSurface): void => {
  let changed = false
  for (const server of getState().servers) {
    changed = manifests.delete(manifestKey(server.url, surface)) || changed
    if (server.status === 'connected') void syncServerTemplates(server, [], undefined, surface)
  }
  if (changed) notifyManifestChange()
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
  controller?.abort()
  controller = next === null ? null : new AbortController()
  if (previous !== null) retire(previous)
  syncSelected()
}

/** Poll exact alliance surface manifests only while that Wplace editor is active. */
export const installAllianceServerSync = (): void => {
  if (installed) return
  installed = true
  onActiveAllianceSurfaceChange(selectActiveSurface)
  onStateChange(syncSelected)
  selectActiveSurface()
  setInterval(syncSelected, POLL_MS)
}

/** Stable diagnostic key for the currently selected alliance manifest scope. */
export const selectedAllianceManifestScope = (): string | null =>
  selected === null ? null : templateSurfaceKey(selected)
