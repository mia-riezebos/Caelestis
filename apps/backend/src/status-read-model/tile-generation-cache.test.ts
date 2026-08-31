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
      coverageToken: preparedToken.coverageToken,
      commitToken: preparedToken.commitToken,
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    expect(cache.resolve('public', oldOffer).acknowledgedDeliveryIds).toEqual([])
    expect(cache.resolve('public', newOffer).acknowledgedDeliveryIds).toEqual(['new'])
  })

  it('rejects an older repair after a newer prepare for the same tile', () => {
    const cache = createTileGenerationCache({ now: () => 2_000 })
    const tile = { x: 1, y: 2 }
    const other = { x: 3, y: 4 }
    const coverageToken = cache.resolve('public', []).coverageToken ?? ''
    cache.apply({
      tile: other,
      hash: 'c'.repeat(64),
      observedAt: millis(1_000),
      commitOrder: 1,
      coverageToken,
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    const commitA = cache.prepare(tile)
    const commitB = cache.prepare(tile)

    cache.apply({
      tile,
      hash: 'a'.repeat(64),
      observedAt: millis(1_000),
      commitOrder: 1,
      ...commitA,
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    expect(
      cache.resolve('public', [{ deliveryId: 'a', tile, hash: 'a'.repeat(64) }])
        .unresolvedDeliveryIds,
    ).toEqual(['a'])
    expect(
      cache.resolve('public', [{ deliveryId: 'other', tile: other, hash: 'c'.repeat(64) }])
        .acknowledgedDeliveryIds,
    ).toEqual(['other'])

    cache.apply({
      tile,
      hash: 'b'.repeat(64),
      observedAt: millis(2_000),
      commitOrder: 2,
      ...commitB,
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    expect(
      cache.resolve('public', [{ deliveryId: 'b', tile, hash: 'b'.repeat(64) }])
        .acknowledgedDeliveryIds,
    ).toEqual(['b'])
  })

  it('publishes a successful concurrent commit after the losing commit settles', () => {
    const cache = createTileGenerationCache({ now: () => 2_000 })
    const tile = { x: 1, y: 2 }
    const commitA = cache.prepare(tile)
    const commitB = cache.prepare(tile)

    cache.apply({
      tile,
      hash: 'a'.repeat(64),
      observedAt: millis(1_000),
      commitOrder: 1,
      ...commitA,
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    cache.finish(tile, commitB)

    expect(
      cache.resolve('public', [{ deliveryId: 'winner', tile, hash: 'a'.repeat(64) }])
        .acknowledgedDeliveryIds,
    ).toEqual(['winner'])
  })

  it('keeps a recovered repair behind a newer same-tile commit fence', () => {
    let token = 0
    const options = {
      now: () => 2_000,
      createCoverageToken: () => `token-${token++}`,
    }
    const tile = { x: 1, y: 2 }
    const first = createTileGenerationCache(options)
    first.synchronizeCoverageToken('manifest-1')
    const commitA = first.prepare(tile)

    const recovered = createTileGenerationCache(options)
    recovered.synchronizeCoverageToken('manifest-1')
    const commitB = recovered.prepare(tile)
    recovered.apply({
      tile,
      hash: 'a'.repeat(64),
      observedAt: millis(1_000),
      commitOrder: 1,
      ...commitA,
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    const offerA = [{ deliveryId: 'a', tile, hash: 'a'.repeat(64) }]

    expect(recovered.resolve('public', offerA).unresolvedDeliveryIds).toEqual(['a'])
    recovered.finish(tile, commitB)
    expect(recovered.resolve('public', offerA).acknowledgedDeliveryIds).toEqual(['a'])
  })

  it('restores the prior generation when a replacement commit loses', () => {
    const cache = createTileGenerationCache({ now: () => 2_000 })
    const tile = { x: 1, y: 2 }
    const coverageToken = cache.resolve('public', []).coverageToken ?? ''
    cache.apply({
      tile,
      hash: 'a'.repeat(64),
      observedAt: millis(1_000),
      commitOrder: 1,
      coverageToken,
      visibleToPublic: true,
      visibleToAdmin: true,
    })

    const replacement = cache.prepare(tile)
    cache.finish(tile, replacement)

    expect(
      cache.resolve('public', [{ deliveryId: 'prior', tile, hash: 'a'.repeat(64) }])
        .acknowledgedDeliveryIds,
    ).toEqual(['prior'])
  })

  it('expires abandoned commit fences without restoring stale candidates', () => {
    let now = 1_000
    const cache = createTileGenerationCache({ now: () => now, ttlMilliseconds: 100 })
    const tile = { x: 1, y: 2 }
    const coverageToken = cache.resolve('public', []).coverageToken ?? ''
    cache.apply({
      tile,
      hash: 'a'.repeat(64),
      observedAt: millis(1_000),
      commitOrder: 1,
      coverageToken,
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    cache.prepare(tile)
    now = 1_101

    const replacement = cache.prepare(tile)
    cache.finish(tile, replacement)

    expect(
      cache.resolve('public', [{ deliveryId: 'stale', tile, hash: 'a'.repeat(64) }]),
    ).toMatchObject({ acknowledgedDeliveryIds: [], unresolvedDeliveryIds: ['stale'] })
  })

  it('keeps an expired newer commit fence unresolved until its repair arrives', () => {
    let now = 1_000
    let token = 0
    const cache = createTileGenerationCache({
      now: () => now,
      ttlMilliseconds: 100,
      createCoverageToken: () => `token-${token++}`,
    })
    const tile = { x: 1, y: 2 }
    const older = cache.prepare(tile)
    const newer = cache.prepare(tile)
    now = 1_050
    cache.apply({
      tile,
      hash: 'a'.repeat(64),
      observedAt: millis(1_000),
      commitOrder: 1,
      ...older,
      visibleToPublic: true,
      visibleToAdmin: true,
    })

    now = 1_101
    expect(
      cache.resolve('public', [{ deliveryId: 'older', tile, hash: 'a'.repeat(64) }]),
    ).toMatchObject({ acknowledgedDeliveryIds: [], unresolvedDeliveryIds: ['older'] })

    cache.apply({
      tile,
      hash: 'b'.repeat(64),
      observedAt: millis(1_001),
      commitOrder: 2,
      ...newer,
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    expect(
      cache.resolve('public', [{ deliveryId: 'newer', tile, hash: 'b'.repeat(64) }]),
    ).toMatchObject({ acknowledgedDeliveryIds: ['newer'], unresolvedDeliveryIds: [] })
  })

  it('keeps a settled candidate unresolved when another commit token expires', () => {
    let now = 1_000
    let token = 0
    const cache = createTileGenerationCache({
      now: () => now,
      ttlMilliseconds: 100,
      createCoverageToken: () => `token-${token++}`,
    })
    const tile = { x: 1, y: 2 }
    const coverageToken = cache.resolve('public', []).coverageToken ?? ''
    cache.prepare(tile)
    now = 1_050
    const committed = cache.prepare(tile)
    cache.apply({
      tile,
      hash: 'b'.repeat(64),
      observedAt: millis(1_050),
      commitOrder: 2,
      ...committed,
      visibleToPublic: true,
      visibleToAdmin: true,
    })

    now = 1_101
    const next = cache.prepare(tile)
    cache.finish(tile, next)

    expect(
      cache.resolve('public', [{ deliveryId: 'settled', tile, hash: 'b'.repeat(64) }]),
    ).toMatchObject({ acknowledgedDeliveryIds: [], unresolvedDeliveryIds: ['settled'] })
    expect(cache.resolve('public', []).coverageToken).toBe(coverageToken)
  })
})
