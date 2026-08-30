import type {
  CommittedStatusChange,
  StatusReadModel,
  StatusSnapshotQuery,
  StatusSubscriberAttachment,
  StatusSubscriberQuery,
} from '../../ports/index.js'
import type { StatusReadModelObject } from '../../status-read-model-object.js'

/** Event-scoped RPC adapter for the season-named Durable Object. */
export class DurableObjectStatusReadModel implements StatusReadModel {
  constructor(private readonly namespace: DurableObjectNamespace<StatusReadModelObject>) {}

  private stub(season: number): DurableObjectStub<StatusReadModelObject> {
    return this.namespace.getByName(`season:${season}`)
  }

  applyCommittedChange(change: CommittedStatusChange): Promise<void> {
    return this.stub(change.season).applyCommittedChange(change)
  }

  reconcileSnapshot(query: StatusSnapshotQuery) {
    return this.stub(query.season).reconcileSnapshot(query)
  }

  attachSubscriber(query: StatusSubscriberQuery): Promise<StatusSubscriberAttachment> {
    return this.stub(query.season).attachSubscriber(query)
  }
}
