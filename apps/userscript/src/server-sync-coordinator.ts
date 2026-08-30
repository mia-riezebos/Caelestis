import { SERVER_SYNC_FALLBACK_MIN_MS, type SyncRequestMetadata } from '@caelestis/shared'
import { warn } from './debug.js'
import {
  type ConnectedServer,
  getState,
  isCurrentServerConnection,
  onServerContents,
  onStateChange,
  type ServerContents,
  sameServerConnection,
} from './state.js'

export type ServerSyncResource = 'alarms' | 'manifest' | 'status'
export type ServerSyncRefresh = (
  server: ConnectedServer,
  metadata: SyncRequestMetadata,
) => Promise<string | null>

const CHANGED_RECHECK_MS = 60_000
const MAX_JITTER_MS = 30_000

interface ResourceState {
  revision?: string
  inFlight?: Promise<void>
  responseSerial: number
  nextAt: number | null
}

interface ConnectionState {
  readonly server: ConnectedServer
  readonly resources: Map<ServerSyncResource, ResourceState>
}

const refreshers = new Map<ServerSyncResource, ServerSyncRefresh>()
const connections = new Map<string, ConnectionState>()
let installed = false
let suspended = false
let timer: ReturnType<typeof setTimeout> | null = null

const online = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false

const active = (): boolean =>
  (typeof document === 'undefined' || document.visibilityState !== 'hidden') && online()

const connectedServers = (): readonly ConnectedServer[] =>
  getState().servers.filter((server) => server.status === 'connected' && server.season !== null)

const stateFor = (server: ConnectedServer): ConnectionState => {
  const current = connections.get(server.url)
  if (current !== undefined && sameServerConnection(current.server, server)) return current
  const replacement: ConnectionState = {
    server,
    resources: new Map(),
  }
  connections.set(server.url, replacement)
  return replacement
}

const resourceStateFor = (state: ConnectionState, resource: ServerSyncResource): ResourceState => {
  const current = state.resources.get(resource)
  if (current !== undefined) return current
  const created: ResourceState = { responseSerial: 0, nextAt: null }
  state.resources.set(resource, created)
  return created
}

const scheduleTimer = (): void => {
  if (timer !== null) clearTimeout(timer)
  timer = null
  if (!active()) {
    suspended = true
    return
  }
  let nextAt = Number.POSITIVE_INFINITY
  for (const state of connections.values()) {
    for (const resource of state.resources.values()) {
      if (resource.nextAt !== null) nextAt = Math.min(nextAt, resource.nextAt)
    }
  }
  if (!Number.isFinite(nextAt)) return
  timer = setTimeout(
    () => {
      timer = null
      const now = Date.now()
      for (const state of connections.values()) {
        const due: ServerSyncResource[] = []
        for (const [resource, resourceState] of state.resources) {
          if (resourceState.nextAt === null || resourceState.nextAt > now) continue
          resourceState.nextAt = null
          if (resourceState.inFlight !== undefined) {
            preserveFallbackAfter(state, resource, resourceState.inFlight)
            continue
          }
          due.push(resource)
        }
        if (due.length === 0) continue
        void refreshConnection(state, due, {
          mode: 'compatibility-poll',
          reason: 'interval',
        })
      }
      scheduleTimer()
    },
    Math.max(0, nextAt - Date.now()),
  )
}

const scheduleFallback = (
  state: ConnectionState,
  resource: ServerSyncResource,
  changed: boolean,
): void => {
  if (connections.get(state.server.url) !== state) return
  const base = changed ? CHANGED_RECHECK_MS : SERVER_SYNC_FALLBACK_MIN_MS
  resourceStateFor(state, resource).nextAt =
    Date.now() + base + Math.floor(Math.random() * (MAX_JITTER_MS + 1))
  scheduleTimer()
}

const preserveFallbackAfter = (
  state: ConnectionState,
  resource: ServerSyncResource,
  running: Promise<void>,
): void => {
  void running.then(() => {
    if (connections.get(state.server.url) !== state) return
    const resourceState = resourceStateFor(state, resource)
    if (resourceState.nextAt === null) scheduleFallback(state, resource, false)
  })
}

const noteResponse = (
  server: ConnectedServer,
  resource: ServerSyncResource,
  revision: string,
): void => {
  if (!isCurrentServerConnection(server)) return
  const state = stateFor(server)
  const resourceState = resourceStateFor(state, resource)
  const changed = resourceState.revision !== undefined && resourceState.revision !== revision
  resourceState.responseSerial += 1
  resourceState.revision = revision
  scheduleFallback(state, resource, changed)
}

const runResource = (
  state: ConnectionState,
  resource: ServerSyncResource,
  metadata: SyncRequestMetadata,
): Promise<void> => {
  const resourceState = resourceStateFor(state, resource)
  if (resourceState.inFlight !== undefined) return resourceState.inFlight
  const refresh = refreshers.get(resource)
  if (refresh === undefined) return Promise.resolve()
  const beforeResponse = resourceState.responseSerial
  const running = (async () => {
    try {
      const revision = await refresh(state.server, metadata)
      if (revision !== null) noteResponse(state.server, resource, revision)
    } catch (error) {
      warn('install', `could not refresh server ${resource}`, String(error))
    } finally {
      if (resourceState.responseSerial === beforeResponse) scheduleFallback(state, resource, false)
    }
  })()
  resourceState.inFlight = running
  const release = (): void => {
    if (resourceState.inFlight === running) delete resourceState.inFlight
  }
  void running.then(release, release)
  return running
}

const refreshConnection = async (
  state: ConnectionState,
  resources: readonly ServerSyncResource[],
  metadata: SyncRequestMetadata,
): Promise<void> => {
  if (!active()) {
    suspended = true
    scheduleTimer()
    return
  }
  if (connections.get(state.server.url) !== state || !isCurrentServerConnection(state.server))
    return
  await Promise.all(resources.map((resource) => runResource(state, resource, metadata)))
}

export const registerServerSyncResource = (
  resource: ServerSyncResource,
  refresh: ServerSyncRefresh,
): void => {
  refreshers.set(resource, refresh)
}

export const requestServerSync = async (
  server: ConnectedServer,
  resources: readonly ServerSyncResource[],
  metadata: SyncRequestMetadata,
): Promise<void> => {
  if (!isCurrentServerConnection(server)) return
  await refreshConnection(stateFor(server), resources, metadata)
}

/**
 * Apply an authoritative event after any read that started before it, coalescing concurrent events
 * onto one bounded follow-up per resource.
 */
export const requestServerSyncAfterCurrent = async (
  server: ConnectedServer,
  resources: readonly ServerSyncResource[],
  metadata: SyncRequestMetadata,
): Promise<void> => {
  if (!isCurrentServerConnection(server) || !online()) return
  const state = stateFor(server)
  await Promise.all(
    resources.map(async (resource) => {
      const current = resourceStateFor(state, resource).inFlight
      if (current !== undefined) await current
      if (connections.get(server.url) !== state || !isCurrentServerConnection(server) || !online())
        return
      await runResource(state, resource, metadata)
    }),
  )
}

const manifestRevision = (contents: ServerContents): string => JSON.stringify(contents)

const refreshActive = (reason: 'focus' | 'visibility' | 'online'): void => {
  if (!active()) return
  suspended = false
  for (const server of connectedServers()) {
    void requestServerSyncAfterCurrent(server, [...refreshers.keys()], {
      mode: 'recovery',
      reason,
    })
  }
}

const recover = (reason: 'visibility' | 'online'): void => {
  if (!active() || !suspended) return
  refreshActive(reason)
}

export const installServerSyncCoordinator = (): void => {
  if (installed) return
  installed = true
  onServerContents((server, contents) => {
    noteResponse(server, 'manifest', manifestRevision(contents))
  })
  onStateChange(() => {
    const connected = connectedServers()
    const urls = new Set(connected.map((server) => server.url))
    for (const url of connections.keys()) {
      if (!urls.has(url)) connections.delete(url)
    }
    for (const server of connected) {
      const previous = connections.get(server.url)
      if (previous !== undefined && sameServerConnection(previous.server, server)) continue
      const state = stateFor(server)
      if (active())
        void refreshConnection(state, [...refreshers.keys()], {
          mode: 'recovery',
          reason: 'state-change',
        })
      else suspended = true
    }
    scheduleTimer()
  })
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        suspended = true
        scheduleTimer()
      } else recover('visibility')
    })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('offline', () => {
      suspended = true
      scheduleTimer()
    })
    window.addEventListener('online', () => recover('online'))
    window.addEventListener('focus', () => refreshActive('focus'))
  }
  if (!active()) {
    suspended = true
    return
  }
  for (const server of connectedServers()) {
    void refreshConnection(stateFor(server), [...refreshers.keys()], {
      mode: 'recovery',
      reason: 'connect',
    })
  }
}
