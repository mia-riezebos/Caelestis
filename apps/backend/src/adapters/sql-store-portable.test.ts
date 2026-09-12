import {
  millis,
  seconds,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
  type WorkActivity,
  type WorkItem,
} from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type SqlStoreHarness, sqlStoreAdapters } from './sql-store.test-helper.js'

describe.each(sqlStoreAdapters)('$name portable writes', ({ make }) => {
  let harness: SqlStoreHarness
  beforeEach(async () => {
    harness = await make()
  })
  afterEach(() => harness?.close())

  const template = async () => {
    await harness.store.insertTemplateVersion({
      templateId: 'template-1',
      versionId: 'version-1',
      season: 0,
      surface: WORLD_TEMPLATE_SURFACE,
      nodeId: null,
      name: 'Artwork',
      createdAt: millis(1000),
      createdWithToken: 'a'.repeat(64),
      createdByUserId: null,
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      totalPixels: 1,
      chunks: [{ tileX: 0, tileY: 0, hash: 'b'.repeat(64) }],
    })
  }

  it('records event accounting once and returns the original accounting on retry', async () => {
    await template()
    const accounting = {
      counters: [
        { templateId: 'template-1', occurredAt: seconds(1), placed: 3, correct: 2, repairs: 1 },
      ],
      contributions: [
        {
          templateId: 'template-1',
          wplaceUserId: 42,
          day: seconds(0),
          reportedWithToken: 'a'.repeat(64),
          reportedByUserId: 42,
          placed: 3,
          correct: 2,
          repairs: 1,
        },
      ],
    }
    const results = await Promise.all([
      harness.store.applyPaintEvent('event-1', 42, 'Painter', millis(1000), accounting),
      harness.store.applyPaintEvent('event-1', 42, 'Painter', millis(1000), accounting),
    ])
    expect(results.filter((result) => result.applied)).toHaveLength(1)
    expect(
      await harness.store.applyPaintEvent('event-1', 42, 'Changed', millis(2000), {
        counters: [],
        contributions: [],
      }),
    ).toEqual({ applied: false, accounting })
    expect(
      await harness.store.readContributions({
        templateIds: ['template-1'],
        fromSeconds: seconds(0),
        toSeconds: seconds(86400),
        includeUnpublished: true,
      }),
    ).toEqual([expect.objectContaining({ placed: 3, correct: 2, repairs: 1 })])
  })

  it('preserves tag identities and advances the template revision on assignments and renames', async () => {
    await template()
    const store = harness.store
    await store.mutateTag({ type: 'create', id: 'tag', name: 'Border' }, millis(2000))
    await store.mutateTag(
      { type: 'assign', id: 'tag', templateId: 'template-1', attached: true },
      millis(3000),
    )
    expect(
      await store.listManifestTags({ season: 0, surface: WORLD_TEMPLATE_SURFACE }, true),
    ).toEqual([{ templateId: 'template-1', tag: { id: 'tag', name: 'Border' } }])
    expect(await store.listTagScopes()).toEqual([{ season: 0, surface: WORLD_TEMPLATE_SURFACE }])
    expect((await store.readTemplate('template-1'))?.updatedAt).toBe(3000)
    await store.mutateTag({ type: 'rename', id: 'tag', name: 'Outline' }, millis(4000))
    expect((await store.readTemplate('template-1'))?.updatedAt).toBe(4000)
  })

  it('retains work activity and rejects a stale claim without an extra audit row', async () => {
    const work = harness.store.work
    const item: WorkItem = {
      id: uuidV7(),
      season: 0,
      surface: WORLD_TEMPLATE_SURFACE,
      title: 'Repair',
      description: '',
      status: 'open',
      priority: 'normal',
      tags: [],
      blockerIds: [],
      nodeId: null,
      templateIds: [],
      claimant: null,
      revision: 1,
      createdAt: 1000,
      updatedAt: 1000,
    }
    const activity = (item: WorkItem): WorkActivity => ({
      id: uuidV7(),
      action: item.revision === 1 ? 'create' : 'claim',
      actor: { wplaceUserId: 42, displayName: 'Painter' },
      item,
    })
    expect(await work.save(item, 0, activity(item), 'a'.repeat(64))).toBe(true)
    const claimed = { ...item, revision: 2, claimant: { wplaceUserId: 42, displayName: 'Painter' } }
    expect(await work.save(claimed, 1, activity(claimed), 'a'.repeat(64))).toBe(true)
    expect(
      await work.save(
        { ...claimed, claimant: { wplaceUserId: 43, displayName: 'Other' } },
        1,
        activity(claimed),
        'a'.repeat(64),
      ),
    ).toBe(false)
    expect(await work.list(0, WORLD_TEMPLATE_SURFACE)).toEqual([claimed])
    expect(await work.history(item.id, 3)).toHaveLength(2)
  })
})
