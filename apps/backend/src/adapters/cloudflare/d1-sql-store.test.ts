import { encodeIndexedPng, millis, seconds } from '@wts/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TelemetryBucket, TemplateVersionRecord } from '../../ports/index.js'
import { NodeNotFoundError } from '../../ports/index.js'
import { storeTemplate } from '../../templates/store.js'
import { MemoryBlobStore } from '../memory/memory-blob-store.js'
import { D1SqlStore } from './d1-sql-store.js'
import { SqliteD1Database } from './sqlite-d1.test-helper.js'

// reported_with_token is a sha256 digest of the access token, constrained by CHECK rather than by a foreign
// key: the audit record outlives the credential it names, so a fixture needs the shape, not a row.
const bucket = (overrides: Partial<TelemetryBucket> = {}): TelemetryBucket => ({
  templateId: 'template-1',
  resolution: 60,
  bucketStart: seconds(1_749_988_800),
  placed: 10,
  correct: 8,
  repairs: 2,
  ...overrides,
})

const templateVersion = (
  overrides: Partial<TemplateVersionRecord> = {},
): TemplateVersionRecord => ({
  templateId: 'template-1',
  nodeId: 'node-1',
  name: 'Template',
  versionId: 'version-1',
  createdWithToken: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  createdByUserId: null,
  createdAt: millis(1_000),
  bbox: { minX: 0, minY: 0, maxX: 1001, maxY: 1 },
  totalPixels: 2,
  chunks: [
    { tileX: 0, tileY: 0, hash: 'a'.repeat(64) },
    { tileX: 1, tileY: 0, hash: 'b'.repeat(64) },
  ],
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

  it('stores through the real D1 adapter only when the node exists', async () => {
    const blobs = new MemoryBlobStore()
    const png = await encodeIndexedPng(1, 1, new Uint8Array([0]))
    const nodeId = '01890f3a-6b7c-7def-8123-456789abcde0'
    const input = {
      nodeId,
      name: 'Template',
      createdWithToken: 'a'.repeat(64),
      createdByUserId: null,
      originX: 0,
      originY: 0,
      png,
    }

    await expect(store.insertTemplateVersion(templateVersion({ nodeId }))).rejects.toBeInstanceOf(
      NodeNotFoundError,
    )
    await expect(storeTemplate({ sql: store, blobs }, input)).rejects.toBeInstanceOf(
      NodeNotFoundError,
    )
    await store.insertNode({
      id: nodeId,
      season: 1,
      parentId: null,
      path: '/node',
      name: 'Node',
      description: null,
      createdAt: millis(1_750_000_000_000),
    })

    const stored = await storeTemplate({ sql: store, blobs }, input)

    expect(d1.sqlite.prepare('SELECT node_id, published_at FROM templates').get()).toEqual({
      node_id: nodeId,
      published_at: null,
    })
    await expect(store.readTemplateVersion(stored.versionId)).resolves.toMatchObject({ nodeId })
  })

  it('writes a template, version, tile index and current pointer in one batch', async () => {
    d1.sqlite
      .prepare("INSERT INTO nodes VALUES ('node-1', 1, NULL, '/node-1', 'Node', NULL, 1)")
      .run()
    const version = templateVersion()

    await store.insertTemplateVersion(version)

    expect(d1.batchCalls).toBe(1)
    expect(d1.sqlite.prepare('SELECT COUNT(*) AS count FROM templates').get()).toEqual({ count: 1 })
    expect(d1.sqlite.prepare('SELECT COUNT(*) AS count FROM template_versions').get()).toEqual({
      count: 1,
    })
    expect(d1.sqlite.prepare('SELECT COUNT(*) AS count FROM version_tiles').get()).toEqual({
      count: 2,
    })
    expect(d1.sqlite.prepare('SELECT current_version_id FROM templates').get()).toEqual({
      current_version_id: version.versionId,
    })
    await expect(store.readTemplateVersion(version.versionId)).resolves.toEqual(version)
  })

  it('rolls the whole template write back when one tile row fails', async () => {
    d1.sqlite
      .prepare("INSERT INTO nodes VALUES ('node-1', 1, NULL, '/node-1', 'Node', NULL, 1)")
      .run()
    const firstTile = { tileX: 0, tileY: 0, hash: 'a'.repeat(64) }
    const duplicateTile = { tileX: 0, tileY: 0, hash: 'b'.repeat(64) }
    const version = templateVersion({ chunks: [firstTile, duplicateTile] })

    await expect(store.insertTemplateVersion(version)).rejects.toThrow(/UNIQUE constraint failed/)
    expect(d1.batchCalls).toBe(1)
    expect(d1.sqlite.prepare('SELECT COUNT(*) AS count FROM templates').get()).toEqual({ count: 0 })
    expect(d1.sqlite.prepare('SELECT COUNT(*) AS count FROM template_versions').get()).toEqual({
      count: 0,
    })
    expect(d1.sqlite.prepare('SELECT COUNT(*) AS count FROM version_tiles').get()).toEqual({
      count: 0,
    })
  })

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
        fromSeconds: seconds(1_749_988_800),
        toSeconds: seconds(1_749_988_920),
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
      bucket({ templateId: 'template-2', bucketStart: seconds(1_749_988_860) }),
    ])

    expect(d1.batchCalls).toBe(1)
    expect(d1.sqlite.prepare('SELECT COUNT(*) AS count FROM telemetry_buckets').get()).toEqual({
      count: 2,
    })
  })

  it('reads requested ids at one resolution over a half-open range in stable order', async () => {
    const fromSeconds = seconds(1_749_988_800)
    const middleSeconds = seconds(1_749_988_860)
    const toSeconds = seconds(1_749_988_920)
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

  it('counts distinct ids against the budget, not repeats', async () => {
    // The cap is applied after deduplication, which is what makes the port's "duplicate ids are
    // read once" contract consistent with it. Checking the raw array instead passes every other
    // test here — the duplicate test sends 91 ids and the over-budget test has no duplicates — and
    // would refuse a legal call.
    const templateIds = [
      ...Array.from({ length: 3_600 }, (_, index) => `template-${index}`),
      'template-0',
    ]

    await expect(
      store.readBuckets({
        templateIds,
        resolution: 60,
        fromSeconds: seconds(0),
        toSeconds: seconds(100),
      }),
    ).resolves.toEqual([])
  })

  it('returns one ordering across chunk boundaries', async () => {
    // Each chunk is ordered on its own, but ids are spread across chunks in input order, so a bare
    // concatenation is unsorted. Reading these two in reverse order puts them in different chunks.
    const templateIds = Array.from({ length: 91 }, (_, index) => `template-${index}`).reverse()
    const early = bucket({ templateId: 'template-0', bucketStart: seconds(0) })
    const late = bucket({ templateId: 'template-90', bucketStart: seconds(0) })
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
    [
      "INSERT INTO access_tokens VALUES ('6666666666666666666666666666666666666666666666666666666666666666', 'l', 'superadmin', 'c', 1)",
    ],
    ["INSERT INTO telemetry_buckets VALUES ('template', 42, 60, 1, 1, 0)"],
    [
      "INSERT INTO tile_history VALUES (0, 0, 60, 0, '5555555555555555555555555555555555555555555555555555555555555555', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7)",
    ],
    [
      "INSERT INTO version_tiles VALUES ('v', 2048, 0, '5555555555555555555555555555555555555555555555555555555555555555')",
    ],
  ])('rejects a value outside its SQL domain: %s', (statement) => {
    expect(() => d1.sqlite.prepare(statement).run()).toThrow(/CHECK constraint failed/)
  })

  it.each([['read'], ['report'], ['admin']])('accepts the %s scope', (scope) => {
    expect(() =>
      d1.sqlite
        .prepare(`INSERT INTO access_tokens VALUES ('h-${scope}', 'l', ?, 'c', 1)`)
        .run(scope),
    ).not.toThrow()
  })

  it.each([[60], [300], [900], [3_600], [21_600]])(
    'accepts telemetry ladder resolution %i',
    (resolution) => {
      expect(() =>
        d1.sqlite
          .prepare('INSERT INTO telemetry_buckets VALUES (?, ?, 0, 1, 1, 0)')
          .run(`template-${resolution}`, resolution),
      ).not.toThrow()
    },
  )

  it.each([[0], [3_600], [21_600], [86_400]])(
    'accepts tile-history ladder resolution %i',
    (resolution) => {
      expect(() =>
        d1.sqlite
          .prepare(
            "INSERT INTO tile_history VALUES (0, 0, ?, ?, '5555555555555555555555555555555555555555555555555555555555555555', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7)",
          )
          .run(resolution, resolution),
      ).not.toThrow()
    },
  )

  it('accepts a bounding box that wraps through zero in x', () => {
    d1.sqlite.exec(`
      INSERT INTO nodes VALUES ('wrap-node', 1, NULL, '/wrap', 'Wrap', NULL, 1);
      INSERT INTO templates VALUES ('wrap-template', 'wrap-node', 'T', NULL, NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1);
    `)
    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO template_versions VALUES ('wrap', 'wrap-template', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 2047000, 0, 1000, 1000, 5, NULL, NULL, NULL, NULL)",
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
        INSERT OR IGNORE INTO nodes VALUES ('pixel-node', 1, NULL, '/pixel', 'Pixel', NULL, 1);
        INSERT OR IGNORE INTO templates VALUES ('pixel-template', 'pixel-node', 'T', NULL, NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1);
      `)
      expect(() =>
        d1.sqlite
          .prepare(
            "INSERT INTO template_versions VALUES (?, 'pixel-template', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)",
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
        .prepare(
          "INSERT INTO tile_history VALUES (?, ?, 0, 0, '5555555555555555555555555555555555555555555555555555555555555555', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7)",
        )
        .run(tileX, tileY),
    ).toThrow(/CHECK constraint failed/)
  })

  it.each([
    [0.5, 0],
    [0, 0.5],
  ])('rejects fractional tile-history coordinates: %s/%s', (tileX, tileY) => {
    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO tile_history VALUES (?, ?, 0, 0, '5555555555555555555555555555555555555555555555555555555555555555', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7)",
        )
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
      d1.sqlite
        .prepare(
          "INSERT INTO version_tiles VALUES ('v', ?, ?, '5555555555555555555555555555555555555555555555555555555555555555')",
        )
        .run(tileX, tileY),
    ).toThrow(/CHECK constraint failed/)
  })

  it('requires native bounds to be complete, ordered and in latitude/longitude range', () => {
    d1.sqlite.exec(`
      INSERT INTO nodes VALUES ('node', 1, NULL, '/node', 'Node', NULL, 1);
      INSERT INTO templates VALUES ('template', 'node', 'Template', NULL, NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1);
    `)

    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO template_versions VALUES ('partial', 'template', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 0, 0, 1, 1, 1, 45, NULL, NULL, NULL)",
        )
        .run(),
    ).toThrow()
    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO template_versions VALUES ('range', 'template', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 0, 0, 1, 1, 1, 91, -45, -10, 10)",
        )
        .run(),
    ).toThrow()
    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO template_versions VALUES ('ordered', 'template', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 0, 0, 1, 1, 1, -45, 45, -10, 10)",
        )
        .run(),
    ).toThrow()
  })

  it.each([
    // All three negative, so repairs <= correct <= placed still holds and only the sign clause can
    // reject: a single negative counter is caught by the ordering instead, leaving the sign free.
    ["INSERT INTO telemetry_buckets VALUES ('t', 60, 60, -5, -5, -5)"],
    // A bucket start is the floor of an event time to its resolution, so it is always a multiple of
    // it. 61 at resolution 60 is a row no reader can align with any other tier of the ladder.
    ["INSERT INTO telemetry_buckets VALUES ('t', 60, 61, 1, 1, 0)"],
    ["INSERT INTO telemetry_buckets VALUES ('t', 300, 60, 1, 1, 0)"],
    ["INSERT INTO telemetry_buckets VALUES ('t', 60, 60, 1, 'oops', 0)"],
    ["INSERT INTO telemetry_buckets VALUES ('t', 60, 60, 1, 1, 0.5)"],
    ["INSERT INTO telemetry_buckets VALUES ('t', 60, 60, 1, 2, 0)"],
    // `%` casts to integer before dividing, so the alignment clause reads 60.5 as 60 and passes it.
    // INTEGER is an affinity: 60.5 stays REAL, and `(t, 60, 60)` and `(t, 60, 60.5)` are then two
    // primary keys for one minute, which every reader that sums the tier double-counts.
    ["INSERT INTO telemetry_buckets VALUES ('t', 60, 60.5, 1, 1, 0)"],
    // Aligned and negative: only a sign clause can reject it. A bucket start is an absolute time.
    ["INSERT INTO telemetry_buckets VALUES ('t', 60, -60, 1, 1, 0)"],
    // repairs <= correct <= placed holds in both, so only the typeof clause named in each can
    // reject. Without these two, `typeof(placed)` and `typeof(correct)` are individually deletable:
    // the 'oops' case is caught by the ordering comparison instead, and 0.5 only covers repairs.
    ["INSERT INTO telemetry_buckets VALUES ('t', 60, 60, 1.5, 1, 0)"],
    ["INSERT INTO telemetry_buckets VALUES ('t', 60, 60, 2, 1.5, 0)"],
    [
      "INSERT INTO contributions VALUES (1, 'ct', -86400, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1, 1, 0)",
    ],
    // day_s is the leaderboard's day bucket, so it is a UTC midnight. Unaligned, 1 and 2 are two
    // primary keys for one day and a rollup splits one painter's day across both.
    [
      "INSERT INTO contributions VALUES (2, 'ct', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1, 1, 0)",
    ],
    // Positive, and a multiple of every smaller round number a mistyped divisor might use. Without
    // it `% 86400` can become `% 60` with the suite green, since 1 fails both and 0/86400 pass both.
    [
      "INSERT INTO contributions VALUES (9, 'ct', 60, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1, 1, 0)",
    ],
    // All non-negative, so only the ordering clause can reject. telemetry_buckets has this case and
    // contributions never got the equivalent, leaving its whole ordering half uncovered.
    [
      "INSERT INTO contributions VALUES (3, 'ct', 86400, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1, 2, 0)",
    ],
    [
      "INSERT INTO contributions VALUES (4, 'ct', 86400, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 2, 1, 2)",
    ],
    [
      "INSERT INTO contributions VALUES (1, 'ct', 86400, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, -5, -5, -5)",
    ],
    // One typeof clause each, for the same reason as the telemetry pair above. 86400.5 casts to
    // 86400, so it clears the alignment clause and leaves only the type guard to reject it.
    [
      "INSERT INTO contributions VALUES (5, 'ct', 86400.5, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1, 1, 0)",
    ],
    [
      "INSERT INTO contributions VALUES (6, 'ct', 0, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1.5, 1, 0)",
    ],
    [
      "INSERT INTO contributions VALUES (7, 'ct', 0, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 2, 1.5, 0)",
    ],
    [
      "INSERT INTO contributions VALUES (8, 'ct', 0, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 2, 2, 0.5)",
    ],
    // A folded bucket start is the floor of an observation to its tier, exactly as on
    // telemetry_buckets. 3601 at the hourly tier keys a bucket that overlaps the real 3600 one, so
    // the decay fold sees two hours where one was observed. Raw observations (0) are exempt.
    // wplace_user_id is attacker-supplied and was the one key column with no type guard, while
    // day_s and all three counters beside it got one. INTEGER affinity converts '1' but not 1.5 or
    // 'abc', so those persisted as distinct primary keys — one report token minting unbounded
    // "painters" at 1.5, 1.25, 1.125, and a GROUP BY that reads each as a separate person.
    [
      "INSERT INTO contributions VALUES (1.5, 'ct', 0, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1, 1, 0)",
    ],
    [
      "INSERT INTO contributions VALUES ('abc', 'ct', 0, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1, 1, 0)",
    ],
    [
      "INSERT INTO tile_history VALUES (0, 0, 3600, 3601, '5555555555555555555555555555555555555555555555555555555555555555', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7)",
    ],
    // Aligned to the hourly tier but not to this row's own. Every accepted start is a multiple of
    // 3600, so without this the divisor can be hardcoded to 3600 and still pass — the check would
    // stop reading the resolution column it is written against.
    [
      "INSERT INTO tile_history VALUES (0, 0, 21600, 3600, '5555555555555555555555555555555555555555555555555555555555555555', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7)",
    ],
    [
      "INSERT INTO tile_history VALUES (0, 0, 3600, 3600.5, '5555555555555555555555555555555555555555555555555555555555555555', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7)",
    ],
    [
      "INSERT INTO tile_history VALUES (0, 0, 0, -1, '5555555555555555555555555555555555555555555555555555555555555555', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7)",
    ],
    // The four *_user_id domains, none of which had a reject case: every fixture here used a small
    // positive literal, so the type and sign guards on the columns that now carry quorum identity
    // were each individually deletable.
    [
      "INSERT INTO tile_history VALUES (0, 0, 0, 0, '6666666666666666666666666666666666666666666666666666666666666666', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', -1)",
    ],
    [
      "INSERT INTO tile_history VALUES (0, 0, 0, 0, '6666666666666666666666666666666666666666666666666666666666666666', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1.5)",
    ],
    [
      "INSERT INTO contributions VALUES (1, 'ct', 0, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', -1, 1, 1, 0)",
    ],
    [
      "INSERT INTO contributions VALUES (1, 'ct', 0, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1.5, 1, 1, 0)",
    ],
    // The same digest rule was written on four columns and pinned on two.
    ["INSERT INTO contributions VALUES (1, 'ct', 0, 'short', 7, 1, 1, 0)"],
    [
      "INSERT INTO contributions VALUES (1, 'ct', 0, 'gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg', 7, 1, 1, 0)",
    ],
    // TEXT is an affinity too and never converts a BLOB: length() counts bytes and GLOB coerces, so
    // both conjuncts passed and the row was invisible to every digest query — reachable by binding
    // crypto.subtle.digest's ArrayBuffer instead of its hex string.
    [
      "INSERT INTO tile_history VALUES (0, 0, 0, 0, '6666666666666666666666666666666666666666666666666666666666666666', X'61616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161', 7)",
    ],
    [
      "INSERT INTO contributions VALUES (1, 'ct', 0, X'61616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161', 7, 1, 1, 0)",
    ],
    // applied_events was the one table with an attacker-supplied integer and no guard at all.
    ["INSERT INTO applied_events VALUES ('e', 1.5, 1)"],
    ["INSERT INTO applied_events VALUES ('e', -1, 1)"],
    // The content digests, which had the rule their credential siblings carry and were left out of
    // it. A BLOB here is invisible to text lookups, cannot satisfy the wire's Chunk.hash or an R2
    // object key, and splits the quorum two spellings of one hash should agree on.
    [
      "INSERT INTO tile_history VALUES (0, 0, 0, 0, X'61616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7)",
    ],
    [
      "INSERT INTO tile_history VALUES (0, 0, 0, 0, 'short', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7)",
    ],
    [
      "INSERT INTO tile_history VALUES (0, 0, 0, 0, 'GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7)",
    ],
    [
      "INSERT INTO version_tiles VALUES ('v1', 0, 0, X'61616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161')",
    ],
    ["INSERT INTO version_tiles VALUES ('v1', 0, 0, 'short')"],
  ])('rejects a counter outside its SQL domain: %s', (statement) => {
    d1.sqlite.exec(`
      INSERT OR IGNORE INTO nodes VALUES ('cn', 1, NULL, '/cn', 'CN', NULL, 1);
      INSERT OR IGNORE INTO templates VALUES ('ct', 'cn', 'T', NULL, NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1);
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
      INSERT INTO tile_history VALUES (0, 0, 0, 100, '2222222222222222222222222222222222222222222222222222222222222222', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 7);
      INSERT OR IGNORE INTO tile_history VALUES (0, 0, 0, 100, '2222222222222222222222222222222222222222222222222222222222222222', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 7);
      INSERT INTO tile_history VALUES (0, 0, 0, 100, '3333333333333333333333333333333333333333333333333333333333333333', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 7);
    `)
    expect(
      d1.sqlite
        .prepare(
          'SELECT sha256, COUNT(*) AS reporters FROM tile_history GROUP BY sha256 ORDER BY sha256',
        )
        .all(),
    ).toEqual([
      { sha256: '2222222222222222222222222222222222222222222222222222222222222222', reporters: 1 },
      { sha256: '3333333333333333333333333333333333333333333333333333333333333333', reporters: 1 },
    ])
  })

  it('counts two reporters of the same hash as two', () => {
    // The test above changes hash and reporter together, so dropping the reporter from the primary
    // key still passes it — and agreement is the case quorum is actually read from. Two honest
    // clients seeing the same tile must not collapse into one row. Two *accounts*: the account is
    // the client, so distinct tokens alone no longer make distinct reporters.
    d1.sqlite.exec(`
      INSERT INTO tile_history VALUES (1, 1, 0, 100, '1111111111111111111111111111111111111111111111111111111111111111', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 11);
      INSERT INTO tile_history VALUES (1, 1, 0, 100, '1111111111111111111111111111111111111111111111111111111111111111', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 22);
    `)
    expect(
      d1.sqlite
        .prepare('SELECT COUNT(*) AS reporters FROM tile_history WHERE tile_x = 1 AND sha256 = ?')
        .all('1111111111111111111111111111111111111111111111111111111111111111'),
    ).toEqual([{ reporters: 2 }])
  })

  it.each(['/canada%', '/canada_x', 'canada', '/canada/', '/canada//x', '/'])(
    'rejects the unusable node path %o',
    (path) => {
      // NodePath excludes these on the wire, but that schema validates the manifest *response* —
      // nothing stood between a create-group route and this column, and nodes was the one table
      // here with no CHECK at all. `%` and `_` are LIKE metacharacters and path is the
      // subtree-rewrite key, so `/canada%` captures sibling subtrees on the documented
      // `LIKE '<old>/%'` move and `/%` captures the entire tree.
      expect(() =>
        d1.sqlite
          .prepare('INSERT INTO nodes VALUES (?, 1, NULL, ?, ?, NULL, 1)')
          .run('bad', path, 'Bad'),
      ).toThrow(/CHECK constraint failed/)
    },
  )

  it('rejects a current version belonging to another template', () => {
    // current_version_id is what the manifest reads bounds and chunks from. Referencing
    // template_versions(id) alone lets one template point at another's version, so it would serve
    // that template's geometry under its own identity — wrong pixels, wrong progress denominator.
    d1.sqlite.exec(`
      INSERT INTO nodes VALUES ('own-node', 1, NULL, '/own', 'Own', NULL, 1);
      INSERT INTO templates VALUES ('t-a', 'own-node', 'A', NULL, NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1);
      INSERT INTO templates VALUES ('t-b', 'own-node', 'B', NULL, NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1);
      INSERT INTO template_versions VALUES ('v-a', 't-a', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 0, 0, 1, 1, 1, NULL, NULL, NULL, NULL);
    `)
    expect(() =>
      d1.sqlite.prepare("UPDATE templates SET current_version_id = 'v-a' WHERE id = 't-b'").run(),
    ).toThrow(/FOREIGN KEY constraint failed/)
    expect(() =>
      d1.sqlite.prepare("UPDATE templates SET current_version_id = 'v-a' WHERE id = 't-a'").run(),
    ).not.toThrow()
  })

  it('records who created a template and when, alongside each version upload', () => {
    // The template is the thing that gets renamed, moved and deleted, and it had a creation time
    // and no author — only its versions recorded one. Attribution is the same pair a report is
    // attributed to, so "who uploaded this" answers with a credential and an account.
    d1.sqlite.exec(`
      INSERT INTO nodes VALUES ('attr-node', 1, NULL, '/attr', 'Attr', NULL, 1);
      INSERT INTO templates VALUES ('attr-t', 'attr-node', 'T', NULL, NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 42, 1700);
      INSERT INTO template_versions VALUES ('attr-v', 'attr-t', 1800, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 99, 0, 0, 1, 1, 1, NULL, NULL, NULL, NULL);
    `)
    expect(
      d1.sqlite
        .prepare(
          `SELECT t.created_with_token AS templateBy, t.created_by_user_id AS templateUser,
                  t.created_at_ms AS templateAt, v.created_by_user_id AS versionUser,
                  v.created_at_ms AS versionAt
           FROM templates t JOIN template_versions v ON v.template_id = t.id
           WHERE t.id = 'attr-t'`,
        )
        .get(),
    ).toEqual({
      templateBy: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      templateUser: 42,
      templateAt: 1700,
      versionUser: 99,
      versionAt: 1800,
    })
  })

  it.each([['short'], ['g'.repeat(64)]])(
    'rejects the malformed template author digest %o',
    (createdWithToken) => {
      d1.sqlite.exec(
        "INSERT OR IGNORE INTO nodes VALUES ('bad-node', 1, NULL, '/bad', 'Bad', NULL, 1)",
      )
      expect(() =>
        d1.sqlite
          .prepare("INSERT INTO templates VALUES ('bad-t', 'bad-node', 'T', NULL, NULL, ?, 7, 1)")
          .run(createdWithToken),
      ).toThrow(/CHECK constraint failed/)
    },
  )

  it('rejects a node that is its own parent', () => {
    // The wire derives acyclicity from the path rule, which is also response-only. A self-parent
    // satisfies the foreign key, hangs any recursive ancestor walk, and makes the manifest
    // undecodable for every client.
    expect(() =>
      d1.sqlite
        .prepare("INSERT INTO nodes VALUES ('self', 1, 'self', '/self', 'Self', NULL, 1)")
        .run(),
    ).toThrow(/CHECK constraint failed/)
  })

  it('counts two members sharing one token as two reporters', () => {
    // A token is not a client. An alliance that configures one report token across five userscripts
    // was five clients reporting and one row — quorum collapsed to 1 for tiles five members agreed
    // on. The identity is the token *and* the wplace /me id of whoever is running the script, so
    // these two rows coexist and COUNT(*) reads 2.
    d1.sqlite.exec(`
      INSERT INTO tile_history VALUES (2, 2, 0, 100, '4444444444444444444444444444444444444444444444444444444444444444', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 11);
      INSERT INTO tile_history VALUES (2, 2, 0, 100, '4444444444444444444444444444444444444444444444444444444444444444', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 22);
    `)
    expect(
      d1.sqlite.prepare('SELECT COUNT(*) AS reporters FROM tile_history WHERE tile_x = 2').all(),
    ).toEqual([{ reporters: 2 }])
  })

  it('counts one account holding two tokens as one reporter', () => {
    // The inverse of the shared-token case, and the one the pair alone does not close: keying on
    // (token, account) made a member with two valid report tokens two reporters, so one client
    // could manufacture the two-distinct-client quorum the ladder prefers. The account is the
    // client; the token is only what it authenticated with.
    d1.sqlite.exec(`
      INSERT INTO tile_history VALUES (3, 3, 0, 100, '4444444444444444444444444444444444444444444444444444444444444444', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7);
      INSERT OR REPLACE INTO tile_history VALUES (3, 3, 0, 100, '4444444444444444444444444444444444444444444444444444444444444444', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 7);
    `)
    expect(
      d1.sqlite.prepare('SELECT COUNT(*) AS reporters FROM tile_history WHERE tile_x = 3').all(),
    ).toEqual([{ reporters: 1 }])
  })

  it('keeps a tile-history report whose token is gone', () => {
    // reported_with_token is an audit column, not a relation: it records which credential reported a tile
    // so a leak can be traced through what it wrote. A foreign key made that record die with the
    // credential — deleting a token that ever reported failed unless its history went first — so
    // an orphan is the intended state, and only the digest shape is enforced.
    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO tile_history VALUES (0, 0, 0, 0, '6666666666666666666666666666666666666666666666666666666666666666', ?, 7)",
        )
        .run('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'),
    ).not.toThrow()
  })

  it.each([
    ['short'],
    ['dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'.toUpperCase()],
    ['g'.repeat(64)],
  ])('rejects the malformed reporter digest %o', (reportedWithToken) => {
    // The foreign key's real job was "keeps this a token, not free text". A 64-character
    // lowercase hex digest still is not free text, and it holds for a token row long deleted.
    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO tile_history VALUES (0, 0, 0, 0, '6666666666666666666666666666666666666666666666666666666666666666', ?, 7)",
        )
        .run(reportedWithToken),
    ).toThrow(/CHECK constraint failed/)
  })

  it('keeps a contribution whose token is gone', () => {
    // Same reason as tile_history: the reporter record has to outlive the credential it names.
    d1.sqlite.exec(`
      INSERT OR IGNORE INTO nodes VALUES ('fk-node', 1, NULL, '/fk', 'FK', NULL, 1);
      INSERT OR IGNORE INTO templates VALUES ('fk-t', 'fk-node', 'T', NULL, NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1);
    `)
    expect(() =>
      d1.sqlite
        .prepare("INSERT INTO contributions VALUES (1, 'fk-t', 0, ?, 7, 1, 1, 0)")
        .run('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'),
    ).not.toThrow()
  })

  it('stores, reads back and revokes an access token', async () => {
    // The memory adapter is tested directly; this is the one that talks to real D1, and the two must
    // agree or the parity the ports exist for is fiction.
    const token = {
      tokenHash: 'a'.repeat(64),
      label: 'discord-regulars',
      scope: 'report' as const,
      createdWithToken: 'bootstrap',
      createdAt: millis(1_000),
    }
    await store.insertAccessToken(token)

    await expect(store.readAccessToken(token.tokenHash)).resolves.toEqual(token)
    await expect(store.readAccessToken('missing')).resolves.toBeNull()

    await store.revokeAccessToken(token.tokenHash)
    await expect(store.readAccessToken(token.tokenHash)).resolves.toBeNull()
  })

  it('refuses to overwrite an existing token hash', async () => {
    const token = {
      tokenHash: 'b'.repeat(64),
      label: 'first',
      scope: 'read' as const,
      createdWithToken: 'bootstrap',
      createdAt: millis(1_000),
    }
    await store.insertAccessToken(token)

    await expect(store.insertAccessToken({ ...token, label: 'second' })).rejects.toThrow()
    await expect(store.readAccessToken(token.tokenHash)).resolves.toMatchObject({ label: 'first' })
  })

  it('revokes by deleting, idempotently, and leaves what the token reported', async () => {
    // Revocation is a hard delete: a soft flag obliged every reader to remember to filter on it and
    // nothing made them. Deleting needs no cooperation, and a credential is never re-provisioned.
    //
    // What it must not do is rewrite history. Reported state records what was actually on wplace,
    // so it is canonical regardless of what later happens to the credential that carried it —
    // revoking ends a holder's future access, it does not retract observations. Nothing references
    // access_tokens, so this row survives on purpose.
    const token = {
      tokenHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      label: 'leaked',
      scope: 'read' as const,
      createdWithToken: 'bootstrap',
      createdAt: millis(1_000),
    }
    await store.insertAccessToken(token)
    // A second credential, because one row cannot tell a targeted delete from a WHERE-less one, and
    // a revoke that took the whole table with it would lock the deployment out of its own admin
    // surface the moment the operator dropped ADMIN_TOKEN. The memory store pins this; D1 did not.
    const bystander = {
      ...token,
      tokenHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      label: 'bystander',
    }
    await store.insertAccessToken(bystander)
    // Both tables carry reported state, so both have to survive. Seeding only tile_history left a
    // cascade on contributions passing green.
    d1.sqlite.exec(`
      INSERT INTO nodes VALUES ('rev-node', 1, NULL, '/rev', 'Rev', NULL, 1);
      INSERT INTO templates VALUES ('rev-t', 'rev-node', 'T', NULL, NULL, '${'a'.repeat(64)}', 7, 1);
      INSERT INTO tile_history VALUES (9, 9, 0, 0, '7777777777777777777777777777777777777777777777777777777777777777', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 7);
      INSERT INTO contributions VALUES (5, 'rev-t', 0, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 7, 1, 1, 0);
    `)

    await store.revokeAccessToken(token.tokenHash)
    await store.revokeAccessToken(token.tokenHash)

    await expect(store.readAccessToken(token.tokenHash)).resolves.toBeNull()
    await expect(store.readAccessToken(bystander.tokenHash)).resolves.toMatchObject({
      label: 'bystander',
    })
    expect(
      d1.sqlite
        .prepare(
          `SELECT (SELECT COUNT(*) FROM tile_history WHERE tile_x = 9)
                + (SELECT COUNT(*) FROM contributions WHERE wplace_user_id = 5) AS kept`,
        )
        .all(),
    ).toEqual([{ kept: 2 }])
  })

  it('serves only published templates to members, and every season only its own', async () => {
    // The whole manifest read path ran on the memory store alone: `listNodes`,
    // `listManifestTemplates`, `listManifestTiles`, `setTemplatePublishedAt` and `deleteNode` had no
    // D1 test at all. Dropping `isNotNull(publishedAt)` from both queries left 301 tests green while
    // serving every unpublished draft — with its chunk hashes, which /chunks/:hash then hands over —
    // to any read-scope member. Same for the season filter, which put two seasons' nodes into one
    // manifest and made it undecodable.
    d1.sqlite.exec(`
      INSERT INTO nodes VALUES ('s1', 1, NULL, '/one', 'One', NULL, 1);
      INSERT INTO nodes VALUES ('s2', 2, NULL, '/two', 'Two', NULL, 1);
    `)
    const place = (templateId: string, nodeId: string, minX: number, hash: string) => ({
      templateId,
      nodeId,
      name: templateId,
      versionId: `${templateId}-v`,
      createdWithToken: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      createdByUserId: null,
      createdAt: millis(1_000),
      bbox: { minX, minY: 0, maxX: minX + 10, maxY: 10 },
      totalPixels: 4,
      chunks: [{ tileX: minX, tileY: 0, hash }],
    })
    await store.insertTemplateVersion(place('pub', 's1', 0, '1'.repeat(64)))
    await store.insertTemplateVersion(place('draft', 's1', 100, '2'.repeat(64)))
    await store.insertTemplateVersion(place('other', 's2', 0, '3'.repeat(64)))
    await store.setTemplatePublishedAt('pub', millis(2_000))

    const members = await store.listManifestTemplates(1, false)
    const admins = await store.listManifestTemplates(1, true)
    const memberTiles = await store.listManifestTiles(1, false)

    expect(members.map((t) => t.id)).toEqual(['pub'])
    expect(admins.map((t) => t.id).sort()).toEqual(['draft', 'pub'])
    expect(memberTiles.map((t) => t.hash)).toEqual(['1'.repeat(64)])
    expect((await store.listNodes(1)).map((n) => n.id)).toEqual(['s1'])
  })

  it('keeps a many-tile template inside D1 per-invocation query budget', async () => {
    // One statement per tile put a 48-chunk template at 51 — template, version, 48 tiles, pointer —
    // against the 50 D1 allows per Worker invocation on the free plan. A 48,000x1 one-colour upload
    // reaches that without stressing memory or R2, so the whole batch failed on a legal template.
    const chunks = Array.from({ length: 48 }, (_, index) => ({
      tileX: index,
      tileY: 0,
      hash: index.toString(16).padStart(64, '0'),
    }))
    d1.sqlite.exec("INSERT INTO nodes VALUES ('bulk-node', 1, NULL, '/bulk', 'Bulk', NULL, 1)")
    const before = d1.batchStatements

    await store.insertTemplateVersion({
      templateId: 'bulk-t',
      nodeId: 'bulk-node',
      name: 'Bulk',
      versionId: 'bulk-v',
      createdWithToken: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      createdByUserId: null,
      createdAt: millis(1_000),
      bbox: { minX: 0, minY: 0, maxX: 48_000, maxY: 1 },
      totalPixels: 48,
      chunks,
    })

    expect(d1.sqlite.prepare('SELECT COUNT(*) AS tiles FROM version_tiles').all()).toEqual([
      { tiles: 48 },
    ])
    expect(d1.batchStatements - before).toBeLessThanOrEqual(50)
  })

  it('orders tokens minted in the same millisecond by hash, as the port promises', async () => {
    // SQL leaves equal ORDER BY keys unspecified, so the adapters could return different arrays for
    // one input — the memory store applies the port's tiebreak and D1 did not. Date.now() is
    // millisecond-resolution and scripted provisioning mints a read and a report token in one tick.
    for (const hash of ['c', 'a', 'b']) {
      await store.insertAccessToken({
        tokenHash: hash.repeat(64),
        label: hash,
        scope: 'read',
        createdWithToken: 'bootstrap',
        createdAt: millis(1_000),
      })
    }

    await expect(store.listAccessTokens()).resolves.toMatchObject([
      { label: 'a' },
      { label: 'b' },
      { label: 'c' },
    ])
  })

  it('lists tokens newest first', async () => {
    for (const [index, createdAt] of [3_000, 1_000, 2_000].entries()) {
      await store.insertAccessToken({
        tokenHash: `${index}`.repeat(64),
        label: `${createdAt}`,
        scope: 'read',
        createdWithToken: 'bootstrap',
        createdAt: millis(createdAt),
      })
    }
    await expect(store.listAccessTokens()).resolves.toMatchObject([
      { label: '3000' },
      { label: '2000' },
      { label: '1000' },
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
      d1.sqlite.exec("INSERT INTO nodes VALUES ('n1', 1, NULL, '/canada', 'Canada', NULL, 1)")
      expect(() =>
        d1.sqlite
          .prepare('INSERT INTO nodes VALUES (?, 1, NULL, ?, ?, NULL, 1)')
          .run('n2', path, 'Other'),
      ).toThrow(/UNIQUE constraint failed|constraint failed/)
    },
  )

  it.each([
    ['south below -90', '45, -91, -10, 10'],
    ['west below -180', '45, -45, -181, 10'],
    ['east above 180', '45, -45, -10, 181'],
    // Each range is a BETWEEN, and only one end of each was ever probed, so the other end of any of
    // them could be dropped with the suite green. north > south keeps the two latitudes ordered, so
    // these reach the range clause rather than being rejected by the ordering one.
    ['north below -90', '-91, -92, -10, 10'],
    ['south above 90', '92, 91, -10, 10'],
    ['west above 180', '45, -45, 181, 182'],
    ['east below -180', '45, -45, -182, -181'],
  ])('rejects native bounds with %s', (label, bounds) => {
    // The test above names longitude and only ever probes bounds_north, so the south range and both
    // longitude ranges were deletable. Matching the message too: a bare .toThrow() accepts
    // "no such table" as readily as a constraint failure, which this file's own comment argues
    // against.
    d1.sqlite.exec(`
      INSERT OR IGNORE INTO nodes VALUES ('bounds-node', 1, NULL, '/bounds', 'Bounds', NULL, 1);
      INSERT OR IGNORE INTO templates VALUES ('bounds-template', 'bounds-node', 'T', NULL, NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1);
    `)
    expect(() =>
      d1.sqlite
        .prepare(
          `INSERT INTO template_versions VALUES ('${label.replace(/\s/g, '-')}', 'bounds-template', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 0, 0, 1, 1, 1, ${bounds})`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/)
  })

  it.each([
    [
      'version_tiles keeps one row per tile of a version',
      "INSERT INTO version_tiles VALUES ('v1', 0, 0, '6666666666666666666666666666666666666666666666666666666666666666'), ('v1', 0, 1, '6666666666666666666666666666666666666666666666666666666666666666')",
    ],
    [
      'contributions keeps one row per user, template, day and reporter',
      "INSERT INTO contributions VALUES (1, 'ct', 0, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1, 1, 0), (1, 'ct', 86400, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1, 1, 0)",
    ],
    [
      'contributions separate two accounts sharing one reporter token',
      "INSERT INTO contributions VALUES (2, 'ct', 0, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 11, 1, 1, 0), (2, 'ct', 0, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 22, 1, 1, 0)",
    ],
    [
      'tile_history keeps one row per tile, tier and bucket',
      "INSERT INTO tile_history VALUES (0, 0, 0, 0, '6666666666666666666666666666666666666666666666666666666666666666', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7), (0, 0, 0, 60, '6666666666666666666666666666666666666666666666666666666666666666', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7)",
    ],
  ])('%s', (_label, statement) => {
    // Nothing references access_tokens — reported_with_token is a shape-checked digest, not a foreign key —
    // so these rows exist only because the assertions read them back.
    // Each composite primary key is the identity the draft specifies. Dropping a component makes
    // these two rows collide, so the insert throws — nothing else in the suite writes two rows that
    // differ only in the trailing key column.
    d1.sqlite.exec(`
      INSERT OR IGNORE INTO nodes VALUES ('pk-node', 1, NULL, '/pk', 'PK', NULL, 1);
      INSERT OR IGNORE INTO templates VALUES ('ct', 'pk-node', 'T', NULL, NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 1);
      INSERT OR IGNORE INTO template_versions VALUES ('v1', 'ct', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 0, 0, 1, 1, 1, NULL, NULL, NULL, NULL);
    `)
    expect(() => d1.sqlite.prepare(statement).run()).not.toThrow()
  })
})
