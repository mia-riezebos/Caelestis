import {
  isPresenceDraft,
  isPresenceRect,
  isRegionDocument,
  isWorkIdentity,
  MAX_PRESENCE_REGIONS,
  type PainterIdentity,
  PRESENCE_DRAFT_MIN_MS,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_PROTOCOL_V1,
  PRESENCE_VIEWPORT_MIN_MS,
  type PresenceClientEvent,
  type PresenceDraft,
  type PresencePeer,
  type PresenceRect,
  type RegionClaim,
  type RegionClaimRequest,
  sameRect,
  sameTemplateSurface,
  templateSurface,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { userscriptVersion } from './client-metrics.js'
import { log, warn } from './debug.js'
import { draftIn, viewportRectIn } from './presence-geometry.js'
import {
  isProfileEnabled,
  measureProfile,
  measureProfileDetail,
  recordProfileCounter,
  recordProfileMessage,
  recordProfileWorkload,
} from './profile.js'
import { liveClientId, liveCredentialProtocol } from './server-sync-coordinator.js'
import { requestServerMutation, requestServerTree } from './server-transport.js'
import { serverEndpoint } from './server-url.js'
import {
  activeServerToken,
  type ConnectedServer,
  getState,
  isCurrentServerConnection,
  onStateChange,
  serverConnectionIdentity,
} from './state.js'
import { draftedPixelOffsets, draftedTiles, type TileFrame } from './tile-transform.js'
import { accountIdentity, loadAccount } from './wplace-account.js'

/**
 * One throttled socket per compatible server. Each may have a distinct audience.
 * Viewports and drafts retain their existing cadence and server-side nearby filtering.
 * A random tab publisher ID identifies copies without sharing credential admission IDs.
 */

const MAX_RECONNECT_MS = 30_000
const INITIAL_RECONNECT_MS = 1_000
const CLAIM_SNAPSHOT_MS = 30_000

interface Connection {
  readonly server: ConnectedServer
  socket: WebSocket | null
  sessionId: string | null
  peers: Map<string, PresencePeer>
  regions: readonly RegionClaim[]
  claimsRevision: number
  ownedRegionIds: readonly string[]
  canWriteClaims: boolean
  snapshotTimer: ReturnType<typeof setTimeout> | null
  snapshotRequest: AbortController | null
  attempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setTimeout> | null
  flushTimer: ReturnType<typeof setTimeout> | null
  /** Undefined means nothing has been sent on this socket yet. */
  sentViewport: PresenceRect | null | undefined
  sentDraft: PresenceDraft | null | undefined
  sentViewportAt: number
  sentDraftAt: number
}

export interface PresenceView {
  readonly peers: readonly PresencePeer[]
  readonly regions: readonly RegionClaim[]
  readonly online: number
  readonly connected: boolean
  readonly me: PainterIdentity | null
}

const connections = new Map<object, Connection>()
const listeners: (() => void)[] = []
const claimListeners: (() => void)[] = []
const receivedOrder = new WeakMap<PresencePeer, number>()
let receivedSequence = 0
let installed = false
let identityRequested = false
const publisherId = uuidV7()
let hiddenTab = false
let pendingViewport: PresenceRect | null = null
let pendingDraft: PresenceDraft | null = null
let draftCheckedAt = Number.NEGATIVE_INFINITY

const now = (): number => Date.now()

const notify = (): void => {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      warn('install', 'presence listener failed', String(error))
    }
  }
}

/** Runs after any peer, region, or connection change. */
export const onPresenceChange = (listener: () => void): void => {
  listeners.push(listener)
}

/** Observe claim snapshots without reconciling claims for every viewport update. */
export const onPresenceClaimsChange = (listener: () => void): void => {
  claimListeners.push(listener)
}

const eligible = (server: ConnectedServer): boolean =>
  server.status === 'connected' &&
  server.season !== null &&
  server.info?.presence === 1 &&
  typeof WebSocket !== 'undefined'

const canPublish = (): boolean => getState().sharePresence && !hiddenTab

const sameDraft = (left: PresenceDraft | null, right: PresenceDraft | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    sameRect(left.rect, right.rect) &&
    left.pixels === right.pixels &&
    left.mask === right.mask)

const isPeer = (value: unknown): value is PresencePeer => {
  if (typeof value !== 'object' || value === null) return false
  const peer = value as PresencePeer
  return (
    typeof peer.sessionId === 'string' &&
    peer.sessionId.length > 0 &&
    peer.sessionId.length <= 64 &&
    (peer.publisherId === undefined ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        peer.publisherId,
      )) &&
    isWorkIdentity(peer.painter) &&
    (peer.viewport === null || isPresenceRect(peer.viewport)) &&
    (peer.draft === null || isPresenceDraft(peer.draft))
  )
}

/** Validate remote and persisted claims before they enter routing or rendering. */
export const isPresenceRegion = (value: unknown): value is RegionClaim => {
  if (typeof value !== 'object' || value === null) return false
  const region = value as RegionClaim
  return (
    Number.isSafeInteger(region.season) &&
    region.season >= 0 &&
    region.surface != null &&
    templateSurface(region.surface.kind, region.surface.allianceId) !== null &&
    (region.expiresAt === undefined || Number.isSafeInteger(region.expiresAt)) &&
    typeof region.id === 'string' &&
    region.id.length <= 64 &&
    (region.templateId === null ||
      (typeof region.templateId === 'string' && region.templateId.length <= 128)) &&
    isWorkIdentity(region.claimant) &&
    isRegionDocument(region.document) &&
    isPresenceRect(region.rect) &&
    typeof region.label === 'string' &&
    region.label.length <= 64 &&
    Number.isSafeInteger(region.createdAt)
  )
}

const send = (connection: Connection, event: PresenceClientEvent): boolean => {
  const socket = connection.socket
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false
  try {
    measureProfile('Presence send', () => {
      const payload = JSON.stringify(event)
      socket.send(payload)
      recordProfileMessage('Presence sent', payload)
    })
  } catch (error) {
    warn('install', 'presence send failed', String(error))
    return false
  }
  armHeartbeat(connection)
  return true
}

const armHeartbeat = (connection: Connection): void => {
  if (connection.heartbeatTimer !== null) clearTimeout(connection.heartbeatTimer)
  connection.heartbeatTimer = setTimeout(() => {
    connection.heartbeatTimer = null
    // The full state goes with the heartbeat, so a server that hibernated and lost this session's
    // draft mask gets it back without any extra message.
    const draft = canPublish() ? (connection.sentDraft ?? null) : null
    if (draft === null) send(connection, { type: 'presence-heartbeat' })
    else {
      send(connection, {
        type: 'presence-update',
        viewport: connection.sentViewport ?? null,
        draft,
      })
    }
  }, PRESENCE_HEARTBEAT_MS)
}

/** What this tab is willing to publish right now: the pending state, or nothing at all. */
const effective = (): {
  readonly viewport: PresenceRect | null
  readonly draft: PresenceDraft | null
} =>
  canPublish()
    ? { viewport: pendingViewport, draft: pendingDraft }
    : { viewport: null, draft: null }

/** Send whatever changed and is due; wait for whatever changed but is not due yet. */
const flush = (connection: Connection): void => {
  connection.flushTimer = null
  if (connection.socket?.readyState !== WebSocket.OPEN) return
  const { viewport, draft } = effective()
  const at = now()
  const viewportDirty =
    connection.sentViewport === undefined || !sameRect(connection.sentViewport, viewport)
  const draftDirty = connection.sentDraft === undefined || !sameDraft(connection.sentDraft, draft)
  if (!viewportDirty && !draftDirty) return
  const viewportDue = at - connection.sentViewportAt >= PRESENCE_VIEWPORT_MIN_MS
  const draftDue = at - connection.sentDraftAt >= PRESENCE_DRAFT_MIN_MS
  // Clearing is always due: a closed tab or a cancelled draft should vanish for peers at once.
  const sendViewport = viewportDirty && (viewportDue || viewport === null)
  const sendDraft = draftDirty && (draftDue || draft === null)
  if (sendViewport || sendDraft) {
    const event: PresenceClientEvent = {
      type: 'presence-update',
      ...(sendViewport ? { viewport } : {}),
      ...(sendDraft ? { draft } : {}),
    }
    if (send(connection, event)) {
      if (sendViewport) {
        connection.sentViewport = viewport
        connection.sentViewportAt = at
      }
      if (sendDraft) {
        connection.sentDraft = draft
        connection.sentDraftAt = at
      }
    }
  }
  if ((viewportDirty && !sendViewport) || (draftDirty && !sendDraft)) scheduleFlush(connection)
}

const scheduleFlush = (connection: Connection): void => {
  if (connection.flushTimer !== null) return
  const at = now()
  const { viewport, draft } = effective()
  // Clearing never waits, matching `flush`: peers should lose a stale rect straight away.
  const viewportWait =
    viewport === null ? 0 : Math.max(0, connection.sentViewportAt + PRESENCE_VIEWPORT_MIN_MS - at)
  const draftWait =
    draft === null ? 0 : Math.max(0, connection.sentDraftAt + PRESENCE_DRAFT_MIN_MS - at)
  const viewportDirty =
    connection.sentViewport === undefined || !sameRect(connection.sentViewport, viewport)
  const draftDirty = connection.sentDraft === undefined || !sameDraft(connection.sentDraft, draft)
  const wait = Math.min(
    viewportDirty ? viewportWait : Number.POSITIVE_INFINITY,
    draftDirty ? draftWait : Number.POSITIVE_INFINITY,
  )
  if (!Number.isFinite(wait)) return
  connection.flushTimer = setTimeout(() => flush(connection), wait)
}

const scheduleAll = (): void => {
  for (const connection of connections.values()) scheduleFlush(connection)
}

const applyServerEvent = (connection: Connection, value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Record<string, unknown>
  if (event.type === 'presence-ready') {
    if (
      typeof event.sessionId !== 'string' ||
      !Number.isSafeInteger(event.online) ||
      !Array.isArray(event.peers) ||
      !Array.isArray(event.regions)
    )
      return false
    connection.sessionId = event.sessionId
    // A server that completes the handshake and then misbehaves keeps its backoff; only a
    // healthy exchange resets it.
    connection.attempts = 0
    connection.peers = new Map(
      event.peers.filter(isPeer).map((peer) => {
        receivedOrder.set(peer, ++receivedSequence)
        return [peer.sessionId, peer] as const
      }),
    )
    connection.regions = event.regions
      .filter(isPresenceRegion)
      .filter(
        (region) =>
          region.season === connection.server.season &&
          sameTemplateSurface(region.surface, WORLD_TEMPLATE_SURFACE),
      )
      .slice(0, MAX_PRESENCE_REGIONS)
    connection.claimsRevision++
    connection.ownedRegionIds = regionIds(event.ownedRegionIds)
    connection.canWriteClaims = event.canWrite === true
    stopSnapshots(connection)
    for (const listener of claimListeners) listener()
    return true
  }
  if (event.type === 'presence-delta') {
    if (
      !Number.isSafeInteger(event.online) ||
      !Array.isArray(event.upsert) ||
      !Array.isArray(event.remove)
    )
      return false
    for (const id of event.remove) if (typeof id === 'string') connection.peers.delete(id)
    for (const peer of event.upsert)
      if (isPeer(peer)) {
        receivedOrder.set(peer, ++receivedSequence)
        connection.peers.set(peer.sessionId, peer)
      }
    return true
  }
  if (event.type === 'regions') {
    if (!Array.isArray(event.regions)) return false
    connection.regions = event.regions
      .filter(isPresenceRegion)
      .filter(
        (region) =>
          region.season === connection.server.season &&
          sameTemplateSurface(region.surface, WORLD_TEMPLATE_SURFACE),
      )
      .slice(0, MAX_PRESENCE_REGIONS)
    connection.claimsRevision++
    connection.ownedRegionIds = regionIds(event.ownedRegionIds)
    for (const listener of claimListeners) listener()
    return true
  }
  if (event.type === 'claims-renewed') {
    if (!Number.isSafeInteger(event.expiresAt)) return false
    const expiresAt = Number(event.expiresAt)
    const ids = new Set(regionIds(event.ids))
    connection.regions = connection.regions.map((region) =>
      ids.has(region.id) ? { ...region, expiresAt } : region,
    )
    for (const listener of claimListeners) listener()
    return true
  }
  // Unknown events belong to a newer server; they are not a reason to drop the socket.
  return true
}

const clearTimers = (connection: Connection): void => {
  if (connection.reconnectTimer !== null) clearTimeout(connection.reconnectTimer)
  if (connection.heartbeatTimer !== null) clearTimeout(connection.heartbeatTimer)
  if (connection.flushTimer !== null) clearTimeout(connection.flushTimer)
  connection.reconnectTimer = null
  connection.heartbeatTimer = null
  connection.flushTimer = null
}

const regionIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string').slice(0, MAX_PRESENCE_REGIONS)
    : []

const stopSnapshots = (connection: Connection): void => {
  if (connection.snapshotTimer !== null) clearTimeout(connection.snapshotTimer)
  connection.snapshotTimer = null
  connection.snapshotRequest?.abort()
  connection.snapshotRequest = null
}

/** Keep persisted claims readable when admission limits or network failures prevent a socket. */
const startSnapshots = (connection: Connection): void => {
  if (
    connection.sessionId !== null ||
    connection.snapshotRequest !== null ||
    connection.snapshotTimer !== null
  )
    return
  const controller = new AbortController()
  connection.snapshotRequest = controller
  const { server } = connection
  const endpoint = scopedEndpoint(server, '/work/regions')
  const actor = accountIdentity()
  if (actor !== null) endpoint.searchParams.set('painterId', String(actor.wplaceUserId))
  const token = activeServerToken(server)
  void requestServerTree(endpoint.toString(), {
    signal: controller.signal,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  })
    .then(({ response, body }) => {
      if (
        controller.signal.aborted ||
        !isCurrentServerConnection(server) ||
        connection.sessionId !== null
      )
        return
      if (!response.ok || typeof body !== 'object' || body === null || !('regions' in body)) return
      if (!applyServerEvent(connection, { ...body, type: 'regions' })) return
      connection.canWriteClaims = 'canWrite' in body && body.canWrite === true
      for (const listener of claimListeners) listener()
      notify()
    })
    .catch((error: unknown) => {
      if (!controller.signal.aborted) warn('install', 'claim snapshot failed', String(error))
    })
    .finally(() => {
      if (connection.snapshotRequest !== controller) return
      connection.snapshotRequest = null
      if (
        controller.signal.aborted ||
        !isCurrentServerConnection(server) ||
        connection.sessionId !== null
      )
        return
      connection.snapshotTimer = setTimeout(() => {
        connection.snapshotTimer = null
        startSnapshots(connection)
      }, CLAIM_SNAPSHOT_MS)
    })
}

const scopedEndpoint = (server: ConnectedServer, path: string): URL => {
  const endpoint = new URL(serverEndpoint(server.url, path))
  endpoint.searchParams.set('season', String(server.season))
  endpoint.searchParams.set('surface', WORLD_TEMPLATE_SURFACE.kind)
  return endpoint
}

const closeConnection = (connection: Connection): void => {
  stopSnapshots(connection)
  clearTimers(connection)
  const socket = connection.socket
  connection.socket = null
  connection.sessionId = null
  if (socket !== null && socket.readyState < WebSocket.CLOSING) {
    try {
      socket.close(1000, 'presence retired')
    } catch {
      // Already gone.
    }
  }
  if (connection.peers.size > 0) {
    connection.peers = new Map()
    notify()
  }
}

const scheduleReconnect = (connection: Connection): void => {
  startSnapshots(connection)
  if (connection.reconnectTimer !== null) return
  const delay = Math.min(MAX_RECONNECT_MS, INITIAL_RECONNECT_MS * 2 ** connection.attempts)
  connection.attempts = Math.min(connection.attempts + 1, 10)
  connection.reconnectTimer = setTimeout(
    () => {
      connection.reconnectTimer = null
      open(connection)
    },
    delay + Math.random() * 500,
  )
}

const open = (connection: Connection): void => {
  const { server } = connection
  const identity = accountIdentity()
  if (
    connection.socket !== null ||
    connection.reconnectTimer !== null ||
    !isCurrentServerConnection(server) ||
    !eligible(server) ||
    server.season === null ||
    identity === null
  )
    return
  const endpoint = new URL(serverEndpoint(server.url, '/telemetry/presence'))
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  endpoint.searchParams.set('season', String(server.season))
  endpoint.searchParams.set('surface', WORLD_TEMPLATE_SURFACE.kind)
  endpoint.searchParams.set('painterId', String(identity.wplaceUserId))
  endpoint.searchParams.set('painterName', identity.displayName)
  endpoint.searchParams.set('client', 'userscript')
  endpoint.searchParams.set('clientVersion', userscriptVersion)
  const token = activeServerToken(server)
  // Every connection carries this browser's id, so painters sharing one token are not counted
  // as one client against the per-client socket cap.
  endpoint.searchParams.set('clientId', liveClientId(server.url))
  endpoint.searchParams.set('publisherId', publisherId)
  const protocols = [PRESENCE_PROTOCOL_V1]
  if (token !== null) protocols.push(liveCredentialProtocol(token))
  let socket: WebSocket
  try {
    socket = new WebSocket(endpoint, protocols)
  } catch (error) {
    warn('install', 'presence socket could not open', String(error))
    scheduleReconnect(connection)
    return
  }
  connection.socket = socket
  socket.addEventListener('open', () => {
    if (connection.socket !== socket) return
    if (socket.protocol !== PRESENCE_PROTOCOL_V1) {
      // Browsers only allow 1000 or 3000..4999 from a page; anything else throws instead of closing.
      socket.close(4002, 'presence protocol not negotiated')
      return
    }
    connection.sentViewport = undefined
    connection.sentDraft = undefined
    connection.sentViewportAt = Number.NEGATIVE_INFINITY
    connection.sentDraftAt = Number.NEGATIVE_INFINITY
    log('install', 'presence connected', { server: server.url })
    armHeartbeat(connection)
    scheduleFlush(connection)
    notify()
  })
  socket.addEventListener('message', (message) => {
    if (connection.socket !== socket || typeof message.data !== 'string') return
    recordProfileMessage('Presence received', message.data)
    if (message.data === 'pong') return
    let parsed: unknown
    try {
      parsed = measureProfile('Presence parse', () => JSON.parse(message.data))
    } catch {
      socket.close(4002, 'invalid presence event')
      return
    }
    if (!measureProfile('Presence state update', () => applyServerEvent(connection, parsed))) {
      recordProfileCounter('Presence invalid messages')
      socket.close(4002, 'invalid presence event')
      return
    }
    measureProfileDetail('Presence notify', notify)
    if (isProfileEnabled()) {
      recordProfileWorkload('Presence peers', connection.peers.size)
      recordProfileWorkload('Presence regions', connection.regions.length)
      recordProfileWorkload(
        'Presence region shapes',
        connection.regions.reduce((sum, region) => sum + region.document.items.length, 0),
      )
      recordProfileWorkload(
        'Presence region bounding pixels',
        connection.regions.reduce((sum, region) => sum + region.rect.w * region.rect.h, 0),
      )
    }
  })
  socket.addEventListener('error', () => socket.close())
  socket.addEventListener('close', () => {
    if (connection.socket !== socket) return
    connection.socket = null
    connection.sessionId = null
    clearTimers(connection)
    connection.peers = new Map()
    notify()
    if (isCurrentServerConnection(server) && eligible(server)) scheduleReconnect(connection)
  })
}

const reconcile = (): void => {
  const retained = new Set<object>()
  const identity = accountIdentity()
  if (identity === null && !identityRequested) {
    identityRequested = true
    void loadAccount()
      .catch(() => undefined)
      .then(() => {
        identityRequested = false
        if (accountIdentity() !== null) reconcile()
      })
  }
  for (const server of getState().servers) {
    if (!eligible(server)) continue
    const owner = serverConnectionIdentity(server)
    retained.add(owner)
    let connection = connections.get(owner)
    if (connection === undefined) {
      connection = {
        server,
        socket: null,
        sessionId: null,
        peers: new Map(),
        regions: [],
        claimsRevision: 0,
        ownedRegionIds: [],
        canWriteClaims: false,
        snapshotTimer: null,
        snapshotRequest: null,
        attempts: 0,
        reconnectTimer: null,
        heartbeatTimer: null,
        flushTimer: null,
        sentViewport: undefined,
        sentDraft: undefined,
        sentViewportAt: Number.NEGATIVE_INFINITY,
        sentDraftAt: Number.NEGATIVE_INFINITY,
      }
      connections.set(owner, connection)
    }
  }
  for (const [owner, connection] of connections) {
    if (retained.has(owner)) continue
    closeConnection(connection)
    connections.delete(owner)
  }
  for (const connection of connections.values()) {
    open(connection)
    startSnapshots(connection)
  }
}

/** Feed one tile frame. Cheap on every frame; the draft scan runs at most once a second. */
export const observePresenceFrame = (frame: TileFrame): void => {
  if (connections.size === 0) return
  const viewport = viewportRectIn(frame)
  let changed = false
  if (!sameRect(viewport, pendingViewport)) {
    pendingViewport = viewport
    changed = true
  }
  const at = now()
  if (at - draftCheckedAt >= PRESENCE_DRAFT_MIN_MS) {
    draftCheckedAt = at
    const tiles = draftedTiles()
    const draft =
      tiles.length === 0
        ? null
        : measureProfileDetail('Presence draft scan', () => draftIn(tiles, draftedPixelOffsets))
    recordProfileWorkload('Presence local draft tiles', tiles.length)
    recordProfileWorkload('Presence local draft pixels', draft?.pixels ?? 0)
    if (!sameDraft(draft, pendingDraft)) {
      pendingDraft = draft
      changed = true
    }
  }
  if (changed) scheduleAll()
}

/** Unique nearby sessions and logical claims across all connected servers. */
export const presenceView = (): PresenceView => {
  const peers = new Map<string, PresencePeer>()
  const regions = new Map<string, RegionClaim>()
  let connected = false
  for (const connection of connections.values()) {
    if (connection.socket?.readyState === WebSocket.OPEN) {
      connected = true
      for (const peer of connection.peers.values()) {
        if (peer.sessionId === connection.sessionId || peer.publisherId === publisherId) continue
        const key =
          peer.publisherId === undefined
            ? `${connection.server.url}:${peer.sessionId}`
            : `${peer.painter.wplaceUserId}:${peer.publisherId}`
        const previous = peers.get(key)
        if (
          previous === undefined ||
          (receivedOrder.get(peer) ?? 0) > (receivedOrder.get(previous) ?? 0)
        )
          peers.set(key, peer)
      }
    }
    for (const region of connection.regions) {
      const key = `${region.season}:${region.surface.kind}:${region.surface.allianceId}:${region.claimant.wplaceUserId}:${region.id}`
      regions.set(key, region)
    }
  }
  return {
    peers: [...peers].map(([key, peer]) => ({ ...peer, sessionId: key })),
    regions: [...regions.values()],
    online: peers.size,
    connected,
    me: accountIdentity(),
  }
}

/** Every connected server supporting presence, including sockets currently reconnecting. */
export const presenceServers = (): readonly ConnectedServer[] =>
  [...connections.values()].map((connection) => connection.server)

/** The presence connection of a server, live or not, when the server supports presence. */
const connectionFor = (server: ConnectedServer): Connection | null =>
  connections.get(serverConnectionIdentity(server)) ?? null

/** Raw copies and handshake state for claim reconciliation. */
export const presenceServerClaims = (
  server: ConnectedServer,
): {
  readonly ready: boolean
  readonly regions: readonly RegionClaim[]
  readonly revision: number
  readonly ownedRegionIds: readonly string[]
} => {
  const connection = connectionFor(server)
  return {
    ready: (connection?.claimsRevision ?? 0) > 0,
    regions: connection?.regions ?? [],
    revision: connection?.claimsRevision ?? 0,
    ownedRegionIds: connection?.ownedRegionIds ?? [],
  }
}

/** Claims require report/admin capability from an authenticated server snapshot. */
export const presenceCanWriteClaims = (server: ConnectedServer): boolean =>
  activeServerToken(server) !== null && connectionFor(server)?.canWriteClaims === true

const regionRequest = async (
  server: ConnectedServer,
  method: 'PUT' | 'DELETE',
  id: string,
  body: unknown,
  scope?: Pick<RegionClaim, 'season' | 'surface'>,
  signal?: AbortSignal,
): Promise<string | null> => {
  if (server.season === null) return 'Server season unknown.'
  const token = activeServerToken(server)
  if (token === null) return 'Sign in to this server to claim regions.'
  const endpoint = scopedEndpoint(server, `/work/regions/${id}`)
  if (scope !== undefined) {
    endpoint.searchParams.set('season', String(scope.season))
    endpoint.searchParams.set('surface', scope.surface.kind)
    if (scope.surface.allianceId !== null)
      endpoint.searchParams.set('allianceId', String(scope.surface.allianceId))
  }
  try {
    const { response, body: answer } = await requestServerMutation(endpoint.toString(), {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.ok || (method === 'DELETE' && response.status === 404)) {
      return null
    }
    const error =
      typeof answer === 'object' &&
      answer !== null &&
      typeof (answer as { error?: unknown }).error === 'string'
        ? (answer as { error: string }).error
        : `Server answered ${response.status}.`
    return error
  } catch (error) {
    return error instanceof Error ? error.message : 'Region request failed.'
  }
}

/** Persist a region claim. Resolves to an error message, or null on success. */
export const claimRegion = async (
  server: ConnectedServer,
  id: string,
  request: RegionClaimRequest,
  scope?: Pick<RegionClaim, 'season' | 'surface'>,
  signal?: AbortSignal,
): Promise<string | null> => {
  if (connectionFor(server) === null) return 'This server does not support region claims.'
  return regionRequest(server, 'PUT', id, request, scope, signal)
}

/** Release one region claim. Resolves to an error message, or null on success. */
export const releaseRegion = async (
  server: ConnectedServer,
  id: string,
  actor: PainterIdentity,
  scope?: Pick<RegionClaim, 'season' | 'surface'>,
  signal?: AbortSignal,
): Promise<string | null> => regionRequest(server, 'DELETE', id, { actor }, scope, signal)

/** The current viewport and draft as last observed, for claiming what is on screen. */
export const presencePending = (): {
  readonly viewport: PresenceRect | null
  readonly draft: PresenceDraft | null
} => ({ viewport: pendingViewport, draft: pendingDraft })

const onVisibility = (): void => {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  if (hidden === hiddenTab) return
  hiddenTab = hidden
  scheduleAll()
}

/** Install once, after state has loaded. Safe to call again. */
export const installPresence = (): void => {
  if (installed) return
  installed = true
  onStateChange(() => {
    reconcile()
    scheduleAll()
  })
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
    // A tab that installs while hidden gets no visibility event; read the state now so a hidden
    // tab never publishes before it is looked at.
    hiddenTab = document.visibilityState === 'hidden'
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', reconcile)
    window.addEventListener('offline', () => {
      for (const connection of connections.values()) closeConnection(connection)
    })
  }
  reconcile()
}
