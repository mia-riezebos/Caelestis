import { type ContributionDay, seconds } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  DAY_SECONDS,
  defaultVisiblePainters,
  painterColour,
  painterHue,
  painterLabel,
  painterSeries,
} from './painter-pace.js'

const row = (
  wplaceUserId: number,
  day: number,
  counts: Partial<Pick<ContributionDay, 'placed' | 'correct' | 'repairs'>> = {},
  options: { templateId?: string; displayName?: string } = {},
): ContributionDay => ({
  wplaceUserId,
  displayName: options.displayName ?? `painter ${wplaceUserId}`,
  templateId: options.templateId ?? 'template',
  day: seconds(day * DAY_SECONDS),
  placed: counts.placed ?? 0,
  correct: counts.correct ?? 0,
  repairs: counts.repairs ?? 0,
})

describe('painterSeries', () => {
  it('sums a painter-day across templates and zero-fills the days in between', () => {
    const series = painterSeries(
      [
        row(1, 0, { placed: 10, correct: 8, repairs: 1 }, { templateId: 'a' }),
        row(1, 0, { placed: 5, correct: 5, repairs: 0 }, { templateId: 'b' }),
        row(1, 2, { placed: 3, correct: 3, repairs: 2 }),
      ],
      0,
      3 * DAY_SECONDS,
    )

    expect(series).toEqual([
      {
        wplaceUserId: 1,
        displayName: 'painter 1',
        days: [
          { day: 0, placed: 15, correct: 13, repairs: 1 },
          { day: DAY_SECONDS, placed: 0, correct: 0, repairs: 0 },
          { day: 2 * DAY_SECONDS, placed: 3, correct: 3, repairs: 2 },
        ],
        totals: { placed: 18, correct: 16, repairs: 3 },
      },
    ])
  })

  it('covers every day of a range that does not start or end on a day boundary', () => {
    const [painter] = painterSeries([row(1, 1, { placed: 1 })], 3_600, 2 * DAY_SECONDS + 1)
    expect(painter?.days.map((day) => day.day)).toEqual([0, DAY_SECONDS, 2 * DAY_SECONDS])
  })

  it('ignores rows outside the range instead of inventing days for them', () => {
    const series = painterSeries(
      [row(1, 0, { placed: 4 }), row(1, 5, { placed: 9 }), row(2, 1, { placed: 1 })],
      DAY_SECONDS,
      3 * DAY_SECONDS,
    )
    expect(series).toEqual([
      {
        wplaceUserId: 2,
        displayName: 'painter 2',
        days: [
          { day: DAY_SECONDS, placed: 1, correct: 0, repairs: 0 },
          { day: 2 * DAY_SECONDS, placed: 0, correct: 0, repairs: 0 },
        ],
        totals: { placed: 1, correct: 0, repairs: 0 },
      },
    ])
  })

  it('only builds series for painters the server served rows for', () => {
    const series = painterSeries(
      [row(7, 0, { placed: 1 }), row(9, 1, { placed: 1 })],
      0,
      2 * DAY_SECONDS,
    )
    expect(series.map((painter) => painter.wplaceUserId).sort()).toEqual([7, 9])
    expect(painterSeries([], 0, 2 * DAY_SECONDS)).toEqual([])
  })

  it('orders painters like the leaderboard: correct, then placed, then id', () => {
    const series = painterSeries(
      [
        row(3, 0, { placed: 10, correct: 2 }),
        row(2, 0, { placed: 5, correct: 5 }),
        row(1, 0, { placed: 10, correct: 2 }),
        row(4, 0, { placed: 20, correct: 2 }),
      ],
      0,
      DAY_SECONDS,
    )
    expect(series.map((painter) => painter.wplaceUserId)).toEqual([2, 4, 1, 3])
  })

  it('labels a painter with their newest non-empty display name', () => {
    const [painter] = painterSeries(
      [
        row(1, 2, { placed: 1 }, { displayName: '' }),
        row(1, 1, { placed: 1 }, { displayName: 'new name' }),
        row(1, 0, { placed: 1 }, { displayName: 'old name' }),
      ],
      0,
      3 * DAY_SECONDS,
    )
    expect(painter?.displayName).toBe('new name')
    expect(
      painterLabel({
        wplaceUserId: 1,
        displayName: '',
        days: [],
        totals: { placed: 0, correct: 0, repairs: 0 },
      }),
    ).toBe('user 1')
  })
})

describe('default selection and colours', () => {
  it('picks a bounded set of leading painters', () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      row(index + 1, 0, { placed: 100 - index, correct: 100 - index }),
    )
    const visible = defaultVisiblePainters(painterSeries(rows, 0, DAY_SECONDS))
    expect(visible.size).toBe(8)
    expect([...visible]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(defaultVisiblePainters(painterSeries(rows, 0, DAY_SECONDS), 2)).toEqual(new Set([1, 2]))
  })

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
