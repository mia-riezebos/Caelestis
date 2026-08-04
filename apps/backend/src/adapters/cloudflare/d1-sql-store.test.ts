import { seconds } from '@wts/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TelemetryBucket } from '../../ports/index.js'
import { D1SqlStore } from './d1-sql-store.js'
import { SqliteD1Database } from './sqlite-d1.test-helper.js'

const bucket = (overrides: Partial<TelemetryBucket> = {}): TelemetryBucket => ({
  templateId: 'template-1',
  resolution: 60,
  bucketStart: seconds(1_750_000_000),
  placed: 10,
  correct: 8,
  repairs: 2,
  ...overrides,
})

describe('D1SqlStore', () => {
  let d1: SqliteD1Database
  let store: D1SqlStore

  beforeEach(() => {
    d1 = new SqliteD1Database()
    store = new D1SqlStore(d1 as unknown as D1Database)
  })

  afterEach(() => d1.close())

  it('issues no D1 calls for empty input', async () => {
    await store.appendBuckets([])
    expect({ prepares: d1.prepareCalls, batches: d1.batchCalls }).toEqual({
      prepares: 0,
      batches: 0,
    })
  })

  it('issues no D1 calls when reading an empty template-id set', async () => {
    const callsBeforeRead = d1.prepareCalls

    await expect(
      store.readBuckets({
        templateIds: [],
        resolution: 60,
        fromSeconds: seconds(1_750_000_000),
        toSeconds: seconds(1_750_000_120),
      }),
    ).resolves.toEqual([])
    expect(d1.prepareCalls).toBe(callsBeforeRead)
  })

  it('replaces an identical retry instead of double-counting', async () => {
    await store.appendBuckets([bucket()])
    await store.appendBuckets([bucket()])

    expect(
      d1.sqlite.prepare('SELECT placed, correct, repairs FROM telemetry_buckets').get(),
    ).toEqual({
      placed: 10,
      correct: 8,
      repairs: 2,
    })
  })

  it('rewrites cumulative values in place', async () => {
    await store.appendBuckets([bucket()])
    await store.appendBuckets([bucket({ placed: 15, correct: 12, repairs: 4 })])

    expect(
      d1.sqlite.prepare('SELECT placed, correct, repairs FROM telemetry_buckets').get(),
    ).toEqual({
      placed: 15,
      correct: 12,
      repairs: 4,
    })
  })

  it('keeps distinct resolutions in separate rows', async () => {
    await store.appendBuckets([bucket(), bucket({ resolution: 300, placed: 20 })])

    expect(
      d1.sqlite
        .prepare('SELECT resolution, placed FROM telemetry_buckets ORDER BY resolution')
        .all(),
    ).toEqual([
      { resolution: 60, placed: 10 },
      { resolution: 300, placed: 20 },
    ])
  })

  it('writes a multi-row append with one batch call', async () => {
    await store.appendBuckets([
      bucket(),
      bucket({ templateId: 'template-2', bucketStart: seconds(1_750_000_060) }),
    ])

    expect(d1.batchCalls).toBe(1)
    expect(d1.sqlite.prepare('SELECT COUNT(*) AS count FROM telemetry_buckets').get()).toEqual({
      count: 2,
    })
  })

  it('reads requested ids at one resolution over a half-open range in stable order', async () => {
    const fromSeconds = seconds(1_750_000_000)
    const middleSeconds = seconds(1_750_000_060)
    const toSeconds = seconds(1_750_000_120)
    const template1Start = bucket({ templateId: 'template-1', bucketStart: fromSeconds })
    const template1Middle = bucket({
      templateId: 'template-1',
      bucketStart: middleSeconds,
      placed: 11,
    })
    const template2Start = bucket({
      templateId: 'template-2',
      bucketStart: fromSeconds,
      placed: 12,
    })

    await store.appendBuckets([
      template2Start,
      bucket({ templateId: 'template-3', bucketStart: fromSeconds }),
      bucket({ templateId: 'template-1', resolution: 300, bucketStart: fromSeconds }),
      bucket({ templateId: 'template-1', bucketStart: toSeconds }),
      template1Middle,
      template1Start,
    ])

    await expect(
      store.readBuckets({
        templateIds: ['template-2', 'template-1'],
        resolution: 60,
        fromSeconds,
        toSeconds,
      }),
    ).resolves.toEqual([template1Start, template1Middle, template2Start])
  })

  it('issues one statement per parameter chunk when reading a large template set', async () => {
    // D1 allows 100 bound parameters per query. The fake is node:sqlite, whose limit is 32_766, so
    // an unchunked read passes here and fails only in production — the statement count is the one
    // observable that distinguishes them.
    const templateIds = Array.from({ length: 271 }, (_, index) => `template-${index}`)
    const callsBeforeRead = d1.prepareCalls

    await store.readBuckets({
      templateIds,
      resolution: 60,
      fromSeconds: seconds(0),
      toSeconds: seconds(100),
    })

    expect(d1.prepareCalls - callsBeforeRead).toBe(4)
  })

  it('returns one ordering across chunk boundaries', async () => {
    // Each chunk is ordered on its own, but ids are spread across chunks in input order, so a bare
    // concatenation is unsorted. Reading these two in reverse order puts them in different chunks.
    const templateIds = Array.from({ length: 91 }, (_, index) => `template-${index}`).reverse()
    const early = bucket({ templateId: 'template-0', bucketStart: seconds(10) })
    const late = bucket({ templateId: 'template-90', bucketStart: seconds(10) })
    await store.appendBuckets([late, early])

    await expect(
      store.readBuckets({
        templateIds,
        resolution: 60,
        fromSeconds: seconds(0),
        toSeconds: seconds(100),
      }),
    ).resolves.toEqual([early, late])
  })

  // A bare .toThrow() accepts "no such table" as readily as a constraint failure, so these match the
  // message. The accept cases matter more: a CHECK that rejects a valid scope or ladder tier would
  // otherwise ship green, and nothing would notice until production.
  it.each([
    ["INSERT INTO access_tokens VALUES ('h', 'l', 'superadmin', 'c', 1, NULL)"],
    ["INSERT INTO telemetry_buckets VALUES ('template', 42, 60, 1, 1, 0)"],
    ["INSERT INTO tile_history VALUES (0, 0, 60, 0, 'hash', 1)"],
    ["INSERT INTO version_tiles VALUES ('v', 2048, 0, 'hash')"],
  ])('rejects a value outside its SQL domain: %s', (statement) => {
    expect(() => d1.sqlite.prepare(statement).run()).toThrow(/CHECK constraint failed/)
  })

  it.each([['read'], ['report'], ['admin']])('accepts the %s scope', (scope) => {
    expect(() =>
      d1.sqlite
        .prepare(`INSERT INTO access_tokens VALUES ('h-${scope}', 'l', ?, 'c', 1, NULL)`)
        .run(scope),
    ).not.toThrow()
  })

  it.each([[60], [300], [900], [3_600], [21_600]])(
    'accepts telemetry ladder resolution %i',
    (resolution) => {
      expect(() =>
        d1.sqlite
          .prepare('INSERT INTO telemetry_buckets VALUES (?, ?, 60, 1, 1, 0)')
          .run(`template-${resolution}`, resolution),
      ).not.toThrow()
    },
  )

  it.each([[0], [3_600], [21_600], [86_400]])(
    'accepts tile-history ladder resolution %i',
    (resolution) => {
      expect(() =>
        d1.sqlite
          .prepare("INSERT INTO tile_history VALUES (0, 0, ?, ?, 'hash', 1)")
          .run(resolution, resolution),
      ).not.toThrow()
    },
  )

  it('accepts a bounding box that wraps through zero in x', () => {
    d1.sqlite.exec(`
      INSERT INTO nodes VALUES ('wrap-node', NULL, '/wrap', 'Wrap', 1);
      INSERT INTO templates VALUES ('wrap-template', 'wrap-node', 'T', 1, NULL, 1);
    `)
    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO template_versions VALUES ('wrap', 'wrap-template', 1, 'c', 2047000, 0, 1000, 1000, 5, NULL, NULL, NULL, NULL)",
        )
        .run(),
    ).not.toThrow()
  })

  it.each([
    [-1, 0, 1, 1, 1],
    [0, -1, 1, 1, 1],
    [0, 0, 2_048_001, 1, 1],
    [0, 0, 1, 2_048_001, 1],
    [1, 0, 1, 1, 1],
    [0, 1, 1, 1, 1],
    [0, 0, 1, 1, -1],
  ])(
    'rejects template-version pixel bounds outside the wire domain: %j',
    (minX, minY, maxX, maxY, totalPixels) => {
      d1.sqlite.exec(`
        INSERT OR IGNORE INTO nodes VALUES ('pixel-node', NULL, '/pixel', 'Pixel', 1);
        INSERT OR IGNORE INTO templates VALUES ('pixel-template', 'pixel-node', 'T', 1, NULL, 1);
      `)
      expect(() =>
        d1.sqlite
          .prepare(
            "INSERT INTO template_versions VALUES (?, 'pixel-template', 1, 'c', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)",
          )
          .run(
            `pixel-${minX}-${minY}-${maxX}-${maxY}-${totalPixels}`,
            minX,
            minY,
            maxX,
            maxY,
            totalPixels,
          ),
      ).toThrow(/CHECK constraint failed/)
    },
  )

  it.each([
    [2048, 0],
    [0, 2048],
    [-1, 0],
    [0, -1],
  ])('rejects tile-history coordinates outside the canvas: %i/%i', (tileX, tileY) => {
    expect(() =>
      d1.sqlite
        .prepare("INSERT INTO tile_history VALUES (?, ?, 0, 0, 'hash', 1)")
        .run(tileX, tileY),
    ).toThrow(/CHECK constraint failed/)
  })

  it('requires native bounds to be complete, ordered and in latitude/longitude range', () => {
    d1.sqlite.exec(`
      INSERT INTO nodes VALUES ('node', NULL, '/node', 'Node', 1);
      INSERT INTO templates VALUES ('template', 'node', 'Template', 1, NULL, 1);
    `)

    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO template_versions VALUES ('partial', 'template', 1, 'creator', 0, 0, 1, 1, 1, 45, NULL, NULL, NULL)",
        )
        .run(),
    ).toThrow()
    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO template_versions VALUES ('range', 'template', 1, 'creator', 0, 0, 1, 1, 1, 91, -45, -10, 10)",
        )
        .run(),
    ).toThrow()
    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO template_versions VALUES ('ordered', 'template', 1, 'creator', 0, 0, 1, 1, 1, -45, 45, -10, 10)",
        )
        .run(),
    ).toThrow()
  })
})
