import { type PainterHistoryBucket, seconds } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  bucketsForPainters,
  defaultVisiblePainters,
  fuzzyScore,
  painterColour,
  painterHue,
  painterLabel,
  painterOptions,
  rankPainters,
} from './painter-pace.js'

const bucket = (
  wplaceUserId: number,
  bucketStart: number,
  counts: Partial<Pick<PainterHistoryBucket, 'placed' | 'correct' | 'repairs'>> = {},
  displayName = `painter ${wplaceUserId}`,
): PainterHistoryBucket => ({
  templateId: 'template',
  wplaceUserId,
  displayName,
  resolution: 60,
  bucketStart: seconds(bucketStart),
  placed: counts.placed ?? 0,
  correct: counts.correct ?? 0,
  repairs: counts.repairs ?? 0,
})

describe('painterOptions', () => {
  it('sums each served painter over the range and orders them like the leaderboard', () => {
    const options = painterOptions([
      bucket(3, 0, { placed: 10, correct: 2 }),
      bucket(2, 0, { placed: 5, correct: 5 }),
      bucket(1, 0, { placed: 10, correct: 2 }),
      bucket(4, 0, { placed: 20, correct: 2 }),
      bucket(2, 60, { placed: 1, correct: 1, repairs: 1 }),
    ])
    expect(options.map((painter) => painter.wplaceUserId)).toEqual([2, 4, 1, 3])
    expect(options[0]).toEqual({
      wplaceUserId: 2,
      displayName: 'painter 2',
      placed: 6,
      correct: 6,
      repairs: 1,
    })
  })

  it('only lists painters the server served buckets for', () => {
    expect(painterOptions([])).toEqual([])
    expect(painterOptions([bucket(7, 0, { placed: 1 })]).map((p) => p.wplaceUserId)).toEqual([7])
  })

  it('labels a painter by name and falls back to the id', () => {
    const [named] = painterOptions([bucket(1, 0, {}, 'Ada')])
    expect(named && painterLabel(named)).toBe('Ada')
    expect(painterLabel({ wplaceUserId: 1, displayName: '' })).toBe('user 1')
  })
})

describe('selection', () => {
  const crowd = Array.from({ length: 20 }, (_, index) =>
    bucket(index + 1, 0, { placed: 100 - index, correct: 100 - index }),
  )

  it('picks a bounded set of leading painters', () => {
    const visible = defaultVisiblePainters(painterOptions(crowd))
    expect([...visible]).toEqual([1, 2, 3, 4, 5])
    expect(defaultVisiblePainters(painterOptions(crowd), 2)).toEqual(new Set([1, 2]))
  })

  it('keeps only the drawn painters’ buckets', () => {
    expect(
      bucketsForPainters({ buckets: crowd }, new Set([3, 17])).map((b) => b.wplaceUserId),
    ).toEqual([3, 17])
  })
})

describe('fuzzy search', () => {
  it('matches subsequences, prefers prefixes and word starts, and rejects the rest', () => {
    expect(fuzzyScore('ada', 'Ada Lovelace')).toBeGreaterThan(fuzzyScore('ada', 'Nevada') ?? 0)
    expect(fuzzyScore('al', 'Ada Lovelace')).toBeGreaterThan(fuzzyScore('al', 'Salvo') ?? 0)
    expect(fuzzyScore('lvc', 'Ada Lovelace')).not.toBeNull()
    expect(fuzzyScore('xyz', 'Ada Lovelace')).toBeNull()
    expect(fuzzyScore('', 'anyone')).toBe(0)
  })

  it('ranks painters by name or id and keeps leaderboard order for an empty query', () => {
    const options = painterOptions([
      bucket(900, 0, { placed: 3, correct: 3 }, 'Bo'),
      bucket(42, 0, { placed: 2, correct: 2 }, 'Ada'),
      bucket(7, 0, { placed: 1, correct: 1 }, 'Cyd'),
    ])
    expect(rankPainters(options, '').map((p) => p.displayName)).toEqual(['Bo', 'Ada', 'Cyd'])
    expect(rankPainters(options, 'ad').map((p) => p.displayName)).toEqual(['Ada'])
    expect(rankPainters(options, '90').map((p) => p.wplaceUserId)).toEqual([900])
    expect(rankPainters(options, 'zz')).toEqual([])
  })
})

describe('colours', () => {
  it('assigns a colour from the painter id alone', () => {
    expect(painterHue(42)).toBe(painterHue(42))
    expect(painterColour(42)).toBe(`oklch(var(--painter-l) var(--painter-c) ${painterHue(42)})`)
    const hues = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(painterHue))
    expect(hues.size).toBe(8)
    for (const hue of hues) {
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })
})
