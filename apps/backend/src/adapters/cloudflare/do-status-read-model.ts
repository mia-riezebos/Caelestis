import type { StatusSnapshotRead, StatusVisibilityScope } from '../../status-read-model/model.js'
import type { StatusReadModelPort } from '../../status-read-model/port.js'
import type { StatusReadModelObject } from '../../status-read-model-object.js'

const seasonName = (season: number): string => `season:${season}`

export class DurableObjectStatusReadModel implements StatusReadModelPort {
  constructor(private readonly namespace: DurableObjectNamespace<StatusReadModelObject>) {}

  private shard(season: number): DurableObjectStub<StatusReadModelObject> {
    return this.namespace.getByName(seasonName(season))
  }

  async applyCommittedChange(season: number): Promise<void> {
    await this.shard(season).applyCommittedChange(season)
  }

  reconcileSnapshot(season: number, scope: StatusVisibilityScope): Promise<StatusSnapshotRead> {
    return this.shard(season).reconcileSnapshot(season, scope)
  }
}
