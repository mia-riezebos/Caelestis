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

  it('returns a stored bucket once when an id repeats across chunks', async () => {
    // Each chunk returns its own rows and the merge does not join them, so a repeated id came back
    // once per chunk it landed in and any consumer summing the result double-counted.
    const stored = bucket({ templateId: 'dup', bucketStart: seconds(60) })
    await store.appendBuckets([stored])
    const templateIds = [
      'dup',
      ...Array.from({ length: 89 }, (_, index) => `template-${index}`),
      'dup',
    ]

    await expect(
      store.readBuckets({
        templateIds,
        resolution: 60,
        fromSeconds: seconds(0),
        toSeconds: seconds(100),
      }),
    ).resolves.toEqual([stored])
  })

  it('refuses a template set beyond the D1 per-invocation query budget', async () => {
    // Chunking solved the 100-parameter limit and met the next one: 50 queries per invocation on
    // the free plan. Failing here names the limit; reaching D1 produces an opaque D1_ERROR.
    const templateIds = Array.from({ length: 3_601 }, (_, index) => `template-${index}`)

    await expect(
      store.readBuckets({
        templateIds,
        resolution: 60,
        fromSeconds: seconds(0),
        toSeconds: seconds(100),
      }),
    ).rejects.toThrow(/at most 3600 template ids/)
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
    ["INSERT INTO tile_history VALUES (0, 0, 60, 0, 'hash', 'tok')"],
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
          .prepare("INSERT INTO tile_history VALUES (0, 0, ?, ?, 'hash', 'tok')")
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
    // min is inclusive and max exclusive, so the minima stop one short of the world edge and the
    // maxima start at 1. Only the far side of each was covered, leaving both near bounds free to
    // move by one.
    [2_048_000, 0, 1, 1, 1],
    [0, 2_048_000, 1, 1, 1],
    // min_x must differ from max_x, so a max_x of 0 needs an unequal min_x or the zero-width clause
    // does the rejecting and the lower bound stays free. max_y has no equivalent case: `min_y >= 0
    // AND min_y < max_y` already implies `max_y >= 1`, so its BETWEEN lower bound is genuinely
    // redundant and a test here would only appear to pin it.
    [5, 0, 0, 1, 1],
    // y does not wrap, so min_y > max_y is illegal — not merely unequal. Nothing covered the
    // ordering, so the CHECK could weaken to <> and store a pole-wrapping box whose height is
    // negative for every consumer.
    [0, 1_000, 1, 500, 1],
    // SQLite INTEGER is an affinity, not a type: without typeof(...) = 'integer' a fractional
    // coordinate satisfies BETWEEN and is stored as a REAL, putting every later
    // `y * TILE_SIZE + x` off the grid.
    [0.5, 0, 1, 1, 1],
    [0, 0.5, 1, 1, 1],
    [0, 0, 1.5, 1, 1],
    [0, 0, 1, 1.5, 1],
    [0, 0, 1, 1, 0.5],
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
        .prepare("INSERT INTO tile_history VALUES (?, ?, 0, 0, 'hash', 'tok')")
        .run(tileX, tileY),
    ).toThrow(/CHECK constraint failed/)
  })

  it.each([
    [0.5, 0],
    [0, 0.5],
  ])('rejects fractional tile-history coordinates: %s/%s', (tileX, tileY) => {
    expect(() =>
      d1.sqlite
        .prepare("INSERT INTO tile_history VALUES (?, ?, 0, 0, 'hash', 'tok')")
        .run(tileX, tileY),
    ).toThrow(/CHECK constraint failed/)
  })

  it.each([
    [2048, 0],
    [0, 2048],
    [-1, 0],
    [0, -1],
    [0.5, 0],
    [0, 0.5],
  ])('rejects version-tile coordinates outside the canvas: %s/%s', (tileX, tileY) => {
    // Only tile_x = 2048 was covered here, so the y bound and both integer guards were free.
    expect(() =>
      d1.sqlite.prepare("INSERT INTO version_tiles VALUES ('v', ?, ?, 'hash')").run(tileX, tileY),
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

  it.each([
    // All three negative, so repairs <= correct <= placed still holds and only the sign clause can
    // reject: a single negative counter is caught by the ordering instead, leaving the sign free.
    ["INSERT INTO telemetry_buckets VALUES ('t', 60, 60, -5, -5, -5)"],
    ["INSERT INTO telemetry_buckets VALUES ('t', 60, 60, 1, 'oops', 0)"],
    ["INSERT INTO telemetry_buckets VALUES ('t', 60, 60, 1, 1, 0.5)"],
    ["INSERT INTO telemetry_buckets VALUES ('t', 60, 60, 1, 2, 0)"],
    ["INSERT INTO contributions VALUES (1, 'ct', -1, 'tok', 1, 1, 0)"],
    ["INSERT INTO contributions VALUES (1, 'ct', 1, 'tok', -5, -5, -5)"],
  ])('rejects a counter outside its SQL domain: %s', (statement) => {
    d1.sqlite.exec(`
      INSERT OR IGNORE INTO nodes VALUES ('cn', NULL, '/cn', 'CN', 1);
      INSERT OR IGNORE INTO templates VALUES ('ct', 'cn', 'T', 1, NULL, 1);
    `)
    // The geometry columns get typeof + range; the counters got neither, so a negative, fractional
    // or textual count persisted. isValidCounterDelta already refuses these — this is the second
    // half of the rule, for any writer that is not the shard.
    expect(() => d1.sqlite.prepare(statement).run()).toThrow(/CHECK constraint failed/)
  })

  it('counts a repeated report from one reporter once, and keeps competing hashes', () => {
    // reporters used to be an aggregate integer on a row keyed only by tile, tier and bucket: one
    // hostile client could increment it by replaying its own hash until it looked like quorum, and
    // an honest competing hash could not be stored at all. One row per reporter per hash fixes both.
    d1.sqlite.exec(`
      INSERT INTO tile_history VALUES (0, 0, 0, 100, 'attacker-hash', 'tok-a');
      INSERT OR IGNORE INTO tile_history VALUES (0, 0, 0, 100, 'attacker-hash', 'tok-a');
      INSERT INTO tile_history VALUES (0, 0, 0, 100, 'honest-hash', 'tok-b');
    `)
    expect(
      d1.sqlite
        .prepare(
          'SELECT sha256, COUNT(*) AS reporters FROM tile_history GROUP BY sha256 ORDER BY sha256',
        )
        .all(),
    ).toEqual([
      { sha256: 'attacker-hash', reporters: 1 },
      { sha256: 'honest-hash', reporters: 1 },
    ])
  })

  it('rejects a replayed event id regardless of the claimed user', () => {
    // The replay guard has to key on the event id alone. Keying it with the attacker-supplied user
    // would let one captured event be replayed once per fabricated identity.
    d1.sqlite.exec("INSERT INTO applied_events VALUES ('e1', 100, 1000)")
    expect(() =>
      d1.sqlite.prepare("INSERT INTO applied_events VALUES ('e1', 200, 2000)").run(),
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/)
  })

  it('rejects a replayed event id', () => {
    // PaintEvent.eventId is documented as "client-generated, so a retry can never double-count",
    // and nothing stored it — the pending path is purely additive, so replaying one captured event
    // N times multiplied the counters by N.
    d1.sqlite.exec("INSERT INTO applied_events VALUES ('e1', 1, 1000)")
    expect(() =>
      d1.sqlite.prepare("INSERT INTO applied_events VALUES ('e1', 1, 2000)").run(),
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/)
  })

  it.each([['/canada'], ['/Canada']])(
    'rejects a second node claiming the existing path as %s',
    (path) => {
      // path is the prefix-rollup key and the subtree-rewrite key; duplicates make a rollup
      // attribute one group's templates to another. The case variant matters because SQLite's LIKE
      // is ASCII-case-insensitive, so /Canada and /canada would capture each other on a move.
      d1.sqlite.exec("INSERT INTO nodes VALUES ('n1', NULL, '/canada', 'Canada', 1)")
      expect(() =>
        d1.sqlite.prepare('INSERT INTO nodes VALUES (?, NULL, ?, ?, 1)').run('n2', path, 'Other'),
      ).toThrow(/UNIQUE constraint failed|constraint failed/)
    },
  )

  it.each([
    ['south below -90', '45, -91, -10, 10'],
    ['west below -180', '45, -45, -181, 10'],
    ['east above 180', '45, -45, -10, 181'],
  ])('rejects native bounds with %s', (label, bounds) => {
    // The test above names longitude and only ever probes bounds_north, so the south range and both
    // longitude ranges were deletable. Matching the message too: a bare .toThrow() accepts
    // "no such table" as readily as a constraint failure, which this file's own comment argues
    // against.
    d1.sqlite.exec(`
      INSERT OR IGNORE INTO nodes VALUES ('bounds-node', NULL, '/bounds', 'Bounds', 1);
      INSERT OR IGNORE INTO templates VALUES ('bounds-template', 'bounds-node', 'T', 1, NULL, 1);
    `)
    expect(() =>
      d1.sqlite
        .prepare(
          `INSERT INTO template_versions VALUES ('${label.replace(/\s/g, '-')}', 'bounds-template', 1, 'c', 0, 0, 1, 1, 1, ${bounds})`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/)
  })

  it.each([
    [
      'version_tiles keeps one row per tile of a version',
      "INSERT INTO version_tiles VALUES ('v1', 0, 0, 'h'), ('v1', 0, 1, 'h')",
    ],
    [
      'contributions keeps one row per user, template, day and reporter',
      "INSERT INTO contributions VALUES (1, 'ct', 1, 'tok', 1, 1, 0), (1, 'ct', 2, 'tok', 1, 1, 0)",
    ],
    [
      'contributions separate two reporters of the same user, template and day',
      "INSERT INTO contributions VALUES (2, 'ct', 1, 'tok-a', 1, 1, 0), (2, 'ct', 1, 'tok-b', 1, 1, 0)",
    ],
    [
      'tile_history keeps one row per tile, tier and bucket',
      "INSERT INTO tile_history VALUES (0, 0, 0, 0, 'h', 'tok'), (0, 0, 0, 60, 'h', 'tok')",
    ],
  ])('%s', (_label, statement) => {
    // Each composite primary key is the identity the draft specifies. Dropping a component makes
    // these two rows collide, so the insert throws — nothing else in the suite writes two rows that
    // differ only in the trailing key column.
    d1.sqlite.exec(`
      INSERT OR IGNORE INTO nodes VALUES ('pk-node', NULL, '/pk', 'PK', 1);
      INSERT OR IGNORE INTO templates VALUES ('ct', 'pk-node', 'T', 1, NULL, 1);
      INSERT OR IGNORE INTO template_versions VALUES ('v1', 'ct', 1, 'c', 0, 0, 1, 1, 1, NULL, NULL, NULL, NULL);
    `)
    expect(() => d1.sqlite.prepare(statement).run()).not.toThrow()
  })
})
