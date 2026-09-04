import { type HistoryResponse, seconds } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  availableRangePresets,
  averagePace,
  axisScale,
  clampWindow,
  clipSeries,
  formatCount,
  nearestSorted,
  rollingPaceSeries,
  snapTime,
  timeTickStep,
  windowKeyStep,
} from './progress-pace.js'

describe('pace summaries', () => {
  it('averages complete retained buckets instead of treating partial boundaries as full hours', () => {
    const history: HistoryResponse = {
      resolution: 21_600,
      coverageStart: seconds(0),
      buckets: [0, 21_600, 43_200, 64_800, 86_400].map((bucketStart, index) => ({
        templateId: 'template',
        resolution: 21_600,
        bucketStart: seconds(bucketStart),
        placed: index === 0 || index === 4 ? 600 : 60,
        correct: index === 0 || index === 4 ? 300 : 30,
        repairs: 0,
      })),
    }

    expect(averagePace(history, 90_000, 86_400)).toEqual({
      placed: 10,
      correct: 5,
      hours: 18,
    })
  })

  it('includes the first bucket and stamps each trailing window at its end', () => {
    expect(
      rollingPaceSeries(
        [
          { t: 0, cumPlaced: 4 },
          { t: 3_600, cumPlaced: 12 },
          { t: 7_200, cumPlaced: 15 },
        ],
        3_600,
        7_200,
      ),
    ).toEqual([
      { t: 7_200, v: 6 },
      { t: 10_800, v: 5.5 },
    ])
  })
})

describe('time axis', () => {
  it('limits a six-month lifecycle to the labels that fit the plot', () => {
    const span = 180 * 86_400
    const step = timeTickStep(span, 544)

    expect(step).toBe(30 * 86_400)
    expect(Math.ceil(span / step)).toBeLessThanOrEqual(7)
  })
})

describe('value axis', () => {
  it('puts round gridlines under the data and gives the data a little headroom', () => {
    expect(axisScale(33_000, 4, 1)).toEqual({
      max: 34_320,
      ticks: [5_000, 10_000, 15_000, 20_000, 25_000, 30_000],
    })
    expect(axisScale(1_234, 4, 1)).toEqual({
      max: 1_283.36,
      ticks: [200, 400, 600, 800, 1_000, 1_200],
    })
    expect(axisScale(8, 4, 1)).toEqual({ max: 8.32, ticks: [2, 4, 6, 8] })
  })

  it('steps up when a finer step would crowd the axis', () => {
    expect(axisScale(19.9, 4)).toEqual({ max: 20.696, ticks: [5, 10, 15] })
  })

  it('keeps pixel counts on whole ticks and lets slow paces use fractions', () => {
    expect(axisScale(0, 4)).toEqual({ max: 1, ticks: [1] })
    expect(axisScale(1, 4, 1)).toEqual({ max: 1.04, ticks: [1] })
    expect(axisScale(3, 4, 1)).toEqual({ max: 3.12, ticks: [1, 2, 3] })
    expect(axisScale(0.9, 4)).toEqual({ max: 0.936, ticks: [0.2, 0.4, 0.6, 0.8] })
  })

  it('formats compact counts', () => {
    expect(formatCount(850)).toBe((850).toLocaleString())
    expect(formatCount(1_500)).toBe(`${(1.5).toLocaleString()}k`)
    expect(formatCount(12_000)).toBe(`${(12).toLocaleString()}k`)
    expect(formatCount(0.25)).toBe((0.25).toLocaleString())
  })
})

describe('time window', () => {
  const lerp = (a: { t: number; v: number }, b: { t: number; v: number }, fraction: number) => ({
    t: a.t + (b.t - a.t) * fraction,
    v: a.v + (b.v - a.v) * fraction,
  })
  const series = [
    { t: 0, v: 0 },
    { t: 10, v: 10 },
    { t: 20, v: 30 },
    { t: 30, v: 60 },
  ]

  it('clips a series to a window and interpolates both edges', () => {
    expect(clipSeries(series, 5, 25, lerp)).toEqual([
      { t: 5, v: 5 },
      { t: 10, v: 10 },
      { t: 20, v: 30 },
      { t: 25, v: 45 },
    ])
    expect(clipSeries(series, 10, 20, lerp)).toEqual([
      { t: 10, v: 10 },
      { t: 20, v: 30 },
    ])
    expect(clipSeries(series, -5, 100, lerp)).toEqual(series)
  })

  it('keeps a window inside the range and at least the minimum width', () => {
    expect(clampWindow({ from: 90, to: 95 }, 0, 100, 20)).toEqual({ from: 80, to: 100 })
    expect(clampWindow({ from: -10, to: 30 }, 0, 100, 20)).toEqual({ from: 0, to: 40 })
    expect(clampWindow({ from: 10, to: 50 }, 0, 100, 20)).toEqual({ from: 10, to: 50 })
    expect(clampWindow({ from: 0, to: 500 }, 0, 100, 20)).toEqual({ from: 0, to: 100 })
  })

  it('snaps to the nearest rendered time', () => {
    expect(nearestSorted([], 5)).toBeNull()
    expect(nearestSorted([0, 10, 20], 14)).toBe(10)
    expect(nearestSorted([0, 10, 20], 16)).toBe(20)
    expect(nearestSorted([0, 10, 20], -3)).toBe(0)
    expect(nearestSorted([0, 10, 20], 99)).toBe(20)
  })

  it('offers only presets that fit between the minimum window and the whole history', () => {
    expect(availableRangePresets(3 * 86_400, 21_600).map((preset) => preset.key)).toEqual([
      '6h',
      '1d',
    ])
    expect(availableRangePresets(3 * 86_400, 36 * 3_600)).toEqual([])
    expect(availableRangePresets(180 * 86_400, 900).map((preset) => preset.key)).toEqual([
      '6h',
      '1d',
      '3d',
      '7d',
      '30d',
    ])
  })

  it('nudges a grip by about a hundredth of the history, never finer than a bucket', () => {
    expect(windowKeyStep(3 * 86_400, 3_600)).toBe(3_600)
    expect(windowKeyStep(180 * 86_400, 21_600)).toBe(8 * 21_600)
    expect(snapTime(4_000, 3_600, 0, 7_000)).toBe(3_600)
    expect(snapTime(-4_000, 3_600, 0, 7_000)).toBe(0)
  })
})
