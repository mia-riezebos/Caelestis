import {
  type LiveSyncServerEvent,
  type LiveTileOfferBatch,
  type LiveTileOfferCacheResponse,
  type ReconciliationReason,
  type SyncTransport,
  uuidV7,
} from '@caelestis/shared'
import { userscriptVersion } from './client-metrics.js'
import { canonicalServerUrl, serverEndpoint } from './server-url.js'
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
const MAX_FAST_RECONNECT_ATTEMPTS = 6
const LIVE_HEARTBEAT_MS = 15 * 60_000
const LIVE_HEARTBEAT_TIMEOUT_MS = 10_000
const LIVE_RECOVERY_POLL_MS = 60 * 60_000
const LIVE_BOOTSTRAP_FALLBACK_MS = 1_000
const LIVE_COMMAND_TIMEOUT_MS = 5_000
const LIVE_CLIENT_ID_KEY = 'caelestis.live-client-id.v1'
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const cachedLiveClientIds = new Map<string, string>()

/** Stable, non-secret browser identity scoped to one anonymous server. */
const liveClientId = (serverUrl: string): string => {
  const serverKey = canonicalServerUrl(serverUrl)
  const cached = cachedLiveClientIds.get(serverKey)
  if (cached !== undefined) return cached
  const storageKey = `${LIVE_CLIENT_ID_KEY}:${serverKey}`
  try {
    const stored = localStorage.getItem(storageKey)
    if (stored !== null && UUID_V7.test(stored)) {
      cachedLiveClientIds.set(serverKey, stored)
      return stored
    }
    const created = uuidV7()
    localStorage.setItem(storageKey, created)
    cachedLiveClientIds.set(serverKey, created)
    return created
  } catch {
    const created = uuidV7()
    cachedLiveClientIds.set(serverKey, created)
    return created
  }
}

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
  /** A global manifest revision invalidates this resource's currently active surface. */
  readonly reconcileOnManifestEvent?: boolean
  /** Optional resource-owned validation/application for a compact live event. */
  readonly applyLiveEvent?: (server: ConnectedServer, event: unknown) => boolean
}

interface Schedule {
  readonly server: ConnectedServer
  readonly scope: string
  readonly resource: string
  readonly revision?: string
  readonly unchanged: number
  readonly failed: boolean
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
  bootstrapFallbackTimer: ReturnType<typeof setTimeout> | null
  fallbackReadRequested: boolean
  heartbeatTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimeout: ReturnType<typeof setTimeout> | null
  attempts: number
  healthy: boolean
  manifestRevision: number | null
  readonly pendingTileOffers: Map<
    string,
    {
      readonly resolve: (response: LiveTileOfferCacheResponse | null) => void
      readonly timer: ReturnType<typeof setTimeout>
    }
  >
}

const resources = new Map<string, ServerSyncResource>()
const schedules = new Map<string, Schedule>()
const running = new WeakMap<object, Map<string, Promise<void>>>()
const pendingLiveRevisions = new WeakMap<object, Map<string, number>>()
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
  return liveCapable(server) && held?.healthy === true && isCurrentServerConnection(server)
}

const liveCapable = (server: ConnectedServer): boolean =>
  server.info?.liveSync === 1 && typeof WebSocket !== 'undefined'

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
    failed: result.status === 'failed',
    dueAt: Date.now() + delay,
  })
}

const deferHealthyLiveSchedules = (server: ConnectedServer): void => {
  const now = Date.now()
  for (const resource of resources.values()) {
    if (resource.live !== true) continue
    const scope = resource.scope(server)
    if (scope === null) continue
    const key = scheduleKey(server, scope, resource.id)
    const schedule = schedules.get(key)
    if (schedule === undefined || schedule.failed) continue
    schedules.set(key, {
      ...schedule,
      dueAt: Math.max(schedule.dueAt, now + LIVE_RECOVERY_POLL_MS),
    })
  }
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
      finishPendingLiveRevision(server, scope, resource.id)
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

const requestLiveServerSync = (reason: ReconciliationReason, server: ConnectedServer): void => {
  for (const resource of resources.values()) {
    if (resource.live === true) requestServerSync(reason, resource.id, server)
  }
}

const requestAvailableServerSync = (reason: ReconciliationReason, onlyResource?: string): void => {
  for (const server of connected()) {
    for (const resource of resources.values()) {
      if (onlyResource !== undefined && resource.id !== onlyResource) continue
      if (resource.live === true && liveCapable(server) && !liveHealthy(server)) continue
      requestServerSync(reason, resource.id, server)
    }
  }
  armTimer()
}

/** Register a consumer without giving it a timer of its own. */
export const registerServerSyncResource = (resource: ServerSyncResource): void => {
  if (resources.has(resource.id)) throw new Error(`duplicate server sync resource: ${resource.id}`)
  resources.set(resource.id, resource)
  if (installed) requestAvailableServerSync('connect', resource.id)
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

const revisionNumber = (
  server: ConnectedServer,
  scope: string,
  resource: string,
): number | null => {
  const revision = Number(serverSyncRevision(server, scope, resource))
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null
}

const requestLiveRevision = (
  server: ConnectedServer,
  scope: string,
  resource: string,
  revision: number,
): void => {
  const current = revisionNumber(server, scope, resource)
  if (current !== null && current >= revision) return
  const owner = serverConnectionIdentity(server)
  const key = scheduleKey(server, scope, resource)
  if (running.get(owner)?.has(key) === true) {
    let pending = pendingLiveRevisions.get(owner)
    if (pending === undefined) {
      pending = new Map()
      pendingLiveRevisions.set(owner, pending)
    }
    pending.set(key, Math.max(revision, pending.get(key) ?? -1))
    return
  }
  requestServerSync('revision-gap', resource, server)
}

const finishPendingLiveRevision = (
  server: ConnectedServer,
  scope: string,
  resource: string,
): void => {
  const owner = serverConnectionIdentity(server)
  const key = scheduleKey(server, scope, resource)
  const pending = pendingLiveRevisions.get(owner)
  const expected = pending?.get(key)
  if (expected === undefined) return
  pending?.delete(key)
  if (pending?.size === 0) pendingLiveRevisions.delete(owner)
  if (!isCurrentServerConnection(server)) return
  const current = revisionNumber(server, scope, resource)
  if (current === null || current < expected) requestServerSync('revision-gap', resource, server)
}

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
  if (
    candidate.type === 'tile-offer-cache-result' &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.response === 'object' &&
    candidate.response !== null
  ) {
    const response = candidate.response as Record<string, unknown>
    if (
      Array.isArray(response.acknowledgedDeliveryIds) &&
      response.acknowledgedDeliveryIds.every((id) => typeof id === 'string') &&
      Array.isArray(response.unresolvedDeliveryIds) &&
      response.unresolvedDeliveryIds.every((id) => typeof id === 'string') &&
      (response.error === undefined ||
        response.error === 'forbidden' ||
        response.error === 'invalid')
    ) {
      return {
        type: 'tile-offer-cache-result',
        requestId: candidate.requestId,
        response: response as unknown as LiveTileOfferCacheResponse,
      }
    }
  }
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
      for (const resource of resources.values()) {
        if (resource.reconcileOnManifestEvent === true)
          requestServerSync('revision-gap', resource.id, server)
      }
      return
    }
    const live = liveConnections.get(serverConnectionIdentity(server))
    if (live === undefined || event.revision <= (live.manifestRevision ?? -1)) return
    live.manifestRevision = event.revision
    for (const resource of resources.values()) {
      if (resource.reconcileOnManifestEvent === true)
        requestServerSync('revision-gap', resource.id, server)
    }
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
  if (event.type === 'tile-offer-cache-result') {
    const live = liveConnections.get(serverConnectionIdentity(server))
    const pending = live?.pendingTileOffers.get(event.requestId)
    if (pending === undefined) return
    live?.pendingTileOffers.delete(event.requestId)
    clearTimeout(pending.timer)
    pending.resolve(event.response)
    return
  }
  requestLiveRevision(server, 'world', 'telemetry-status', event.revision)
}

const closeLiveConnection = (connection: LiveConnection, preserveReconnect = false): void => {
  if (!preserveReconnect && connection.reconnectTimer !== null)
    clearTimeout(connection.reconnectTimer)
  if (connection.bootstrapFallbackTimer !== null) clearTimeout(connection.bootstrapFallbackTimer)
  if (connection.heartbeatTimer !== null) clearTimeout(connection.heartbeatTimer)
  if (connection.heartbeatTimeout !== null) clearTimeout(connection.heartbeatTimeout)
  if (!preserveReconnect) connection.reconnectTimer = null
  for (const pending of connection.pendingTileOffers.values()) {
    clearTimeout(pending.timer)
    pending.resolve(null)
  }
  connection.pendingTileOffers.clear()
  connection.bootstrapFallbackTimer = null
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
  const attempt = connection.attempts
  connection.attempts = Math.min(attempt + 1, MAX_FAST_RECONNECT_ATTEMPTS)
  const delay =
    attempt < MAX_FAST_RECONNECT_ATTEMPTS
      ? Math.min(1_000 * 2 ** attempt, MAX_RECONNECT_MS)
      : LIVE_RECOVERY_POLL_MS
  connection.reconnectTimer = setTimeout(() => {
    connection.reconnectTimer = null
    openLiveConnection(connection)
  }, delay)
}

const armLiveBootstrapFallback = (connection: LiveConnection): void => {
  if (connection.bootstrapFallbackTimer !== null) clearTimeout(connection.bootstrapFallbackTimer)
  connection.bootstrapFallbackTimer = setTimeout(() => {
    connection.bootstrapFallbackTimer = null
    if (
      !isCurrentServerConnection(connection.server) ||
      connection.healthy ||
      connection.fallbackReadRequested
    )
      return
    connection.fallbackReadRequested = true
    requestLiveServerSync('reconnect', connection.server)
  }, LIVE_BOOTSTRAP_FALLBACK_MS)
}

const openLiveConnection = (connection: LiveConnection): void => {
  const { server } = connection
  if (
    !activeDocument() ||
    !isCurrentServerConnection(server) ||
    server.info?.liveSync !== 1 ||
    server.season === null ||
    typeof WebSocket === 'undefined' ||
    connection.socket !== null ||
    connection.reconnectTimer !== null
  )
    return
  const endpoint = new URL(serverEndpoint(server.url, '/telemetry/live'))
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  endpoint.searchParams.set('season', String(server.season))
  endpoint.searchParams.set('scope', liveScope(server))
  endpoint.searchParams.set('client', 'userscript')
  endpoint.searchParams.set('clientVersion', userscriptVersion)
  const authenticated = server.token !== null && server.tokenUsable !== false
  if (!authenticated) endpoint.searchParams.set('clientId', liveClientId(server.url))
  const revision = serverSyncRevision(server, 'world', 'telemetry-status')
  if (revision !== undefined) endpoint.searchParams.set('revision', revision)
  const protocols = [LIVE_PROTOCOL]
  if (authenticated) {
    protocols.push(liveCredentialProtocol(server.token))
  }
  let socket: WebSocket
  try {
    socket = new WebSocket(endpoint, protocols)
  } catch {
    scheduleLiveReconnect(connection)
    armLiveBootstrapFallback(connection)
    return
  }
  connection.socket = socket
  armLiveBootstrapFallback(connection)
  socket.addEventListener('open', () => {
    if (connection.socket !== socket || !isCurrentServerConnection(server)) return
    connection.healthy = true
    if (connection.bootstrapFallbackTimer !== null) clearTimeout(connection.bootstrapFallbackTimer)
    connection.bootstrapFallbackTimer = null
    deferHealthyLiveSchedules(server)
    armLiveHeartbeat(connection)
    requestLiveServerSync(connection.attempts === 0 ? 'connect' : 'reconnect', server)
    connection.fallbackReadRequested = false
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
    scheduleLiveReconnect(connection)
    armLiveBootstrapFallback(connection)
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
        bootstrapFallbackTimer: null,
        fallbackReadRequested: false,
        heartbeatTimer: null,
        heartbeatTimeout: null,
        attempts: 0,
        healthy: false,
        manifestRevision: null,
        pendingTileOffers: new Map(),
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
    for (const server of connected()) {
      for (const resource of resources.values()) {
        if (resource.live === true && liveHealthy(server)) continue
        requestServerSync(reason, resource.id, server)
      }
    }
    armTimer()
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
      next.some((server) => {
        const previous = previousConnections.find(
          (held) => held.url === server.url && isCurrentServerConnection(held),
        )
        return previous === undefined || liveCapable(previous) !== liveCapable(server)
      })
    previousConnections = next
    if (changed) {
      reconcileLiveConnections()
      requestAvailableServerSync('state-change')
    }
  })
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', () => recover('focus'))
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => recover('focus'))
    window.addEventListener('online', () => recover('online'))
    window.addEventListener('offline', () => {
      clearTimer()
      for (const connection of liveConnections.values()) closeLiveConnection(connection, true)
    })
  }
  reconcileLiveConnections()
  requestAvailableServerSync('connect')
}

export const serverLiveSyncHealthy = (server: ConnectedServer): boolean => liveHealthy(server)

export const requestLiveTileOfferCache = (
  server: ConnectedServer,
  batch: LiveTileOfferBatch,
): Promise<LiveTileOfferCacheResponse | null> => {
  const connection = liveConnections.get(serverConnectionIdentity(server))
  if (
    server.info?.liveTileOffers !== 1 ||
    !liveHealthy(server) ||
    connection?.socket === null ||
    connection === undefined
  )
    return Promise.resolve(null)
  const requestId = uuidV7()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      connection.pendingTileOffers.delete(requestId)
      resolve(null)
    }, LIVE_COMMAND_TIMEOUT_MS)
    connection.pendingTileOffers.set(requestId, { resolve, timer })
    try {
      connection.socket?.send(JSON.stringify({ type: 'tile-offer-cache', requestId, batch }))
    } catch {
      clearTimeout(timer)
      connection.pendingTileOffers.delete(requestId)
      resolve(null)
    }
  })
}
