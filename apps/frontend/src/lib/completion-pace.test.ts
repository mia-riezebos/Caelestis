import { type ArchiveProgressSample, type HistoryResponse, seconds } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { completionPace } from './completion-pace'

const DAY = 86_400
const sample = (day: number, correct: number | null): ArchiveProgressSample => ({
  at: day * DAY,
  snapshotId: day,
  correct,
  mismatched: correct === null ? null : 0,
  total: 1000,
})
const history: HistoryResponse = {
  resolution: DAY,
  coverageStart: seconds(0),
  buckets: [
    {
      templateId: 'template',
      resolution: DAY,
      bucketStart: seconds(3 * DAY),
      placed: 1000,
      correct: 24,
      repairs: 0,
    },
  ],
}

it('combines net archive gains with correct reports and excludes overlapping archive intervals', () => {
  const archives = [sample(1, 0), sample(2, 48), sample(3, 96), sample(4, 996)]
  expect(completionPace(history, archives, [], 4 * DAY, 7 * DAY)).toEqual({
    correct: 120 / 72,
    hours: 72,
  })
})

it('keeps reported zero-activity buckets after the first report in the denominator', () => {
  expect(completionPace(history, [sample(1, 0), sample(3, 96)], [], 5 * DAY, 7 * DAY)).toEqual({
    correct: 120 / 96,
    hours: 96,
  })
})

it('uses archive history when the backend has no retained paint history metadata', () => {
  expect(
    completionPace({ buckets: [] }, [sample(1, 0), sample(2, 48)], [], 3 * DAY, 7 * DAY),
  ).toEqual({
    correct: 2,
    hours: 24,
  })
})

it('keeps regressions signed and excludes explicit gaps from coverage', () => {
  const archives = [sample(0, 0), sample(1, 96), sample(2, null), sample(3, 100), sample(4, 52)]
  expect(completionPace(undefined, archives, [], 4 * DAY, 7 * DAY)).toEqual({
    correct: 1,
    hours: 48,
  })
})

it('clips a daily capture to the selected window without including future observations', () => {
  const archives = [sample(0, 0), sample(1, 24), sample(2, 72), sample(3, 1000)]
  expect(completionPace(undefined, archives, [], 2.5 * DAY, DAY)).toEqual({ correct: 2, hours: 12 })
  expect(completionPace(undefined, archives, [], 5 * DAY, DAY)).toBeNull()
})

it('does not infer daily pace from a multi-day archive gap', () => {
  expect(completionPace(undefined, [sample(0, 0), sample(3, 72)], [], 3 * DAY, DAY)).toBeNull()
})

it('joins the last archive sample to the first saved native observation, with native precedence', () => {
  expect(
    completionPace(
      history,
      [sample(1, 0), sample(2, 48), sample(3, 900)],
      [sample(3, 72)],
      4 * DAY,
      7 * DAY,
    ),
  ).toEqual({
    correct: 96 / 72,
    hours: 72,
  })
})

it('excludes archive intervals crossing the first report and partial reported buckets', () => {
  const archives = [sample(1, 0), sample(2, 48), sample(3.5, 900)]
  expect(completionPace(history, archives, [], 3.5 * DAY, 7 * DAY)).toEqual({
    correct: 2,
    hours: 24,
  })
})

it('preserves the retained-history average when there are no usable archive intervals', () => {
  expect(completionPace(history, [sample(1, 100)], [], 4 * DAY, 7 * DAY)).toEqual({
    placed: 1000 / 96,
    correct: 24 / 96,
    hours: 96,
  })
})
