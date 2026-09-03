import { type HistoryResponse, seconds } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { averagePace, timeTickStep } from './progress-pace.js'

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
})

describe('time axis', () => {
  it('limits a six-month lifecycle to the labels that fit the plot', () => {
    const span = 180 * 86_400
    const step = timeTickStep(span, 544)

    expect(step).toBe(30 * 86_400)
    expect(Math.ceil(span / step)).toBeLessThanOrEqual(7)
  })
})
