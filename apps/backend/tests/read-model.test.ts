import { millis } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { createSeasonStatusReadModel } from '../src/status-read-model/model.js'
import { createTileGenerationCache } from '../src/status-read-model/tile-generation-cache.js'

describe('tile generation cache', () => {
  it('does not let a losing or expired prepared commit overwrite the newest tile generation', async () => {
    let now = 1_000
    let sequence = 0
    const cache = createTileGenerationCache({
      now: () => now,
      ttlMilliseconds: 100,
      createCoverageToken: () => `coverage-${sequence++}`,
    })
    const tile = { x: 4, y: 8 }
    const first = cache.prepare(tile)
    const second = cache.prepare(tile)

    await cache.apply({
      tile,
      hash: 'new',
      observedAt: millis(2),
      commitOrder: 2,
      coverageToken: second.coverageToken,
      commitToken: second.commitToken,
      commitExpiresAt: second.commitExpiresAt,
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    await cache.finish(tile, first)

    expect(await cache.resolve('public', [{ deliveryId: 'd', tile, hash: 'new' }])).toMatchObject({
      acknowledgedDeliveryIds: ['d'],
      unresolvedDeliveryIds: [],
    })

    now = first.commitExpiresAt + 1
    await cache.finish(tile, first)
    expect(await cache.resolve('public', [{ deliveryId: 'old', tile, hash: 'old' }])).toMatchObject(
      {
        unresolvedDeliveryIds: ['old'],
      },
    )
  })
})

describe('status projection', () => {
  it('keeps the public projection filtered while serving cache hits without another source read', async () => {
    let reads = 0
    let revision = 0
    const source = {
      read: async (_season: number, scope: 'public' | 'admin') => {
        reads++
        const published = {
          templateId: 'published',
          correct: 4,
          wrong: 1,
          blank: 0,
          total: 5,
          observedAt: millis(1),
        }
        const privateTemplate = {
          templateId: 'private',
          correct: 0,
          wrong: 5,
          blank: 0,
          total: 5,
          observedAt: millis(1),
        }
        return scope === 'public' ? [published] : [published, privateTemplate]
      },
    }
    let saved = false
    const model = createSeasonStatusReadModel({
      season: 1,
      source,
      persistence: {
        load: async () => null,
        save: async (state) => {
          void state
          saved = true
        },
      },
      revisions: {
        current: async () => revision,
        commit: async (_season, expected) => {
          if (expected !== revision) return null
          revision++
          return revision
        },
      },
    })

    expect(
      (await model.reconcileSnapshot('public')).snapshot.templates.map(
        (template) => template.templateId,
      ),
    ).toEqual(['published'])
    expect(
      (await model.reconcileSnapshot('admin')).snapshot.templates.map(
        (template) => template.templateId,
      ),
    ).toEqual(['published', 'private'])
    expect(reads).toBe(2)
    expect(saved).toBe(true)
    await model.reconcileSnapshot('admin')
    expect(reads).toBe(2)
  })
})
