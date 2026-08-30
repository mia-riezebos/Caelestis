import type { StatusResponse } from '@caelestis/shared'

export type StatusVisibilityScope = 'admin' | 'read'

export interface CommittedStatusChange {
  readonly season: number
  readonly revision: number
}

export interface StatusSnapshotQuery {
  readonly season: number
  readonly scope: StatusVisibilityScope
}

export interface StatusSnapshotIdentity extends StatusSnapshotQuery {
  readonly revision: number
}

export interface StatusSubscriberQuery extends StatusSnapshotQuery {
  /** Snapshot the subscriber already holds, including its season and authorization scope. */
  readonly after: StatusSnapshotIdentity | null
}

export interface StatusSubscriberAttachment {
  readonly identity: StatusSnapshotIdentity
  /** Null means the subscriber already holds this exact season, scope, and revision. */
  readonly snapshot: StatusResponse | null
}

/**
 * Reconstructible season status projection. Live transport builds on this boundary without owning
 * D1 or R2 authority.
 */
export interface StatusReadModel {
  applyCommittedChange(change: CommittedStatusChange): Promise<void>
  reconcileSnapshot(query: StatusSnapshotQuery): Promise<StatusResponse>
  attachSubscriber(query: StatusSubscriberQuery): Promise<StatusSubscriberAttachment>
}
