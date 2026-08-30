import {
  type ReconciliationReason,
  sameTemplateSurface,
  type TemplateSurface,
  templateSurfaceKey,
} from '@caelestis/shared'
import { activeAllianceSurface, onActiveAllianceSurfaceChange } from './alliance-surface.js'
import { userscriptClientHeaders } from './client-metrics.js'
import { count } from './debug.js'
import type { ServerManifest } from './server-manifest.js'
import { parseServerManifest } from './server-manifest.js'
import { coalesceServerRead } from './server-read-coalescer.js'
import {
  registerServerSyncResource,
  requestServerSync,
  type ServerSyncResult,
} from './server-sync-coordinator.js'
import { serverEndpoint } from './server-url.js'
import {
  activeServerToken,
  type ConnectedServer,
  getState,
  serverConnectionIdentity,
} from './state.js'
import { syncServerTemplates } from './templates/server-sync.js'

const MANIFEST_TIMEOUT_MS = 15_000
const ALLIANCE_MANIFEST_RESOURCE = 'alliance-manifest'

let installed = false
let generation = 0
let controller: AbortController | null = null
let selected: TemplateSurface | null = null
let readyGeneration = -1
let transition = Promise.resolve()
const manifests = new Map<string, ServerManifest>()
const requestSequences = new Map<string, number>()
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
  reason: ReconciliationReason,
): Promise<ServerSyncResult> => {
  count('alliance-sync:server considered')
  if (server.status !== 'connected') {
    count('alliance-sync:server not connected')
    return { status: 'skipped' }
  }
  if (server.info === null || server.season === null) {
    count('alliance-sync:server identity unavailable')
    return { status: 'skipped' }
  }
  if (!currentSurface(surface, ownGeneration)) {
    count('alliance-sync:surface superseded')
    return { status: 'skipped' }
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
    requestSequences.get(key) === requestSequence && currentSurface(surface, ownGeneration)
  try {
    count('alliance-sync:manifest requested')
    const token = activeServerToken(server)
    const response = await coalesceServerRead(
      serverConnectionIdentity(server),
      `${server.season}\u0000${templateSurfaceKey(surface)}\u0000manifest`,
      async () =>
        await fetch(serverEndpoint(server.url, `/manifest?${query}`), {
          headers: {
            ...userscriptClientHeaders({ transport: 'compatibility-poll', reason }),
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          },
          signal: AbortSignal.any([signal, AbortSignal.timeout(MANIFEST_TIMEOUT_MS)]),
        }),
    )
    if (!response.ok || !requestCurrent()) {
      count('alliance-sync:manifest refused')
      return { status: 'failed' }
    }
    const manifest = parseServerManifest(await response.json(), server.info, surface)
    if (manifest === null || manifest.season !== server.season || !requestCurrent()) {
      count('alliance-sync:manifest invalid')
      return { status: 'failed' }
    }
    count('alliance-sync:manifest admitted')
    manifests.set(key, manifest)
    notifyManifestChange()
    await syncServerTemplates(server, manifest.templates, requestCurrent, surface)
    return { status: 'unchanged', revision: manifest.version }
  } catch {
    count('alliance-sync:manifest failed')
    // A failed alliance poll keeps the last admitted overlay, like the world manifest poll.
    return { status: 'failed' }
  }
}

const retire = async (surface: TemplateSurface): Promise<void> => {
  let changed = false
  const removals: Promise<void>[] = []
  for (const server of getState().servers) {
    changed = manifests.delete(manifestKey(server.url, surface)) || changed
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
      requestServerSync('state-change', ALLIANCE_MANIFEST_RESOURCE)
    })
  void transition.catch(() => undefined)
}

/** Poll exact alliance surface manifests only while that Wplace editor is active. */
export const installAllianceServerSync = (): void => {
  if (installed) return
  installed = true
  onActiveAllianceSurfaceChange(selectActiveSurface)
  registerServerSyncResource({
    id: ALLIANCE_MANIFEST_RESOURCE,
    scope: () =>
      selected !== null && readyGeneration === generation ? templateSurfaceKey(selected) : null,
    refresh: async (server, reason) => {
      const surface = selected
      const signal = controller?.signal
      if (surface === null || signal === undefined || readyGeneration !== generation)
        return { status: 'skipped' }
      return readServer(server, surface, generation, signal, reason)
    },
  })
  selectActiveSurface()
}

/** Stable diagnostic key for the currently selected alliance manifest scope. */
export const selectedAllianceManifestScope = (): string | null =>
  selected === null ? null : templateSurfaceKey(selected)
