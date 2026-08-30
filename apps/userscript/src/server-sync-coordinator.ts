import type { ReconciliationReason } from '@caelestis/shared'
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
  ) => Promise<ServerSyncResult>
}

interface Schedule {
  readonly server: ConnectedServer
  readonly scope: string
  readonly resource: string
  readonly revision?: string
  readonly unchanged: number
  readonly dueAt: number
}

const resources = new Map<string, ServerSyncResource>()
const schedules = new Map<string, Schedule>()
const running = new WeakMap<object, Map<string, Promise<void>>>()
let installed = false
let timer: ReturnType<typeof setTimeout> | null = null
let requestedResources: Set<string> | null = new Set()
let requestedReason: ReconciliationReason = 'connect'

const connected = (): readonly ConnectedServer[] =>
  getState().servers.filter(
    (server) => server.status === 'connected' && server.info !== null && server.season !== null,
  )

const activeDocument = (): boolean =>
  (typeof document === 'undefined' || document.visibilityState !== 'hidden') &&
  (typeof navigator === 'undefined' || navigator.onLine !== false)

const scheduleKey = (server: ConnectedServer, scope: string, resource: string): string =>
  `${server.url}\u0000${server.season ?? ''}\u0000${scope}\u0000${resource}`

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
  if (!installed || !activeDocument()) return
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
    dueAt: Date.now() + adaptiveServerSyncDelay(unchanged),
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
    .refresh(server, reason)
    .then((result) => applyResult(server, scope, resource.id, result))
    .catch(() => applyResult(server, scope, resource.id, { status: 'failed' }))
    .finally(() => {
      if (owned?.get(key) === started) owned.delete(key)
    })
  owned.set(key, started)
  return started
}

const sweep = async (
  reason: ReconciliationReason,
  selected: ReadonlySet<string> | null,
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
      if (selected !== null && !selected.has(resource.id)) continue
      const scheduled = schedules.get(key)
      if (selected === null && scheduled !== undefined && scheduled.dueAt > now) continue
      work.push(() => runResource(resource, server, scope, reason))
    }
  }
  for (const key of schedules.keys()) if (!liveKeys.has(key)) schedules.delete(key)
  for (let offset = 0; offset < work.length; offset += REFRESH_CONCURRENCY) {
    await Promise.all(work.slice(offset, offset + REFRESH_CONCURRENCY).map(async (run) => run()))
  }
  armTimer()
}

function runRequestedSweep(): void {
  timer = null
  const selected = requestedResources
  const reason = requestedReason
  requestedResources = null
  requestedReason = 'interval'
  void sweep(reason, selected).finally(armTimer)
}

/** Coalesce event bursts into one bounded active-document refresh. */
export const requestServerSync = (reason: ReconciliationReason, resource?: string): void => {
  if (requestedResources !== null && resource === undefined) {
    requestedResources = new Set(resources.keys())
  } else if (resource === undefined) {
    requestedResources = new Set(resources.keys())
  } else if (requestedResources === null) {
    requestedResources = new Set([resource])
  } else {
    requestedResources.add(resource)
  }
  requestedReason = reason
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

const recover = (reason: 'focus' | 'online'): void => {
  if (activeDocument()) requestServerSync(reason)
  else clearTimer()
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
    if (changed) requestServerSync('state-change')
  })
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', () => recover('focus'))
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => recover('focus'))
    window.addEventListener('online', () => recover('online'))
    window.addEventListener('offline', clearTimer)
  }
  requestServerSync('connect')
}
