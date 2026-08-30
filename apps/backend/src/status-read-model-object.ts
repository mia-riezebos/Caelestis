import { DurableObject } from 'cloudflare:workers'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import {
  createSeasonStatusReadModel,
  type PersistedStatusReadModel,
  type SeasonStatusReadModel,
  type StatusSnapshotRead,
  type StatusVisibilityScope,
} from './status-read-model/model.js'

const STORAGE_KEY = 'status-read-model:v1'

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
      persistence: {
        load: async () =>
          (await this.objectState.storage.get<PersistedStatusReadModel>(STORAGE_KEY)) ?? null,
        save: async (next) => {
          await this.objectState.storage.put(STORAGE_KEY, next)
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
