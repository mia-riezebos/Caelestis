import { type StatusResponse, sha256Hex, type TemplateStatus } from '@caelestis/shared'

export type StatusVisibilityScope = 'public' | 'admin'

export interface RevisionedStatusSnapshot extends StatusResponse {
  readonly revision: number
}

export interface StatusSnapshotRead {
  readonly snapshot: RevisionedStatusSnapshot
  readonly cacheOutcome: 'hit' | 'miss' | 'stale'
}

export interface PersistedStatusReadModel {
  readonly season: number
  readonly revision: number
  readonly reconciledAt: number
  readonly publicTemplates: readonly TemplateStatus[]
  readonly adminTemplates: readonly TemplateStatus[]
}

export interface StatusReadModelSource {
  readonly read: (
    season: number,
    scope: StatusVisibilityScope,
  ) => Promise<readonly TemplateStatus[]>
}

export interface StatusReadModelPersistence {
  readonly load: () => Promise<PersistedStatusReadModel | null>
  readonly save: (state: PersistedStatusReadModel) => Promise<void>
}

export interface StatusRevisionStore {
  readonly commit: (
    season: number,
    publicFingerprint: string,
    adminFingerprint: string,
  ) => Promise<number>
}

export interface StatusSubscriber {
  readonly scope: StatusVisibilityScope
  readonly publish: (snapshot: RevisionedStatusSnapshot) => void | Promise<void>
}

export interface StatusSubscriberAttachment {
  readonly snapshot: RevisionedStatusSnapshot
  readonly detach: () => void
}

export interface SeasonStatusReadModel {
  readonly applyCommittedChange: () => Promise<void>
  readonly reconcileSnapshot: (scope: StatusVisibilityScope) => Promise<StatusSnapshotRead>
  readonly attachSubscriber: (subscriber: StatusSubscriber) => Promise<StatusSubscriberAttachment>
}

export const STATUS_READ_MODEL_TTL_MILLISECONDS = 3 * 60_000

const sameTemplates = (
  left: readonly TemplateStatus[],
  right: readonly TemplateStatus[],
): boolean => JSON.stringify(left) === JSON.stringify(right)

const snapshotFor = (
  state: PersistedStatusReadModel,
  scope: StatusVisibilityScope,
): RevisionedStatusSnapshot => ({
  revision: state.revision,
  templates: scope === 'admin' ? state.adminTemplates : state.publicTemplates,
})

/**
 * One season's reconstructible projection. Source reads and persistence are serialized so a stale
 * reconciliation can never publish after a newer one.
 */
export const createSeasonStatusReadModel = (options: {
  readonly season: number
  readonly source: StatusReadModelSource
  readonly persistence: StatusReadModelPersistence
  readonly revisions: StatusRevisionStore
  readonly now?: () => number
  readonly ttlMilliseconds?: number
}): SeasonStatusReadModel => {
  const now = options.now ?? Date.now
  const ttlMilliseconds = options.ttlMilliseconds ?? STATUS_READ_MODEL_TTL_MILLISECONDS
  const subscribers = new Set<StatusSubscriber>()
  let state: PersistedStatusReadModel | null = null
  let loaded = false
  let tail = Promise.resolve()

  const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
    const running = tail.then(operation, operation)
    tail = running.then(
      () => undefined,
      () => undefined,
    )
    return running
  }

  const load = async (): Promise<void> => {
    if (loaded) return
    const persisted = await options.persistence.load()
    state = persisted?.season === options.season ? persisted : null
    loaded = true
  }

  const publish = async (next: PersistedStatusReadModel): Promise<void> => {
    await Promise.all(
      [...subscribers].map(async (subscriber) => {
        try {
          await subscriber.publish(snapshotFor(next, subscriber.scope))
        } catch {
          subscribers.delete(subscriber)
        }
      }),
    )
  }

  const reconcile = async (
    force: boolean,
  ): Promise<{
    readonly state: PersistedStatusReadModel
    readonly cacheOutcome: 'hit' | 'miss' | 'stale'
  }> => {
    await load()
    const readAt = now()
    if (
      !force &&
      state !== null &&
      readAt - state.reconciledAt >= 0 &&
      readAt - state.reconciledAt < ttlMilliseconds
    ) {
      return { state, cacheOutcome: 'hit' }
    }

    const cacheOutcome = state === null ? 'miss' : 'stale'

    const [publicTemplates, adminTemplates] = await Promise.all([
      options.source.read(options.season, 'public'),
      options.source.read(options.season, 'admin'),
    ])
    const fingerprint = (templates: readonly TemplateStatus[]) =>
      sha256Hex(new TextEncoder().encode(JSON.stringify(templates)))
    const [publicFingerprint, adminFingerprint] = await Promise.all([
      fingerprint(publicTemplates),
      fingerprint(adminTemplates),
    ])
    const revision = await options.revisions.commit(
      options.season,
      publicFingerprint,
      adminFingerprint,
    )
    const changed =
      state === null ||
      state.revision !== revision ||
      !sameTemplates(state.publicTemplates, publicTemplates) ||
      !sameTemplates(state.adminTemplates, adminTemplates)
    const next: PersistedStatusReadModel = {
      season: options.season,
      revision,
      reconciledAt: readAt,
      publicTemplates,
      adminTemplates,
    }

    // Persist first. Subscribers may only observe a revision that reconstruction can recover.
    await options.persistence.save(next)
    state = next
    if (changed) await publish(next)
    return { state: next, cacheOutcome }
  }

  return {
    applyCommittedChange: () => exclusive(async () => void (await reconcile(true))),
    reconcileSnapshot: (scope) =>
      exclusive(async () => {
        const read = await reconcile(false)
        return { snapshot: snapshotFor(read.state, scope), cacheOutcome: read.cacheOutcome }
      }),
    attachSubscriber: (subscriber) =>
      exclusive(async () => {
        const current = (await reconcile(false)).state
        subscribers.add(subscriber)
        return {
          snapshot: snapshotFor(current, subscriber.scope),
          detach: () => subscribers.delete(subscriber),
        }
      }),
  }
}
