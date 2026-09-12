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
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { userscriptVersion } from './client-metrics.js'
import { log, warn } from './debug.js'
import { draftIn, viewportRectIn } from './presence-geometry.js'
import { liveClientId, liveCredentialProtocol } from './server-sync-coordinator.js'
import { requestServerMetadata, requestServerMutation } from './server-transport.js'
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
 * The painter presence channel: one socket per tab, on the least crowded server.
 *
 * A painter connected to several servers that advertise presence still opens a single socket.
 * Before opening it, every candidate is asked over plain HTTP how many painters it has online,
 * and the emptiest one wins (ties go to the smaller server id, so two painters sharing the same
 * servers make the same choice). Busy servers therefore get fewer collaboration sockets, and
 * painters who share several servers are not seen twice. The choice only happens when no socket
 * is open: an open socket is never moved, so nobody flaps between servers as headcounts shift.
 *
 * Region claims are persistent and belong to whichever server they were saved on, so the servers
 * without the socket still contribute their claims, fetched over HTTP on connection and refreshed
 * every few minutes. Saving and releasing a claim is HTTP on every server.
 *
 * Everything that leaves this module is throttled, because the socket's cost on the server is
 * counted per incoming message. A pan produces one viewport rect a second at most, a
 * draft one mask a second, and a quiet tab one heartbeat every thirty. What arrives is already
 * filtered to the peers near this viewport, so the layer only has to draw what it is given.
 *
 * Nothing here touches the map or the DOM. `observePresenceFrame` is fed each tile frame by the
 * main loop, and the GL layer and the panel read `presenceView()`.
 */

const MAX_RECONNECT_MS = 30_000
const INITIAL_RECONNECT_MS = 1_000
/** How often a server without the socket is asked again for its region claims. */
export const PRESENCE_REGION_REFRESH_MS = 5 * 60_000

interface Connection {
  readonly server: ConnectedServer
  /** Whether this is the server that carries the socket. At most one connection is live. */
  live: boolean
  socket: WebSocket | null
  regionsTimer: ReturnType<typeof setTimeout> | null
  /** When the claims were last fetched over HTTP; never, for the live connection. */
  regionsAt: number
  sessionId: string | null
  peers: Map<string, PresencePeer>
  regions: readonly RegionClaim[]
  online: number
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
let installed = false
let identityRequested = false
/** The election in flight, if any; its sequence number lets a reset discard a late result. */
let electing = false
let electionSequence = 0
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
    isWorkIdentity(peer.painter) &&
    (peer.viewport === null || isPresenceRect(peer.viewport)) &&
    (peer.draft === null || isPresenceDraft(peer.draft))
  )
}

const isRegion = (value: unknown): value is RegionClaim => {
  if (typeof value !== 'object' || value === null) return false
  const region = value as RegionClaim
  return (
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
    socket.send(JSON.stringify(event))
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
    connection.online = Number(event.online)
    connection.peers = new Map(
      event.peers.filter(isPeer).map((peer) => [peer.sessionId, peer] as const),
    )
    connection.regions = event.regions.filter(isRegion).slice(0, MAX_PRESENCE_REGIONS)
    return true
  }
  if (event.type === 'presence-delta') {
    if (
      !Number.isSafeInteger(event.online) ||
      !Array.isArray(event.upsert) ||
      !Array.isArray(event.remove)
    )
      return false
    connection.online = Number(event.online)
    for (const id of event.remove) if (typeof id === 'string') connection.peers.delete(id)
    for (const peer of event.upsert) if (isPeer(peer)) connection.peers.set(peer.sessionId, peer)
    return true
  }
  if (event.type === 'regions') {
    if (!Array.isArray(event.regions)) return false
    connection.regions = event.regions.filter(isRegion).slice(0, MAX_PRESENCE_REGIONS)
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

const clearRegionsTimer = (connection: Connection): void => {
  if (connection.regionsTimer !== null) clearTimeout(connection.regionsTimer)
  connection.regionsTimer = null
}

const readHeaders = (server: ConnectedServer): HeadersInit => {
  const token = activeServerToken(server)
  return token === null ? {} : { authorization: `Bearer ${token}` }
}

const scopedEndpoint = (server: ConnectedServer, path: string): URL => {
  const endpoint = new URL(serverEndpoint(server.url, path))
  endpoint.searchParams.set('season', String(server.season))
  endpoint.searchParams.set('surface', WORLD_TEMPLATE_SURFACE.kind)
  return endpoint
}

/** How many painters a server has online, or infinity when it cannot say: it is picked last. */
const probeOnline = async (server: ConnectedServer): Promise<number> => {
  try {
    const { response, body } = await requestServerMetadata(
      scopedEndpoint(server, '/telemetry/presence/online').toString(),
      { headers: readHeaders(server) },
    )
    const online = (body as { online?: unknown } | null)?.online
    if (!response.ok || !Number.isSafeInteger(online) || (online as number) < 0)
      return Number.POSITIVE_INFINITY
    return online as number
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** A server without the socket wants its claims fetched when it has none recent enough. */
const regionsDue = (connection: Connection): boolean =>
  !connection.live &&
  connection.regionsTimer === null &&
  now() - connection.regionsAt >= PRESENCE_REGION_REFRESH_MS

/** Region claims of a server that does not carry the socket, over HTTP. */
const refreshRegions = async (connection: Connection): Promise<void> => {
  clearRegionsTimer(connection)
  if (connection.live || connection.server.season === null) return
  connection.regionsAt = now()
  try {
    const { response, body } = await requestServerMetadata(
      scopedEndpoint(connection.server, '/work/regions').toString(),
      { headers: readHeaders(connection.server) },
    )
    const regions = (body as { regions?: unknown } | null)?.regions
    if (response.ok && Array.isArray(regions)) {
      connection.regions = regions.filter(isRegion).slice(0, MAX_PRESENCE_REGIONS)
      notify()
    }
  } catch (error) {
    warn('install', 'presence regions could not be fetched', String(error))
  }
  if (
    connection.live ||
    connections.get(serverConnectionIdentity(connection.server)) !== connection
  )
    return
  clearRegionsTimer(connection)
  connection.regionsTimer = setTimeout(() => {
    connection.regionsTimer = null
    void refreshRegions(connection)
  }, PRESENCE_REGION_REFRESH_MS)
}

const liveConnection = (): Connection | null => {
  for (const connection of connections.values()) if (connection.live) return connection
  return null
}

/** Stable tie-break so painters who share the same servers land on the same one. */
const serverRank = (server: ConnectedServer): string => server.info?.id ?? server.url

/**
 * Pick the server for the socket: the one with the fewest painters online. Runs only while no
 * socket is open or pending, so an established connection is never moved.
 */
const elect = (): void => {
  if (electing || accountIdentity() === null) return
  const current = liveConnection()
  if (current !== null && (current.socket !== null || current.reconnectTimer !== null)) return
  const candidates = [...connections.values()]
  if (candidates.length === 0) return
  electing = true
  const sequence = electionSequence
  void Promise.all(
    candidates.map(async (connection) => ({
      connection,
      online: await probeOnline(connection.server),
    })),
  ).then((probed) => {
    electing = false
    if (sequence !== electionSequence) return
    const alive = probed.filter(
      ({ connection }) =>
        connections.get(serverConnectionIdentity(connection.server)) === connection,
    )
    alive.sort(
      (left, right) =>
        left.online - right.online ||
        serverRank(left.connection.server).localeCompare(serverRank(right.connection.server)),
    )
    const winner = alive[0]?.connection
    if (winner === undefined) return
    for (const connection of connections.values()) {
      connection.live = connection === winner
      if (connection.live) clearRegionsTimer(connection)
      else if (regionsDue(connection)) void refreshRegions(connection)
    }
    log('install', 'presence server chosen', {
      server: winner.server.url,
      online: alive[0]?.online,
      candidates: alive.length,
    })
    open(winner)
  })
}

const closeConnection = (connection: Connection): void => {
  clearTimers(connection)
  clearRegionsTimer(connection)
  connection.live = false
  const socket = connection.socket
  connection.socket = null
  if (socket !== null && socket.readyState < WebSocket.CLOSING) {
    try {
      socket.close(1000, 'presence retired')
    } catch {
      // Already gone.
    }
  }
  if (connection.peers.size > 0 || connection.online > 0) {
    connection.peers = new Map()
    connection.online = 0
    notify()
  }
}

const scheduleReconnect = (connection: Connection): void => {
  if (connection.reconnectTimer !== null) return
  const delay = Math.min(MAX_RECONNECT_MS, INITIAL_RECONNECT_MS * 2 ** connection.attempts)
  connection.attempts = Math.min(connection.attempts + 1, 10)
  connection.reconnectTimer = setTimeout(
    () => {
      connection.reconnectTimer = null
      // A lost socket is a fresh choice: the server may be down, or may have filled up meanwhile.
      // The backoff stays on this connection, so a server that keeps failing keeps waiting longer.
      connection.live = false
      elect()
    },
    delay + Math.random() * 500,
  )
}

const open = (connection: Connection): void => {
  const { server } = connection
  const identity = accountIdentity()
  if (
    !connection.live ||
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
  if (token === null) endpoint.searchParams.set('clientId', liveClientId(server.url))
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
    connection.attempts = 0
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
    if (message.data === 'pong') return
    let parsed: unknown
    try {
      parsed = JSON.parse(message.data)
    } catch {
      socket.close(4002, 'invalid presence event')
      return
    }
    if (!applyServerEvent(connection, parsed)) {
      socket.close(4002, 'invalid presence event')
      return
    }
    notify()
  })
  socket.addEventListener('error', () => socket.close())
  socket.addEventListener('close', () => {
    if (connection.socket !== socket) return
    connection.socket = null
    connection.sessionId = null
    clearTimers(connection)
    connection.peers = new Map()
    connection.online = 0
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
        live: false,
        socket: null,
        regionsTimer: null,
        regionsAt: Number.NEGATIVE_INFINITY,
        sessionId: null,
        peers: new Map(),
        regions: [],
        online: 0,
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
  elect()
  // Once a socket is chosen the other servers only need their claims; a server added while the
  // socket is already open joins as one of those straight away.
  if (liveConnection() !== null) {
    for (const connection of connections.values()) {
      if (regionsDue(connection)) void refreshRegions(connection)
    }
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
    const draft = tiles.length === 0 ? null : draftIn(tiles, draftedPixelOffsets)
    if (!sameDraft(draft, pendingDraft)) {
      pendingDraft = draft
      changed = true
    }
  }
  if (changed) scheduleAll()
}

/**
 * Peers and headcount from the server carrying the socket, without this tab's own session, plus
 * the claims of every presence server.
 */
export const presenceView = (): PresenceView => {
  const peers: PresencePeer[] = []
  const regions: RegionClaim[] = []
  let online = 0
  let connected = false
  for (const connection of connections.values()) {
    if (connection.live && connection.socket?.readyState === WebSocket.OPEN) {
      connected = true
      online = connection.online
      for (const peer of connection.peers.values()) {
        if (peer.sessionId !== connection.sessionId) peers.push(peer)
      }
    }
    regions.push(...connection.regions)
  }
  return { peers, regions, online, connected, me: accountIdentity() }
}

/** Presence servers that can take a claim: the one with the open socket first, then the rest. */
export const presenceServers = (): readonly ConnectedServer[] => {
  const servers: ConnectedServer[] = []
  const live = presenceLiveServer()
  if (live !== null) servers.push(live)
  for (const connection of connections.values()) {
    if (!connection.live) servers.push(connection.server)
  }
  return servers
}

/** The server carrying this tab's presence socket, when it is open. */
export const presenceLiveServer = (): ConnectedServer | null => {
  const live = liveConnection()
  return live !== null && live.socket?.readyState === WebSocket.OPEN ? live.server : null
}

/** The server a region claim came from, or null once that connection is gone. */
export const presenceRegionServer = (id: string): ConnectedServer | null => {
  for (const connection of connections.values()) {
    if (connection.regions.some((region) => region.id === id)) return connection.server
  }
  return null
}

/** The presence connection of a server, live or not, when the server supports presence. */
const connectionFor = (server: ConnectedServer): Connection | null =>
  connections.get(serverConnectionIdentity(server)) ?? null

const regionRequest = async (
  server: ConnectedServer,
  method: 'PUT' | 'DELETE',
  id: string,
  body: unknown,
): Promise<string | null> => {
  if (server.season === null) return 'Server season unknown.'
  const token = activeServerToken(server)
  if (token === null) return 'Sign in to this server to claim regions.'
  const endpoint = scopedEndpoint(server, `/work/regions/${id}`)
  try {
    const { response, body: answer } = await requestServerMutation(endpoint.toString(), {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.ok) {
      // The live server pushes the new list over the socket; the others are asked for it.
      const connection = connectionFor(server)
      if (connection !== null && !connection.live) void refreshRegions(connection)
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
): Promise<string | null> => {
  if (connectionFor(server) === null) return 'This server does not support region claims.'
  return regionRequest(server, 'PUT', id, request)
}

/** Release one region claim. Resolves to an error message, or null on success. */
export const releaseRegion = async (
  server: ConnectedServer,
  id: string,
  actor: PainterIdentity,
): Promise<string | null> => regionRequest(server, 'DELETE', id, { actor })

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
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', reconcile)
    window.addEventListener('offline', () => {
      for (const connection of connections.values()) closeConnection(connection)
    })
  }
  reconcile()
}

/** Test seam: drop every connection and forget module state. */
export const resetPresence = (): void => {
  for (const connection of connections.values()) closeConnection(connection)
  connections.clear()
  listeners.length = 0
  installed = false
  identityRequested = false
  electing = false
  electionSequence += 1
  hiddenTab = false
  pendingViewport = null
  pendingDraft = null
  draftCheckedAt = Number.NEGATIVE_INFINITY
}
