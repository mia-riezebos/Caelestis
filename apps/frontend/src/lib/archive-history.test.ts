import { type ArchiveHistory, seconds } from '@caelestis/shared'
import { expect, it } from 'vitest'
import {
  archiveContributionDays,
  archiveIntervals,
  combineArchiveSamples,
  mergeArchiveFrames,
} from './archive-history.js'

it('preserves real buckets and distinguishes missing archive coverage from a blank tile', () => {
  const frames = mergeArchiveFrames(
    { resolution: 3600, frames: [{ bucketStart: seconds(3600), hash: 'real', reporters: 1 }] },
    [
      { at: 100, snapshotId: 1, hash: 'old' },
      { at: 200, snapshotId: 2, hash: null },
      { at: 3700, snapshotId: 3, hash: 'overlap' },
    ],
  )
  expect(frames).toEqual([
    { bucketStart: 100, hash: 'archive:old' },
    { bucketStart: 200, hash: undefined, missing: true },
    { bucketStart: 3600, hash: 'real', reporters: 1 },
  ])
})

it('keeps net regressions and does not bridge incomplete observations', () => {
  const samples = [10, 8, null, 20].map((correct, index) => ({
    at: index * 86_400,
    snapshotId: index,
    correct,
    mismatched: correct === null ? null : 0,
    total: 20,
  }))
  expect(archiveIntervals(samples)).toEqual([
    { from: 0, to: 86_400, startCorrect: 10, endCorrect: 8, rate: -2 / 24 },
  ])
})

it('requires complete scope coverage before showing aggregate completion', () => {
  const first: ArchiveHistory = {
    source: 'eralyon',
    basis: {
      templateId: 'one',
      versionId: 'v1',
      name: 'One',
      season: 0,
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      total: 10,
      chunks: [],
    },
    samples: [{ at: 100, snapshotId: 1, correct: 5, mismatched: 2, total: 10 }],
    frames: [],
  }
  const second: ArchiveHistory = { ...first, samples: [] }
  expect(combineArchiveSamples([first, second])[0]?.correct).toBeNull()
  expect(combineArchiveSamples([first, first])[0]?.correct).toBe(10)
})

it('includes daily imported gains without live overlap, regressions, or multi-day guesses', () => {
  const samples = [10, 20, 15, null, 30, 40, 50].map((correct, index) => ({
    at: index * 86_400,
    snapshotId: index,
    correct,
    mismatched: 0,
    total: 100,
  }))
  expect([...archiveContributionDays(samples, 6 * 86_400)]).toEqual([
    [86_400, 10],
    [2 * 86_400, 0],
    [5 * 86_400, 10],
  ])
  expect([...archiveContributionDays(samples, 5 * 86_400)]).not.toContainEqual([5 * 86_400, 10])
  expect(
    archiveContributionDays(
      samples.filter((_, index) => index === 0 || index === 2),
      Infinity,
    ).size,
  ).toBe(0)
})

it('attributes drifting daily captures to the newer UTC capture date and skips missed dates', () => {
  const captures = ['2025-09-26T21:00Z', '2025-09-27T22:00Z', '2025-09-29T01:00Z'].map(
    (date, index) => ({
      at: Date.parse(date) / 1000,
      snapshotId: index,
      correct: index * 25,
      mismatched: 0,
      total: 100,
    }),
  )
  expect([...archiveContributionDays(captures, Infinity)]).toEqual([
    [Date.parse('2025-09-27T00:00Z') / 1000, 25],
  ])
})
