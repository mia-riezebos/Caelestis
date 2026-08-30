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
  readonly notifyManifestChange?: (season: number) => Promise<void>
  /** Optional on portable adapters; production closes live sessions for a revoked credential. */
  readonly closeCredential?: (season: number, tokenHash: string) => Promise<void>
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
): Promise<void> => {
  try {
    await readModel.notifyManifestChange?.(season)
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

  async applyCommittedChange(
    season: number,
    mutation?: StatusProjectionMutation,
  ): Promise<StatusProjectionChange | null> {
    return this.model(season).applyCommittedChange(mutation)
  }

  reconcileSnapshot(season: number, scope: StatusVisibilityScope): Promise<StatusSnapshotRead> {
    return this.model(season).reconcileSnapshot(scope)
  }
}
