import {
  type Millis,
  type StatusDelta,
  type StatusResponse,
  sha256Hex,
  type TemplateStatus,
  type TileKey,
} from '@caelestis/shared'

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
  readonly current: (season: number) => Promise<number>
  readonly commit: (
    season: number,
    expectedRevision: number,
    retainRevision: boolean,
    publicFingerprint: string,
    adminFingerprint: string,
  ) => Promise<number | null>
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
  readonly applyCommittedChange: (
    mutation?: StatusProjectionMutation,
  ) => Promise<StatusProjectionChange | null>
  readonly reconcileSnapshot: (scope: StatusVisibilityScope) => Promise<StatusSnapshotRead>
  readonly attachSubscriber: (subscriber: StatusSubscriber) => Promise<StatusSubscriberAttachment>
}

export interface StatusProjectionChange {
  readonly public: StatusDelta
  readonly admin: StatusDelta
}

export interface StatusTileValue {
  readonly correct: number
  readonly wrong: number
  readonly blank: number
  readonly colours?: readonly {
    readonly index: number
    readonly correct: number
    readonly wrong: number
    readonly blank: number
    readonly total: number
  }[]
  readonly observedAt: Millis
}

export interface StatusProjectionMutation {
  readonly baseRevision: number
  readonly revision: number
  /** Rebuild from the authoritative source when a batch contains a revision gap. */
  readonly forceReconcile?: true
  readonly invalidatedTiles?: readonly TileKey[]
  readonly changes: readonly {
    readonly templateId: string
    readonly published: boolean
    readonly total: number
    readonly colourTotals?: readonly { readonly index: number; readonly total: number }[]
    readonly previous: StatusTileValue | null
    readonly current: StatusTileValue
  }[]
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

const deltaFor = (
  previous: PersistedStatusReadModel,
  next: PersistedStatusReadModel,
  scope: StatusVisibilityScope,
  invalidatedTiles?: readonly TileKey[],
): StatusDelta => {
  const before = new Map(
    (scope === 'admin' ? previous.adminTemplates : previous.publicTemplates).map((status) => [
      status.templateId,
      status,
    ]),
  )
  const after = scope === 'admin' ? next.adminTemplates : next.publicTemplates
  const afterIds = new Set(after.map((status) => status.templateId))
  return {
    baseRevision: previous.revision,
    revision: next.revision,
    templates: after.filter(
      (status) => JSON.stringify(before.get(status.templateId)) !== JSON.stringify(status),
    ),
    removedTemplateIds: [...before.keys()].filter((templateId) => !afterIds.has(templateId)),
    ...(invalidatedTiles === undefined ? {} : { invalidatedTiles }),
  }
}

const applyScopeMutation = (
  templates: readonly TemplateStatus[],
  mutation: StatusProjectionMutation,
  scope: StatusVisibilityScope,
): readonly TemplateStatus[] | null => {
  const next = new Map(templates.map((status) => [status.templateId, status]))
  for (const change of mutation.changes) {
    if (scope === 'public' && !change.published) continue
    const held = next.get(change.templateId)
    if (held === undefined && change.previous !== null) return null
    if (held !== undefined && held.total !== change.total) return null
    const base: TemplateStatus = held ?? {
      templateId: change.templateId,
      correct: 0,
      wrong: 0,
      blank: 0,
      total: change.total,
      ...(change.colourTotals === undefined
        ? {}
        : {
            colours: change.colourTotals.map(({ index, total }) => ({
              index,
              total,
              correct: 0,
              wrong: 0,
              blank: 0,
            })),
          }),
      observedAt: 0 as Millis,
    }
    const previous = change.previous
    if (
      previous !== null &&
      base.observedAt === previous.observedAt &&
      change.current.observedAt < previous.observedAt
    ) {
      return null
    }
    const correct = base.correct - (previous?.correct ?? 0) + change.current.correct
    const wrong = base.wrong - (previous?.wrong ?? 0) + change.current.wrong
    const blank = base.blank - (previous?.blank ?? 0) + change.current.blank
    if (correct < 0 || wrong < 0 || blank < 0) return null

    let colours = base.colours
    if (colours === undefined && change.current.colours !== undefined) return null
    if (colours !== undefined) {
      if (change.current.colours === undefined) return null
      const counts = new Map(colours.map((colour) => [colour.index, { ...colour }]))
      for (const colour of previous?.colours ?? []) {
        const aggregate = counts.get(colour.index)
        if (aggregate === undefined) return null
        counts.set(colour.index, {
          ...aggregate,
          correct: aggregate.correct - colour.correct,
          wrong: aggregate.wrong - colour.wrong,
          blank: aggregate.blank - colour.blank,
        })
      }
      for (const colour of change.current.colours ?? []) {
        const aggregate = counts.get(colour.index)
        if (aggregate === undefined) return null
        counts.set(colour.index, {
          ...aggregate,
          correct: aggregate.correct + colour.correct,
          wrong: aggregate.wrong + colour.wrong,
          blank: aggregate.blank + colour.blank,
        })
      }
      colours = [...counts.values()].sort((left, right) => left.index - right.index)
      if (colours.some((colour) => colour.correct < 0 || colour.wrong < 0 || colour.blank < 0))
        return null
    }
    next.set(change.templateId, {
      ...base,
      correct,
      wrong,
      blank,
      ...(colours === undefined ? {} : { colours }),
      observedAt: Math.max(base.observedAt, change.current.observedAt) as Millis,
    })
  }
  return [...next.values()].sort((left, right) => left.templateId.localeCompare(right.templateId))
}

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
    invalidatedTiles?: readonly TileKey[],
  ): Promise<{
    readonly state: PersistedStatusReadModel
    readonly cacheOutcome: 'hit' | 'miss' | 'stale'
    readonly change: StatusProjectionChange | null
  }> => {
    await load()
    const readAt = now()
    if (
      !force &&
      state !== null &&
      readAt - state.reconciledAt >= 0 &&
      readAt - state.reconciledAt < ttlMilliseconds
    ) {
      return { state, cacheOutcome: 'hit', change: null }
    }

    const cacheOutcome = state === null ? 'miss' : 'stale'

    const fingerprint = (templates: readonly TemplateStatus[]) =>
      sha256Hex(new TextEncoder().encode(JSON.stringify(templates)))
    for (let attempt = 0; attempt < 4; attempt++) {
      const expectedRevision = await options.revisions.current(options.season)
      const [publicTemplates, adminTemplates] = await Promise.all([
        options.source.read(options.season, 'public'),
        options.source.read(options.season, 'admin'),
      ])
      const [publicFingerprint, adminFingerprint] = await Promise.all([
        fingerprint(publicTemplates),
        fingerprint(adminTemplates),
      ])
      const retainRevision =
        state !== null &&
        state.revision === expectedRevision &&
        sameTemplates(state.publicTemplates, publicTemplates) &&
        sameTemplates(state.adminTemplates, adminTemplates)
      const revision = await options.revisions.commit(
        options.season,
        expectedRevision,
        retainRevision,
        publicFingerprint,
        adminFingerprint,
      )
      if (revision === null) continue
      const previous = state
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
      return {
        state: next,
        cacheOutcome,
        change:
          previous === null
            ? null
            : {
                public: deltaFor(previous, next, 'public', invalidatedTiles),
                admin: deltaFor(previous, next, 'admin', invalidatedTiles),
              },
      }
    }
    throw new Error('status projection changed repeatedly during reconciliation')
  }

  const applyMutation = async (
    mutation: StatusProjectionMutation,
  ): Promise<StatusProjectionChange | null> => {
    await load()
    if (mutation.forceReconcile === true) {
      return (await reconcile(true, mutation.invalidatedTiles)).change
    }
    if (state === null || mutation.baseRevision !== state.revision) {
      if (state !== null && mutation.revision <= state.revision) {
        const unchanged = {
          baseRevision: state.revision,
          revision: state.revision,
          templates: [],
          removedTemplateIds: [],
        }
        return { public: unchanged, admin: unchanged }
      }
      return (await reconcile(true, mutation.invalidatedTiles)).change
    }
    const publicTemplates = applyScopeMutation(state.publicTemplates, mutation, 'public')
    const adminTemplates = applyScopeMutation(state.adminTemplates, mutation, 'admin')
    if (publicTemplates === null || adminTemplates === null)
      return (await reconcile(true, mutation.invalidatedTiles)).change
    const previous = state
    const next: PersistedStatusReadModel = {
      season: options.season,
      revision: mutation.revision,
      reconciledAt: now(),
      publicTemplates,
      adminTemplates,
    }
    await options.persistence.save(next)
    state = next
    await publish(next)
    return {
      public: deltaFor(previous, next, 'public', mutation.invalidatedTiles),
      admin: deltaFor(previous, next, 'admin', mutation.invalidatedTiles),
    }
  }

  return {
    applyCommittedChange: (mutation) =>
      exclusive(async () =>
        mutation === undefined ? (await reconcile(true)).change : applyMutation(mutation),
      ),
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
