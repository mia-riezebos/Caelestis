import type { LiveSyncServerEvent, ReconciliationReason, SyncTransport } from '@caelestis/shared'
import { serverEndpoint } from './server-url.js'
import {
  type ConnectedServer,
  getState,
  isCurrentServerConnection,
  onStateChange,
  serverConnectionIdentity,
} from './state.js'

const INITIAL_POLL_MS = 60_000
const MAX_UNCHANGED_POLL_MS = 5 * 60_000
const JITTER_RANGE_MS = 30_000
const REFRESH_CONCURRENCY = 4
const LIVE_PROTOCOL = 'caelestis.live.v1'
const LIVE_AUTH_PREFIX = 'caelestis.auth.b64.'
const MAX_LIVE_MESSAGE_BYTES = 64 * 1024
const MAX_RECONNECT_MS = 30_000
const LIVE_HEARTBEAT_MS = 15 * 60_000
const LIVE_HEARTBEAT_TIMEOUT_MS = 10_000
const LIVE_RECOVERY_POLL_MS = 60 * 60_000

export type ParsedLiveEvent =
  | Exclude<LiveSyncServerEvent, { readonly type: 'manifest-reconcile' }>
  | { readonly type: 'manifest-reconcile'; readonly revision: number | null }

export interface ServerSyncResult {
  readonly status: 'changed' | 'unchanged' | 'failed' | 'skipped'
  readonly revision?: string
}

export interface ServerSyncResource {
  /** Stable resource dimension, such as `manifest`, `status`, or `alarms`. */
  readonly id: string
  /** Stable visibility scope. Null means the resource is not active for this server. */
  readonly scope: (server: ConnectedServer) => string | null
  readonly refresh: (
    server: ConnectedServer,
    reason: ReconciliationReason,
    transport: SyncTransport,
  ) => Promise<ServerSyncResult>
  /** Healthy live transport suppresses interval polling for this resource. */
  readonly live?: boolean
  /** Optional resource-owned validation/application for a compact live event. */
  readonly applyLiveEvent?: (server: ConnectedServer, event: unknown) => boolean
}

interface Schedule {
  readonly server: ConnectedServer
  readonly scope: string
  readonly resource: string
  readonly revision?: string
  readonly unchanged: number
  readonly dueAt: number
}

interface PendingResourceRequest {
  allReason?: ReconciliationReason
  readonly servers: Map<object, ReconciliationReason>
}

interface LiveConnection {
  readonly server: ConnectedServer
  socket: WebSocket | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimeout: ReturnType<typeof setTimeout> | null
  attempts: number
  healthy: boolean
  manifestRevision: number | null
}

const resources = new Map<string, ServerSyncResource>()
const schedules = new Map<string, Schedule>()
const running = new WeakMap<object, Map<string, Promise<void>>>()
let installed = false
let timer: ReturnType<typeof setTimeout> | null = null
let sweepRun: Promise<void> | null = null
let requestedResources: Map<string, PendingResourceRequest> | null = new Map()
const liveConnections = new Map<object, LiveConnection>()

const connected = (): readonly ConnectedServer[] =>
  getState().servers.filter(
    (server) => server.status === 'connected' && server.info !== null && server.season !== null,
  )

const activeDocument = (): boolean =>
  (typeof document === 'undefined' || document.visibilityState !== 'hidden') &&
  (typeof navigator === 'undefined' || navigator.onLine !== false)

const scheduleKey = (server: ConnectedServer, scope: string, resource: string): string =>
  `${server.url}\u0000${server.season ?? ''}\u0000${scope}\u0000${resource}`

const liveScope = (server: ConnectedServer): 'public' | 'admin' =>
  server.isAdmin ? 'admin' : 'public'

const liveHealthy = (server: ConnectedServer): boolean => {
  const held = liveConnections.get(serverConnectionIdentity(server))
  return held?.healthy === true && held.server === server && isCurrentServerConnection(server)
}

const liveCredentialProtocol = (token: string): string => {
  const bytes = new TextEncoder().encode(token)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${LIVE_AUTH_PREFIX}${encoded}`
}

/** Terminal unchanged cadence is never below five minutes; jitter only spreads it later. */
export const adaptiveServerSyncDelay = (unchanged: number, jitter = Math.random()): number => {
  const base = Math.min(INITIAL_POLL_MS * 2 ** Math.max(0, unchanged), MAX_UNCHANGED_POLL_MS)
  const spread = Math.min(JITTER_RANGE_MS, Math.floor(base / 10))
  return base + Math.floor(Math.max(0, Math.min(1, jitter)) * spread)
}

const clearTimer = (): void => {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

const armTimer = (): void => {
  clearTimer()
  if (!installed || !activeDocument() || sweepRun !== null) return
  const now = Date.now()
  let next = Number.POSITIVE_INFINITY
  for (const schedule of schedules.values()) {
    if (!isCurrentServerConnection(schedule.server)) continue
    next = Math.min(next, schedule.dueAt)
  }
  if (requestedResources !== null || next !== Number.POSITIVE_INFINITY) {
    const delay = requestedResources !== null ? 0 : Math.max(0, next - now)
    timer = setTimeout(runRequestedSweep, delay)
  }
}

const applyResult = (
  server: ConnectedServer,
  scope: string,
  resource: string,
  result: ServerSyncResult,
): void => {
  if (!isCurrentServerConnection(server) || result.status === 'skipped') return
  const key = scheduleKey(server, scope, resource)
  const previous = schedules.get(key)
  const revisionChanged = result.revision !== undefined && result.revision !== previous?.revision
  const changed = result.status === 'changed' || revisionChanged
  const unchanged = result.status === 'failed' || changed ? 0 : (previous?.unchanged ?? 0) + 1
  const delay =
    result.status !== 'failed' && resources.get(resource)?.live === true && liveHealthy(server)
      ? LIVE_RECOVERY_POLL_MS
      : adaptiveServerSyncDelay(unchanged)
  schedules.set(key, {
    server,
    scope,
    resource,
    ...(result.revision === undefined
      ? previous?.revision === undefined
        ? {}
        : { revision: previous.revision }
      : { revision: result.revision }),
    unchanged,
    dueAt: Date.now() + delay,
  })
}

const runResource = async (
  resource: ServerSyncResource,
  server: ConnectedServer,
  scope: string,
  reason: ReconciliationReason,
): Promise<void> => {
  const key = scheduleKey(server, scope, resource.id)
  const owner = serverConnectionIdentity(server)
  let owned = running.get(owner)
  if (owned === undefined) {
    owned = new Map()
    running.set(owner, owned)
  }
  const pending = owned.get(key)
  if (pending !== undefined) return pending
  const started = resource
    .refresh(
      server,
      reason,
      resource.live === true && liveHealthy(server) ? 'recovery' : 'compatibility-poll',
    )
    .then((result) => applyResult(server, scope, resource.id, result))
    .catch(() => applyResult(server, scope, resource.id, { status: 'failed' }))
    .finally(() => {
      if (owned?.get(key) === started) owned.delete(key)
    })
  owned.set(key, started)
  return started
}

const sweep = async (
  requested: ReadonlyMap<string, PendingResourceRequest> | null,
): Promise<void> => {
  if (!activeDocument()) return
  const now = Date.now()
  const work: Array<() => Promise<void>> = []
  const liveKeys = new Set<string>()
  for (const server of connected()) {
    for (const resource of resources.values()) {
      const scope = resource.scope(server)
      if (scope === null) continue
      const key = scheduleKey(server, scope, resource.id)
      liveKeys.add(key)
      const explicit = requested?.get(resource.id)
      const targeted = explicit?.servers.get(serverConnectionIdentity(server))
      if (requested !== null && explicit?.allReason === undefined && targeted === undefined)
        continue
      const scheduled = schedules.get(key)
      if (requested === null && scheduled !== undefined && scheduled.dueAt > now) continue
      const reason = targeted ?? explicit?.allReason ?? 'interval'
      work.push(() =>
        isCurrentServerConnection(server)
          ? runResource(resource, server, scope, reason)
          : Promise.resolve(),
      )
    }
  }
  for (const key of schedules.keys()) if (!liveKeys.has(key)) schedules.delete(key)
  for (let offset = 0; offset < work.length; offset += REFRESH_CONCURRENCY) {
    await Promise.all(work.slice(offset, offset + REFRESH_CONCURRENCY).map(async (run) => run()))
  }
}

function runRequestedSweep(): void {
  timer = null
  if (sweepRun !== null) return
  sweepRun = (async () => {
    let first = true
    while (activeDocument() && (first || requestedResources !== null)) {
      first = false
      const requested = requestedResources
      requestedResources = null
      await sweep(requested)
    }
  })().finally(() => {
    sweepRun = null
    armTimer()
  })
}

/** Coalesce event bursts into one bounded active-document refresh. */
export const requestServerSync = (
  reason: ReconciliationReason,
  resource?: string,
  server?: ConnectedServer,
): void => {
  requestedResources ??= new Map()
  for (const id of resource === undefined ? resources.keys() : [resource]) {
    const pending: PendingResourceRequest = requestedResources.get(id) ?? { servers: new Map() }
    if (server === undefined) pending.allReason = reason
    else pending.servers.set(serverConnectionIdentity(server), reason)
    requestedResources.set(id, pending)
  }
  armTimer()
}

/** Register a consumer without giving it a timer of its own. */
export const registerServerSyncResource = (resource: ServerSyncResource): void => {
  if (resources.has(resource.id)) throw new Error(`duplicate server sync resource: ${resource.id}`)
  resources.set(resource.id, resource)
  if (installed) requestServerSync('connect', resource.id)
}

/**
 * Apply a revision carried by an authoritative response without rereading the same resource.
 * Later protocol slices can call this for mutation responses and live updates.
 */
export const applyServerSyncRevision = (
  server: ConnectedServer,
  scope: string,
  resource: string,
  revision: string,
): void => {
  applyResult(server, scope, resource, { status: 'unchanged', revision })
  armTimer()
}

export type ServerSyncDeltaOutcome = 'applied' | 'duplicate' | 'reconcile' | 'stale-connection'

export const serverSyncRevision = (
  server: ConnectedServer,
  scope: string,
  resource: string,
): string | undefined => schedules.get(scheduleKey(server, scope, resource))?.revision

/** Apply a full read only if no response-driven delta advanced the resource while it was in flight. */
export const applyServerSyncSnapshot = (
  server: ConnectedServer,
  scope: string,
  resource: string,
  startedRevision: string | undefined,
  result: ServerSyncResult,
  apply: () => void,
): 'applied' | 'stale' | 'stale-connection' => {
  if (!isCurrentServerConnection(server)) return 'stale-connection'
  if (serverSyncRevision(server, scope, resource) !== startedRevision) return 'stale'
  apply()
  applyResult(server, scope, resource, result)
  armTimer()
  return 'applied'
}

/**
 * Apply one ordered authoritative delta. Exact base matching makes duplicate, stale, and
 * out-of-order mutation responses harmless; a gap schedules one bounded reconciliation.
 */
export const applyServerSyncDelta = (
  server: ConnectedServer,
  scope: string,
  resource: string,
  baseRevision: string,
  revision: string,
  apply: () => void,
): ServerSyncDeltaOutcome => {
  if (!isCurrentServerConnection(server)) return 'stale-connection'
  const current = serverSyncRevision(server, scope, resource)
  if (current === revision) return 'duplicate'
  if (current === undefined || current !== baseRevision) {
    requestServerSync('revision-gap', resource, server)
    return 'reconcile'
  }
  try {
    apply()
  } catch {
    requestServerSync('revision-gap', resource, server)
    return 'reconcile'
  }
  applyResult(server, scope, resource, { status: 'changed', revision })
  armTimer()
  return 'applied'
}

export const parseLiveServerEvent = (data: unknown): ParsedLiveEvent | null => {
  if (
    typeof data !== 'string' ||
    new TextEncoder().encode(data).byteLength > MAX_LIVE_MESSAGE_BYTES
  )
    return null
  const parsed: unknown = (() => {
    try {
      return JSON.parse(data)
    } catch {
      return null
    }
  })()
  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return null
  const candidate = parsed as Record<string, unknown>
  if (candidate.type === 'manifest-reconcile' && !('revision' in candidate)) {
    return { type: 'manifest-reconcile', revision: null }
  }
  if (
    candidate.type === 'manifest-reconcile' &&
    Number.isSafeInteger(candidate.revision) &&
    Number(candidate.revision) >= 0
  ) {
    return { type: 'manifest-reconcile', revision: Number(candidate.revision) }
  }
  if (
    (candidate.type === 'ready' || candidate.type === 'status-reconcile') &&
    Number.isSafeInteger(candidate.revision) &&
    Number(candidate.revision) >= 0
  ) {
    return { type: candidate.type, revision: Number(candidate.revision) }
  }
  if (candidate.type === 'status-delta' && candidate.delta !== undefined) {
    return { type: 'status-delta', delta: candidate.delta as never }
  }
  if (candidate.type === 'alarms-reconcile') return { type: 'alarms-reconcile' }
  return null
}

const handleLiveEvent = (server: ConnectedServer, raw: unknown): void => {
  if (!isCurrentServerConnection(server)) return
  const event = parseLiveServerEvent(raw)
  if (event === null) {
    requestServerSync('revision-gap', 'telemetry-status', server)
    return
  }
  if (event.type === 'manifest-reconcile') {
    if (event.revision === null) {
      requestServerSync('revision-gap', 'world-manifest', server)
      return
    }
    const live = liveConnections.get(serverConnectionIdentity(server))
    if (live === undefined || event.revision <= (live.manifestRevision ?? -1)) return
    live.manifestRevision = event.revision
    requestServerSync('revision-gap', 'world-manifest', server)
    return
  }
  if (event.type === 'alarms-reconcile') {
    requestServerSync('revision-gap', 'telemetry-alarms', server)
    return
  }
  if (event.type === 'status-delta') {
    const applied =
      resources.get('telemetry-status')?.applyLiveEvent?.(server, event.delta) ?? false
    if (!applied) requestServerSync('revision-gap', 'telemetry-status', server)
    return
  }
  const current = serverSyncRevision(server, 'world', 'telemetry-status')
  if (current !== String(event.revision)) {
    requestServerSync('revision-gap', 'telemetry-status', server)
  }
}

const closeLiveConnection = (connection: LiveConnection): void => {
  if (connection.reconnectTimer !== null) clearTimeout(connection.reconnectTimer)
  if (connection.heartbeatTimer !== null) clearTimeout(connection.heartbeatTimer)
  if (connection.heartbeatTimeout !== null) clearTimeout(connection.heartbeatTimeout)
  connection.reconnectTimer = null
  connection.heartbeatTimer = null
  connection.heartbeatTimeout = null
  connection.healthy = false
  const socket = connection.socket
  connection.socket = null
  if (socket !== null && socket.readyState < 2) socket.close(1000, 'retired')
}

const armLiveHeartbeat = (connection: LiveConnection): void => {
  if (connection.heartbeatTimer !== null) clearTimeout(connection.heartbeatTimer)
  if (connection.heartbeatTimeout !== null) clearTimeout(connection.heartbeatTimeout)
  connection.heartbeatTimeout = null
  connection.heartbeatTimer = setTimeout(() => {
    connection.heartbeatTimer = null
    const socket = connection.socket
    if (socket === null || socket.readyState !== 1) return
    socket.send('ping')
    connection.heartbeatTimeout = setTimeout(() => {
      connection.heartbeatTimeout = null
      if (connection.socket === socket) socket.close(1001, 'live sync heartbeat timeout')
    }, LIVE_HEARTBEAT_TIMEOUT_MS)
  }, LIVE_HEARTBEAT_MS)
}

const confirmLiveConnection = (connection: LiveConnection): void => {
  connection.attempts = 0
  connection.healthy = true
  armLiveHeartbeat(connection)
}

const scheduleLiveReconnect = (connection: LiveConnection): void => {
  if (connection.reconnectTimer !== null) return
  const delay = Math.min(1_000 * 2 ** connection.attempts++, MAX_RECONNECT_MS)
  connection.reconnectTimer = setTimeout(() => {
    connection.reconnectTimer = null
    openLiveConnection(connection)
  }, delay)
}

const openLiveConnection = (connection: LiveConnection): void => {
  const { server } = connection
  if (
    !activeDocument() ||
    !isCurrentServerConnection(server) ||
    server.info?.liveSync !== 1 ||
    server.season === null ||
    typeof WebSocket === 'undefined' ||
    connection.socket !== null
  )
    return
  const endpoint = new URL(serverEndpoint(server.url, '/telemetry/live'))
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  endpoint.searchParams.set('season', String(server.season))
  endpoint.searchParams.set('scope', liveScope(server))
  const revision = serverSyncRevision(server, 'world', 'telemetry-status')
  if (revision !== undefined) endpoint.searchParams.set('revision', revision)
  const protocols = [LIVE_PROTOCOL]
  if (server.token !== null && server.tokenUsable !== false) {
    protocols.push(liveCredentialProtocol(server.token))
  }
  let socket: WebSocket
  try {
    socket = new WebSocket(endpoint, protocols)
  } catch {
    scheduleLiveReconnect(connection)
    return
  }
  connection.socket = socket
  socket.addEventListener('open', () => {
    if (connection.socket !== socket || !isCurrentServerConnection(server)) return
    connection.healthy = true
    armLiveHeartbeat(connection)
    requestServerSync('connect', 'telemetry-status', server)
    requestServerSync('connect', 'world-manifest', server)
    requestServerSync('connect', 'telemetry-alarms', server)
    armTimer()
  })
  socket.addEventListener('message', (message) => {
    if (connection.socket !== socket) return
    if (message.data === 'pong') {
      confirmLiveConnection(connection)
      return
    }
    handleLiveEvent(server, message.data)
    confirmLiveConnection(connection)
  })
  socket.addEventListener('error', () => socket.close())
  socket.addEventListener('close', () => {
    if (connection.socket !== socket) return
    connection.socket = null
    connection.healthy = false
    if (connection.heartbeatTimer !== null) clearTimeout(connection.heartbeatTimer)
    if (connection.heartbeatTimeout !== null) clearTimeout(connection.heartbeatTimeout)
    connection.heartbeatTimer = null
    connection.heartbeatTimeout = null
    if (!isCurrentServerConnection(server)) return
    requestServerSync('reconnect', 'telemetry-status', server)
    requestServerSync('reconnect', 'world-manifest', server)
    requestServerSync('reconnect', 'telemetry-alarms', server)
    scheduleLiveReconnect(connection)
    armTimer()
  })
}

const reconcileLiveConnections = (): void => {
  const retained = new Set<object>()
  for (const server of connected()) {
    if (server.info?.liveSync !== 1 || typeof WebSocket === 'undefined') continue
    const owner = serverConnectionIdentity(server)
    retained.add(owner)
    let connection = liveConnections.get(owner)
    if (connection === undefined) {
      connection = {
        server,
        socket: null,
        reconnectTimer: null,
        heartbeatTimer: null,
        heartbeatTimeout: null,
        attempts: 0,
        healthy: false,
        manifestRevision: null,
      }
      liveConnections.set(owner, connection)
    }
    openLiveConnection(connection)
  }
  for (const [owner, connection] of liveConnections) {
    if (retained.has(owner)) continue
    closeLiveConnection(connection)
    liveConnections.delete(owner)
  }
}

const recover = (reason: 'focus' | 'online'): void => {
  if (activeDocument()) {
    reconcileLiveConnections()
    requestServerSync(reason)
  } else clearTimer()
}

/** Install the one scheduler after every status and manifest resource has registered. */
export const installServerSyncCoordinator = (): void => {
  if (installed) return
  installed = true
  let previousConnections = connected()
  onStateChange(() => {
    const next = connected()
    const changed =
      next.length !== previousConnections.length ||
      next.some(
        (server) =>
          !previousConnections.some(
            (held) => held.url === server.url && isCurrentServerConnection(held),
          ),
      )
    previousConnections = next
    if (changed) {
      reconcileLiveConnections()
      requestServerSync('state-change')
    }
  })
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', () => recover('focus'))
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => recover('focus'))
    window.addEventListener('online', () => recover('online'))
    window.addEventListener('offline', () => {
      clearTimer()
      for (const connection of liveConnections.values()) closeLiveConnection(connection)
    })
  }
  reconcileLiveConnections()
  requestServerSync('connect')
}

export const serverLiveSyncHealthy = (server: ConnectedServer): boolean => liveHealthy(server)
