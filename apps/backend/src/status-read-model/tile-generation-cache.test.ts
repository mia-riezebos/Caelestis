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
      commitOrder: 1,
      coverageToken: cache.resolve('public', []).coverageToken ?? '',
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
      commitOrder: 2,
      coverageToken: cache.resolve('public', []).coverageToken ?? '',
      visibleToPublic: false,
      visibleToAdmin: true,
    })
    cache.apply({
      tile: { x: 1, y: 2 },
      hash: 'a'.repeat(64),
      observedAt: millis(1_000),
      commitOrder: 1,
      coverageToken: cache.resolve('public', []).coverageToken ?? '',
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
      commitOrder: 1,
      coverageToken: cache.resolve('public', []).coverageToken ?? '',
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

  it('uses authoritative commit order instead of observation timestamp or repair arrival', () => {
    const cache = createTileGenerationCache({ now: () => 10_000 })
    const generation = (hash: string, observedAt: number, commitOrder: number) => ({
      tile: { x: 1, y: 2 },
      hash: hash.repeat(64),
      observedAt: millis(observedAt),
      commitOrder,
      coverageToken: cache.resolve('public', []).coverageToken ?? '',
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    cache.apply(generation('b', 2_000, 1))
    cache.apply(generation('a', 1_000, 2))

    expect(
      cache.resolve('public', [
        { deliveryId: 'authoritative', tile: { x: 1, y: 2 }, hash: 'a'.repeat(64) },
      ]).acknowledgedDeliveryIds,
    ).toEqual(['authoritative'])

    cache.apply(generation('c', 3_000, 1))
    expect(
      cache.resolve('public', [
        { deliveryId: 'older-client', tile: { x: 1, y: 2 }, hash: 'c'.repeat(64) },
      ]).unresolvedDeliveryIds,
    ).toEqual(['older-client'])
  })

  it('rejects a delayed repair that began before manifest invalidation', () => {
    let token = 0
    const cache = createTileGenerationCache({
      now: () => 2_000,
      createCoverageToken: () => `coverage-${token++}`,
    })
    const generation = (coverageToken: string) => ({
      tile: { x: 1, y: 2 },
      hash: 'a'.repeat(64),
      observedAt: millis(1_000),
      commitOrder: 1,
      coverageToken,
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    const offer = [{ deliveryId: 'one', tile: { x: 1, y: 2 }, hash: 'a'.repeat(64) }]

    const beforeRead = cache.resolve('public', []).coverageToken ?? ''
    cache.invalidate()
    cache.apply(generation(beforeRead))
    expect(cache.resolve('public', offer).cacheOutcome).toBe('miss')

    const afterRead = cache.resolve('public', []).coverageToken ?? ''
    cache.apply(generation(afterRead))
    expect(cache.resolve('public', offer).acknowledgedDeliveryIds).toEqual(['one'])
  })

  it('removes the old tile generation before a replacement commit begins', () => {
    const cache = createTileGenerationCache({ now: () => 2_000 })
    const tile = { x: 1, y: 2 }
    const oldOffer = [{ deliveryId: 'old', tile, hash: 'a'.repeat(64) }]
    const newOffer = [{ deliveryId: 'new', tile, hash: 'b'.repeat(64) }]
    const initialToken = cache.resolve('public', []).coverageToken ?? ''
    cache.apply({
      tile,
      hash: 'a'.repeat(64),
      observedAt: millis(1_000),
      commitOrder: 1,
      coverageToken: initialToken,
      visibleToPublic: true,
      visibleToAdmin: true,
    })

    const preparedToken = cache.prepare(tile)
    expect(cache.resolve('public', oldOffer)).toMatchObject({
      acknowledgedDeliveryIds: [],
      unresolvedDeliveryIds: ['old'],
    })

    cache.apply({
      tile,
      hash: 'b'.repeat(64),
      observedAt: millis(2_000),
      commitOrder: 2,
      coverageToken: preparedToken,
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    expect(cache.resolve('public', oldOffer).acknowledgedDeliveryIds).toEqual([])
    expect(cache.resolve('public', newOffer).acknowledgedDeliveryIds).toEqual(['new'])
  })
})
