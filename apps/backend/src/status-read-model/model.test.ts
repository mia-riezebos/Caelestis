import { millis, type TemplateStatus } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import type { StatusVisibilityScope } from '../ports/status-read-model.js'
import {
  createStatusReadModel,
  type StatusProjectionSource,
  type StatusProjectionStorage,
  type StoredStatusSnapshot,
} from './model.js'

const status = (templateId: string, correct: number): TemplateStatus => ({
  templateId,
  correct,
  wrong: 0,
  blank: 1 - correct,
  total: 1,
  observedAt: millis(1_000),
})

class MemoryProjectionStorage implements StatusProjectionStorage {
  readonly snapshots = new Map<string, StoredStatusSnapshot>()

  private key(season: number, scope: StatusVisibilityScope): string {
    return `${season}:${scope}`
  }

  async read(season: number, scope: StatusVisibilityScope): Promise<StoredStatusSnapshot | null> {
    return this.snapshots.get(this.key(season, scope)) ?? null
  }

  async write(
    season: number,
    scope: StatusVisibilityScope,
    snapshot: StoredStatusSnapshot,
  ): Promise<void> {
    this.snapshots.set(this.key(season, scope), snapshot)
  }
}

const source = (
  options: {
    revision?: number
    read?: readonly TemplateStatus[]
    admin?: readonly TemplateStatus[]
  } = {},
) => {
  let revision = options.revision ?? 1
  const readRevision = vi.fn(async () => revision)
  const advanceRevision = vi.fn(async () => ++revision)
  const readTemplates = vi.fn(async (_season: number, scope: StatusVisibilityScope) =>
    scope === 'admin' ? (options.admin ?? []) : (options.read ?? []),
  )
  return {
    value: {
      readRevision,
      advanceRevision,
      readTemplates,
    } satisfies StatusProjectionSource,
    readRevision,
    advanceRevision,
    readTemplates,
    setRevision: (next: number) => {
      revision = next
    },
  }
}

describe('revisioned status read model', () => {
  it('rebuilds once and reuses the stored aggregation at the current revision', async () => {
    const origin = source({ revision: 4, read: [status('public', 1)] })
    const storage = new MemoryProjectionStorage()
    const model = createStatusReadModel({
      source: origin.value,
      storage,
      now: () => 1_000,
    })

    const first = await model.reconcileSnapshot({ season: 7, scope: 'read' })
    const repeated = await model.reconcileSnapshot({
      season: 7,
      scope: 'read',
    })

    expect(first).toEqual({
      season: 7,
      revision: 4,
      templates: [status('public', 1)],
    })
    expect(repeated).toBe(first)
    expect(origin.readTemplates).toHaveBeenCalledOnce()
  })

  it('retries a revision gap without publishing a torn snapshot', async () => {
    const templates = [status('settled', 1)]
    const revisions = [5, 5, 6, 6, 6]
    const origin: StatusProjectionSource = {
      readRevision: vi.fn(async () => revisions.shift() ?? 6),
      advanceRevision: vi.fn(async () => 7),
      readTemplates: vi.fn(async () => templates),
    }
    const storage = new MemoryProjectionStorage()
    const model = createStatusReadModel({ source: origin, storage })

    await expect(model.reconcileSnapshot({ season: 2, scope: 'read' })).resolves.toEqual({
      season: 2,
      revision: 6,
      templates,
    })
    expect(origin.readTemplates).toHaveBeenCalledTimes(2)
  })

  it('ignores stale committed changes without moving either visibility projection backward', async () => {
    const origin = source({ revision: 8 })
    const storage = new MemoryProjectionStorage()
    const held = (scope: StatusVisibilityScope): StoredStatusSnapshot => ({
      response: { season: 0, revision: 8, templates: [status(scope, 1)] },
      reconciledAt: 1_000,
    })
    storage.snapshots.set('0:read', held('read'))
    storage.snapshots.set('0:admin', held('admin'))
    const model = createStatusReadModel({ source: origin.value, storage })

    await model.applyCommittedChange({ season: 0, revision: 7 })

    expect(origin.readRevision).not.toHaveBeenCalled()
    expect(origin.readTemplates).not.toHaveBeenCalled()
    expect(storage.snapshots.get('0:read')?.response.revision).toBe(8)
    expect(storage.snapshots.get('0:admin')?.response.revision).toBe(8)
  })

  it('keeps accepted state repairable when projection publication fails', async () => {
    const origin = source({
      revision: 3,
      read: [status('new', 1)],
      admin: [status('new', 1)],
    })
    const storage = new MemoryProjectionStorage()
    const previous: StoredStatusSnapshot = {
      response: { season: 0, revision: 2, templates: [status('old', 0)] },
      reconciledAt: 0,
    }
    storage.snapshots.set('0:read', previous)
    storage.snapshots.set('0:admin', previous)
    origin.readTemplates.mockRejectedValueOnce(new Error('projection storage unavailable'))
    const model = createStatusReadModel({ source: origin.value, storage })

    await expect(model.applyCommittedChange({ season: 0, revision: 3 })).rejects.toThrow(
      /projection storage unavailable/,
    )
    expect(storage.snapshots.get('0:read')?.response.revision).toBe(2)

    await expect(model.reconcileSnapshot({ season: 0, scope: 'read' })).resolves.toMatchObject({
      revision: 3,
      templates: [status('new', 1)],
    })
  })

  it('never shares an admin-visible snapshot with read scope', async () => {
    const origin = source({
      revision: 3,
      read: [status('published', 1)],
      admin: [status('published', 1), status('draft', 0)],
    })
    const model = createStatusReadModel({
      source: origin.value,
      storage: new MemoryProjectionStorage(),
    })

    const read = await model.reconcileSnapshot({ season: 1, scope: 'read' })
    const admin = await model.reconcileSnapshot({ season: 1, scope: 'admin' })

    expect(read.templates.map(({ templateId }) => templateId)).toEqual(['published'])
    expect(admin.templates.map(({ templateId }) => templateId)).toEqual(['published', 'draft'])
    expect(origin.readTemplates).toHaveBeenCalledWith(1, 'read')
    expect(origin.readTemplates).toHaveBeenCalledWith(1, 'admin')
  })

  it('attaches without a snapshot only for the same season, scope, and revision', async () => {
    const origin = source({ revision: 9, read: [status('public', 1)] })
    const model = createStatusReadModel({
      source: origin.value,
      storage: new MemoryProjectionStorage(),
    })

    const stale = await model.attachSubscriber({
      season: 4,
      scope: 'read',
      after: { season: 4, scope: 'read', revision: 8 },
    })
    const current = await model.attachSubscriber({
      season: 4,
      scope: 'read',
      after: { season: 4, scope: 'read', revision: 9 },
    })
    const promoted = await model.attachSubscriber({
      season: 4,
      scope: 'admin',
      after: { season: 4, scope: 'read', revision: 9 },
    })
    const demoted = await model.attachSubscriber({
      season: 4,
      scope: 'read',
      after: { season: 4, scope: 'admin', revision: 9 },
    })

    expect(stale).toMatchObject({
      identity: { season: 4, scope: 'read', revision: 9 },
      snapshot: { season: 4, revision: 9 },
    })
    expect(current).toEqual({
      identity: { season: 4, scope: 'read', revision: 9 },
      snapshot: null,
    })
    expect(promoted.snapshot).not.toBeNull()
    expect(demoted.snapshot).not.toBeNull()
  })

  it('repairs a missed revision publication with a distinct monotonic identity', async () => {
    let now = 0
    const origin = source({ revision: 4, read: [status('public', 0)] })
    const storage = new MemoryProjectionStorage()
    const model = createStatusReadModel({
      source: origin.value,
      storage,
      now: () => now,
      repairAfterMs: 60_000,
    })
    await model.reconcileSnapshot({ season: 0, scope: 'read' })
    origin.readTemplates.mockResolvedValue([status('public', 1)])
    now = 60_000

    const repaired = await model.reconcileSnapshot({
      season: 0,
      scope: 'read',
    })

    expect(origin.advanceRevision).toHaveBeenCalledWith(0)
    expect(repaired).toEqual({
      season: 0,
      revision: 5,
      templates: [status('public', 1)],
    })
  })

  it('revalidates an unchanged cached snapshot after the bounded safety TTL', async () => {
    let now = 0
    const origin = source({ revision: 1, read: [status('public', 0)] })
    const storage = new MemoryProjectionStorage()
    const model = createStatusReadModel({
      source: origin.value,
      storage,
      now: () => now,
      repairAfterMs: 120_000,
    })

    const initial = await model.reconcileSnapshot({ season: 0, scope: 'read' })
    now = 120_000
    const repaired = await model.reconcileSnapshot({
      season: 0,
      scope: 'read',
    })

    expect(initial.templates).toEqual([status('public', 0)])
    expect(repaired.templates).toEqual([status('public', 0)])
    expect(origin.readTemplates).toHaveBeenCalledTimes(2)
    expect(origin.advanceRevision).not.toHaveBeenCalled()
  })
})
