import { millis, seconds } from '@caelestis/shared'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ContributionDelta,
  SqlStore,
  TemplateVersionRecord,
  TileObservation,
} from '../ports/index.js'
import {
  EXPIRES_AFTER_SECONDS,
  type PainterTelemetryBucket,
  painterBucketResolution,
  TELEMETRY_DECAY_EDGES,
} from '../ports/index.js'
import { SqlStoreService } from '../runtime/backend-runtime.js'
import { readProgressHistory } from '../telemetry/progress-history.js'
import { readTileHistory } from '../telemetry/queries.js'
import { D1SqlStore } from './cloudflare/d1-sql-store.js'
import { SqliteD1Database } from './cloudflare/sqlite-d1.test-helper.js'
import { MemorySqlStore } from './memory/memory-sql-store.js'

const TOKEN = 'a'.repeat(64)
const DAY = seconds(1_750_032_000) // a UTC midnight
const NEXT_DAY = seconds(1_750_032_000 + 86_400)

const version = (templateId: string, season = 1): TemplateVersionRecord => ({
  templateId,
  surface: { kind: 'world', allianceId: null },
  season,
  nodeId: null,
  name: templateId,
  versionId: `${templateId}-version`,
  createdWithToken: TOKEN,
  createdByUserId: null,
  createdAt: millis(1_000),
  bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  totalPixels: 1,
  chunks: [{ tileX: 0, tileY: 0, hash: 'c'.repeat(64) }],
})

const delta = (overrides: Partial<ContributionDelta>): ContributionDelta => ({
  templateId: 'template-1',
  wplaceUserId: 7,
  day: DAY,
  reportedWithToken: TOKEN,
  reportedByUserId: 1,
  placed: 10,
  correct: 8,
  repairs: 2,
  ...overrides,
})

const observation = (overrides: Partial<TileObservation>): TileObservation => ({
  season: 1,
  tile: { x: 3, y: 4 },
  hash: 'd'.repeat(64),
  observedAt: millis(1_750_032_000_000),
  reportedAt: seconds(1_750_032_000),
  reportedWithToken: TOKEN,
  reportedByUserId: 1,
  ...overrides,
})

type Harness = { store: SqlStore; close(): void }

const adapters: readonly { name: string; make(): Harness }[] = [
  {
    name: 'memory',
    make: () => ({ store: new MemorySqlStore(), close: () => undefined }),
  },
  {
    name: 'D1',
    make: () => {
      const database = new SqliteD1Database()
      return {
        store: new D1SqlStore(database as unknown as D1Database),
        close: () => database.close(),
      }
    },
  },
]

it('reads progress for an accepted 400-chunk template in one D1 query', async () => {
  const database = new SqliteD1Database()
  const store = new D1SqlStore(database as unknown as D1Database)
  try {
    const large = {
      ...version('large'),
      totalPixels: 400,
      bbox: { minX: 0, minY: 0, maxX: 20000, maxY: 20000 },
      chunks: Array.from({ length: 400 }, (_, i) => ({
        tileX: i % 20,
        tileY: Math.floor(i / 20),
        hash: 'c'.repeat(64),
      })),
    }
    await store.insertTemplateVersion(large)
    const tile = { x: 19, y: 19 }
    const saved = observation({ tile })
    await store.recordTileObservation(saved, [
      {
        templateId: large.templateId,
        versionId: large.versionId,
        tile,
        correct: 1,
        wrong: 0,
        blank: 0,
        observedAt: saved.observedAt,
      },
    ])
    const before = database.prepareCalls
    const response = await Effect.runPromise(
      readProgressHistory(large, {
        fromSeconds: seconds(0),
        toSeconds: seconds(DAY + 86401),
      }).pipe(Effect.provideService(SqlStoreService, store)),
    )
    expect(response.samples).toEqual([
      { at: DAY + 86400, correct: null, mismatched: null, total: 400 },
    ])
    expect(database.prepareCalls - before).toBe(1)
  } finally {
    database.close()
  }
})

describe.each(adapters)('$name telemetry read contract', ({ make }) => {
  let harness: Harness
  let store: SqlStore

  beforeEach(() => {
    harness = make()
    store = harness.store
  })

  afterEach(() => harness.close())

  it('finds the first native bucket across retained tiers without including other seasons or tiles', async () => {
    await store.insertTemplateVersion(version('template-1'))
    const id = 'template-1-version'
    expect(await store.readFirstTemplateObservation(id)).toBeNull()
    await store.recordTileObservation(observation({ reportedAt: seconds(DAY - 100) }), [])
    await store.recordTileObservation(
      observation({ season: 0, tile: { x: 0, y: 0 }, reportedAt: seconds(DAY - 50) }),
      [],
    )
    expect(await store.readFirstTemplateObservation(id)).toBeNull()
    const tile = { x: 0, y: 0 }
    await store.recordTileObservation(observation({ tile, reportedAt: seconds(DAY + 10) }), [])
    await store.recordTileObservation(observation({ tile, reportedAt: seconds(DAY + 20) }), [])
    expect(await store.readFirstTemplateObservation(id)).toBe(DAY + 10)
    await store.foldTileHistory(1, tile, seconds(DAY + 2 * 86400))
    expect(await store.readFirstTemplateObservation(id)).toBe(DAY)
    expect(await store.readFirstTemplateObservation('missing')).toBeNull()
  })

  it.each([0, 3600, 86400])(
    'batched progress preserves tile-history quorum and latest-frame selection at resolution %s',
    async (resolution) => {
      await store.insertTemplateVersion(version('template-1'))
      const tile = { x: 0, y: 0 }
      for (const [at, hash, reporter] of [
        [DAY + 10, 'd'.repeat(64), 1],
        [DAY + 10, 'd'.repeat(64), 2],
        [DAY + 10, 'e'.repeat(64), 3],
        [DAY + 20, 'e'.repeat(64), 1],
      ] as const) {
        await store.recordTileObservation(
          observation({ tile, hash, reportedAt: seconds(at), reportedByUserId: reporter }),
          [
            {
              templateId: 'template-1',
              versionId: 'template-1-version',
              tile,
              correct: hash.startsWith('d') ? 1 : 0,
              wrong: 0,
              blank: hash.startsWith('d') ? 0 : 1,
              observedAt: millis(at * 1000),
            },
          ],
        )
      }
      const frames = await store.readTemplateProgressFrames(
        'template-1-version',
        DAY,
        seconds(DAY + 86401),
        resolution,
      )
      if (resolution === 0) {
        const history = await Effect.runPromise(
          readTileHistory({
            season: 1,
            tile,
            legacyResolution: 0,
            range: { fromSeconds: DAY, toSeconds: seconds(DAY + 86401) },
          }).pipe(Effect.provideService(SqlStoreService, store)),
        )
        expect(frames.map(({ bucketStart, hash }) => ({ bucketStart, hash }))).toEqual(
          history.frames.map(({ bucketStart, hash }) => ({ bucketStart, hash })),
        )
        expect(frames.map((frame) => frame.correct)).toEqual([1, 0])
      } else {
        expect(frames).toEqual([
          { tileX: 0, tileY: 0, bucketStart: DAY, hash: 'e'.repeat(64), correct: 0, wrong: 0 },
        ])
      }
    },
  )

  it('reclaims measurements only after folding and blob GC remove their last source reference', async () => {
    await store.insertTemplateVersion(version('template-1'))
    const tile = { x: 0, y: 0 }
    const older = observation({ tile, hash: 'd'.repeat(64) })
    const newer = {
      ...older,
      hash: 'e'.repeat(64),
      reportedAt: seconds(DAY + 1),
      observedAt: millis(older.observedAt + 1000),
    }
    const status = {
      templateId: 'template-1',
      versionId: 'template-1-version',
      tile,
      correct: 1,
      wrong: 0,
      blank: 0,
      observedAt: older.observedAt,
    }
    await store.recordTileObservation(older, [status])
    await store.recordTileObservation(newer, [{ ...status, observedAt: newer.observedAt }])
    await store.foldTileHistory(1, tile, seconds(DAY + 2 * 86400))
    const now = millis((DAY + 2 * 86400) * 1000)
    expect(await store.noteTileBlobObject(older.hash, older.hash, now)).toBe('candidate')
    expect(await store.claimTileBlobDeletion(older.hash, now)).toBe('claimed')
    await store.finishTileBlobDeletion(older.hash, now)
    expect(await store.readTileMeasurements(status.versionId, tile, [older.hash])).toEqual([])
    expect(await store.noteTileBlobObject(newer.hash, newer.hash, now)).toBe('referenced')
    await store.finishTileBlobDeletion(newer.hash, now)
    expect(await store.readTileMeasurements(status.versionId, tile, [newer.hash])).toHaveLength(1)
  })

  it('keeps historical pixel counts tied to their tile hash when live progress changes', async () => {
    await store.insertTemplateVersion(version('template-1'))
    const tile = { x: 0, y: 0 }
    const first = observation({ tile, hash: 'd'.repeat(64) })
    const status = {
      templateId: 'template-1',
      versionId: 'template-1-version',
      tile,
      correct: 0,
      wrong: 0,
      blank: 1,
      observedAt: first.observedAt,
    }
    await store.recordTileObservation(first, [status])
    await store.recordTileObservation(
      {
        ...first,
        hash: 'e'.repeat(64),
        observedAt: millis(first.observedAt + 1000),
        reportedAt: seconds(first.reportedAt + 1),
      },
      [{ ...status, correct: 1, blank: 0, observedAt: millis(first.observedAt + 1000) }],
    )
    expect(await store.readTileMeasurements(status.versionId, tile, [first.hash])).toEqual([
      { hash: first.hash, correct: 0, wrong: 0, blank: 1 },
    ])
    expect(await store.readTileMeasurements('other-version', tile, [first.hash])).toEqual([])
  })

  it('atomically records classifications for a reserved upload, including an older observation', async () => {
    await store.insertTemplateVersion(version('template-1'))
    const tile = { x: 0, y: 0 }
    const first = observation({ tile, hash: 'd'.repeat(64) })
    const now = first.observedAt
    await store.setTemplatePublishedAt('template-1', now, now)
    const status = {
      templateId: 'template-1',
      versionId: 'template-1-version',
      tile,
      correct: 1,
      wrong: 0,
      blank: 0,
      observedAt: now,
    }
    await store.reserveTileBlobUpload(first.hash, first.hash, 'first', now, millis(now + 10000))
    expect(
      await store.commitTileBlobReservation('first', now, first, [status], true),
    ).not.toBeNull()
    const older = { ...first, hash: 'e'.repeat(64), observedAt: millis(now - 1000) }
    await store.reserveTileBlobUpload(older.hash, older.hash, 'older', now, millis(now + 10000))
    expect(
      await store.commitTileBlobReservation(
        'older',
        now,
        older,
        [{ ...status, correct: 0, blank: 1, observedAt: older.observedAt }],
        true,
      ),
    ).not.toBeNull()
    expect(
      await store.readTileMeasurements(status.versionId, tile, [first.hash, older.hash]),
    ).toEqual(
      expect.arrayContaining([
        { hash: first.hash, correct: 1, wrong: 0, blank: 0 },
        { hash: older.hash, correct: 0, wrong: 0, blank: 1 },
      ]),
    )
    const refused = { ...first, hash: 'f'.repeat(64) }
    expect(
      await store.commitTileBlobReservation('missing', now, refused, [status], true),
    ).toBeNull()
    expect(await store.readTileMeasurements(status.versionId, tile, [refused.hash])).toEqual([])
  })

  it('keeps a finished template frozen until it is reopened', async () => {
    await store.insertTemplateVersion(version('template-1'))
    await expect(
      store.updateTemplate(
        'template-1',
        { finishedAt: millis(2_000), timelapseFrozenAt: millis(2_000) },
        millis(2_000),
      ),
    ).resolves.toBe(true)

    await expect(
      store.updateTemplate('template-1', { timelapseFrozenAt: null }, millis(3_000)),
    ).resolves.toBe(false)
    await expect(store.readTemplate('template-1')).resolves.toMatchObject({
      finished: true,
      timelapseFrozen: true,
    })

    await expect(
      store.updateTemplate(
        'template-1',
        { finishedAt: null, timelapseFrozenAt: null },
        millis(4_000),
      ),
    ).resolves.toBe(true)
  })

  it('reduces contributions to the maximum per reporter before anything can sum them', async () => {
    await store.insertTemplateVersion(version('template-1'))
    await store.rememberPainter(7, 'Mia', millis(1_000))
    // Two reporters describing the same painter-day: partial views, not additive work.
    await store.addContributions([
      delta({ reportedByUserId: 1, placed: 10, correct: 8, repairs: 2 }),
      delta({ reportedByUserId: 2, placed: 6, correct: 6, repairs: 3 }),
    ])

    await expect(
      store.readContributions({ templateIds: ['template-1'], includeUnpublished: true }),
    ).resolves.toEqual([
      {
        templateId: 'template-1',
        day: DAY,
        wplaceUserId: 7,
        displayName: 'Mia',
        // The maximum of each counter independently — not 16/14/5, and not either row verbatim.
        placed: 10,
        correct: 8,
        repairs: 3,
      },
    ])
  })

  it('resolves a season to its templates, bounds the day range and labels unknown painters', async () => {
    await store.insertTemplateVersion(version('template-1', 1))
    await store.insertTemplateVersion(version('template-2', 2))
    await store.addContributions([
      delta({ templateId: 'template-1', day: DAY }),
      delta({ templateId: 'template-1', day: NEXT_DAY, placed: 4, correct: 4, repairs: 0 }),
      delta({ templateId: 'template-2', day: DAY }),
    ])

    const rows = await store.readContributions({
      season: 1,
      fromSeconds: DAY,
      toSeconds: NEXT_DAY,
      includeUnpublished: true,
    })
    expect(rows).toEqual([
      {
        templateId: 'template-1',
        day: DAY,
        wplaceUserId: 7,
        // No painters row: the id as a string, so the label is never empty.
        displayName: '7',
        placed: 10,
        correct: 8,
        repairs: 2,
      },
    ])
  })

  it('refuses a contribution query naming neither a season nor any templates', async () => {
    await expect(store.readContributions({ includeUnpublished: true })).rejects.toThrow(
      'readContributions requires a season or template ids',
    )
  })

  it('gates unpublished templates out of contributions and the published-id filter alike', async () => {
    await store.insertTemplateVersion(version('published-1'))
    await store.insertTemplateVersion(version('unpublished-1'))
    await store.setTemplatePublishedAt('published-1', millis(2_000), millis(2_000))
    await store.addContributions([
      delta({ templateId: 'published-1' }),
      delta({ templateId: 'unpublished-1' }),
    ])

    // Explicit ids and the season form filter identically: knowing an unpublished id is not a way
    // around the manifest's admin gate.
    const byIds = await store.readContributions({
      templateIds: ['published-1', 'unpublished-1'],
      includeUnpublished: false,
    })
    expect(byIds.map((row) => row.templateId)).toEqual(['published-1'])
    const bySeason = await store.readContributions({ season: 1, includeUnpublished: false })
    expect(bySeason.map((row) => row.templateId)).toEqual(['published-1'])
    const asAdmin = await store.readContributions({ season: 1, includeUnpublished: true })
    expect(asAdmin.map((row) => row.templateId)).toEqual(['published-1', 'unpublished-1'])

    // Order-preserving, duplicate-dropping, and silent about ids that name nothing.
    await expect(
      store.filterPublishedTemplateIds([
        'unpublished-1',
        'published-1',
        'published-1',
        'missing-1',
      ]),
    ).resolves.toEqual(['published-1'])
  })

  it('lists the latest observation per tile for one season, ordered by x then y', async () => {
    await store.recordTileObservation(observation({ tile: { x: 5, y: 1 } }), [])
    await store.recordTileObservation(observation({ tile: { x: 3, y: 4 } }), [])
    await store.recordTileObservation(observation({ season: 2, tile: { x: 0, y: 0 } }), [])
    // A newer observation of an already-listed tile replaces it rather than appearing beside it.
    await store.recordTileObservation(
      observation({
        tile: { x: 3, y: 4 },
        hash: 'e'.repeat(64),
        observedAt: millis(1_750_032_060_000),
      }),
      [],
    )

    await expect(store.listLatestTiles(1)).resolves.toEqual([
      {
        season: 1,
        tile: { x: 3, y: 4 },
        hash: 'e'.repeat(64),
        observedAt: millis(1_750_032_060_000),
      },
      {
        season: 1,
        tile: { x: 5, y: 1 },
        hash: 'd'.repeat(64),
        observedAt: millis(1_750_032_000_000),
      },
    ])
  })

  it('updates the latest tile and status without appending history when asked', async () => {
    const tile = { x: 3, y: 4 }
    const latest = observation({ tile, hash: 'e'.repeat(64) })

    await store.recordTileObservation(latest, [], false)

    await expect(store.readLatestTile(1, tile)).resolves.toMatchObject({ hash: latest.hash })
    await expect(
      store.readTileHistory({
        season: 1,
        tile,
        resolution: 0,
        fromSeconds: seconds(1_750_031_000),
        toSeconds: seconds(1_750_033_000),
      }),
    ).resolves.toEqual([])
  })

  it('lets an authoritative server fetch replace a future-dated client observation', async () => {
    const tile = { x: 0, y: 0 }
    await store.insertTemplateVersion(version('template-1'))
    await store.recordTileObservation(
      observation({ tile, hash: 'f'.repeat(64), observedAt: millis(2_000) }),
      [
        {
          templateId: 'template-1',
          versionId: 'template-1-version',
          tile,
          correct: 0,
          wrong: 1,
          blank: 0,
          observedAt: millis(2_000),
        },
      ],
    )

    await expect(store.listAlarmTiles(1)).resolves.toEqual([
      expect.objectContaining({ templateId: 'template-1', observedAt: null }),
    ])
    await expect(store.readTemplateStatuses(1, true, { serverOwnedOnly: true })).resolves.toEqual(
      [],
    )

    await store.recordTileObservation(
      observation({ tile, hash: 'e'.repeat(64), observedAt: millis(1_000) }),
      [
        {
          templateId: 'template-1',
          versionId: 'template-1-version',
          tile,
          correct: 1,
          wrong: 0,
          blank: 0,
          observedAt: millis(1_000),
        },
      ],
      false,
      true,
    )

    // A slower, older backend request must not roll the authoritative result backward.
    await store.recordTileObservation(
      observation({ tile, hash: 'a'.repeat(64), observedAt: millis(500) }),
      [
        {
          templateId: 'template-1',
          versionId: 'template-1-version',
          tile,
          correct: 0,
          wrong: 1,
          blank: 0,
          observedAt: millis(500),
        },
      ],
      false,
      true,
    )

    await expect(store.readLatestTile(1, tile)).resolves.toMatchObject({
      hash: 'e'.repeat(64),
      observedAt: 1_000,
    })
    await expect(store.readTemplateStatuses(1, true)).resolves.toEqual([
      expect.objectContaining({ templateId: 'template-1', correct: 1, wrong: 0 }),
    ])
    await expect(store.readTemplateStatuses(1, true, { serverOwnedOnly: true })).resolves.toEqual([
      expect.objectContaining({ templateId: 'template-1', correct: 1, wrong: 0 }),
    ])

    await store.recordTileObservation(
      observation({ tile, hash: 'b'.repeat(64), observedAt: millis(3_000) }),
      [
        {
          templateId: 'template-1',
          versionId: 'template-1-version',
          tile,
          correct: 0,
          wrong: 1,
          blank: 0,
          observedAt: millis(3_000),
        },
      ],
    )
    await expect(store.listAlarmTiles(1)).resolves.toEqual([
      expect.objectContaining({ templateId: 'template-1', observedAt: 1_000 }),
    ])
    await expect(store.readTemplateStatuses(1, true, { serverOwnedOnly: true })).resolves.toEqual([
      expect.objectContaining({ templateId: 'template-1', correct: 1, wrong: 0 }),
    ])
  })

  it('keeps the hash with the most distinct reporters per bucket, ties to the smaller hash', async () => {
    const tile = { x: 3, y: 4 }
    // Bucket one: two reporters agree on one hash, a third dissents — quorum wins.
    await store.recordTileObservation(observation({ tile, hash: 'f'.repeat(64) }), [])
    await store.recordTileObservation(
      observation({ tile, hash: 'f'.repeat(64), reportedByUserId: 2 }),
      [],
    )
    await store.recordTileObservation(
      observation({ tile, hash: '1'.repeat(64), reportedByUserId: 3 }),
      [],
    )
    // The same account repeating itself is one reporter, not two.
    await store.recordTileObservation(observation({ tile, hash: 'f'.repeat(64) }), [])
    // Bucket two: an even split goes to the lexically smaller hash.
    const later = seconds(1_750_032_060)
    await store.recordTileObservation(
      observation({ tile, hash: 'b'.repeat(64), reportedAt: later }),
      [],
    )
    await store.recordTileObservation(
      observation({ tile, hash: 'a'.repeat(64), reportedAt: later, reportedByUserId: 2 }),
      [],
    )

    await expect(
      store.readTileHistory({
        season: 1,
        tile,
        resolution: 0,
        fromSeconds: seconds(1_750_032_000),
        toSeconds: seconds(1_750_032_120),
      }),
    ).resolves.toEqual([
      { bucketStart: seconds(1_750_032_000), hash: 'f'.repeat(64), reporters: 2 },
      { bucketStart: seconds(1_750_032_060), hash: 'a'.repeat(64), reporters: 1 },
    ])
  })

  it('refuses a tile-history query off the resolution ladder or off the canvas', async () => {
    const range = { fromSeconds: seconds(0), toSeconds: seconds(1) }
    await expect(
      store.readTileHistory({ season: 1, tile: { x: 0, y: 0 }, resolution: 61, ...range }),
    ).rejects.toThrow('not a ladder tier')
    await expect(
      store.readTileHistory({ season: 1, tile: { x: -1, y: 0 }, resolution: 0, ...range }),
    ).rejects.toThrow('outside the canvas')
  })

  it('folds complete telemetry windows by sum at the retention boundary', async () => {
    const now = seconds(1_800_000_000)
    const cutoff = now - 6 * 3_600
    const targetStart = cutoff - 300
    await store.appendBuckets([
      {
        templateId: 'template-1',
        resolution: 60,
        bucketStart: seconds(targetStart),
        placed: 4,
        correct: 3,
        repairs: 1,
      },
      {
        templateId: 'template-1',
        resolution: 60,
        bucketStart: seconds(targetStart + 60),
        placed: 6,
        correct: 5,
        repairs: 2,
      },
      {
        templateId: 'template-1',
        resolution: 60,
        bucketStart: seconds(cutoff),
        placed: 1,
        correct: 1,
        repairs: 0,
      },
    ])

    await store.foldTelemetryBuckets(['template-1'], now)
    await store.foldTelemetryBuckets(['template-1'], now)

    await expect(
      store.readBuckets({
        templateIds: ['template-1'],
        resolution: 300,
        fromSeconds: seconds(targetStart),
        toSeconds: seconds(cutoff),
      }),
    ).resolves.toEqual([
      {
        templateId: 'template-1',
        resolution: 300,
        bucketStart: seconds(targetStart),
        placed: 10,
        correct: 8,
        repairs: 3,
      },
    ])
    await expect(
      store.readBuckets({
        templateIds: ['template-1'],
        resolution: 60,
        fromSeconds: seconds(targetStart),
        toSeconds: seconds(cutoff + 60),
      }),
    ).resolves.toEqual([expect.objectContaining({ bucketStart: seconds(cutoff), placed: 1 })])
  })

  it('keeps the first telemetry fold beyond the retained counter hot edge', () => {
    expect(TELEMETRY_DECAY_EDGES[0]?.retainSeconds).toBeGreaterThan(EXPIRES_AFTER_SECONDS)
  })

  it('does not cascade a partially drained telemetry window', async () => {
    const now = seconds(1_800_000_000)
    const targetStart = Math.floor((now - 2 * 86_400) / 900) * 900
    await store.appendBuckets(
      Array.from({ length: 21 }, (_, index) => ({
        templateId: 'template-1',
        resolution: 60,
        bucketStart: seconds(targetStart + index * 300),
        placed: 1,
        correct: 1,
        repairs: 0,
      })),
    )

    await store.foldTelemetryBuckets(['template-1'], now)

    await expect(
      store.readBuckets({
        templateIds: ['template-1'],
        resolution: 300,
        fromSeconds: seconds(targetStart + 18 * 300),
        toSeconds: seconds(targetStart + 21 * 300),
      }),
    ).resolves.toHaveLength(2)
    await expect(
      store.readBuckets({
        templateIds: ['template-1'],
        resolution: 900,
        fromSeconds: seconds(targetStart + 18 * 300),
        toSeconds: seconds(targetStart + 21 * 300),
      }),
    ).resolves.toEqual([])
  })

  it('folds tile state by latest bucket and carries the winning reporter rows', async () => {
    const now = seconds(1_800_000_000)
    const targetStart = now - 86_400 - 3_600
    const tile = { x: 3, y: 4 }
    const at = (offset: number) => seconds(targetStart + offset)
    await store.recordTileObservation(
      observation({ tile, reportedAt: at(60), hash: 'f'.repeat(64), reportedByUserId: 1 }),
      [],
    )
    await store.recordTileObservation(
      observation({ tile, reportedAt: at(60), hash: 'f'.repeat(64), reportedByUserId: 2 }),
      [],
    )
    await store.recordTileObservation(
      observation({ tile, reportedAt: at(60), hash: '1'.repeat(64), reportedByUserId: 3 }),
      [],
    )
    await store.recordTileObservation(
      observation({ tile, reportedAt: at(120), hash: 'c'.repeat(64), reportedByUserId: 4 }),
      [],
    )
    await store.recordTileObservation(
      observation({ tile, reportedAt: at(120), hash: 'c'.repeat(64), reportedByUserId: 5 }),
      [],
    )
    await store.recordTileObservation(
      observation({ tile, reportedAt: at(120), hash: 'b'.repeat(64), reportedByUserId: 6 }),
      [],
    )

    await store.foldTileHistory(1, tile, now)

    await expect(
      store.readTileHistory({
        season: 1,
        tile,
        resolution: 3_600,
        fromSeconds: seconds(targetStart),
        toSeconds: seconds(targetStart + 3_600),
      }),
    ).resolves.toEqual([{ bucketStart: seconds(targetStart), hash: 'c'.repeat(64), reporters: 2 }])
  })

  it('exempts a frozen template capture plan from tile-history decay', async () => {
    const now = seconds(1_800_000_000)
    const templateId = 'frozen-template'
    await store.insertTemplateVersion({
      ...version(templateId),
      bbox: { minX: 0, minY: 0, maxX: 1_000, maxY: 10_000 },
    })
    await store.updateTemplate(templateId, { timelapseFrozenAt: millis(now * 1_000) }, millis(1))
    const contextTile = { x: 3, y: 0 }
    const old = observation({
      tile: contextTile,
      reportedAt: seconds(now - 90_000),
      hash: 'e'.repeat(64),
    })
    await store.recordTileObservation(old, [])

    await store.foldTileHistory(1, contextTile, now)
    await expect(
      store.readTileHistory({
        season: 1,
        tile: contextTile,
        resolution: 0,
        fromSeconds: seconds(now - 100_000),
        toSeconds: now,
      }),
    ).resolves.toEqual([{ bucketStart: old.reportedAt, hash: old.hash, reporters: 1 }])
  })

  it('does not let a frozen alliance template preserve world tile history', async () => {
    const now = seconds(1_800_000_000)
    const templateId = 'frozen-alliance-template'
    await store.insertTemplateVersion({
      ...version(templateId),
      surface: { kind: 'alliance-banner', allianceId: 535_245 },
    })
    await store.updateTemplate(templateId, { timelapseFrozenAt: millis(now * 1_000) }, millis(1))
    const old = observation({
      tile: { x: 0, y: 0 },
      reportedAt: seconds(now - 90_000),
      hash: 'e'.repeat(64),
    })
    await store.recordTileObservation(old, [])

    await store.foldTileHistory(1, old.tile, now)

    await expect(
      store.readTileHistory({
        season: 1,
        tile: old.tile,
        resolution: 0,
        fromSeconds: seconds(now - 100_000),
        toSeconds: now,
      }),
    ).resolves.toEqual([])
  })
})

describe('painter bucket tier', () => {
  it('lands a paint at the tier its window has already reached', () => {
    const now = seconds(1_800_000_000)
    expect(painterBucketResolution(now, now)).toBe(60)
    // Inside the 6h retention of the first edge: still a minute bucket.
    expect(painterBucketResolution(seconds(now - 5 * 3_600), now)).toBe(60)
    // A 300s window that ended more than 6h ago has been folded up one tier.
    expect(painterBucketResolution(seconds(now - 7 * 3_600), now)).toBe(300)
    // The window containing the paint is what counts, not the paint itself.
    const edge = now - 6 * 3_600
    const windowStart = Math.floor(edge / 300) * 300
    expect(painterBucketResolution(seconds(windowStart), now)).toBe(
      windowStart + 300 <= edge ? 300 : 60,
    )
    expect(painterBucketResolution(seconds(now - 2 * 86_400), now)).toBe(900)
    expect(painterBucketResolution(seconds(now - 8 * 86_400), now)).toBe(3_600)
    expect(painterBucketResolution(seconds(now - 40 * 86_400), now)).toBe(21_600)
  })
})

describe.each(adapters)('$name painter bucket contract', ({ make }) => {
  let harness: Harness
  let store: SqlStore

  beforeEach(() => {
    harness = make()
    store = harness.store
  })

  afterEach(() => harness.close())

  const bucket = (overrides: Partial<PainterTelemetryBucket>): PainterTelemetryBucket => ({
    templateId: 'template-1',
    wplaceUserId: 7,
    resolution: 60,
    bucketStart: seconds(1_800_000_000),
    placed: 3,
    correct: 2,
    repairs: 1,
    ...overrides,
  })

  const apply = (eventId: string, buckets: readonly PainterTelemetryBucket[]) =>
    store.applyPaintEvent(eventId, 7, 'Ada', millis(1_800_000_000_000), {
      counters: [],
      contributions: [],
      painterBuckets: buckets,
    })

  it('adds painter buckets per event, once per event id', async () => {
    await store.insertTemplateVersion(version('template-1'))
    await apply('event-1', [bucket({})])
    await apply('event-2', [bucket({ placed: 5, correct: 4, repairs: 0 })])
    await apply('event-2', [bucket({ placed: 5, correct: 4, repairs: 0 })])
    await apply('event-3', [bucket({ wplaceUserId: 9 })])

    await expect(
      store.readPainterBuckets({
        templateIds: ['template-1'],
        wplaceUserIds: [7, 9],
        resolution: 60,
        fromSeconds: seconds(1_800_000_000),
        toSeconds: seconds(1_800_000_060),
      }),
    ).resolves.toEqual([bucket({ placed: 8, correct: 6, repairs: 1 }), bucket({ wplaceUserId: 9 })])
    await expect(store.readPainterNames([7, 9, 11])).resolves.toEqual(new Map([[7, 'Ada']]))
    // A read for one painter never carries the other; a read for none costs nothing.
    await expect(
      store.readPainterBuckets({
        templateIds: ['template-1'],
        wplaceUserIds: [9],
        resolution: 60,
        fromSeconds: seconds(1_800_000_000),
        toSeconds: seconds(1_800_000_060),
      }),
    ).resolves.toEqual([bucket({ wplaceUserId: 9 })])
    await expect(
      store.readPainterBuckets({
        templateIds: ['template-1'],
        wplaceUserIds: Array.from({ length: 51 }, (_, index) => index),
        resolution: 60,
        fromSeconds: seconds(1_800_000_000),
        toSeconds: seconds(1_800_000_060),
      }),
    ).rejects.toThrow(/at most 50 painters/)
    // Totals sum in the store and come back leading first, cut at the limit.
    await expect(
      store.readPainterTotals(
        {
          templateIds: ['template-1'],
          resolution: [60, 300],
          fromSeconds: seconds(1_800_000_000),
          toSeconds: seconds(1_800_000_060),
        },
        1,
      ),
    ).resolves.toEqual([{ wplaceUserId: 7, placed: 8, correct: 6, repairs: 1 }])
  })

  it('reports when painter collection began', async () => {
    // The memory store has always collected; D1 learns the moment from the migration's row.
    const start = await store.readPainterCollectionStart()
    expect(start === null || Number.isSafeInteger(start)).toBe(true)
  })

  it('rejects a painter bucket off the ladder before it reaches the database', async () => {
    await expect(
      apply('event-1', [bucket({ resolution: 61, bucketStart: seconds(61) })]),
    ).rejects.toThrow(/ladder tier/)
    await expect(apply('event-2', [bucket({ wplaceUserId: -1 })])).rejects.toThrow(/wplaceUserId/)
  })

  it('folds each painter separately and adds into a target a late report already reached', async () => {
    await store.insertTemplateVersion(version('template-1'))
    const now = seconds(1_800_000_000)
    const cutoff = now - 6 * 3_600
    const targetStart = seconds(cutoff - 300)
    await apply('event-1', [
      bucket({ bucketStart: targetStart, placed: 4, correct: 3, repairs: 1 }),
      bucket({ bucketStart: seconds(targetStart + 60), placed: 6, correct: 5, repairs: 2 }),
      bucket({
        wplaceUserId: 9,
        bucketStart: seconds(targetStart + 120),
        placed: 1,
        correct: 1,
        repairs: 0,
      }),
      bucket({ bucketStart: seconds(cutoff), placed: 1, correct: 1, repairs: 0 }),
    ])
    // A late report written straight at the 300s tier, as `painterBucketResolution` would place it.
    await apply('event-2', [
      bucket({ resolution: 300, bucketStart: targetStart, placed: 10, correct: 10, repairs: 0 }),
    ])

    await store.foldPainterBuckets(['template-1'], now)
    await store.foldPainterBuckets(['template-1'], now)

    await expect(
      store.readPainterBuckets({
        templateIds: ['template-1'],
        wplaceUserIds: [7, 9],
        resolution: 300,
        fromSeconds: targetStart,
        toSeconds: seconds(cutoff),
      }),
    ).resolves.toEqual([
      bucket({ resolution: 300, bucketStart: targetStart, placed: 20, correct: 18, repairs: 3 }),
      bucket({
        wplaceUserId: 9,
        resolution: 300,
        bucketStart: targetStart,
        placed: 1,
        correct: 1,
        repairs: 0,
      }),
    ])
    await expect(
      store.readPainterBuckets({
        templateIds: ['template-1'],
        wplaceUserIds: [7, 9],
        resolution: 60,
        fromSeconds: targetStart,
        toSeconds: seconds(cutoff + 60),
      }),
    ).resolves.toEqual([
      bucket({ bucketStart: seconds(cutoff), placed: 1, correct: 1, repairs: 0 }),
    ])
  })
})
