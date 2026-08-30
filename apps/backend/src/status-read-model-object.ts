import { DurableObject } from 'cloudflare:workers'
import type { LiveSyncServerEvent, StatusDelta } from '@caelestis/shared'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import {
  createSeasonStatusReadModel,
  type PersistedStatusReadModel,
  type SeasonStatusReadModel,
  type StatusProjectionChange,
  type StatusProjectionMutation,
  type StatusReadModelPersistence,
  type StatusSnapshotRead,
  type StatusVisibilityScope,
} from './status-read-model/model.js'

const MANIFEST_KEY = 'status-read-model:v2:manifest'
const CHUNK_PREFIX = 'status-read-model:v2:chunk:'
// Leave ample headroom below Durable Object storage's 2 MiB key-plus-value limit. Structured-clone
// encoding is not byte-identical to JSON, so the persisted chunks deliberately stay much smaller.
const MAX_CHUNK_JSON_BYTES = 512 * 1024
const MAX_DELTA_MESSAGE_BYTES = 32 * 1024
const LIVE_PROTOCOL = 'caelestis.live.v1'

interface LiveSubscriberAttachment {
  readonly season: number
  readonly scope: StatusVisibilityScope
  readonly tokenHash: string
  readonly revocable: boolean
  readonly lastRevision: number | null
}

export interface LiveSessionFence {
  readonly attach: <A>(revalidate: () => Promise<boolean>, attach: () => A) => Promise<A | null>
  readonly revoke: (close: () => void | Promise<void>) => Promise<void>
}

/** Serialize the second credential check, socket attachment, and revocation close scan. */
export const createLiveSessionFence = (): LiveSessionFence => {
  let tail = Promise.resolve()
  const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
    const running = tail.then(operation, operation)
    tail = running.then(
      () => undefined,
      () => undefined,
    )
    return running
  }
  return {
    attach: (revalidate, attach) => exclusive(async () => ((await revalidate()) ? attach() : null)),
    revoke: (close) => exclusive(async () => close()),
  }
}

interface PersistedChunkSlot {
  readonly revision: number
  readonly publicChunks: number
  readonly adminChunks: number
}

interface PersistedStatusManifest {
  readonly season: number
  readonly revision: number
  readonly reconciledAt: number
  readonly activeSlot: 0 | 1
  readonly slots: readonly [PersistedChunkSlot | null, PersistedChunkSlot | null]
}

const chunkKey = (slot: 0 | 1, scope: StatusVisibilityScope, index: number): string =>
  `${CHUNK_PREFIX}${slot}:${scope}:${index}`

const chunkTemplates = <A>(values: readonly A[]): readonly (readonly A[])[] => {
  const chunks: A[][] = []
  let chunk: A[] = []
  let bytes = 2
  for (const value of values) {
    const valueBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
    const nextBytes = bytes + valueBytes + (chunk.length === 0 ? 0 : 1)
    if (chunk.length > 0 && nextBytes > MAX_CHUNK_JSON_BYTES) {
      chunks.push(chunk)
      chunk = []
      bytes = 2
    }
    chunk.push(value)
    bytes += valueBytes + (chunk.length === 1 ? 0 : 1)
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

/** Atomic, bounded-value persistence for a complete season projection. */
export const createChunkedStatusPersistence = (
  storage: DurableObjectStorage,
  season: number,
): StatusReadModelPersistence => {
  let manifest: PersistedStatusManifest | null = null
  const loadChunks = async (slot: 0 | 1, scope: StatusVisibilityScope, count: number) => {
    const templates: PersistedStatusReadModel['publicTemplates'][number][] = []
    for (let index = 0; index < count; index += 1) {
      const chunk = await storage.get<PersistedStatusReadModel['publicTemplates']>(
        chunkKey(slot, scope, index),
      )
      if (chunk === undefined) return null
      templates.push(...chunk)
    }
    return templates
  }

  return {
    load: async () => {
      const stored = (await storage.get<PersistedStatusManifest>(MANIFEST_KEY)) ?? null
      if (stored === null || stored.season !== season) return null
      const slot = stored.slots[stored.activeSlot]
      if (slot === null || slot.revision !== stored.revision) return null
      const [publicTemplates, adminTemplates] = await Promise.all([
        loadChunks(stored.activeSlot, 'public', slot.publicChunks),
        loadChunks(stored.activeSlot, 'admin', slot.adminChunks),
      ])
      if (publicTemplates === null || adminTemplates === null) return null
      manifest = stored
      return {
        season: stored.season,
        revision: stored.revision,
        reconciledAt: stored.reconciledAt,
        publicTemplates,
        adminTemplates,
      }
    },
    save: async (next) => {
      if (manifest !== null && manifest.revision === next.revision) {
        const refreshed = { ...manifest, reconciledAt: next.reconciledAt }
        await storage.put(MANIFEST_KEY, refreshed)
        manifest = refreshed
        return
      }

      const targetSlot: 0 | 1 = manifest?.activeSlot === 0 ? 1 : 0
      const publicChunks = chunkTemplates(next.publicTemplates)
      const adminChunks = chunkTemplates(next.adminTemplates)
      const previousTarget = manifest?.slots[targetSlot] ?? null
      const nextSlot: PersistedChunkSlot = {
        revision: next.revision,
        publicChunks: publicChunks.length,
        adminChunks: adminChunks.length,
      }
      const slots: [PersistedChunkSlot | null, PersistedChunkSlot | null] = [
        manifest?.slots[0] ?? null,
        manifest?.slots[1] ?? null,
      ]
      slots[targetSlot] = nextSlot
      const published: PersistedStatusManifest = {
        season: next.season,
        revision: next.revision,
        reconciledAt: next.reconciledAt,
        activeSlot: targetSlot,
        slots,
      }

      await storage.transaction(async (transaction) => {
        if (previousTarget !== null) {
          for (const scope of ['public', 'admin'] as const) {
            const count =
              scope === 'public' ? previousTarget.publicChunks : previousTarget.adminChunks
            for (let index = 0; index < count; index += 1) {
              await transaction.delete(chunkKey(targetSlot, scope, index))
            }
          }
        }
        for (const [scope, chunks] of [
          ['public', publicChunks],
          ['admin', adminChunks],
        ] as const) {
          for (let index = 0; index < chunks.length; index += 1) {
            await transaction.put(chunkKey(targetSlot, scope, index), chunks[index])
          }
        }
        await transaction.put(MANIFEST_KEY, published)
      })
      manifest = published
    },
  }
}

const validSeason = (season: number): void => {
  if (!Number.isSafeInteger(season) || season < 0)
    throw new RangeError('season must be non-negative')
}

/** Cloudflare lifecycle adapter; all projection rules stay in the deep read-model module. */
export class StatusReadModelObject extends DurableObject<Env> {
  private bound: { readonly season: number; readonly model: SeasonStatusReadModel } | null = null
  private readonly sql: D1SqlStore
  private readonly liveSessions = createLiveSessionFence()

  constructor(
    private readonly objectState: DurableObjectState,
    env: Env,
  ) {
    super(objectState, env)
    this.sql = new D1SqlStore(env.DB)
  }

  private model(season: number): SeasonStatusReadModel {
    validSeason(season)
    if (this.bound !== null) {
      if (this.bound.season !== season)
        throw new Error('Durable Object is already bound to a season')
      return this.bound.model
    }
    const created = createSeasonStatusReadModel({
      season,
      source: {
        read: (requestedSeason, scope) =>
          this.sql.readTemplateStatuses(requestedSeason, scope === 'admin'),
      },
      persistence: createChunkedStatusPersistence(this.objectState.storage, season),
      revisions: {
        current: (requestedSeason) => this.sql.readStatusProjectionRevision(requestedSeason),
        commit: (
          requestedSeason,
          expectedRevision,
          retainRevision,
          publicFingerprint,
          adminFingerprint,
        ) =>
          this.sql.commitStatusProjectionRevision(
            requestedSeason,
            expectedRevision,
            retainRevision,
            publicFingerprint,
            adminFingerprint,
          ),
      },
    })
    this.bound = { season, model: created }
    return created
  }

  private send(socket: WebSocket, event: LiveSyncServerEvent): void {
    try {
      socket.send(JSON.stringify(event))
    } catch {
      try {
        socket.close(1011, 'live sync send failed')
      } catch {}
    }
  }

  private subscribers(scope?: StatusVisibilityScope): readonly WebSocket[] {
    return this.objectState.getWebSockets('status').filter((socket) => {
      const attachment = socket.deserializeAttachment() as LiveSubscriberAttachment | null
      return (
        typeof attachment === 'object' &&
        attachment !== null &&
        attachment.season === this.bound?.season &&
        (attachment.scope === 'public' || attachment.scope === 'admin') &&
        /^[0-9a-f]{64}$/.test(attachment.tokenHash) &&
        typeof attachment.revocable === 'boolean' &&
        (scope === undefined || attachment.scope === scope)
      )
    })
  }

  private broadcastStatus(scope: StatusVisibilityScope, delta: StatusDelta): void {
    const encoded = JSON.stringify({ type: 'status-delta', delta } satisfies LiveSyncServerEvent)
    const event: LiveSyncServerEvent =
      new TextEncoder().encode(encoded).byteLength <= MAX_DELTA_MESSAGE_BYTES
        ? { type: 'status-delta', delta }
        : { type: 'status-reconcile', revision: delta.revision }
    for (const socket of this.subscribers(scope)) this.send(socket, event)
  }

  async applyCommittedChange(
    season: number,
    mutation?: StatusProjectionMutation,
  ): Promise<StatusProjectionChange | null> {
    const change = await this.model(season).applyCommittedChange(mutation)
    if (change === null) {
      const snapshot = await this.model(season).reconcileSnapshot('public')
      const event: LiveSyncServerEvent = {
        type: 'status-reconcile',
        revision: snapshot.snapshot.revision,
      }
      for (const socket of this.subscribers()) this.send(socket, event)
    } else {
      this.broadcastStatus('public', change.public)
      this.broadcastStatus('admin', change.admin)
    }
    return change
  }

  reconcileSnapshot(season: number, scope: StatusVisibilityScope): Promise<StatusSnapshotRead> {
    if (scope !== 'public' && scope !== 'admin') throw new RangeError('invalid visibility scope')
    return this.model(season).reconcileSnapshot(scope)
  }

  async notifyManifestChange(season: number): Promise<void> {
    this.model(season)
    const event: LiveSyncServerEvent = { type: 'manifest-reconcile' }
    for (const socket of this.subscribers()) this.send(socket, event)
  }

  async closeCredential(season: number, tokenHash: string): Promise<void> {
    this.model(season)
    await this.liveSessions.revoke(() => {
      for (const socket of this.subscribers()) {
        const attachment = socket.deserializeAttachment() as LiveSubscriberAttachment | null
        if (attachment?.tokenHash === tokenHash) socket.close(1008, 'credential revoked')
      }
    })
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 })
    }
    const seasonHeader = request.headers.get('x-caelestis-season')
    if (seasonHeader === null || !/^(?:0|[1-9]\d*)$/.test(seasonHeader)) {
      return new Response('Invalid season', { status: 400 })
    }
    const season = Number(seasonHeader)
    const scope = request.headers.get('x-caelestis-scope')
    const tokenHash = request.headers.get('x-caelestis-token-hash')
    const revocableHeader = request.headers.get('x-caelestis-revocable')
    const revisionHeader = request.headers.get('x-caelestis-revision')
    const lastRevision = revisionHeader === null ? null : Number(revisionHeader)
    if (!Number.isSafeInteger(season)) return new Response('Invalid season', { status: 400 })
    if (scope !== 'public' && scope !== 'admin')
      return new Response('Invalid scope', { status: 400 })
    if (tokenHash === null || !/^[0-9a-f]{64}$/.test(tokenHash)) {
      return new Response('Invalid credential identity', { status: 400 })
    }
    if (revocableHeader !== '0' && revocableHeader !== '1') {
      return new Response('Invalid credential kind', { status: 400 })
    }
    const revocable = revocableHeader === '1'
    if (lastRevision !== null && (!Number.isSafeInteger(lastRevision) || lastRevision < 0)) {
      return new Response('Invalid revision', { status: 400 })
    }

    const response = await this.liveSessions.attach(
      async () => {
        if (!revocable) return true
        const token = await this.sql.readAccessToken(tokenHash)
        return token !== null && (scope === 'public' || token.scope === 'admin')
      },
      () => {
        const pair = new WebSocketPair()
        const client = pair[0]
        const server = pair[1]
        server.serializeAttachment({
          season,
          scope,
          tokenHash,
          revocable,
          lastRevision,
        } satisfies LiveSubscriberAttachment)
        this.objectState.acceptWebSocket(server, ['status'])
        return { client, server }
      },
    )
    if (response === null) return new Response('Credential revoked', { status: 401 })
    try {
      const { snapshot } = await this.model(season).reconcileSnapshot(scope)
      this.send(
        response.server,
        lastRevision === snapshot.revision
          ? { type: 'ready', revision: snapshot.revision }
          : { type: 'status-reconcile', revision: snapshot.revision },
      )
    } catch (error) {
      response.server.close(1011, 'status reconciliation failed')
      throw error
    }
    return new Response(null, {
      status: 101,
      headers: { 'sec-websocket-protocol': LIVE_PROTOCOL },
      webSocket: response.client,
    })
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === 'string' && message === 'ping') socket.send('pong')
  }

  override webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void {
    try {
      socket.close(code, reason)
    } catch {
      if (!wasClean) console.error('live sync socket closed uncleanly')
    }
  }
}
