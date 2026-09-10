import { millis, seconds } from '@caelestis/shared'
import { Effect } from 'effect'
import { afterEach, expect, it, vi } from 'vitest'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import type { TemplateVersionRecord } from '../ports/sql-store.js'
import { SqlStoreService } from '../runtime/backend-runtime.js'
import { readProgressHistory } from './progress-history.js'

const NOW = 1_750_032_000
const version: TemplateVersionRecord = {
  templateId: 'template',
  versionId: 'version',
  surface: { kind: 'world', allianceId: null },
  season: 1,
  nodeId: null,
  name: 'Art',
  createdWithToken: 'a'.repeat(64),
  createdByUserId: null,
  createdAt: millis((NOW - 100) * 1000),
  totalPixels: 2,
  bbox: { minX: 0, minY: 0, maxX: 1001, maxY: 1 },
  chunks: [0, 1].map((tileX) => ({ tileX, tileY: 0, hash: 'b'.repeat(64) })),
}
afterEach(() => vi.restoreAllMocks())

it('replays exact saved measurements with incomplete coverage, independent of current totals and paint reports', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
  const sql = new MemorySqlStore()
  await sql.insertTemplateVersion(version)
  const observe = async (x: number, at: number, hash: string, correct: number | null) => {
    const tile = { x, y: 0 }
    await sql.recordTileObservation(
      {
        season: 1,
        tile,
        hash,
        observedAt: millis(at * 1000),
        reportedAt: seconds(at),
        reportedWithToken: 'a'.repeat(64),
        reportedByUserId: 1,
      },
      correct === null
        ? []
        : [
            {
              templateId: version.templateId,
              versionId: version.versionId,
              tile,
              correct,
              wrong: 0,
              blank: 1 - correct,
              observedAt: millis(at * 1000),
            },
          ],
    )
  }
  await observe(0, NOW - 90, 'c'.repeat(64), 1)
  await observe(1, NOW - 80, 'd'.repeat(64), 0)
  await observe(1, NOW - 70, 'e'.repeat(64), null)
  await observe(1, NOW - 60, 'f'.repeat(64), 1)
  const read = () =>
    Effect.runPromise(
      readProgressHistory(version, {
        fromSeconds: seconds(NOW - 100),
        toSeconds: seconds(NOW),
      }).pipe(Effect.provideService(SqlStoreService, sql)),
    )
  const before = await read()
  expect(before.samples.map((sample) => [sample.at, sample.correct])).toEqual([
    [NOW - 90, null],
    [NOW - 80, 1],
    [NOW - 70, null],
    [NOW - 60, 2],
  ])
  await observe(0, NOW + 1, '1'.repeat(64), 0)
  expect(await read()).toEqual(before)
  await sql.writeTileMeasurements(version.versionId, { x: 1, y: 0 }, [
    { hash: 'e'.repeat(64), correct: 0, wrong: 1, blank: 0 },
  ])
  expect((await read()).samples[2]).toMatchObject({ at: NOW - 70, correct: 1, mismatched: 1 })
})

it('dates folded observations at the end of their fixed bucket and excludes a bucket still in progress', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
  const sql = new MemorySqlStore()
  await sql.insertTemplateVersion(version)
  const at = NOW - 5 * 86400
  for (const tileX of [0, 1]) {
    const tile = { x: tileX, y: 0 }
    await sql.recordTileObservation(
      {
        season: 1,
        tile,
        hash: 'c'.repeat(64),
        observedAt: millis((at + 1800) * 1000),
        reportedAt: seconds(at + 1800),
        reportedWithToken: 'a'.repeat(64),
        reportedByUserId: 1,
      },
      [
        {
          templateId: version.templateId,
          versionId: version.versionId,
          tile,
          correct: 1,
          wrong: 0,
          blank: 0,
          observedAt: millis((at + 1800) * 1000),
        },
      ],
    )
  }
  const read = (to: number) =>
    Effect.runPromise(
      readProgressHistory(version, {
        fromSeconds: seconds(at),
        toSeconds: seconds(to),
      }).pipe(Effect.provideService(SqlStoreService, sql)),
    )
  expect((await read(at + 2000)).samples).toEqual([])
  expect((await read(at + 3601)).samples).toEqual([
    { at: at + 3600, correct: 2, mismatched: 0, total: 2 },
  ])
})
