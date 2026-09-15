import { millis, seconds, WORLD_PIXELS } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  archiveContributionDays,
  archiveIntervals,
  combineArchiveSamples,
  mergeArchiveFrames,
} from '../lib/archive-history'
import { completionPace } from '../lib/completion-pace'
import {
  rankPainters,
  selectAllPainters,
  togglePainterSelection,
} from '../lib/components/charts/painter-pace'
import {
  averagePace,
  clampWindow,
  clipSeries,
  rollingIntervalPace,
} from '../lib/components/charts/progress-pace'
import { combineProgressSamples, mergeObservedProgress } from '../lib/progress-history'
import { paddedRect, templateRect, tilesInRect } from '../lib/render'
import { buildTree, folderTemplateIds } from '../lib/tree'
import { manifest, template } from './fixtures'

const sample = (at: number, correct: number | null) => ({
  at: seconds(at),
  correct,
  mismatched: correct === null ? null : 10 - correct,
  total: 10,
})
const archive = (at: number, correct: number | null) => ({ ...sample(at, correct), snapshotId: at })

describe('observed progress and archive precedence', () => {
  it('keeps incomplete scopes unknown and carries each scope forward only after its first observation', () => {
    expect(combineProgressSamples([[sample(10, 2), sample(30, null)], [sample(20, 3)]])).toEqual([
      sample(10, null),
      { ...sample(20, 5), mismatched: 15, total: 20 },
      { ...sample(30, null), total: 20 },
    ])
  })

  it('native gaps replace archive values and a current observation wins at the same timestamp', () => {
    const merged = mergeObservedProgress(
      [archive(10, 1), archive(20, 2), archive(30, 3)],
      [sample(20, null)],
      sample(30, 4),
    )
    expect(merged.map(({ at, correct, archive: imported }) => [at, correct, imported])).toEqual([
      [10, 1, true],
      [20, null, false],
      [30, 4, false],
    ])
    expect(
      mergeArchiveFrames({ frames: [{ bucketStart: seconds(20), hash: 'native', reporters: 1 }] }, [
        { at: 10, snapshotId: 10, hash: null },
        { at: 20, snapshotId: 20, hash: 'overlap' },
      ]),
    ).toEqual([
      { bucketStart: 10, hash: undefined, missing: true },
      { bucketStart: 20, hash: 'native', reporters: 1 },
    ])
  })

  it('archive totals require matching observations and an established basis for every scope', () => {
    const basis = {
      templateId: template().id,
      versionId: template().version,
      name: 'Artwork',
      season: 1,
      bbox: { minX: 0, minY: 0, maxX: 10, maxY: 1 },
      total: 10,
      chunks: [],
    }
    const histories = [
      { source: 'eralyon' as const, basis, samples: [archive(10, 2)], frames: [] },
      { source: 'eralyon' as const, basis, samples: [archive(20, 3)], frames: [] },
    ]
    const values = combineArchiveSamples(histories)
    expect(values.map(({ correct, total }) => ({ correct, total }))).toEqual([
      { correct: null, total: 20 },
      { correct: null, total: 20 },
    ])
    expect(
      combineArchiveSamples([{ source: 'eralyon', basis: null, samples: [], frames: [] }]),
    ).toEqual([])
  })

  it('retains signed regressions and does not invent activity across missing capture days', () => {
    const captures = [archive(0, 5), archive(86400, 3), archive(3 * 86400, 9)]
    expect(archiveIntervals(captures)[0].rate).toBeCloseTo(-2 / 24)
    expect([...archiveContributionDays(captures, 4 * 86400)]).toEqual([[86400, 0]])
  })
})

describe('pace and chart windows', () => {
  it('averages complete covered buckets, excluding the unfinished current bucket', () => {
    const history = {
      coverageStart: seconds(0),
      resolution: 3600,
      buckets: [
        {
          templateId: template().id,
          resolution: 3600,
          bucketStart: seconds(0),
          placed: 100,
          correct: 80,
          repairs: 0,
        },
        {
          templateId: template().id,
          resolution: 3600,
          bucketStart: seconds(3600),
          placed: 999,
          correct: 999,
          repairs: 0,
        },
      ],
    }
    expect(averagePace(history, 5400, 7200)).toEqual({ placed: 100, correct: 80, hours: 1 })
    expect(completionPace(history, [], [], 5400, 7200)).toEqual({
      placed: 100,
      correct: 80,
      hours: 1,
    })
    expect(averagePace({ buckets: [] }, 5400, 7200)).toBeNull()
  })

  it('splits rolling rates at observation gaps', () => {
    expect(
      rollingIntervalPace(
        [
          { from: 0, to: 3600, pixels: 10 },
          { from: 7200, to: 10800, pixels: 20 },
        ],
        3600,
      ),
    ).toEqual([[{ t: 3600, v: 10 }], [{ t: 10800, v: 20 }]])
  })

  it('constrains keyboard/drag windows and interpolates visible series edges', () => {
    expect(clampWindow({ from: -20, to: 30 }, 0, 100, 10)).toEqual({ from: 0, to: 50 })
    expect(clampWindow({ from: 49, to: 51 }, 0, 100, 20)).toEqual({ from: 40, to: 60 })
    expect(
      clipSeries(
        [
          { t: 0, v: 0 },
          { t: 10, v: 20 },
        ],
        2,
        8,
        (a, b, f) => ({ t: a.t + (b.t - a.t) * f, v: a.v + (b.v - a.v) * f }),
      ),
    ).toEqual([
      { t: 2, v: 4 },
      { t: 8, v: 16 },
    ])
  })

  it('painter selection remains within the server request limit and search keeps identity matches', () => {
    const options = [
      { wplaceUserId: 1, displayName: 'Alice', placed: 30, correct: 20, repairs: 0 },
      { wplaceUserId: 2, displayName: 'Bob', placed: 20, correct: 10, repairs: 0 },
    ]
    expect(selectAllPainters(options, true, 1)).toEqual({ 1: true, 2: false })
    expect(togglePainterSelection({}, new Set([1]), 2, 1)).toEqual({})
    expect(togglePainterSelection({}, new Set([1]), 1, 1)).toEqual({ 1: false })
    expect(rankPainters(options, '2').map((p) => p.wplaceUserId)).toEqual([2])
  })
})

describe('tree and canvas boundaries', () => {
  it('rolls up published descendants while retaining root templates and orphan fallback', () => {
    const tree = buildTree(
      manifest({
        nodes: [
          { id: 'folder', parentId: null, name: 'Folder', path: '/folder', createdAt: millis(0) },
        ],
        templates: [
          template({ id: 'child', nodeId: 'folder' }),
          template({ id: 'draft', nodeId: 'folder', published: false }),
          template({ id: 'orphan', nodeId: 'missing' }),
        ],
      }),
      new Map(),
    )
    expect(tree.progress).toEqual({ completed: 0, mismatched: 0, unpainted: 0, known: 0, total: 8 })
    expect(tree.templateCount).toBe(3)
    expect(tree.templates.map((entry) => entry.template.id)).toEqual(['orphan'])
    expect(folderTemplateIds(tree.folders[0])).toEqual(['child'])
  })

  it('wraps longitude tiles without stretching artwork and clamps padding to the viewport', () => {
    const rect = templateRect(
      template({ bbox: { minX: WORLD_PIXELS - 1, minY: 0, maxX: 1, maxY: 2 } }),
    )
    expect(rect.width).toBe(2)
    expect(tilesInRect(rect).map(({ key }) => key)).toEqual(['2047/0', '0/0'])
    expect(
      paddedRect({ x: 2, y: 2, width: 2, height: 2 }, 2, { x: 0, y: 0, width: 5, height: 5 }),
    ).toEqual({ x: 0, y: 0, width: 5, height: 5 })
  })
})
