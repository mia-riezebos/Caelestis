import { millis, seconds } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ContributionDelta,
  SqlStore,
  TemplateVersionRecord,
  TileObservation,
} from '../ports/index.js'
import { EXPIRES_AFTER_SECONDS, TELEMETRY_DECAY_EDGES } from '../ports/index.js'
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

describe.each(adapters)('$name telemetry read contract', ({ make }) => {
  let harness: Harness
  let store: SqlStore

  beforeEach(() => {
    harness = make()
    store = harness.store
  })

  afterEach(() => harness.close())

  it('keeps a monotonic status projection revision per season', async () => {
    await expect(store.readStatusProjectionRevision(1)).resolves.toBe(0)
    await expect(store.advanceStatusProjectionRevision(1)).resolves.toBe(1)
    await expect(store.advanceStatusProjectionRevision(1)).resolves.toBe(2)
    await expect(store.advanceStatusProjectionRevision(2)).resolves.toBe(1)
    await expect(store.readStatusProjectionRevision(1)).resolves.toBe(2)
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

  it('exempts a frozen template tile ring from tile-history decay', async () => {
    const now = seconds(1_800_000_000)
    const templateId = 'frozen-template'
    await store.insertTemplateVersion(version(templateId))
    await store.updateTemplate(templateId, { timelapseFrozenAt: millis(now * 1_000) }, millis(1))
    const ringTile = { x: 1, y: 0 }
    const old = observation({
      tile: ringTile,
      reportedAt: seconds(now - 90_000),
      hash: 'e'.repeat(64),
    })
    await store.recordTileObservation(old, [])

    await store.foldTileHistory(1, ringTile, now)
    await expect(
      store.readTileHistory({
        season: 1,
        tile: ringTile,
        resolution: 0,
        fromSeconds: seconds(now - 100_000),
        toSeconds: now,
      }),
    ).resolves.toEqual([{ bucketStart: old.reportedAt, hash: old.hash, reporters: 1 }])
  })
})
