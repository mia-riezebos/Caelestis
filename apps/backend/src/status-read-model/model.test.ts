import { millis, type TemplateStatus } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  createSeasonStatusReadModel,
  type PersistedStatusReadModel,
  type StatusVisibilityScope,
} from './model.js'

const status = (templateId: string, correct: number): TemplateStatus => ({
  templateId,
  correct,
  wrong: 0,
  blank: 1 - correct,
  total: 1,
  colours: [{ index: 0, correct, wrong: 0, blank: 1 - correct, total: 1 }],
  observedAt: millis(1_750_000_000_000 + correct),
})

interface RevisionState {
  revision: number
  publicFingerprint: string
  adminFingerprint: string
  fingerprintsDirty: boolean
}

const harness = (
  persisted: PersistedStatusReadModel | null = null,
  revisions: RevisionState = {
    revision: persisted?.revision ?? 0,
    publicFingerprint: '',
    adminFingerprint: '',
    fingerprintsDirty: false,
  },
) => {
  let now = 1_000
  let stored = persisted
  let publicTemplates: readonly TemplateStatus[] = [status('public', 0)]
  let adminTemplates: readonly TemplateStatus[] = [...publicTemplates, status('draft', 0)]
  const events: string[] = []
  const read = vi.fn(async (_season: number, scope: StatusVisibilityScope) => {
    events.push(`read:${scope}`)
    return scope === 'admin' ? adminTemplates : publicTemplates
  })
  const save = vi.fn(async (next: PersistedStatusReadModel) => {
    events.push(`save:${next.revision}`)
    stored = next
  })
  const model = createSeasonStatusReadModel({
    season: 7,
    source: { read },
    persistence: { load: async () => stored, save },
    revisions: {
      current: async () => revisions.revision,
      commit: async (
        _season,
        expectedRevision,
        _retainRevision,
        nextPublicFingerprint,
        nextAdminFingerprint,
      ) => {
        if (expectedRevision !== revisions.revision) return null
        if (
          !(revisions.fingerprintsDirty && _retainRevision) &&
          (revisions.revision === 0 ||
            revisions.fingerprintsDirty ||
            revisions.publicFingerprint !== nextPublicFingerprint ||
            revisions.adminFingerprint !== nextAdminFingerprint)
        ) {
          revisions.revision++
        }
        revisions.publicFingerprint = nextPublicFingerprint
        revisions.adminFingerprint = nextAdminFingerprint
        revisions.fingerprintsDirty = false
        return revisions.revision
      },
    },
    now: () => now,
    ttlMilliseconds: 100,
  })
  return {
    model,
    read,
    save,
    events,
    setNow: (value: number) => {
      now = value
    },
    setPublic: (templates: readonly TemplateStatus[]) => {
      publicTemplates = templates
    },
    setAdmin: (templates: readonly TemplateStatus[]) => {
      adminTemplates = templates
    },
    stored: () => stored,
    revisions,
  }
}

describe('season status read model', () => {
  it('materializes both authorization scopes once and reuses the persisted projection within TTL', async () => {
    const test = harness()

    await expect(test.model.reconcileSnapshot('public')).resolves.toEqual({
      cacheOutcome: 'miss',
      snapshot: { revision: 1, templates: [status('public', 0)] },
    })
    await expect(test.model.reconcileSnapshot('admin')).resolves.toEqual({
      cacheOutcome: 'hit',
      snapshot: {
        revision: 1,
        templates: [status('public', 0), status('draft', 0)],
      },
    })

    expect(test.read).toHaveBeenCalledTimes(2)
    expect(test.save).toHaveBeenCalledTimes(1)
  })

  it('advances monotonically after a committed change and publishes only after persistence', async () => {
    const test = harness()
    await test.model.reconcileSnapshot('public')
    test.setPublic([status('public', 1)])
    test.setAdmin([status('public', 1), status('draft', 0)])
    const published: number[] = []
    await test.model.attachSubscriber({
      scope: 'public',
      publish: ({ revision }) => {
        test.events.push(`publish:${revision}`)
        published.push(revision)
      },
    })

    await expect(test.model.applyCommittedChange()).resolves.toEqual({
      public: {
        baseRevision: 1,
        revision: 2,
        templates: [status('public', 1)],
        removedTemplateIds: [],
      },
      admin: {
        baseRevision: 1,
        revision: 2,
        templates: [status('public', 1)],
        removedTemplateIds: [],
      },
    })
    await expect(test.model.reconcileSnapshot('public')).resolves.toMatchObject({
      snapshot: { revision: 2 },
    })

    expect(published).toEqual([2])
    expect(test.events.slice(-2)).toEqual(['save:2', 'publish:2'])
  })

  it('does not advance for a stale committed write whose authoritative projection stayed unchanged', async () => {
    const test = harness()
    await test.model.reconcileSnapshot('public')

    await test.model.applyCommittedChange()
    await expect(test.model.reconcileSnapshot('public')).resolves.toMatchObject({
      snapshot: { revision: 1 },
    })
  })

  it('invalidates every mismatch tile whenever a mutation reconstructs the projection', async () => {
    const test = harness()
    await test.model.reconcileSnapshot('public')
    test.setPublic([status('public', 1)])
    test.setAdmin([status('public', 1), status('draft', 0)])

    await expect(
      test.model.applyCommittedChange({
        baseRevision: 0,
        revision: 2,
        invalidatedTiles: ['3/4'],
        changes: [],
      }),
    ).resolves.toMatchObject({
      public: { baseRevision: 1, revision: 2, invalidateAllTiles: true },
      admin: { baseRevision: 1, revision: 2, invalidateAllTiles: true },
    })

    const forced = harness()
    await forced.model.reconcileSnapshot('public')
    forced.setPublic([status('public', 1)])
    forced.setAdmin([status('public', 1), status('draft', 0)])
    await expect(
      forced.model.applyCommittedChange({
        baseRevision: 1,
        revision: 2,
        forceReconcile: true,
        invalidatedTiles: ['3/4'],
        changes: [],
      }),
    ).resolves.toMatchObject({
      public: { baseRevision: 1, revision: 2, invalidateAllTiles: true },
      admin: { baseRevision: 1, revision: 2, invalidateAllTiles: true },
    })
  })

  it('retains the revision when source colour rows match an incrementally created template', async () => {
    const test = harness()
    test.setPublic([])
    test.setAdmin([])
    await test.model.reconcileSnapshot('public')
    test.revisions.revision = 2
    test.revisions.fingerprintsDirty = true
    const template: TemplateStatus = {
      templateId: 'new-template',
      correct: 1,
      wrong: 0,
      blank: 0,
      total: 1,
      colours: [{ index: 4, total: 1, correct: 1, wrong: 0, blank: 0 }],
      observedAt: millis(1_750_000_000_000),
    }

    await test.model.applyCommittedChange({
      baseRevision: 1,
      revision: 2,
      changes: [
        {
          templateId: template.templateId,
          published: true,
          total: 1,
          colourTotals: [{ index: 4, total: 1 }],
          previous: null,
          current: {
            correct: 1,
            wrong: 0,
            blank: 0,
            colours: [{ index: 4, total: 1, correct: 1, wrong: 0, blank: 0 }],
            observedAt: template.observedAt,
          },
        },
      ],
    })
    test.setPublic([template])
    test.setAdmin([template])
    test.setNow(1_101)

    await expect(test.model.reconcileSnapshot('public')).resolves.toMatchObject({
      snapshot: { revision: 2, templates: [template] },
    })
  })

  it('repairs an expired or revision-gap read from the authoritative source', async () => {
    const test = harness()
    await test.model.reconcileSnapshot('public')
    test.setPublic([status('public', 1)])
    test.setAdmin([status('public', 1), status('draft', 0)])
    test.setNow(1_101)

    await expect(test.model.reconcileSnapshot('public')).resolves.toMatchObject({
      cacheOutcome: 'stale',
      snapshot: { revision: 2, templates: [status('public', 1)] },
    })
  })

  it('retries reconciliation when a tile commit advances the revision during source reads', async () => {
    const test = harness()
    test.setPublic([status('public', 1)])
    test.setAdmin([status('public', 1), status('draft', 0)])
    test.read.mockImplementationOnce(async () => {
      test.revisions.revision = 1
      return [status('public', 1)]
    })

    await expect(test.model.reconcileSnapshot('public')).resolves.toMatchObject({
      snapshot: { revision: 2, templates: [status('public', 1)] },
    })
    expect(test.read).toHaveBeenCalledTimes(4)
  })

  it('rebuilds after projection loss and recovers a persisted snapshot after process eviction', async () => {
    const first = harness()
    await first.model.reconcileSnapshot('public')
    const persisted = first.stored()
    expect(persisted).not.toBeNull()

    const recovered = harness(persisted, first.revisions)
    await expect(recovered.model.reconcileSnapshot('public')).resolves.toMatchObject({
      cacheOutcome: 'hit',
      snapshot: { revision: 1 },
    })
    expect(recovered.read).not.toHaveBeenCalled()

    const rebuilt = harness(null, first.revisions)
    await expect(rebuilt.model.reconcileSnapshot('public')).resolves.toMatchObject({
      cacheOutcome: 'miss',
      snapshot: { revision: 1 },
    })
    expect(rebuilt.read).toHaveBeenCalledTimes(2)
  })

  it('keeps the last reconstructible revision when persistence fails', async () => {
    const test = harness()
    await test.model.reconcileSnapshot('public')
    test.setPublic([status('public', 1)])
    test.setAdmin([status('public', 1), status('draft', 0)])
    test.save.mockRejectedValueOnce(new Error('Durable Object storage unavailable'))

    await expect(test.model.applyCommittedChange()).rejects.toThrow('storage unavailable')
    expect(test.stored()?.revision).toBe(1)
    await expect(test.model.reconcileSnapshot('public')).resolves.toMatchObject({
      snapshot: { revision: 1 },
    })
  })
})
