import { DurableObject } from 'cloudflare:workers'
import {
  decodePresenceDraftMask,
  isWorkIdentity,
  MAX_PRESENCE_MASK_BITS,
  MAX_PRESENCE_MESSAGE_CODE_UNITS,
  MAX_PRESENCE_MESSAGES_PER_SECOND,
  MAX_PRESENCE_PEERS,
  MAX_PRESENCE_SUBSCRIBERS,
  MAX_PRESENCE_SUBSCRIBERS_PER_CLIENT,
  PRESENCE_INTEREST_PADDING,
  PRESENCE_PROTOCOL_V1,
  PRESENCE_STALE_MS,
  PRESENCE_TICK_MS,
  type PresenceDraft,
  type PresencePeer,
  type PresenceRect,
  type PresenceServerEvent,
  padRect,
  peerRect,
  quantiseRect,
  type RegionClaim,
  rectCentreDistance,
  rectsIntersect,
  sameRect,
  type TemplateSurface,
  templateSurface,
} from '@caelestis/shared'
import { PresenceClientEvent } from '@caelestis/wire-schema'
import { Schema } from 'effect'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { instrumentD1, normalizeMetricClientIdentity } from './metrics/request-metrics.js'
import { presenceRectWithinSurface } from './presence/geometry.js'
import type { PresenceConnection } from './presence/port.js'
import { createLiveSessionFence } from './status-read-model-object.js'

interface Attachment extends PresenceConnection {
  readonly sessionId: string
  readonly viewport: PresenceRect | null
  readonly draftRect: PresenceRect | null
  readonly draftPixels: number
  readonly lastSeenAt: number
  readonly closed?: boolean
}

const natural = (text: string | null): number | null => {
  if (text === null || !/^(0|[1-9]\d*)$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}

/** Repack a mask after snapping its rectangle outward; the bit origins must move together. */
const quantisedDraft = (draft: PresenceDraft): PresenceDraft => {
  const rect = quantiseRect(draft.rect)
  if (sameRect(rect, draft.rect)) return draft
  const bits = rect.w * rect.h
  if (draft.mask === undefined || bits > MAX_PRESENCE_MASK_BITS)
    return { rect, pixels: draft.pixels }
  const source = decodePresenceDraftMask(draft)
  if (source === null) return { rect, pixels: draft.pixels }
  const bytes = new Uint8Array(Math.ceil(bits / 8))
  for (let bit = 0; bit < source.length; bit++) {
    if (source[bit] !== 1) continue
    const x = draft.rect.x - rect.x + (bit % draft.rect.w)
    const y = draft.rect.y - rect.y + Math.floor(bit / draft.rect.w)
    const target = y * rect.w + x
    bytes[target >> 3] = (bytes[target >> 3] ?? 0) | (128 >> (target & 7))
  }
  return { rect, pixels: draft.pixels, mask: btoa(String.fromCharCode(...bytes)) }
}

/** One hibernating room per season and drawing surface. Only region claims live in D1. */
export class PresenceObject extends DurableObject<Env> {
  private readonly sql: D1SqlStore
  private readonly sessions = createLiveSessionFence()
  private readonly masks = new Map<string, string>()
  private readonly rates = new Map<string, number[]>()
  private readonly sent = new Map<string, Set<string>>()
  private readonly onlineSent = new Map<string, number>()
  private readonly dirty = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    super(state, env)
    this.sql = new D1SqlStore(instrumentD1(env.DB))
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private attachment(socket: WebSocket): Attachment {
    return socket.deserializeAttachment() as Attachment
  }

  private sockets(): WebSocket[] {
    return this.state
      .getWebSockets('presence')
      .filter((socket) => !this.attachment(socket).closed && socket.readyState === WebSocket.OPEN)
  }

  private peer(attachment: Attachment): PresencePeer {
    const mask = this.masks.get(attachment.sessionId)
    return {
      sessionId: attachment.sessionId,
      painter: attachment.painter,
      viewport: attachment.viewport,
      draft:
        attachment.draftRect === null
          ? null
          : {
              rect: attachment.draftRect,
              pixels: attachment.draftPixels,
              ...(mask === undefined ? {} : { mask }),
            },
    }
  }

  private relevant(subscriber: Attachment, peers: readonly PresencePeer[]): PresencePeer[] {
    const viewport = subscriber.viewport
    if (viewport === null) return []
    const interest = padRect(viewport, PRESENCE_INTEREST_PADDING)
    return peers
      .flatMap((peer) => {
        const rect = peerRect(peer)
        return peer.sessionId !== subscriber.sessionId &&
          rect !== null &&
          rectsIntersect(interest, rect)
          ? [{ peer, distance: rectCentreDistance(viewport, rect) }]
          : []
      })
      .sort((a, b) => a.distance - b.distance || a.peer.sessionId.localeCompare(b.peer.sessionId))
      .slice(0, MAX_PRESENCE_PEERS)
      .map(({ peer }) => peer)
  }

  private send(socket: WebSocket, event: PresenceServerEvent): void {
    try {
      socket.send(JSON.stringify(event))
    } catch {
      this.close(socket, 1011, 'presence send failed')
    }
  }

  private armTick(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.tick()
    }, PRESENCE_TICK_MS)
  }

  private tick(): void {
    const now = Date.now()
    for (const socket of this.sockets()) {
      if (now - this.attachment(socket).lastSeenAt > PRESENCE_STALE_MS)
        this.close(socket, 1000, 'presence stale')
    }
    const sockets = this.sockets()
    const peers = sockets.map((socket) => this.peer(this.attachment(socket)))
    const dirty = new Set(this.dirty)
    this.dirty.clear()
    for (const socket of sockets) {
      const subscriber = this.attachment(socket)
      const relevant = this.relevant(subscriber, peers)
      const previous = this.sent.get(subscriber.sessionId) ?? new Set<string>()
      const next = new Set(relevant.map((peer) => peer.sessionId))
      const upsert = relevant.filter(
        (peer) => dirty.has(peer.sessionId) || !previous.has(peer.sessionId),
      )
      const remove = [...previous].filter((id) => !next.has(id))
      const onlineChanged = this.onlineSent.get(subscriber.sessionId) !== sockets.length
      this.sent.set(subscriber.sessionId, next)
      this.onlineSent.set(subscriber.sessionId, sockets.length)
      if (upsert.length || remove.length || onlineChanged)
        this.send(socket, { type: 'presence-delta', online: sockets.length, upsert, remove })
    }
  }

  private drop(socket: WebSocket): void {
    const attachment = this.attachment(socket)
    socket.serializeAttachment({ ...attachment, closed: true } satisfies Attachment)
    const id = attachment.sessionId
    this.masks.delete(id)
    this.rates.delete(id)
    this.sent.delete(id)
    this.onlineSent.delete(id)
    this.dirty.add(id)
    this.armTick()
  }

  private close(socket: WebSocket, code: number, reason: string): void {
    this.drop(socket)
    try {
      socket.close(code, reason)
    } catch {
      console.error('presence socket close failed')
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response('WebSocket upgrade required', { status: 426 })
    const headers = request.headers
    const season = natural(headers.get('x-caelestis-season'))
    const alliance = headers.get('x-caelestis-alliance-id')
    const surface = templateSurface(
      headers.get('x-caelestis-surface-kind'),
      alliance === null ? null : natural(alliance),
    )
    let displayName: string
    try {
      displayName = decodeURIComponent(headers.get('x-caelestis-painter-name') ?? '')
    } catch {
      return new Response('Invalid painter name', { status: 400 })
    }
    const painter = { wplaceUserId: natural(headers.get('x-caelestis-painter-id')), displayName }
    const tokenHash = headers.get('x-caelestis-token-hash')
    const clientHash = headers.get('x-caelestis-client-hash')
    const credentialScope = headers.get('x-caelestis-credential-scope')
    const anonymous = headers.get('x-caelestis-anonymous')
    const revocable = headers.get('x-caelestis-revocable')
    if (
      season === null ||
      surface === null ||
      (alliance !== null && natural(alliance) === null) ||
      !isWorkIdentity(painter) ||
      tokenHash === null ||
      !/^[0-9a-f]{64}$/.test(tokenHash) ||
      clientHash === null ||
      !/^[0-9a-f]{64}$/.test(clientHash) ||
      (credentialScope !== 'read' && credentialScope !== 'report' && credentialScope !== 'admin') ||
      (anonymous !== '0' && anonymous !== '1') ||
      (revocable !== '0' && revocable !== '1')
    )
      return new Response('Invalid presence connection', { status: 400 })
    const metric = normalizeMetricClientIdentity(
      headers.get('x-caelestis-metric-client') ?? 'unknown',
      headers.get('x-caelestis-metric-client-version') ?? 'unknown',
    )
    let capacity = false
    let regions: readonly RegionClaim[] = []
    const pair = await this.sessions.attach(
      async () => {
        const sockets = this.sockets()
        capacity =
          sockets.length >= MAX_PRESENCE_SUBSCRIBERS ||
          sockets.filter((socket) => this.attachment(socket).clientHash === clientHash).length >=
            MAX_PRESENCE_SUBSCRIBERS_PER_CLIENT
        if (capacity) return false
        if (revocable === '1') {
          const token = await this.sql.readAccessToken(tokenHash)
          if (token === null || token.scope !== credentialScope) return false
        }
        // Share the fence with region publication so ready cannot arrive after a newer regions event.
        regions = await this.sql.regions.listRegions(season, surface)
        return true
      },
      () => {
        const pair = new WebSocketPair()
        const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('')
        const attachment: Attachment = {
          sessionId,
          season,
          surface,
          painter,
          tokenHash,
          clientHash,
          credentialScope,
          anonymous: anonymous === '1',
          revocable: revocable === '1',
          metricClient: metric.client,
          metricClientVersion: metric.clientVersion,
          viewport: null,
          draftRect: null,
          draftPixels: 0,
          lastSeenAt: Date.now(),
        }
        pair[1].serializeAttachment(attachment)
        this.state.acceptWebSocket(pair[1], ['presence', tokenHash])
        const sockets = this.sockets()
        const peers = this.relevant(
          attachment,
          sockets.map((socket) => this.peer(this.attachment(socket))),
        )
        this.sent.set(sessionId, new Set(peers.map((peer) => peer.sessionId)))
        this.onlineSent.set(sessionId, sockets.length)
        this.send(pair[1], {
          type: 'presence-ready',
          sessionId,
          online: sockets.length,
          peers,
          regions,
        })
        this.dirty.add(sessionId)
        this.armTick()
        return pair
      },
    )
    if (capacity)
      return new Response('Presence subscriber limit reached', {
        status: 503,
        headers: { 'Retry-After': '30' },
      })
    if (pair === null) return new Response('Credential revoked', { status: 401 })
    const responseHeaders = new Headers()
    if (
      headers
        .get('sec-websocket-protocol')
        ?.split(',')
        .some((protocol) => protocol.trim() === PRESENCE_PROTOCOL_V1)
    )
      responseHeaders.set('sec-websocket-protocol', PRESENCE_PROTOCOL_V1)
    return new Response(null, { status: 101, headers: responseHeaders, webSocket: pair[0] })
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const attachment = this.attachment(socket)
    if (attachment.closed) return
    if (typeof message !== 'string') return
    if (message.length > MAX_PRESENCE_MESSAGE_CODE_UNITS) {
      this.close(socket, 1009, 'presence message too large')
      return
    }
    if (message === 'ping') {
      socket.send('pong')
      return
    }
    const now = Date.now()
    const rate = (this.rates.get(attachment.sessionId) ?? []).filter((at) => now - at < 1_000)
    rate.push(now)
    this.rates.set(attachment.sessionId, rate)
    if (rate.length > MAX_PRESENCE_MESSAGES_PER_SECOND) {
      this.close(socket, 1008, 'presence rate limit')
      return
    }
    let event: Schema.Schema.Type<typeof PresenceClientEvent>
    try {
      event = Schema.decodeUnknownSync(PresenceClientEvent)(JSON.parse(message))
    } catch {
      return
    }
    if (event.type === 'presence-heartbeat') {
      socket.serializeAttachment({ ...attachment, lastSeenAt: now } satisfies Attachment)
      this.armTick()
      return
    }
    if (attachment.credentialScope === 'read') return
    const viewport =
      event.viewport === undefined
        ? attachment.viewport
        : event.viewport === null
          ? null
          : quantiseRect(event.viewport)
    const draft =
      event.draft === undefined
        ? undefined
        : event.draft === null
          ? null
          : quantisedDraft(event.draft)
    if (
      (event.viewport != null && !presenceRectWithinSurface(event.viewport, attachment.surface)) ||
      (event.draft != null && !presenceRectWithinSurface(event.draft.rect, attachment.surface)) ||
      (viewport !== null && !presenceRectWithinSurface(viewport, attachment.surface)) ||
      (draft != null && !presenceRectWithinSurface(draft.rect, attachment.surface))
    )
      return
    if (draft !== undefined) {
      if (draft?.mask === undefined) this.masks.delete(attachment.sessionId)
      else this.masks.set(attachment.sessionId, draft.mask)
    }
    socket.serializeAttachment({
      ...attachment,
      viewport,
      draftRect: draft === undefined ? attachment.draftRect : (draft?.rect ?? null),
      draftPixels: draft === undefined ? attachment.draftPixels : (draft?.pixels ?? 0),
      lastSeenAt: now,
    } satisfies Attachment)
    this.dirty.add(attachment.sessionId)
    this.armTick()
  }

  override webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): void {
    this.close(socket, code, reason)
  }
  override webSocketError(socket: WebSocket): void {
    this.close(socket, 1011, 'presence socket error')
  }

  /** Reload committed claims and deliver the surface's authoritative region list. */
  async publishRegions(season: number, surface: TemplateSurface): Promise<void> {
    await this.sessions.revoke(async () => {
      const regions = await this.sql.regions.listRegions(season, surface)
      for (const socket of this.sockets()) this.send(socket, { type: 'regions', regions })
    })
  }

  /** Fence revocation against the second D1 credential check and socket acceptance. */
  async closeCredential(tokenHash: string): Promise<void> {
    await this.sessions.revoke(() => {
      for (const socket of this.sockets())
        if (this.attachment(socket).tokenHash === tokenHash)
          this.close(socket, 1008, 'credential revoked')
    })
  }
}
