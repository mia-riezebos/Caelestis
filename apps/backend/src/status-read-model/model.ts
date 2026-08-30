import type { StatusResponse, TemplateStatus } from '@caelestis/shared'
import type {
  CommittedStatusChange,
  StatusReadModel,
  StatusSnapshotQuery,
  StatusSubscriberAttachment,
  StatusSubscriberQuery,
  StatusVisibilityScope,
} from '../ports/status-read-model.js'

export const STATUS_SNAPSHOT_REPAIR_MS = 5 * 60_000
const MAX_RECONCILE_ATTEMPTS = 3

export interface StoredStatusSnapshot {
  readonly response: StatusResponse
  readonly reconciledAt: number
}

export interface StatusProjectionSource {
  readRevision(season: number): Promise<number>
  advanceRevision(season: number): Promise<number>
  readTemplates(season: number, scope: StatusVisibilityScope): Promise<readonly TemplateStatus[]>
}

export interface StatusProjectionStorage {
  read(season: number, scope: StatusVisibilityScope): Promise<StoredStatusSnapshot | null>
  write(season: number, scope: StatusVisibilityScope, snapshot: StoredStatusSnapshot): Promise<void>
}

export class StatusReconciliationError extends Error {
  override readonly name = 'StatusReconciliationError'
}

const scopes = ['read', 'admin'] as const

const validRevision = (revision: number): boolean => Number.isSafeInteger(revision) && revision >= 0

const validSeason = (season: number): boolean => Number.isSafeInteger(season) && season >= 0

const assertQuery = (query: StatusSnapshotQuery): void => {
  if (!validSeason(query.season)) throw new StatusReconciliationError('invalid status season')
  if (query.scope !== 'read' && query.scope !== 'admin') {
    throw new StatusReconciliationError('invalid status visibility scope')
  }
}

const sameTemplates = (
  left: readonly TemplateStatus[],
  right: readonly TemplateStatus[],
): boolean => JSON.stringify(left) === JSON.stringify(right)

/** Build the deep read-model module; the returned boundary intentionally owns only three actions. */
export const createStatusReadModel = (options: {
  readonly source: StatusProjectionSource
  readonly storage: StatusProjectionStorage
  readonly now?: () => number
  readonly repairAfterMs?: number
}): StatusReadModel => {
  const now = options.now ?? Date.now
  const repairAfterMs = options.repairAfterMs ?? STATUS_SNAPSHOT_REPAIR_MS

  const rebuild = async (
    query: StatusSnapshotQuery,
    minimumRevision = 0,
  ): Promise<StatusResponse> => {
    let requiredRevision = minimumRevision
    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt++) {
      const before = await options.source.readRevision(query.season)
      if (!validRevision(before) || before < requiredRevision) continue
      const templates = await options.source.readTemplates(query.season, query.scope)
      const after = await options.source.readRevision(query.season)
      if (before !== after) continue

      const current = await options.storage.read(query.season, query.scope)
      if (current !== null && current.response.revision > after) return current.response
      if (
        current !== null &&
        current.response.revision === after &&
        !sameTemplates(current.response.templates, templates)
      ) {
        // The authoritative mutation committed but its first revision publication was lost. Claim
        // a fresh identity, then reread under it so a concurrent mutation cannot produce a torn
        // snapshot carrying the repair revision.
        const repairedRevision = await options.source.advanceRevision(query.season)
        if (!validRevision(repairedRevision) || repairedRevision <= after) continue
        requiredRevision = repairedRevision
        continue
      }
      const stored: StoredStatusSnapshot = {
        response: { season: query.season, revision: after, templates },
        reconciledAt: now(),
      }
      await options.storage.write(query.season, query.scope, stored)
      return stored.response
    }
    throw new StatusReconciliationError(`status revision did not settle for season ${query.season}`)
  }

  const reconcileSnapshot = async (query: StatusSnapshotQuery): Promise<StatusResponse> => {
    assertQuery(query)
    const revision = await options.source.readRevision(query.season)
    if (!validRevision(revision)) {
      throw new StatusReconciliationError(`invalid status revision for season ${query.season}`)
    }
    const held = await options.storage.read(query.season, query.scope)
    if (
      held !== null &&
      held.response.revision === revision &&
      now() - held.reconciledAt < repairAfterMs
    ) {
      return held.response
    }
    return rebuild(query, revision)
  }

  const applyCommittedChange = async (change: CommittedStatusChange): Promise<void> => {
    if (!validSeason(change.season) || !validRevision(change.revision)) {
      throw new StatusReconciliationError(`invalid committed revision for season ${change.season}`)
    }
    await Promise.all(
      scopes.map(async (scope) => {
        const held = await options.storage.read(change.season, scope)
        if (held !== null && held.response.revision >= change.revision) return
        await rebuild({ season: change.season, scope }, change.revision)
      }),
    )
  }

  const attachSubscriber = async (
    query: StatusSubscriberQuery,
  ): Promise<StatusSubscriberAttachment> => {
    assertQuery(query)
    if (query.after !== null) {
      assertQuery(query.after)
      if (!validRevision(query.after.revision)) {
        throw new StatusReconciliationError('invalid subscriber status revision')
      }
    }
    const snapshot = await reconcileSnapshot(query)
    const identity = {
      season: snapshot.season,
      scope: query.scope,
      revision: snapshot.revision,
    } as const
    const alreadyHeld =
      query.after !== null &&
      query.after.season === identity.season &&
      query.after.scope === identity.scope &&
      query.after.revision === identity.revision
    return {
      identity,
      snapshot: alreadyHeld ? null : snapshot,
    }
  }

  return { applyCommittedChange, reconcileSnapshot, attachSubscriber }
}
