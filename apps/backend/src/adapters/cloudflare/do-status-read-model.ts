import type { TileCoord } from '@caelestis/shared'
import type { ManifestProjectionInput, ManifestProjectionRead } from '../../manifest/read-model.js'
import { type MeasuredD1Operation, mergeD1Usage } from '../../metrics/request-metrics.js'
import type {
  StatusProjectionChange,
  StatusProjectionMutation,
  StatusSnapshotRead,
  StatusVisibilityScope,
} from '../../status-read-model/model.js'
import type { StatusReadModelPort } from '../../status-read-model/port.js'
import type {
  CommittedTileGeneration,
  TileGenerationCacheRead,
  TileGenerationOffer,
} from '../../status-read-model/tile-generation-cache.js'
import type { StatusReadModelObject } from '../../status-read-model-object.js'

const seasonName = (season: number): string => `season:${season}`

const measuredValue = <A>(measured: MeasuredD1Operation<A>): A => {
  mergeD1Usage(measured.usage)
  if (!measured.success) throw measured.error
  return measured.value
}

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
    const measured =
      mutation === undefined
        ? await shard.applyCommittedChangeMeasured(season)
        : await shard.applyCommittedChangeMeasured(season, mutation)
    return measuredValue(measured)
  }

  async reconcileSnapshot(
    season: number,
    scope: StatusVisibilityScope,
  ): Promise<StatusSnapshotRead> {
    const measured = await this.shard(season).reconcileSnapshotMeasured(season, scope)
    return measuredValue(measured)
  }

  async readManifestProjection(input: ManifestProjectionInput): Promise<ManifestProjectionRead> {
    const measured = await this.shard(input.season).readManifestProjectionMeasured(input)
    return measuredValue(measured)
  }

  notifyManifestChange(season: number): Promise<void> {
    return this.shard(season).notifyManifestChange(season)
  }

  notifyAlarmChange(season: number): Promise<void> {
    return this.shard(season).notifyAlarmChange(season)
  }

  closeCredential(season: number, tokenHash: string): Promise<void> {
    return this.shard(season).closeCredential(season, tokenHash)
  }

  async resolveCurrentTileOffers(
    season: number,
    scope: StatusVisibilityScope,
    offers: readonly TileGenerationOffer[],
  ): Promise<TileGenerationCacheRead> {
    return measuredValue(
      await this.shard(season).resolveCurrentTileOffersMeasured(season, scope, offers),
    )
  }

  prepareTileGenerationCommit(season: number, tile: TileCoord): Promise<string> {
    return this.shard(season).prepareTileGenerationCommit(season, tile)
  }

  applyCommittedTileGeneration(season: number, generation: CommittedTileGeneration): Promise<void> {
    return this.shard(season).applyCommittedTileGeneration(season, generation)
  }

  connectLive(
    request: Request,
    connection: {
      readonly season: number
      readonly scope: StatusVisibilityScope
      readonly credentialScope: 'read' | 'report' | 'admin'
      readonly tokenHash: string
      readonly revocable: boolean
      readonly lastRevision: number | null
    },
  ): Promise<Response> {
    const headers = new Headers(request.headers)
    headers.delete('authorization')
    headers.set('sec-websocket-protocol', 'caelestis.live.v1')
    headers.set('x-caelestis-season', String(connection.season))
    headers.set('x-caelestis-scope', connection.scope)
    headers.set('x-caelestis-credential-scope', connection.credentialScope)
    headers.set('x-caelestis-token-hash', connection.tokenHash)
    headers.set('x-caelestis-revocable', connection.revocable ? '1' : '0')
    if (connection.lastRevision === null) headers.delete('x-caelestis-revision')
    else headers.set('x-caelestis-revision', String(connection.lastRevision))
    return this.shard(connection.season).fetch(new Request(request, { headers }))
  }
}
