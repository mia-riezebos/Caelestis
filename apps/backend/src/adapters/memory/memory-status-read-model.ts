import type { SqlStore, StatusReadModel, StatusVisibilityScope } from '../../ports/index.js'
import {
  createStatusReadModel,
  type StatusProjectionStorage,
  type StoredStatusSnapshot,
} from '../../status-read-model/model.js'

class MemoryStatusProjectionStorage implements StatusProjectionStorage {
  private readonly snapshots = new Map<string, StoredStatusSnapshot>()

  async read(season: number, scope: StatusVisibilityScope): Promise<StoredStatusSnapshot | null> {
    return this.snapshots.get(`${season}:${scope}`) ?? null
  }

  async write(
    season: number,
    scope: StatusVisibilityScope,
    snapshot: StoredStatusSnapshot,
  ): Promise<void> {
    this.snapshots.set(`${season}:${scope}`, structuredClone(snapshot))
  }
}

/** Portable runtime fallback used by memory adapters and tests. */
export const createMemoryStatusReadModel = (
  sql: SqlStore,
  options: {
    readonly now?: () => number
    readonly repairAfterMs?: number
  } = {},
): StatusReadModel =>
  createStatusReadModel({
    source: {
      readRevision: (season) => sql.readStatusProjectionRevision(season),
      advanceRevision: (season) => sql.advanceStatusProjectionRevision(season),
      readTemplates: (season, scope) => sql.readTemplateStatuses(season, scope === 'admin'),
    },
    storage: new MemoryStatusProjectionStorage(),
    ...options,
  })
