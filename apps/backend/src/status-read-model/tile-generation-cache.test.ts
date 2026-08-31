import { millis } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { createTileGenerationCache } from './tile-generation-cache.js'

describe('tile generation cache', () => {
  it('touches a matching generation and expires it five minutes after the last hit', () => {
    let now = 1_000
    const cache = createTileGenerationCache({ now: () => now })
    cache.apply({
      tile: { x: 1, y: 2 },
      hash: 'a'.repeat(64),
      observedAt: millis(1_000),
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    const offer = [{ deliveryId: 'one', tile: { x: 1, y: 2 }, hash: 'a'.repeat(64) }]

    now += 299_999
    expect(cache.resolve('public', offer)).toMatchObject({
      acknowledgedDeliveryIds: ['one'],
      cacheOutcome: 'hit',
    })
    now += 299_999
    expect(cache.resolve('public', offer)).toMatchObject({
      acknowledgedDeliveryIds: ['one'],
      cacheOutcome: 'hit',
    })
    now += 300_000
    expect(cache.resolve('public', offer)).toMatchObject({
      unresolvedDeliveryIds: ['one'],
      cacheOutcome: 'stale',
    })
  })

  it('does not expose admin-only coverage or replace a newer generation', () => {
    const cache = createTileGenerationCache({ now: () => 10_000 })
    cache.apply({
      tile: { x: 1, y: 2 },
      hash: 'b'.repeat(64),
      observedAt: millis(2_000),
      visibleToPublic: false,
      visibleToAdmin: true,
    })
    cache.apply({
      tile: { x: 1, y: 2 },
      hash: 'a'.repeat(64),
      observedAt: millis(1_000),
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    const offer = [{ deliveryId: 'one', tile: { x: 1, y: 2 }, hash: 'b'.repeat(64) }]

    expect(cache.resolve('public', offer).acknowledgedDeliveryIds).toEqual([])
    expect(cache.resolve('admin', offer).acknowledgedDeliveryIds).toEqual(['one'])
    cache.invalidate()
    expect(cache.resolve('admin', offer).cacheOutcome).toBe('miss')
  })

  it('falls through changed hashes while making exact delivery replay idempotent', () => {
    const cache = createTileGenerationCache({ now: () => 10_000 })
    cache.apply({
      tile: { x: 1, y: 2 },
      hash: 'a'.repeat(64),
      observedAt: millis(2_000),
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    const replay = [{ deliveryId: 'one', tile: { x: 1, y: 2 }, hash: 'a'.repeat(64) }]

    expect(cache.resolve('public', replay).acknowledgedDeliveryIds).toEqual(['one'])
    expect(cache.resolve('public', replay).acknowledgedDeliveryIds).toEqual(['one'])
    expect(
      cache.resolve('public', [{ deliveryId: 'two', tile: { x: 1, y: 2 }, hash: 'b'.repeat(64) }]),
    ).toMatchObject({ unresolvedDeliveryIds: ['two'], cacheOutcome: 'stale' })
  })
})
