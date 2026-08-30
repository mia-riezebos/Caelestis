import { DurableObject } from 'cloudflare:workers'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import {
  createSeasonStatusReadModel,
  type PersistedStatusReadModel,
  type SeasonStatusReadModel,
  type StatusReadModelPersistence,
  type StatusSnapshotRead,
  type StatusVisibilityScope,
} from './status-read-model/model.js'

const MANIFEST_KEY = 'status-read-model:v2:manifest'
const CHUNK_PREFIX = 'status-read-model:v2:chunk:'
// Leave ample headroom below Durable Object storage's 2 MiB key-plus-value limit. Structured-clone
// encoding is not byte-identical to JSON, so the persisted chunks deliberately stay much smaller.
const MAX_CHUNK_JSON_BYTES = 512 * 1024

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
        commit: (requestedSeason, publicFingerprint, adminFingerprint) =>
          this.sql.commitStatusProjectionRevision(
            requestedSeason,
            publicFingerprint,
            adminFingerprint,
          ),
      },
    })
    this.bound = { season, model: created }
    return created
  }

  async applyCommittedChange(season: number): Promise<void> {
    await this.model(season).applyCommittedChange()
  }

  reconcileSnapshot(season: number, scope: StatusVisibilityScope): Promise<StatusSnapshotRead> {
    if (scope !== 'public' && scope !== 'admin') throw new RangeError('invalid visibility scope')
    return this.model(season).reconcileSnapshot(scope)
  }
}
