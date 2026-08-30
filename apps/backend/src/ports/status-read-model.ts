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

export interface StatusSubscriberQuery extends StatusSnapshotQuery {
  readonly afterRevision: number
}

export interface StatusSubscriberAttachment {
  readonly revision: number
  /** Null means the subscriber already holds this exact revision. */
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
