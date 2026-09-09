import { expect, it } from 'vitest'
import { rollingIntervalPace } from './progress-pace'

const DAY = 86_400
const intervals = [24, 48, -24, 96].map((pixels, i) => ({
  from: i * DAY,
  to: (i + 1) * DAY,
  pixels,
}))

it('uses the same complete trailing windows for daily history', () => {
  expect(rollingIntervalPace(intervals, DAY)).toEqual([
    [
      { t: DAY, v: 1 },
      { t: 2 * DAY, v: 2 },
      { t: 3 * DAY, v: -1 },
      { t: 4 * DAY, v: 4 },
    ],
  ])
  expect(rollingIntervalPace(intervals, 3 * DAY)).toEqual([
    [
      { t: 3 * DAY, v: 2 / 3 },
      { t: 4 * DAY, v: 5 / 3 },
    ],
  ])
  expect(rollingIntervalPace(intervals, DAY / 2)).toEqual([])
  expect(rollingIntervalPace(intervals, 7 * DAY)).toEqual([])
})

it('connects a daily window across archive and live buckets without counting overlap twice', () => {
  const live = Array.from({ length: 24 }, (_, i) => ({
    from: 2 * DAY + i * 3600,
    to: 2 * DAY + (i + 1) * 3600,
    pixels: 3,
  }))
  const [series] = rollingIntervalPace([...intervals.slice(0, 2), ...live], DAY)
  expect(series?.[1]).toEqual({ t: 2 * DAY, v: 2 })
  expect(series?.[2]).toEqual({ t: 2 * DAY + 3600, v: 49 / 24 })
  expect(series?.at(-1)).toEqual({ t: 3 * DAY, v: 3 })
})

it('starts a new line after a coverage gap and waits for a full window again', () => {
  const gapped = intervals.filter((_, index) => index === 0 || index === 2)
  expect(rollingIntervalPace(gapped, DAY)).toEqual([[{ t: DAY, v: 1 }], [{ t: 3 * DAY, v: -1 }]])
  expect(rollingIntervalPace(gapped, 2 * DAY)).toEqual([])
})

it('keeps daily pace for a 25-hour daily capture without inventing subdaily pace', () => {
  const daily = [{ from: 21 * 3600, to: 46 * 3600, pixels: 25, dailyObservation: true }]
  expect(rollingIntervalPace(daily, DAY)).toEqual([[{ t: 46 * 3600, v: 1 }]])
  expect(rollingIntervalPace(daily, 12 * 3600)).toEqual([])
})
