import type { SqlStore } from '../ports/index.js'
import {
  createSeasonStatusReadModel,
  type PersistedStatusReadModel,
  type SeasonStatusReadModel,
  type StatusSnapshotRead,
  type StatusVisibilityScope,
} from './model.js'

export interface StatusReadModelPort {
  readonly applyCommittedChange: (season: number) => Promise<void>
  readonly reconcileSnapshot: (
    season: number,
    scope: StatusVisibilityScope,
  ) => Promise<StatusSnapshotRead>
}

/** Projection failure never changes the outcome of the authoritative write that preceded it. */
export const repairCommittedStatusProjection = async (
  readModel: StatusReadModelPort,
  season: number,
): Promise<void> => {
  try {
    await readModel.applyCommittedChange(season)
  } catch (error) {
    console.error(error)
  }
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
        commit: (requestedSeason, publicFingerprint, adminFingerprint) =>
          this.sql.commitStatusProjectionRevision(
            requestedSeason,
            publicFingerprint,
            adminFingerprint,
          ),
      },
    })
    this.seasons.set(season, created)
    return created
  }

  async applyCommittedChange(season: number): Promise<void> {
    await this.model(season).applyCommittedChange()
  }

  reconcileSnapshot(season: number, scope: StatusVisibilityScope): Promise<StatusSnapshotRead> {
    return this.model(season).reconcileSnapshot(scope)
  }
}
