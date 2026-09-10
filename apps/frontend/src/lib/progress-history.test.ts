import { expect, it } from 'vitest'
import { combineProgressSamples, mergeObservedProgress } from './progress-history'

it('does not break covered intervals merely because the other source has not been recounted', () => {
  const archive = [1, 3].map((at) => ({
    at,
    snapshotId: at,
    correct: 10,
    mismatched: 1,
    total: 100,
  }))
  const gap = { at: 2, correct: null, mismatched: null, total: 100 }
  expect(mergeObservedProgress(archive, [gap]).map((sample) => sample.at)).toEqual([1, 3])
  expect(
    mergeObservedProgress([{ ...gap, snapshotId: 2 }], archive).map((sample) => sample.at),
  ).toEqual([1, 3])
})

it('combines only covered scopes and preserves explicit gaps', () => {
  expect(
    combineProgressSamples([
      [
        { at: 1, correct: 10, mismatched: 2, total: 50 },
        { at: 3, correct: null, mismatched: null, total: 50 },
      ],
      [{ at: 2, correct: 20, mismatched: 1, total: 30 }],
    ]),
  ).toEqual([
    { at: 1, correct: null, mismatched: null, total: 50 },
    { at: 2, correct: 30, mismatched: 3, total: 80 },
    { at: 3, correct: null, mismatched: null, total: 80 },
  ])
})

it('prefers measured native observations at the same time and only adds current counts at now', () => {
  const archive = [1, 2, 3].map((at) => ({
    at,
    snapshotId: at,
    correct: 10,
    mismatched: 1,
    total: 100,
  }))
  const observed = [
    { at: 2, correct: null, mismatched: null, total: 100 },
    { at: 3, correct: 20, mismatched: 2, total: 100 },
  ]
  const past = mergeObservedProgress(archive, observed)
  expect(past.map((sample) => [sample.correct, sample.archive])).toEqual([
    [10, true],
    [10, true],
    [20, false],
  ])
  expect(
    mergeObservedProgress(archive, observed, { at: 4, correct: 80, mismatched: 0 }).slice(0, 3),
  ).toEqual(past)
})
