import type { TemplateSurface, TileCoord } from '@caelestis/shared'
import {
  createSeasonManifestReadModel,
  type ManifestProjectionInput,
  type ManifestProjectionRead,
  type PersistedManifestReadModel,
  type SeasonManifestReadModel,
} from '../manifest/read-model.js'
import { assembleManifestProjection } from '../manifest/source.js'
import type { SqlStore } from '../ports/index.js'
import {
  createSeasonStatusReadModel,
  type PersistedStatusReadModel,
  type SeasonStatusReadModel,
  type StatusProjectionChange,
  type StatusProjectionMutation,
  type StatusSnapshotRead,
  type StatusVisibilityScope,
} from './model.js'
import {
  type CommittedTileGeneration,
  createTileGenerationCache,
  type PreparedTileGenerationCommit,
  type TileGenerationCacheRead,
  type TileGenerationOffer,
} from './tile-generation-cache.js'

export interface StatusReadModelPort {
  readonly applyCommittedChange: (
    season: number,
    mutation?: StatusProjectionMutation,
  ) => Promise<StatusProjectionChange | null>
  readonly reconcileSnapshot: (
    season: number,
    scope: StatusVisibilityScope,
  ) => Promise<StatusSnapshotRead>
  /** Optional on portable adapters; production uses it to wake hibernating manifest subscribers. */
  readonly notifyManifestChange?: (season: number, surface?: TemplateSurface) => Promise<void>
  /** Optional on portable adapters; production wakes live clients after alarm state changes. */
  readonly notifyAlarmChange?: (season: number) => Promise<void>
  /** Optional for compatibility adapters; prepared production and direct adapters cache manifests. */
  readonly readManifestProjection?: (
    input: ManifestProjectionInput,
  ) => Promise<ManifestProjectionRead>
  /** Optional on portable adapters; production closes live sessions through this current season. */
  readonly closeCredential?: (season: number, tokenHash: string) => Promise<void>
  readonly resolveCurrentTileOffers?: (
    season: number,
    scope: StatusVisibilityScope,
    offers: readonly TileGenerationOffer[],
  ) => Promise<TileGenerationCacheRead>
  readonly prepareTileGenerationCommit?: (
    season: number,
    tile: TileCoord,
  ) => Promise<PreparedTileGenerationCommit>
  readonly applyCommittedTileGeneration?: (
    season: number,
    generation: CommittedTileGeneration,
  ) => Promise<void>
  readonly finishTileGenerationCommit?: (
    season: number,
    tile: TileCoord,
    commit: PreparedTileGenerationCommit,
  ) => Promise<void>
}

export const prepareTileGenerationCommit = (
  readModel: StatusReadModelPort,
  season: number,
  tile: TileCoord,
): Promise<PreparedTileGenerationCommit | null> =>
  readModel.prepareTileGenerationCommit?.(season, tile) ?? Promise.resolve(null)

export const resolveCurrentTileOffers = async (
  readModel: StatusReadModelPort,
  season: number,
  scope: StatusVisibilityScope,
  offers: readonly TileGenerationOffer[],
): Promise<TileGenerationCacheRead> => {
  const unresolved = (): TileGenerationCacheRead => ({
    acknowledgedDeliveryIds: [],
    unresolvedDeliveryIds: offers.map((offer) => offer.deliveryId),
    cacheOutcome: 'miss',
    coverageToken: null,
  })
  if (readModel.resolveCurrentTileOffers === undefined) return unresolved()
  try {
    return await readModel.resolveCurrentTileOffers(season, scope, offers)
  } catch (error) {
    console.error('tile generation cache read failed', error)
    return unresolved()
  }
}

/** Cache repair never changes the authoritative D1 commit that preceded it. */
export const repairCommittedTileGeneration = async (
  readModel: StatusReadModelPort,
  season: number,
  generation: CommittedTileGeneration,
): Promise<void> => {
  const finishPrepared = () =>
    generation.commitToken === undefined || generation.commitExpiresAt === undefined
      ? Promise.resolve()
      : finishTileGenerationCommit(readModel, season, generation.tile, {
          coverageToken: generation.coverageToken,
          commitToken: generation.commitToken,
          commitExpiresAt: generation.commitExpiresAt,
        })
  if (readModel.applyCommittedTileGeneration === undefined) {
    await finishPrepared()
    return
  }
  try {
    await readModel.applyCommittedTileGeneration(season, generation)
  } catch (error) {
    console.error(error)
    await finishPrepared()
  }
}

/** Finish a losing tile commit so an earlier authoritative winner can leave the pending fence. */
export const finishTileGenerationCommit = async (
  readModel: StatusReadModelPort,
  season: number,
  tile: TileCoord,
  commit: PreparedTileGenerationCommit,
): Promise<void> => {
  try {
    await readModel.finishTileGenerationCommit?.(season, tile, commit)
  } catch (error) {
    console.error(error)
  }
}

/** Projection failure never changes the outcome of the authoritative write that preceded it. */
export const repairCommittedStatusProjection = async (
  readModel: StatusReadModelPort,
  season: number,
  mutation?: StatusProjectionMutation,
): Promise<StatusProjectionChange | null> => {
  try {
    return await readModel.applyCommittedChange(season, mutation)
  } catch (error) {
    console.error(error)
    return null
  }
}

/** Manifest publication is reconstructible and must never roll back its authoritative mutation. */
export const publishManifestChange = async (
  readModel: StatusReadModelPort,
  season: number,
  surface?: TemplateSurface,
): Promise<void> => {
  try {
    await readModel.notifyManifestChange?.(season, surface)
  } catch (error) {
    console.error(error)
  }
}

/** Alarm notifications are reconstructible hints; a failed hint never fails authoritative work. */
export const publishAlarmChange = async (
  readModel: StatusReadModelPort,
  season: number,
): Promise<void> => {
  try {
    await readModel.notifyAlarmChange?.(season)
  } catch (error) {
    console.error(error)
  }
}

/** Production adapters propagate cleanup failure so idempotent revocation can be retried. */
export const closeLiveCredential = async (
  readModel: StatusReadModelPort,
  season: number,
  tokenHash: string,
): Promise<void> => {
  await readModel.closeCredential?.(season, tokenHash)
}

/** Portable process-local adapter used by tests and non-Worker entry points. */
export class DirectStatusReadModel implements StatusReadModelPort {
  private readonly seasons = new Map<number, SeasonStatusReadModel>()
  private readonly manifests = new Map<number, SeasonManifestReadModel>()
  private readonly tileGenerations = new Map<number, ReturnType<typeof createTileGenerationCache>>()

  constructor(private readonly sql: SqlStore) {}

  private model(season: number): SeasonStatusReadModel {
    const held = this.seasons.get(season)
    if (held !== undefined) return held
    let persisted: PersistedStatusReadModel | null = null
    const created = createSeasonStatusReadModel({
      season,
      source: {
        read: (requestedSeason, scope) =>
          this.sql.readTemplateStatuses(requestedSeason, scope === 'admin'),
      },
      persistence: {
        load: async () => persisted,
        save: async (next) => {
          persisted = next
        },
      },
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
    this.seasons.set(season, created)
    return created
  }

  private manifestModel(season: number): SeasonManifestReadModel {
    const held = this.manifests.get(season)
    if (held !== undefined) return held
    let persisted: PersistedManifestReadModel | null = null
    const created = createSeasonManifestReadModel({
      season,
      source: (input) => assembleManifestProjection(this.sql, input),
      persistence: {
        load: async () => persisted,
        save: async (next) => {
          persisted = next
        },
      },
    })
    this.manifests.set(season, created)
    return created
  }

  async applyCommittedChange(
    season: number,
    mutation?: StatusProjectionMutation,
  ): Promise<StatusProjectionChange | null> {
    return this.model(season).applyCommittedChange(mutation)
  }

  reconcileSnapshot(season: number, scope: StatusVisibilityScope): Promise<StatusSnapshotRead> {
    return this.model(season).reconcileSnapshot(scope)
  }

  readManifestProjection(input: ManifestProjectionInput): Promise<ManifestProjectionRead> {
    return this.manifestModel(input.season).read(input)
  }

  async notifyManifestChange(season: number, surface?: TemplateSurface): Promise<void> {
    this.tileGenerations.get(season)?.invalidate()
    await this.manifestModel(season).invalidate(surface)
  }

  resolveCurrentTileOffers(
    season: number,
    scope: StatusVisibilityScope,
    offers: readonly TileGenerationOffer[],
  ): Promise<TileGenerationCacheRead> {
    const cache = this.tileGenerations.get(season) ?? createTileGenerationCache()
    this.tileGenerations.set(season, cache)
    return Promise.resolve(cache.resolve(scope, offers))
  }

  prepareTileGenerationCommit(
    season: number,
    tile: TileCoord,
  ): Promise<PreparedTileGenerationCommit> {
    const cache = this.tileGenerations.get(season) ?? createTileGenerationCache()
    this.tileGenerations.set(season, cache)
    return Promise.resolve(cache.prepare(tile))
  }

  applyCommittedTileGeneration(season: number, generation: CommittedTileGeneration): Promise<void> {
    const cache = this.tileGenerations.get(season) ?? createTileGenerationCache()
    this.tileGenerations.set(season, cache)
    cache.apply(generation)
    return Promise.resolve()
  }

  finishTileGenerationCommit(
    season: number,
    tile: TileCoord,
    commit: PreparedTileGenerationCommit,
  ): Promise<void> {
    const cache = this.tileGenerations.get(season) ?? createTileGenerationCache()
    this.tileGenerations.set(season, cache)
    cache.finish(tile, commit)
    return Promise.resolve()
  }
}
