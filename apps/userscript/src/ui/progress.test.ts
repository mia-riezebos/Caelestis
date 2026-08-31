import { describe, expect, it } from 'vitest'
import {
  applyColourProgressDelta,
  completionRatio,
  freshestColourProgress,
  freshestProgress,
  sumColourProgress,
  sumProgress,
} from './progress.js'

const progress = { completed: 40, mismatched: 10, unpainted: 30, known: 80, total: 100 }

describe('template progress model calculations', () => {
  it('uses the whole template for completion', () => {
    expect(completionRatio(progress)).toBe(0.4)
  })

  it('accumulates descendants while keeping unknown pixels separate', () => {
    expect(
      sumProgress([progress, { completed: 10, mismatched: 5, unpainted: 5, known: 20, total: 50 }]),
    ).toEqual({ completed: 50, mismatched: 15, unpainted: 35, known: 100, total: 150 })
  })

  it('accumulates per-colour descendants in palette order', () => {
    expect(
      sumColourProgress([
        [{ index: 4, completed: 1, mismatched: 0, unpainted: 0, known: 1, total: 1 }],
        [{ index: 1, completed: 0, mismatched: 1, unpainted: 0, known: 1, total: 1 }],
      ])?.map(({ index }) => index),
    ).toEqual([1, 4])
  })

  it('keeps server baselines while scans load and applies an exact draft category transfer', () => {
    const local = { completed: 20, mismatched: 0, unpainted: 0, known: 20, total: 100 }
    const serverColours = [
      { index: 0, completed: 2, mismatched: 1, unpainted: 1, known: 4, total: 4 },
      { index: 1, completed: 1, mismatched: 0, unpainted: 1, known: 2, total: 2 },
    ]
    expect(freshestProgress(progress, local)).toBe(progress)
    expect(freshestColourProgress(serverColours, [])).toBe(serverColours)
    expect(
      applyColourProgressDelta(serverColours[0] as (typeof serverColours)[number], {
        index: 0,
        completed: 1,
        mismatched: 0,
        unpainted: -1,
      }),
    ).toEqual({ index: 0, completed: 3, mismatched: 1, unpainted: 0, known: 4, total: 4 })
  })
})
