import { DurableObject } from 'cloudflare:workers'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import type {
  CommittedStatusChange,
  StatusReadModel,
  StatusSnapshotQuery,
  StatusSubscriberQuery,
  StatusVisibilityScope,
} from './ports/index.js'
import {
  createStatusReadModel,
  type StatusProjectionStorage,
  type StoredStatusSnapshot,
} from './status-read-model/model.js'

const keyFor = (season: number, scope: StatusVisibilityScope): string => `status:${season}:${scope}`

class DurableStatusProjectionStorage implements StatusProjectionStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  async read(season: number, scope: StatusVisibilityScope): Promise<StoredStatusSnapshot | null> {
    return (await this.storage.get<StoredStatusSnapshot>(keyFor(season, scope))) ?? null
  }

  async write(
    season: number,
    scope: StatusVisibilityScope,
    snapshot: StoredStatusSnapshot,
  ): Promise<void> {
    await this.storage.put(keyFor(season, scope), snapshot)
  }
}

/** Reconstructible season status projection; D1 remains authoritative for every field and revision. */
export class StatusReadModelObject extends DurableObject<Env> implements StatusReadModel {
  private readonly model: StatusReadModel
  private readonly storage: DurableObjectStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.storage = ctx.storage
    const sql = new D1SqlStore(env.DB)
    this.model = createStatusReadModel({
      source: {
        readRevision: (season) => sql.readStatusProjectionRevision(season),
        advanceRevision: (season) => sql.advanceStatusProjectionRevision(season),
        readTemplates: (season, scope) => sql.readTemplateStatuses(season, scope === 'admin'),
      },
      storage: new DurableStatusProjectionStorage(ctx.storage),
    })
  }

  private async runForSeason<A>(season: number, run: () => Promise<A>): Promise<A> {
    if (!Number.isSafeInteger(season) || season < 0) throw new Error('invalid status season')
    const held = await this.storage.get<number>('season')
    if (held === undefined) await this.storage.put('season', season)
    else if (held !== season) {
      throw new Error(`status read-model object is scoped to season ${held}, not ${season}`)
    }
    return run()
  }

  applyCommittedChange(change: CommittedStatusChange): Promise<void> {
    return this.runForSeason(change.season, () => this.model.applyCommittedChange(change))
  }

  reconcileSnapshot(query: StatusSnapshotQuery) {
    return this.runForSeason(query.season, () => this.model.reconcileSnapshot(query))
  }

  attachSubscriber(query: StatusSubscriberQuery) {
    return this.runForSeason(query.season, () => this.model.attachSubscriber(query))
  }
}
