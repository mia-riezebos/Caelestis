import type { PainterTotal } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  defaultVisiblePainters,
  fuzzyScore,
  painterColour,
  painterHue,
  painterLabel,
  rankPainters,
} from './painter-pace.js'

const painter = (wplaceUserId: number, displayName = `painter ${wplaceUserId}`): PainterTotal => ({
  wplaceUserId,
  displayName,
  placed: 1,
  correct: 1,
  repairs: 0,
})

describe('selection', () => {
  it('picks a bounded set of leading painters in the order the server listed them', () => {
    const crowd = Array.from({ length: 20 }, (_, index) => painter(index + 1))
    expect([...defaultVisiblePainters(crowd)]).toEqual([1, 2, 3, 4, 5])
    expect(defaultVisiblePainters(crowd, 2)).toEqual(new Set([1, 2]))
    expect(defaultVisiblePainters([])).toEqual(new Set())
  })

  it('labels a painter by name and falls back to the id', () => {
    expect(painterLabel(painter(1, 'Ada'))).toBe('Ada')
    expect(painterLabel({ wplaceUserId: 1, displayName: '' })).toBe('user 1')
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

  it('ranks painters by name or id and keeps the server order for an empty query', () => {
    const options = [painter(900, 'Bo'), painter(42, 'Ada'), painter(7, 'Cyd')]
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
