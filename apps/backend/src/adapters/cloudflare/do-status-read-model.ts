import type {
  StatusProjectionChange,
  StatusProjectionMutation,
  StatusSnapshotRead,
  StatusVisibilityScope,
} from '../../status-read-model/model.js'
import type { StatusReadModelPort } from '../../status-read-model/port.js'
import type { StatusReadModelObject } from '../../status-read-model-object.js'

const seasonName = (season: number): string => `season:${season}`

export class DurableObjectStatusReadModel implements StatusReadModelPort {
  constructor(private readonly namespace: DurableObjectNamespace<StatusReadModelObject>) {}

  private shard(season: number): DurableObjectStub<StatusReadModelObject> {
    return this.namespace.getByName(seasonName(season))
  }

  async applyCommittedChange(
    season: number,
    mutation?: StatusProjectionMutation,
  ): Promise<StatusProjectionChange | null> {
    const shard = this.shard(season)
    return mutation === undefined
      ? shard.applyCommittedChange(season)
      : shard.applyCommittedChange(season, mutation)
  }

  reconcileSnapshot(season: number, scope: StatusVisibilityScope): Promise<StatusSnapshotRead> {
    return this.shard(season).reconcileSnapshot(season, scope)
  }

  notifyManifestChange(season: number): Promise<void> {
    return this.shard(season).notifyManifestChange(season)
  }

  connectLive(
    request: Request,
    connection: {
      readonly season: number
      readonly scope: StatusVisibilityScope
      readonly lastRevision: number | null
    },
  ): Promise<Response> {
    const headers = new Headers(request.headers)
    headers.delete('authorization')
    headers.set('x-caelestis-season', String(connection.season))
    headers.set('x-caelestis-scope', connection.scope)
    if (connection.lastRevision === null) headers.delete('x-caelestis-revision')
    else headers.set('x-caelestis-revision', String(connection.lastRevision))
    return this.shard(connection.season).fetch(new Request(request, { headers }))
  }
}
