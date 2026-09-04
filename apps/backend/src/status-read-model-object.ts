import { DurableObject } from 'cloudflare:workers'
import type {
  LiveDashboardSubscription,
  LiveProjectionState,
  LiveSyncClientEvent,
  LiveSyncServerEvent,
  LiveTileUpload,
  Manifest,
  ServerInfo,
  StatusDelta,
  TemplateSurface,
} from '@caelestis/shared'
import {
  decodeLiveTileUpload,
  encodeLiveServerEvent,
  MAX_LIVE_BINARY_HEADER_BYTES,
  MAX_LIVE_BINARY_PAYLOAD_BYTES,
  parseTileKey,
  seconds,
  sha256Hex,
  type TileCoord,
  templateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import {
  LiveSyncClientEvent as LiveSyncClientEventSchema,
  LiveTileUpload as LiveTileUploadSchema,
} from '@caelestis/wire-schema'
import { Schema } from 'effect'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { DurableObjectCounterStore } from './adapters/cloudflare/do-counter-store.js'
import { R2BlobStore } from './adapters/cloudflare/r2-blob-store.js'
import { type Scope, satisfiesScope } from './auth/tokens.js'
import {
  createSeasonManifestReadModel,
  type ManifestProjectionInput,
  type ManifestProjectionRead,
  type ManifestReadModelPersistence,
  type PersistedManifestProjection,
  type SeasonManifestReadModel,
} from './manifest/read-model.js'
import { assembleManifestProjection } from './manifest/source.js'
import {
  type CacheOutcome,
  type D1Usage,
  instrumentD1,
  type MeasuredD1Operation,
  measureD1Usage,
  normalizeMetricClientIdentity,
  recordLiveTileOfferCacheMetric,
} from './metrics/request-metrics.js'
import {
  type BackendRuntime,
  createBackendRuntime,
  makeBackendContext,
} from './runtime/backend-runtime.js'
import {
  LIVE_CACHE_OUTCOME_HEADER,
  LIVE_D1_USAGE_HEADER,
} from './status-read-model/live-measurement.js'
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
import type { StatusReadModelPort } from './status-read-model/port.js'
import {
  type CommittedTileGeneration,
  createTileGenerationCache,
  type PreparedTileGenerationCommit,
  type TileGenerationCacheRead,
  type TileGenerationOffer,
} from './status-read-model/tile-generation-cache.js'
import {
  MAX_CANVAS_TILE_BYTES,
  offerTilesWithOutcome,
  recordPaint,
  uploadTile,
} from './telemetry/ingest.js'
import { readAlarms, readContributions, readLeaderboard } from './telemetry/queries.js'

const MANIFEST_KEY = 'status-read-model:v2:manifest'
const CHUNK_PREFIX = 'status-read-model:v2:chunk:'
// Leave ample headroom below Durable Object storage's 2 MiB key-plus-value limit. Structured-clone
// encoding is not byte-identical to JSON, so the persisted chunks deliberately stay much smaller.
const MAX_CHUNK_JSON_BYTES = 512 * 1024
const MAX_DELTA_MESSAGE_BYTES = 32 * 1024
export const MAX_LIVE_SUBSCRIBERS = 256
export const MAX_LIVE_ANONYMOUS_SUBSCRIBERS = 128
export const MAX_LIVE_SUBSCRIBERS_PER_CLIENT = 16
export const MAX_LIVE_CLIENT_MESSAGE_CODE_UNITS = 64 * 1024
export const MAX_LIVE_CLIENT_BINARY_BYTES =
  4 + MAX_LIVE_BINARY_HEADER_BYTES + MAX_LIVE_BINARY_PAYLOAD_BYTES
const MANIFEST_CACHE_INDEX_KEY = 'manifest-read-model:v1:index'
const MAX_TILE_FUTURE_SKEW_SECONDS = 5 * 60
const MAX_DASHBOARD_SUBSCRIPTIONS = 4
// 128 Ki UTF-16 code units are at most 384 KiB in UTF-8, below the intended 512 KiB ceiling.
const MANIFEST_CACHE_CHUNK_CODE_UNITS = 128 * 1024

interface LiveSubscriberAttachment {
  readonly season: number
  readonly scope: StatusVisibilityScope
  readonly credentialScope?: Scope
  readonly tokenHash: string
  readonly clientHash?: string
  readonly anonymous?: boolean
  readonly revocable: boolean
  readonly lastRevision: number | null
  readonly stateVectorReceived?: boolean
  readonly revoked?: boolean
  readonly metricClient?: string
  readonly metricClientVersion?: string
  readonly protocol: 1 | 2
  readonly projections?: readonly LiveProjectionState[]
  readonly dashboardSubscriptions?: readonly LiveDashboardSubscription[]
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

interface StoredManifestProjection extends Omit<PersistedManifestProjection, 'manifest'> {
  readonly version: string
  readonly generation: string
  readonly chunks: number
}

interface StoredManifestRetirement {
  readonly generation: string
  readonly chunks: number
}

interface StoredManifestCacheIndex {
  readonly season: number
  readonly revision: number
  readonly entries: readonly StoredManifestProjection[]
  readonly retired: readonly StoredManifestRetirement[]
}

const manifestChunkKey = (generation: string, index: number): string =>
  `manifest-read-model:v1:chunk:${generation}:${index}`

const tileCoverageToken = (manifestRevision: number): string => `manifest:${manifestRevision}`

const liveMeasurementHeaders = (
  usage: D1Usage,
  cacheOutcome?: Exclude<CacheOutcome, 'none'>,
): Headers => {
  const headers = new Headers({
    [LIVE_D1_USAGE_HEADER]: [
      usage.rowsRead,
      usage.rowsWritten,
      usage.measuredQueries,
      usage.unmeasuredQueries,
    ].join(','),
  })
  if (cacheOutcome !== undefined) headers.set(LIVE_CACHE_OUTCOME_HEADER, cacheOutcome)
  return headers
}

const chunkJsonText = (value: string): readonly string[] => {
  const chunks: string[] = []
  for (let offset = 0; offset < value.length; offset += MANIFEST_CACHE_CHUNK_CODE_UNITS) {
    chunks.push(value.slice(offset, offset + MANIFEST_CACHE_CHUNK_CODE_UNITS))
  }
  return chunks
}

/** Persist each bounded projection independently so one cache write never rewrites every surface. */
export const createChunkedManifestPersistence = (
  storage: DurableObjectStorage,
  season: number,
): ManifestReadModelPersistence => {
  let index: StoredManifestCacheIndex | null = null
  const invalidGenerations = new Set<string>()
  const loadIndex = async () => {
    index ??= (await storage.get<StoredManifestCacheIndex>(MANIFEST_CACHE_INDEX_KEY)) ?? null
    return index
  }
  const deleteRetired = async (retired: readonly StoredManifestRetirement[]) => {
    const keys = retired.flatMap(({ generation, chunks }) =>
      Array.from({ length: chunks }, (_, chunk) => manifestChunkKey(generation, chunk)),
    )
    for (let offset = 0; offset < keys.length; offset += 128) {
      await storage.delete(keys.slice(offset, offset + 128))
    }
  }
  return {
    loadRevision: async () => {
      const stored = await loadIndex()
      return stored?.season === season ? stored.revision : null
    },
    load: async () => {
      const stored = await loadIndex()
      if (stored === null || stored.season !== season) return null
      const entries: PersistedManifestProjection[] = []
      for (const entry of stored.entries) {
        const parts: string[] = []
        for (let chunk = 0; chunk < entry.chunks; chunk += 1) {
          const part = await storage.get<string>(manifestChunkKey(entry.generation, chunk))
          if (part === undefined) {
            invalidGenerations.add(entry.generation)
            return { season: stored.season, revision: stored.revision, entries: [] }
          }
          parts.push(part)
        }
        try {
          const manifest: unknown = JSON.parse(parts.join(''))
          if (
            typeof manifest !== 'object' ||
            manifest === null ||
            !('version' in manifest) ||
            manifest.version !== entry.version
          ) {
            invalidGenerations.add(entry.generation)
            return { season: stored.season, revision: stored.revision, entries: [] }
          }
          entries.push({ ...entry, manifest: manifest as Manifest })
        } catch {
          invalidGenerations.add(entry.generation)
          return { season: stored.season, revision: stored.revision, entries: [] }
        }
      }
      return { season: stored.season, revision: stored.revision, entries }
    },
    save: async (next) => {
      const previous = await loadIndex()
      const priorEntries = new Map(previous?.entries.map((entry) => [entry.key, entry]) ?? [])
      const reservedGenerations = new Set([
        ...(previous?.entries.map((entry) => entry.generation) ?? []),
        ...(previous?.retired.map((entry) => entry.generation) ?? []),
      ])
      const entries: StoredManifestProjection[] = []
      const newlyRetired: StoredManifestRetirement[] = []
      const repairedGenerations: string[] = []
      for (const projection of next.entries) {
        const prior = priorEntries.get(projection.key)
        if (
          prior?.version === projection.manifest.version &&
          !invalidGenerations.has(prior.generation)
        ) {
          entries.push({
            ...prior,
            configuredServer: projection.configuredServer,
            cachedAt: projection.cachedAt,
            expiresAt: projection.expiresAt,
          })
          priorEntries.delete(projection.key)
          continue
        }
        const generationPrefix = `${next.revision}-${projection.manifest.version}-${encodeURIComponent(projection.key)}:`
        let generationIndex = 0
        while (reservedGenerations.has(`${generationPrefix}${generationIndex}`)) generationIndex++
        const generation = `${generationPrefix}${generationIndex}`
        reservedGenerations.add(generation)
        const chunks = chunkJsonText(JSON.stringify(projection.manifest))
        await storage.transaction(async (transaction) => {
          for (let chunk = 0; chunk < chunks.length; chunk += 1) {
            await transaction.put(manifestChunkKey(generation, chunk), chunks[chunk])
          }
        })
        entries.push({
          key: projection.key,
          configuredServer: projection.configuredServer,
          cachedAt: projection.cachedAt,
          expiresAt: projection.expiresAt,
          serializedBytes: projection.serializedBytes,
          version: projection.manifest.version,
          generation,
          chunks: chunks.length,
        })
        if (prior !== undefined) {
          newlyRetired.push({ generation: prior.generation, chunks: prior.chunks })
          if (invalidGenerations.has(prior.generation)) repairedGenerations.push(prior.generation)
          priorEntries.delete(projection.key)
        }
      }
      newlyRetired.push(
        ...[...priorEntries.values()].map(({ generation, chunks }) => ({ generation, chunks })),
      )
      const retired = [...(previous?.retired ?? []), ...newlyRetired]
      const published: StoredManifestCacheIndex = {
        season: next.season,
        revision: next.revision,
        entries,
        retired,
      }
      await storage.put(MANIFEST_CACHE_INDEX_KEY, published)
      index = published
      for (const generation of repairedGenerations) invalidGenerations.delete(generation)
      if (retired.length > 0) {
        try {
          await deleteRetired(retired)
          const cleaned = { ...published, retired: [] }
          await storage.put(MANIFEST_CACHE_INDEX_KEY, cleaned)
          index = cleaned
        } catch (error) {
          // The new index is already durable. Retired chunks are reconstructible garbage and the
          // next save retries their cleanup; they must not suppress the invalidation or live event.
          console.error(error)
        }
      }
    },
  }
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
  private readonly bindings: Env
  private bound: { readonly season: number; readonly model: SeasonStatusReadModel } | null = null
  private manifestBound: {
    readonly season: number
    readonly model: SeasonManifestReadModel
  } | null = null
  private boundSeason: number | null = null
  private readonly sql: D1SqlStore
  private readonly liveSessions = createLiveSessionFence()
  private readonly tileGenerations = createTileGenerationCache()
  private tileGenerationCoverageRevision = 0
  private readonly requestMetrics: AnalyticsEngineDataset | undefined
  private runtime: BackendRuntime | null = null

  constructor(
    private readonly objectState: DurableObjectState,
    env: Env,
  ) {
    super(objectState, env)
    this.bindings = env
    this.sql = new D1SqlStore(instrumentD1(env.DB))
    this.requestMetrics = env.REQUEST_METRICS
    this.objectState.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private backendRuntime(): BackendRuntime {
    if (this.runtime !== null) return this.runtime
    const liveReadModel: StatusReadModelPort = {
      applyCommittedChange: (season, mutation) => this.applyCommittedChange(season, mutation),
      reconcileSnapshot: (season, scope) => this.reconcileSnapshot(season, scope),
      resolveCurrentTileOffers: async (season, scope, offers) =>
        this.resolveCurrentTileOffers(season, scope, offers),
      prepareTileGenerationCommit: (season, tile) => this.prepareTileGenerationCommit(season, tile),
      applyCommittedTileGeneration: (season, generation) =>
        this.applyCommittedTileGeneration(season, generation),
      finishTileGenerationCommit: (season, tile, commit) =>
        this.finishTileGenerationCommit(season, tile, commit),
    }
    this.runtime = createBackendRuntime(
      makeBackendContext(
        new R2BlobStore(this.bindings.BLOBS),
        this.sql,
        new DurableObjectCounterStore(this.bindings.TELEMETRY),
        liveReadModel,
      ),
    )
    return this.runtime
  }

  private model(season: number): SeasonStatusReadModel {
    this.bindSeason(season)
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

  private bindSeason(season: number): void {
    validSeason(season)
    if (this.boundSeason !== null && this.boundSeason !== season) {
      throw new Error('Durable Object is already bound to a season')
    }
    this.boundSeason = season
  }

  private manifestModel(season: number): SeasonManifestReadModel {
    this.bindSeason(season)
    if (this.manifestBound !== null) return this.manifestBound.model
    const model = createSeasonManifestReadModel({
      season,
      source: (input) => assembleManifestProjection(this.sql, input),
      persistence: createChunkedManifestPersistence(this.objectState.storage, season),
    })
    this.manifestBound = { season, model }
    return model
  }

  private synchronizeTileGenerationCoverage(revision: number): void {
    if (revision <= this.tileGenerationCoverageRevision) return
    this.tileGenerationCoverageRevision = revision
    this.tileGenerations.synchronizeCoverageToken(tileCoverageToken(revision))
  }

  private async loadTileGenerationCoverage(season: number): Promise<void> {
    this.synchronizeTileGenerationCoverage(await this.manifestModel(season).revision())
  }

  private send(socket: WebSocket, event: LiveSyncServerEvent): void {
    try {
      for (const message of encodeLiveServerEvent(event)) socket.send(message)
    } catch {
      try {
        socket.close(1011, 'live sync send failed')
      } catch {}
    }
  }

  private configuredServer(): ServerInfo {
    return {
      id: this.bindings.SERVER_ID,
      name: this.bindings.SERVER_NAME,
      ...(this.bindings.SERVER_DESCRIPTION === undefined
        ? {}
        : { description: this.bindings.SERVER_DESCRIPTION }),
      auth: this.bindings.OPEN_ACCESS === 'true' ? 'none' : 'access_token',
      liveSync: 2,
      liveSyncMin: 1,
      liveTileOffers: 1,
    }
  }

  private projectionSurface(projection: LiveProjectionState): TemplateSurface | null {
    if (projection.resource === 'telemetry-alarms') return null
    if (projection.scope === 'world') return WORLD_TEMPLATE_SURFACE
    const match = /^(alliance-headquarters|alliance-picture|alliance-banner):([1-9]\d*)$/.exec(
      projection.scope,
    )
    return match === null ? null : templateSurface(match[1], Number(match[2]))
  }

  private async sendProjectionSnapshot(
    socket: WebSocket,
    attachment: LiveSubscriberAttachment,
    projection: LiveProjectionState,
  ): Promise<void> {
    if (projection.resource === 'telemetry-alarms') {
      if (projection.scope !== 'world') return
      const alarms = await this.backendRuntime().run(
        readAlarms(attachment.season, attachment.scope === 'admin'),
      )
      this.send(socket, { type: 'alarms-snapshot', alarms })
      return
    }
    const surface = this.projectionSurface(projection)
    if (
      surface === null ||
      (projection.resource === 'world-manifest') !== (surface.kind === 'world')
    ) {
      return
    }
    const read = await this.manifestModel(attachment.season).read({
      server: this.configuredServer(),
      season: attachment.season,
      surface,
      scope: attachment.scope,
      ifNoneMatch: [],
    })
    if (read.notModified) return
    this.send(socket, {
      type: 'manifest-snapshot',
      resource: projection.resource,
      scope: projection.scope,
      manifest: read.manifest,
    })
  }

  private async liveProjectionVersion(
    season: number,
    scope: StatusVisibilityScope,
    projection: LiveProjectionState,
  ): Promise<string | null> {
    if (projection.resource === 'telemetry-alarms') {
      if (projection.scope !== 'world') return null
      const alarms = await this.sql.readActiveAlarms(season, scope === 'admin')
      return sha256Hex(new TextEncoder().encode(JSON.stringify(alarms)))
    }
    const surface = this.projectionSurface(projection)
    if (
      surface === null ||
      (projection.resource === 'world-manifest') !== (surface.kind === 'world')
    )
      return null
    return this.manifestModel(season).knownVersion(scope, surface)
  }

  private async reconcileLiveState(
    socket: WebSocket,
    attachment: LiveSubscriberAttachment,
    event: Extract<LiveSyncClientEvent, { readonly type: 'state-vector' }>,
  ): Promise<void> {
    const read = await this.model(attachment.season).reconcileSnapshot(attachment.scope)
    const authoritative = await Promise.all(
      event.projections.map(async (projection) => ({
        ...projection,
        version: await this.liveProjectionVersion(attachment.season, attachment.scope, projection),
      })),
    )
    if (attachment.protocol === 2) {
      if (event.revision !== read.snapshot.revision) {
        this.send(socket, { type: 'status-snapshot', status: read.snapshot })
      }
      await Promise.all(
        authoritative.map(async (projection, index) => {
          if (projection.version === event.projections[index]?.version) return
          await this.sendProjectionSnapshot(socket, attachment, projection)
        }),
      )
    }
    const usable =
      event.revision !== null &&
      event.projections.every((projection) => projection.version !== null) &&
      authoritative.every((projection) => projection.version !== null)
    this.send(socket, {
      type: 'state-correction',
      requestId: event.requestId,
      mode: usable ? 'correction' : 'snapshot',
      revision: read.snapshot.revision,
      projections: usable
        ? authoritative.filter(
            (projection, index) => projection.version !== event.projections[index]?.version,
          )
        : authoritative,
    })
  }

  private subscribers(scope?: StatusVisibilityScope): readonly WebSocket[] {
    return this.objectState.getWebSockets('status').filter((socket) => {
      const attachment = socket.deserializeAttachment() as LiveSubscriberAttachment | null
      return (
        typeof attachment === 'object' &&
        attachment !== null &&
        attachment.season === this.boundSeason &&
        (attachment.scope === 'public' || attachment.scope === 'admin') &&
        /^[0-9a-f]{64}$/.test(attachment.tokenHash) &&
        typeof attachment.revocable === 'boolean' &&
        attachment.revoked !== true &&
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

  applyCommittedChangeMeasured(
    season: number,
    mutation?: StatusProjectionMutation,
  ): Promise<MeasuredD1Operation<StatusProjectionChange | null>> {
    return measureD1Usage(() => this.applyCommittedChange(season, mutation))
  }

  reconcileSnapshot(season: number, scope: StatusVisibilityScope): Promise<StatusSnapshotRead> {
    if (scope !== 'public' && scope !== 'admin') throw new RangeError('invalid visibility scope')
    return this.model(season).reconcileSnapshot(scope)
  }

  reconcileSnapshotMeasured(
    season: number,
    scope: StatusVisibilityScope,
  ): Promise<MeasuredD1Operation<StatusSnapshotRead>> {
    return measureD1Usage(() => this.reconcileSnapshot(season, scope))
  }

  async readManifestProjection(input: ManifestProjectionInput): Promise<ManifestProjectionRead> {
    const projection = await this.manifestModel(input.season).read(input)
    if (projection.revisionChanged) {
      this.synchronizeTileGenerationCoverage(projection.revision)
      this.broadcastManifest(projection.revision)
    }
    return projection
  }

  readManifestProjectionMeasured(
    input: ManifestProjectionInput,
  ): Promise<MeasuredD1Operation<ManifestProjectionRead>> {
    return measureD1Usage(() => this.readManifestProjection(input))
  }

  private broadcastManifest(revision: number, surface?: TemplateSurface): void {
    const event: LiveSyncServerEvent = {
      type: 'manifest-reconcile',
      revision,
      ...(surface === undefined ? {} : { surface }),
    }
    for (const socket of this.subscribers()) this.send(socket, event)
  }

  private async broadcastManifestSnapshots(surface?: TemplateSurface): Promise<void> {
    await Promise.all(
      this.subscribers().map(async (socket) => {
        const attachment = socket.deserializeAttachment() as LiveSubscriberAttachment | null
        if (attachment?.protocol !== 2) return
        for (const projection of attachment.projections ?? []) {
          const requested = this.projectionSurface(projection)
          if (
            projection.resource === 'telemetry-alarms' ||
            requested === null ||
            (surface !== undefined &&
              (requested.kind !== surface.kind || requested.allianceId !== surface.allianceId))
          ) {
            continue
          }
          await this.sendProjectionSnapshot(socket, attachment, projection)
        }
      }),
    )
  }

  async notifyManifestChange(season: number, surface?: TemplateSurface): Promise<void> {
    this.bindSeason(season)
    this.tileGenerations.invalidate()
    const revision = await this.manifestModel(season).invalidate(surface)
    this.synchronizeTileGenerationCoverage(revision)
    this.broadcastManifest(revision, surface)
    await this.broadcastManifestSnapshots(surface)
  }

  resolveCurrentTileOffers(
    season: number,
    scope: StatusVisibilityScope,
    offers: readonly TileGenerationOffer[],
  ): TileGenerationCacheRead {
    this.bindSeason(season)
    return this.tileGenerations.resolve(scope, offers)
  }

  resolveCurrentTileOffersMeasured(
    season: number,
    scope: StatusVisibilityScope,
    offers: readonly TileGenerationOffer[],
  ): Promise<MeasuredD1Operation<TileGenerationCacheRead>> {
    return measureD1Usage(() =>
      Promise.resolve(this.resolveCurrentTileOffers(season, scope, offers)),
    )
  }

  async prepareTileGenerationCommit(
    season: number,
    tile: TileCoord,
  ): Promise<PreparedTileGenerationCommit> {
    this.bindSeason(season)
    await this.loadTileGenerationCoverage(season)
    return this.tileGenerations.prepare(tile)
  }

  async applyCommittedTileGeneration(
    season: number,
    generation: CommittedTileGeneration,
  ): Promise<void> {
    this.bindSeason(season)
    if (generation.commitToken !== undefined) {
      await this.loadTileGenerationCoverage(season)
    }
    this.tileGenerations.apply(generation)
  }

  async finishTileGenerationCommit(
    season: number,
    tile: TileCoord,
    commit: PreparedTileGenerationCommit,
  ): Promise<void> {
    this.bindSeason(season)
    await this.loadTileGenerationCoverage(season)
    this.tileGenerations.finish(tile, commit)
  }

  async notifyAlarmChange(season: number): Promise<void> {
    this.bindSeason(season)
    const event: LiveSyncServerEvent = { type: 'alarms-reconcile' }
    for (const socket of this.subscribers()) this.send(socket, event)
    await Promise.all(
      this.subscribers().map(async (socket) => {
        const attachment = socket.deserializeAttachment() as LiveSubscriberAttachment | null
        if (attachment?.protocol !== 2) return
        await this.sendProjectionSnapshot(socket, attachment, {
          resource: 'telemetry-alarms',
          scope: 'world',
          version: null,
        })
      }),
    )
  }

  private async sendDashboardSnapshot(
    socket: WebSocket,
    attachment: LiveSubscriberAttachment,
    subscription: LiveDashboardSubscription,
  ): Promise<void> {
    const now = seconds(Math.floor(Date.now() / 1_000) + 1)
    if (subscription.contributionsFrom >= now) return
    const includeUnpublished = attachment.scope === 'admin'
    const [contributions, leaderboard] = await Promise.all([
      this.backendRuntime().run(
        readContributions({
          templateIds: subscription.templateIds,
          range: { fromSeconds: subscription.contributionsFrom, toSeconds: now },
          includeUnpublished,
        }),
      ),
      this.backendRuntime().run(
        readLeaderboard({
          season: attachment.season,
          templateIds: subscription.templateIds,
          limit: subscription.leaderboardLimit,
          includeUnpublished,
        }),
      ),
    ])
    this.send(socket, {
      type: 'dashboard-snapshot',
      subscriptionId: subscription.subscriptionId,
      contributions,
      leaderboard,
    })
  }

  private async broadcastDashboardSnapshots(): Promise<void> {
    await Promise.all(
      this.subscribers().flatMap((socket) => {
        const attachment = socket.deserializeAttachment() as LiveSubscriberAttachment | null
        if (attachment?.protocol !== 2) return []
        return (attachment.dashboardSubscriptions ?? []).map((subscription) =>
          this.sendDashboardSnapshot(socket, attachment, subscription),
        )
      }),
    )
  }

  private canReport(attachment: LiveSubscriberAttachment | null, season: number): boolean {
    return (
      attachment !== null &&
      attachment.protocol === 2 &&
      attachment.season === season &&
      attachment.credentialScope !== undefined &&
      satisfiesScope(attachment.credentialScope, 'report')
    )
  }

  private async handlePaintReport(
    socket: WebSocket,
    attachment: LiveSubscriberAttachment | null,
    event: Extract<LiveSyncClientEvent, { readonly type: 'paint-report' }>,
  ): Promise<void> {
    if (!this.canReport(attachment, event.event.season)) {
      this.send(socket, {
        type: 'paint-result',
        requestId: event.requestId,
        eventId: event.event.eventId,
        result: 'duplicate',
        error: 'forbidden',
      })
      return
    }
    try {
      const result = await this.backendRuntime().run(
        recordPaint(event.event, attachment?.tokenHash ?? '', attachment?.scope === 'admin'),
      )
      this.send(socket, {
        type: 'paint-result',
        requestId: event.requestId,
        eventId: event.event.eventId,
        result,
      })
      if (result === 'recorded') await this.broadcastDashboardSnapshots()
    } catch {
      this.send(socket, {
        type: 'paint-result',
        requestId: event.requestId,
        eventId: event.event.eventId,
        result: 'duplicate',
        error: 'unavailable',
      })
    }
  }

  private async handleTileOffer(
    socket: WebSocket,
    attachment: LiveSubscriberAttachment | null,
    event: Extract<LiveSyncClientEvent, { readonly type: 'tile-offer' }>,
  ): Promise<void> {
    const unresolved = event.batch.offers.map((offer) => offer.deliveryId)
    const empty = { acknowledgedDeliveryIds: [], wanted: [], rejectedDeliveryIds: [] }
    if (!this.canReport(attachment, event.batch.season)) {
      this.send(socket, {
        type: 'tile-offer-result',
        requestId: event.requestId,
        response: empty,
        error: 'forbidden',
      })
      return
    }
    const parsed = event.batch.offers.map((offer) => ({ offer, tile: parseTileKey(offer.tile) }))
    if (
      new Set(unresolved).size !== unresolved.length ||
      new Set(event.batch.offers.map((offer) => offer.tile)).size !== event.batch.offers.length ||
      parsed.some(({ tile }) => tile === null)
    ) {
      this.send(socket, {
        type: 'tile-offer-result',
        requestId: event.requestId,
        response: empty,
        error: 'invalid',
      })
      return
    }
    const receivedAt = seconds(Math.floor(Date.now() / 1_000))
    try {
      const result = await this.backendRuntime().run(
        offerTilesWithOutcome(
          parsed.map(({ offer, tile }) => ({
            key: offer.tile,
            metadata: {
              wplaceUserId: event.batch.wplaceUserId,
              displayName: event.batch.displayName,
              tokenHash: attachment?.tokenHash ?? '',
              season: event.batch.season,
              tile: tile ?? { x: -1, y: -1 },
              hash: offer.sha256,
              observedAt: seconds(Math.min(offer.ts, receivedAt + MAX_TILE_FUTURE_SKEW_SECONDS)),
              includeUnpublished: attachment?.scope === 'admin',
            },
          })),
        ),
      )
      const byTile = new Map<string, string>(
        event.batch.offers.map((offer) => [offer.tile, offer.deliveryId]),
      )
      const coverageToken = result.coverageTokens.get(
        `${event.batch.season}:${attachment?.scope === 'admin' ? 'admin' : 'public'}`,
      )
      this.send(socket, {
        type: 'tile-offer-result',
        requestId: event.requestId,
        response: {
          acknowledgedDeliveryIds: result.acknowledged.flatMap((tile) => {
            const deliveryId = byTile.get(tile)
            return deliveryId === undefined ? [] : [deliveryId]
          }),
          wanted: result.wanted.flatMap((tile) => {
            const deliveryId = byTile.get(tile)
            return deliveryId === undefined
              ? []
              : [{ deliveryId, ...(coverageToken === undefined ? {} : { coverageToken }) }]
          }),
          rejectedDeliveryIds: result.rejectedKeys.flatMap((tile) => {
            const deliveryId = byTile.get(tile)
            return deliveryId === undefined ? [] : [deliveryId]
          }),
        },
      })
    } catch {
      this.send(socket, {
        type: 'tile-offer-result',
        requestId: event.requestId,
        response: empty,
        error: 'unavailable',
      })
    }
  }

  private async handleTileUpload(
    socket: WebSocket,
    attachment: LiveSubscriberAttachment | null,
    message: ArrayBuffer,
  ): Promise<void> {
    const frame = decodeLiveTileUpload(message)
    const metadata: LiveTileUpload | null = (() => {
      if (frame === null) return null
      try {
        return Schema.decodeUnknownSync(LiveTileUploadSchema)(frame.metadata)
      } catch {
        return null
      }
    })()
    if (frame === null || metadata === null) {
      socket.close(1003, 'invalid live tile upload')
      return
    }
    if (!this.canReport(attachment, metadata.season)) {
      this.send(socket, {
        type: 'tile-upload-result',
        requestId: metadata.requestId,
        deliveryId: metadata.deliveryId,
        accepted: false,
        error: 'forbidden',
      })
      return
    }
    const tile = parseTileKey(metadata.tile)
    if (tile === null || frame.payload.byteLength > MAX_CANVAS_TILE_BYTES) {
      this.send(socket, {
        type: 'tile-upload-result',
        requestId: metadata.requestId,
        deliveryId: metadata.deliveryId,
        accepted: false,
        error: 'invalid',
      })
      return
    }
    const receivedAt = seconds(Math.floor(Date.now() / 1_000))
    try {
      await this.backendRuntime().run(
        uploadTile(
          {
            wplaceUserId: metadata.wplaceUserId,
            displayName: metadata.displayName,
            tokenHash: attachment?.tokenHash ?? '',
            season: metadata.season,
            tile,
            hash: metadata.sha256,
            observedAt: seconds(Math.min(metadata.ts, receivedAt + MAX_TILE_FUTURE_SKEW_SECONDS)),
            includeUnpublished: attachment?.scope === 'admin',
          },
          frame.payload,
          metadata.coverageToken === undefined ? {} : { coverageToken: metadata.coverageToken },
        ),
      )
      this.send(socket, {
        type: 'tile-upload-result',
        requestId: metadata.requestId,
        deliveryId: metadata.deliveryId,
        accepted: true,
      })
    } catch (error) {
      this.send(socket, {
        type: 'tile-upload-result',
        requestId: metadata.requestId,
        deliveryId: metadata.deliveryId,
        accepted: false,
        error: error instanceof RangeError ? 'invalid' : 'unavailable',
      })
    }
  }

  private async handleDashboardSubscription(
    socket: WebSocket,
    attachment: LiveSubscriberAttachment | null,
    event: Extract<LiveSyncClientEvent, { readonly type: 'dashboard-subscribe' }>,
  ): Promise<void> {
    if (attachment?.protocol !== 2) return
    const retained = (attachment.dashboardSubscriptions ?? []).filter(
      (subscription) => subscription.subscriptionId !== event.subscription.subscriptionId,
    )
    if (retained.length >= MAX_DASHBOARD_SUBSCRIPTIONS) {
      socket.close(1008, 'too many dashboard subscriptions')
      return
    }
    const next = [...retained, event.subscription]
    const updated = { ...attachment, dashboardSubscriptions: next }
    socket.serializeAttachment(updated satisfies LiveSubscriberAttachment)
    await this.sendDashboardSnapshot(socket, updated, event.subscription)
  }

  async closeCredential(season: number, tokenHash: string): Promise<void> {
    this.model(season)
    await this.liveSessions.revoke(() => {
      for (const socket of this.subscribers()) {
        const attachment = socket.deserializeAttachment() as LiveSubscriberAttachment | null
        if (attachment?.tokenHash !== tokenHash || attachment.revoked === true) continue
        socket.serializeAttachment({
          ...attachment,
          revoked: true,
        } satisfies LiveSubscriberAttachment)
        socket.close(1008, 'credential revoked')
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
    const credentialScope = request.headers.get('x-caelestis-credential-scope')
    const tokenHash = request.headers.get('x-caelestis-token-hash')
    const clientHash = request.headers.get('x-caelestis-client-hash')
    const anonymousHeader = request.headers.get('x-caelestis-anonymous')
    const revocableHeader = request.headers.get('x-caelestis-revocable')
    const protocolHeader = request.headers.get('x-caelestis-live-protocol')
    const protocol =
      protocolHeader === null || protocolHeader === '1' ? 1 : protocolHeader === '2' ? 2 : null
    const revisionHeader = request.headers.get('x-caelestis-revision')
    const lastRevision = revisionHeader === null ? null : Number(revisionHeader)
    const stateVector = new URL(request.url).searchParams.get('stateVector') === '1'
    if (!Number.isSafeInteger(season)) return new Response('Invalid season', { status: 400 })
    if (scope !== 'public' && scope !== 'admin')
      return new Response('Invalid scope', { status: 400 })
    if (tokenHash === null || !/^[0-9a-f]{64}$/.test(tokenHash)) {
      return new Response('Invalid credential identity', { status: 400 })
    }
    if (clientHash === null || !/^[0-9a-f]{64}$/.test(clientHash)) {
      return new Response('Invalid client identity', { status: 400 })
    }
    if (anonymousHeader !== '0' && anonymousHeader !== '1') {
      return new Response('Invalid client kind', { status: 400 })
    }
    const anonymous = anonymousHeader === '1'
    if (credentialScope !== 'read' && credentialScope !== 'report' && credentialScope !== 'admin')
      return new Response('Invalid credential scope', { status: 400 })
    if (revocableHeader !== '0' && revocableHeader !== '1') {
      return new Response('Invalid credential kind', { status: 400 })
    }
    if (protocol === null) return new Response('Invalid live protocol', { status: 400 })
    const revocable = revocableHeader === '1'
    const metricClient = normalizeMetricClientIdentity(
      request.headers.get('x-caelestis-metric-client') ?? 'unknown',
      request.headers.get('x-caelestis-metric-client-version') ?? 'unknown',
    )
    if (lastRevision !== null && (!Number.isSafeInteger(lastRevision) || lastRevision < 0)) {
      return new Response('Invalid revision', { status: 400 })
    }
    const measured = await measureD1Usage(async () => {
      let capacityExceeded = false
      const response = await this.liveSessions.attach(
        async () => {
          const sockets = this.objectState.getWebSockets('status')
          if (sockets.length >= MAX_LIVE_SUBSCRIBERS) {
            capacityExceeded = true
            return false
          }
          let anonymousConnections = 0
          let clientConnections = 0
          for (const socket of sockets) {
            const attachment = socket.deserializeAttachment() as LiveSubscriberAttachment | null
            if (attachment?.revoked === true) continue
            if (attachment?.anonymous === true) anonymousConnections += 1
            if (attachment?.clientHash === clientHash) clientConnections += 1
          }
          if (anonymous && anonymousConnections >= MAX_LIVE_ANONYMOUS_SUBSCRIBERS) {
            capacityExceeded = true
            return false
          }
          if (clientConnections >= MAX_LIVE_SUBSCRIBERS_PER_CLIENT) {
            capacityExceeded = true
            return false
          }
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
            credentialScope,
            tokenHash,
            clientHash,
            anonymous,
            revocable,
            lastRevision,
            revoked: false,
            metricClient: metricClient.client,
            metricClientVersion: metricClient.clientVersion,
            protocol,
          } satisfies LiveSubscriberAttachment)
          this.objectState.acceptWebSocket(server, ['status'])
          return { client, server }
        },
      )
      if (capacityExceeded) return { kind: 'capacity' as const }
      if (response === null) return { kind: 'revoked' as const }
      try {
        if (stateVector) {
          return {
            kind: 'connected' as const,
            ...response,
            cacheOutcome: undefined,
          }
        }
        const read = await this.model(season).reconcileSnapshot(scope)
        this.send(
          response.server,
          lastRevision === read.snapshot.revision
            ? { type: 'ready', revision: read.snapshot.revision }
            : { type: 'status-reconcile', revision: read.snapshot.revision },
        )
        return { kind: 'connected' as const, ...response, cacheOutcome: read.cacheOutcome }
      } catch (error) {
        response.server.close(1011, 'status reconciliation failed')
        throw error
      }
    })
    if (!measured.success) throw measured.error
    if (measured.value.kind === 'capacity') {
      const headers = liveMeasurementHeaders(measured.usage)
      headers.set('Retry-After', '30')
      return new Response('Live subscriber limit reached', { status: 503, headers })
    }
    if (measured.value.kind === 'revoked') {
      return new Response('Credential revoked', {
        status: 401,
        headers: liveMeasurementHeaders(measured.usage),
      })
    }
    const headers = liveMeasurementHeaders(measured.usage, measured.value.cacheOutcome)
    headers.set('sec-websocket-protocol', `caelestis.live.v${protocol}`)
    return new Response(null, {
      status: 101,
      headers,
      webSocket: measured.value.client,
    })
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const startedAt = performance.now()
    const attachment = socket.deserializeAttachment() as LiveSubscriberAttachment | null
    if (attachment?.revoked === true) {
      socket.close(1008, 'credential revoked')
      return
    }
    if (typeof message === 'string' && message === 'ping') {
      socket.send('pong')
      return
    }
    if (message instanceof ArrayBuffer) {
      if (message.byteLength > MAX_LIVE_CLIENT_BINARY_BYTES) {
        socket.close(1009, 'live message too large')
        return
      }
      await this.handleTileUpload(socket, attachment, message)
      return
    }
    if (message.length > MAX_LIVE_CLIENT_MESSAGE_CODE_UNITS) {
      socket.close(1009, 'live message too large')
      return
    }
    const event: LiveSyncClientEvent | null = (() => {
      try {
        return Schema.decodeUnknownSync(LiveSyncClientEventSchema)(JSON.parse(message))
      } catch {
        return null
      }
    })()
    if (event === null) return
    if (event.type === 'state-vector') {
      if (
        attachment === null ||
        !Number.isSafeInteger(attachment.season) ||
        attachment.season < 0 ||
        (attachment.scope !== 'public' && attachment.scope !== 'admin')
      ) {
        socket.close(1008, 'invalid live state scope')
        return
      }
      if (attachment.stateVectorReceived === true) {
        socket.close(1008, 'state vector already received')
        return
      }
      const updated = {
        ...attachment,
        stateVectorReceived: true,
        projections: event.projections,
      }
      socket.serializeAttachment(updated satisfies LiveSubscriberAttachment)
      this.bindSeason(attachment.season)
      await this.reconcileLiveState(socket, updated, event)
      return
    }
    if (event.type === 'paint-report') {
      await this.handlePaintReport(socket, attachment, event)
      return
    }
    if (event.type === 'tile-offer') {
      await this.handleTileOffer(socket, attachment, event)
      return
    }
    if (event.type === 'dashboard-subscribe') {
      await this.handleDashboardSubscription(socket, attachment, event)
      return
    }
    if (event.type === 'dashboard-unsubscribe') {
      if (attachment?.protocol !== 2) return
      socket.serializeAttachment({
        ...attachment,
        dashboardSubscriptions: (attachment.dashboardSubscriptions ?? []).filter(
          (subscription) => subscription.subscriptionId !== event.subscriptionId,
        ),
      } satisfies LiveSubscriberAttachment)
      return
    }
    if (event.type !== 'tile-offer-cache') return
    const unresolvedDeliveryIds = event.batch.offers.map((offer) => offer.deliveryId)
    if (
      attachment === null ||
      attachment.season !== event.batch.season ||
      attachment.credentialScope === undefined ||
      !satisfiesScope(attachment.credentialScope, 'report')
    ) {
      this.send(socket, {
        type: 'tile-offer-cache-result',
        requestId: event.requestId,
        response: { acknowledgedDeliveryIds: [], unresolvedDeliveryIds, error: 'forbidden' },
      })
      return
    }
    const uniqueDeliveries = new Set(unresolvedDeliveryIds)
    const uniqueTiles = new Set(event.batch.offers.map((offer) => offer.tile))
    const parsed = event.batch.offers.map((offer) => ({ offer, tile: parseTileKey(offer.tile) }))
    if (
      uniqueDeliveries.size !== event.batch.offers.length ||
      uniqueTiles.size !== event.batch.offers.length ||
      parsed.some(({ tile }) => tile === null)
    ) {
      this.send(socket, {
        type: 'tile-offer-cache-result',
        requestId: event.requestId,
        response: { acknowledgedDeliveryIds: [], unresolvedDeliveryIds, error: 'invalid' },
      })
      return
    }
    const response = this.resolveCurrentTileOffers(
      event.batch.season,
      attachment.scope,
      parsed.map(({ offer, tile }) => ({
        deliveryId: offer.deliveryId,
        // The null case returned above.
        tile: tile ?? { x: -1, y: -1 },
        hash: offer.sha256,
      })),
    )
    recordLiveTileOfferCacheMetric(this.requestMetrics, {
      client: attachment.metricClient ?? 'unknown',
      clientVersion: attachment.metricClientVersion ?? 'unknown',
      cacheOutcome: response.cacheOutcome,
      requested: event.batch.offers.length,
      acknowledged: response.acknowledgedDeliveryIds.length,
      durationMs: performance.now() - startedAt,
    })
    this.send(socket, {
      type: 'tile-offer-cache-result',
      requestId: event.requestId,
      response: {
        acknowledgedDeliveryIds: response.acknowledgedDeliveryIds,
        unresolvedDeliveryIds: response.unresolvedDeliveryIds,
      },
    })
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
