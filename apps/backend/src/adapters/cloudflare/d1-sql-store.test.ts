import { millis, seconds, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TelemetryBucket, TemplateVersionRecord } from '../../ports/index.js'
import {
  NodeNotFoundError,
  NodePathConflictError,
  NodePathTooLongError,
} from '../../ports/index.js'
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
  surface: { kind: 'world', allianceId: null },
  season: 1,
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

  it('retains a status revision for equal fingerprints and advances it atomically on change', async () => {
    await expect(
      store.commitStatusProjectionRevision(4, 0, 'a'.repeat(64), 'b'.repeat(64)),
    ).resolves.toBe(1)
    await expect(
      store.commitStatusProjectionRevision(4, 1, 'a'.repeat(64), 'b'.repeat(64)),
    ).resolves.toBe(1)
    await expect(
      store.commitStatusProjectionRevision(4, 1, 'c'.repeat(64), 'b'.repeat(64)),
    ).resolves.toBe(2)

    const recovered = new D1SqlStore(d1 as unknown as D1Database)
    await expect(
      recovered.commitStatusProjectionRevision(4, 2, 'c'.repeat(64), 'b'.repeat(64)),
    ).resolves.toBe(2)
  })

  it('commits tile status and its revision together and fences a stale reconciliation', async () => {
    await store.insertNode({
      id: 'node-1',
      season: 1,
      parentId: null,
      path: '/node',
      name: 'Node',
      description: null,
      createdAt: millis(1_000),
    })
    await store.insertTemplateVersion(templateVersion())
    const hash = 'd'.repeat(64)
    await expect(
      store.reserveTileBlobUpload(hash, hash, 'reservation', millis(1_000), millis(5_000)),
    ).resolves.not.toBeNull()

    await expect(
      store.commitTileBlobReservation(
        'reservation',
        millis(2_000),
        {
          season: 1,
          tile: { x: 0, y: 0 },
          hash,
          observedAt: millis(2_000),
          reportedAt: seconds(2),
          reportedWithToken: 'c'.repeat(64),
          reportedByUserId: 42,
        },
        [
          {
            templateId: 'template-1',
            versionId: 'version-1',
            tile: { x: 0, y: 0 },
            correct: 1,
            wrong: 0,
            blank: 0,
            observedAt: millis(2_000),
          },
        ],
        false,
      ),
    ).resolves.toMatchObject({ revision: 1, statusChanges: [{ previous: null }] })
    await expect(store.readStatusProjectionRevision(1)).resolves.toBe(1)
    await expect(
      store.commitStatusProjectionRevision(1, 0, 'a'.repeat(64), 'b'.repeat(64)),
    ).resolves.toBeNull()
    await expect(
      store.commitStatusProjectionRevision(1, 1, 'a'.repeat(64), 'b'.repeat(64)),
    ).resolves.toBe(1)
  })

  it('uses hash indexes for tile blob reference checks', () => {
    for (const [table, indexName] of [
      ['tile_history', 'tile_history_sha256_idx'],
      ['canvas_tiles', 'canvas_tiles_sha256_idx'],
    ] as const) {
      const plan = d1.sqlite
        .prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE sha256 = ? LIMIT 1`)
        .all('a'.repeat(64)) as Array<{ detail: string }>
      expect(plan.some(({ detail }) => detail.includes(`USING COVERING INDEX ${indexName}`))).toBe(
        true,
      )
    }
  })

  it('counts the old path in characters, not UTF-16 units, when moving a subtree', async () => {
    // SQLite's `length()` and `substr()` count characters; JavaScript's `.length` counts UTF-16
    // units, and an astral character is two of them. Deriving the SQL offset in JavaScript therefore
    // cut one unit too far into every descendant for each astral character in the ancestor's path —
    // silently, and only against real D1, since the memory store slices in the same units it counts.
    const base = { season: 1, description: null, createdAt: millis(1_000) }
    await store.insertNode({ ...base, id: 'r', parentId: null, path: '/𝐀', name: '𝐀' })
    await store.insertNode({ ...base, id: 'k', parentId: 'r', path: '/𝐀/x', name: 'x' })
    await store.renameNode('r', 'Plain', 'plain')

    expect((await store.readNode('k'))?.path).toBe('/plain/x')
  })

  it('retries a parent-only move from a rename that lands before its batch', async () => {
    const base = { season: 1, description: null, createdAt: millis(1_000) }
    await store.insertNode({
      ...base,
      id: 'destination',
      parentId: null,
      path: '/destination',
      name: 'Destination',
    })
    await store.insertNode({
      ...base,
      id: 'source',
      parentId: null,
      path: '/alpha',
      name: 'Alpha',
    })
    d1.runBeforeNextBatch(() => {
      d1.sqlite.prepare("UPDATE nodes SET name = 'Beta', path = '/beta' WHERE id = 'source'").run()
    })

    await expect(store.moveNode('source', 'destination', '/destination/alpha')).resolves.toBe(true)

    await expect(store.readNode('source')).resolves.toMatchObject({
      name: 'Beta',
      parentId: 'destination',
      path: '/destination/beta',
    })
  })

  it('renames under the live parent when a move lands before its batch', async () => {
    const base = { season: 1, description: null, createdAt: millis(1_000) }
    await store.insertNode({
      ...base,
      id: 'old-parent',
      parentId: null,
      path: '/old',
      name: 'Old',
    })
    await store.insertNode({
      ...base,
      id: 'new-parent',
      parentId: null,
      path: '/new',
      name: 'New',
    })
    await store.insertNode({
      ...base,
      id: 'source',
      parentId: 'old-parent',
      path: '/old/source',
      name: 'Source',
    })
    d1.runBeforeNextBatch(() => {
      d1.sqlite
        .prepare(
          "UPDATE nodes SET parent_id = 'new-parent', path = '/new/source' WHERE id = 'source'",
        )
        .run()
    })

    await store.renameNode('source', 'Renamed', 'renamed')

    await expect(store.readNode('source')).resolves.toMatchObject({
      parentId: 'new-parent',
      path: '/new/renamed',
      name: 'Renamed',
    })
  })

  it('uses the live subtree path when a rename lands before cascade deletion', async () => {
    const base = { season: 1, description: null, createdAt: millis(1_000) }
    await store.insertNode({ ...base, id: 'root', parentId: null, path: '/root', name: 'Root' })
    await store.insertNode({
      ...base,
      id: 'child',
      parentId: 'root',
      path: '/root/child',
      name: 'Child',
    })
    d1.runBeforeNextBatch(() => {
      d1.sqlite.prepare("UPDATE nodes SET path = '/renamed' WHERE id = 'root'").run()
      d1.sqlite.prepare("UPDATE nodes SET path = '/renamed/child' WHERE id = 'child'").run()
    })

    await expect(store.deleteNodeCascade('root', { nodes: 2, templates: 0 })).resolves.toEqual({
      nodes: 2,
      templates: 0,
    })
    await expect(store.readNode('root')).resolves.toBeNull()
    await expect(store.readNode('child')).resolves.toBeNull()
  })

  it('maps an oversized composed path to the port error', async () => {
    // The route bounds the path it derived, but the prefix actually written comes from the parent
    // row — which a rename may have lengthened since. D1 hit `nodes_path_check` and let a bare error
    // escape as a 500; the memory store had no length guard at all and stored a path the wire
    // refuses.
    const base = { season: 1, description: null, createdAt: millis(1_000) }
    await store.insertNode({
      ...base,
      id: 'p',
      parentId: null,
      path: `/${'p'.repeat(250)}`,
      name: 'p',
    })

    await expect(
      store.insertNode({
        ...base,
        id: 'c',
        parentId: 'p',
        path: `/${'x'.repeat(20)}`,
        name: 'x',
      }),
    ).rejects.toBeInstanceOf(NodePathTooLongError)
  })

  it('folds only ASCII when deciding a rename collides', async () => {
    // `lower()` in SQLite folds ASCII and nothing else, so `/QUÉBEC` and `/québec` are two distinct
    // paths to the database. The memory store used `toLowerCase()`, which folds `É`, and refused a
    // rename production would have accepted.
    const base = { season: 1, description: null, createdAt: millis(1_000) }
    await store.insertNode({ ...base, id: 'a', parentId: null, path: '/QUÉBEC', name: 'QUÉBEC' })
    await store.insertNode({ ...base, id: 'b', parentId: null, path: '/other', name: 'Other' })

    expect((await store.renameNode('b', 'québec', 'québec'))?.path).toBe('/québec')
  })

  it('does not report an id collision as a path conflict', async () => {
    // `nodes` has two unique constraints and the translation matched the bare string, so a
    // primary-key collision came back as "node path is already taken" — the wrong reason, the wrong
    // recovery, and a different class of error than the memory store gives for the same input.
    const node = {
      season: 1,
      parentId: null,
      description: null,
      createdAt: millis(1_000),
    }
    const id = '01890f3a-6b7c-7def-8123-456789abcde2'
    await store.insertNode({ ...node, id, path: '/first', name: 'First' })

    await expect(
      store.insertNode({ ...node, id, path: '/second', name: 'Second' }),
    ).rejects.not.toBeInstanceOf(NodePathConflictError)
  })

  it('answers a node deleted under its guard read the same way the guard would', async () => {
    // `insertTemplateVersion` checks the node exists and then writes, and the check is a separate
    // statement — a concurrent delete lands between them (allowed, since no template referenced the
    // node yet) and the foreign key is what notices. Untranslated, losing that race was the one path
    // that answered 500 for what the route means as a 400.
    //
    // A single-threaded test cannot open the real window, so the guard read is made to lie instead:
    // that exercises the same translation the race reaches. Same shape as `insertNode` and
    // `deleteNode`, which commit fe4c50e fixed and this site was left out of.
    const nodeId = '01890f3a-6b7c-7def-8123-456789abcde1'
    store.readNode = async () => ({
      id: nodeId,
      season: 1,
      parentId: null,
      path: '/gone',
      name: 'Gone',
      description: null,
      createdAt: millis(1_000),
    })

    await expect(store.insertTemplateVersion(templateVersion({ nodeId }))).rejects.toBeInstanceOf(
      NodeNotFoundError,
    )
  })

  it('reports a duplicate path as a conflict rather than letting the driver error escape', async () => {
    // The in-memory store threw NodePathConflictError here and D1 did not, because Drizzle wraps the
    // database error: its own message is only "Failed query: insert into …" and the constraint text
    // lives on `cause`, with D1 adding a further layer. Checking `error.message` alone matched
    // neither, so a duplicate folder name surfaced as a 500. Only reproducible against real D1,
    // which is why it belongs in this file and not beside the memory adapter.
    const node = {
      season: 1,
      parentId: null,
      path: '/duplicate',
      name: 'Duplicate',
      description: null,
      createdAt: millis(1_750_000_000_000),
    }
    await store.insertNode({ ...node, id: '01890f3a-6b7c-7def-8123-4567890abcd1' })

    await expect(
      store.insertNode({ ...node, id: '01890f3a-6b7c-7def-8123-4567890abcd2' }),
    ).rejects.toBeInstanceOf(NodePathConflictError)
  })

  it('writes a template, version, tile index and current pointer in one batch', async () => {
    d1.sqlite
      .prepare("INSERT INTO nodes VALUES ('node-1', 1, NULL, '/node-1', 'Node', NULL, NULL, 1)")
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
      .prepare("INSERT INTO nodes VALUES ('node-1', 1, NULL, '/node-1', 'Node', NULL, NULL, 1)")
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

  it('stores current tile anchors and aggregates only the current template version', async () => {
    await store.insertNode({
      id: 'node-1',
      season: 1,
      parentId: null,
      path: '/node',
      name: 'Node',
      description: null,
      createdAt: millis(1_000),
    })
    await store.insertTemplateVersion(
      templateVersion({
        colourTotals: [
          { index: 0, total: 1 },
          { index: 1, total: 1 },
        ],
      }),
    )
    const tokenHash = 'c'.repeat(64)
    await store.recordTileObservation(
      {
        season: 1,
        tile: { x: 0, y: 0 },
        hash: 'd'.repeat(64),
        observedAt: millis(2_000),
        reportedAt: seconds(2),
        reportedWithToken: tokenHash,
        reportedByUserId: 42,
      },
      [
        {
          templateId: 'template-1',
          versionId: 'version-1',
          tile: { x: 0, y: 0 },
          correct: 1,
          wrong: 1,
          blank: 0,
          colours: [
            { index: 0, correct: 1, wrong: 0, blank: 0, total: 1 },
            { index: 1, correct: 0, wrong: 1, blank: 0, total: 1 },
          ],
          observedAt: millis(2_000),
        },
      ],
    )
    // An older upload may finish later. It belongs in history but cannot replace current truth.
    await store.recordTileObservation(
      {
        season: 1,
        tile: { x: 0, y: 0 },
        hash: 'e'.repeat(64),
        observedAt: millis(1_000),
        reportedAt: seconds(1),
        reportedWithToken: tokenHash,
        reportedByUserId: 42,
      },
      [
        {
          templateId: 'template-1',
          versionId: 'version-1',
          tile: { x: 0, y: 0 },
          correct: 0,
          wrong: 0,
          blank: 2,
          colours: [
            { index: 0, correct: 0, wrong: 0, blank: 1, total: 1 },
            { index: 1, correct: 0, wrong: 0, blank: 1, total: 1 },
          ],
          observedAt: millis(1_000),
        },
      ],
    )
    await store.recordTileObservation(
      {
        season: 2,
        tile: { x: 0, y: 0 },
        hash: 'f'.repeat(64),
        observedAt: millis(3_000),
        reportedAt: seconds(3),
        reportedWithToken: tokenHash,
        reportedByUserId: 42,
      },
      [],
    )

    await expect(store.readLatestTile(1, { x: 0, y: 0 })).resolves.toMatchObject({
      season: 1,
      hash: 'd'.repeat(64),
      observedAt: 2_000,
    })
    await expect(store.readLatestTile(2, { x: 0, y: 0 })).resolves.toMatchObject({
      season: 2,
      hash: 'f'.repeat(64),
      observedAt: 3_000,
    })
    await expect(store.readTemplateStatuses(1, true)).resolves.toEqual([
      {
        templateId: 'template-1',
        correct: 1,
        wrong: 1,
        blank: 0,
        total: 2,
        colours: [
          { index: 0, correct: 1, wrong: 0, blank: 0, total: 1 },
          { index: 1, correct: 0, wrong: 1, blank: 0, total: 1 },
        ],
        observedAt: 2_000,
      },
    ])
  })

  it('recovers a legacy version colour histogram from complete classified tile rows', async () => {
    await store.insertNode({
      id: 'node-1',
      season: 1,
      parentId: null,
      path: '/node',
      name: 'Node',
      description: null,
      createdAt: millis(1_000),
    })
    await store.insertTemplateVersion(templateVersion())
    await store.recordTileObservation(
      {
        season: 1,
        tile: { x: 0, y: 0 },
        hash: 'd'.repeat(64),
        observedAt: millis(2_000),
        reportedAt: seconds(2),
        reportedWithToken: 'c'.repeat(64),
        reportedByUserId: 42,
      },
      [
        {
          templateId: 'template-1',
          versionId: 'version-1',
          tile: { x: 0, y: 0 },
          correct: 1,
          wrong: 0,
          blank: 1,
          colours: [
            { index: 4, correct: 1, wrong: 0, blank: 0, total: 1 },
            { index: 9, correct: 0, wrong: 0, blank: 1, total: 1 },
          ],
          observedAt: millis(2_000),
        },
      ],
    )

    await expect(store.readTemplateStatuses(1, true)).resolves.toEqual([
      {
        templateId: 'template-1',
        correct: 1,
        wrong: 0,
        blank: 1,
        total: 2,
        colours: [
          { index: 4, correct: 1, wrong: 0, blank: 0, total: 1 },
          { index: 9, correct: 0, wrong: 0, blank: 1, total: 1 },
        ],
        observedAt: 2_000,
      },
    ])
  })

  it('claims paint event ids once', async () => {
    await expect(store.claimPaintEvent('event-1', 42, millis(1_000))).resolves.toBe(true)
    await expect(store.claimPaintEvent('event-1', 42, millis(2_000))).resolves.toBe(false)
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

  it('records who created a template and when, alongside each version upload', () => {
    // The template is the thing that gets renamed, moved and deleted, and it had a creation time
    // and no author — only its versions recorded one. Attribution is the same pair a report is
    // attributed to, so "who uploaded this" answers with a credential and an account.
    d1.sqlite.exec(`
      INSERT INTO nodes VALUES ('attr-node', 1, NULL, '/attr', 'Attr', NULL, NULL, 1);
      INSERT INTO templates (
        id, season, surface_kind, alliance_id, node_id, name, current_version_id, published_at,
        created_with_token, created_by_user_id, created_at_ms, updated_at_ms,
        timelapse_frozen_at_ms, finished_at_ms
      ) VALUES (
        'attr-t', 1, 'world', NULL, 'attr-node', 'T', NULL, NULL,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 42, 1700, 1700,
        NULL, NULL
      );
      INSERT INTO template_versions (
        id, template_id, created_at_ms, created_with_token, created_by_user_id,
        min_x, min_y, max_x, max_y, total_pixels
      ) VALUES (
        'attr-v', 'attr-t', 1800,
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        99, 0, 0, 1, 1, 1
      );
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

  it('keeps a many-tile template inside D1 per-invocation query budget', async () => {
    // One statement per tile put a 48-chunk template at 51 — template, version, 48 tiles, pointer —
    // against the 50 D1 allows per Worker invocation on the free plan. A 48,000x1 one-colour upload
    // reaches that without stressing memory or R2, so the whole batch failed on a legal template.
    const chunks = Array.from({ length: 48 }, (_, index) => ({
      tileX: index,
      tileY: 0,
      hash: index.toString(16).padStart(64, '0'),
    }))
    d1.sqlite.exec(
      "INSERT INTO nodes VALUES ('bulk-node', 1, NULL, '/bulk', 'Bulk', NULL, NULL, 1)",
    )
    const before = d1.batchStatements

    await store.insertTemplateVersion({
      templateId: 'bulk-t',
      surface: { kind: 'world', allianceId: null },
      season: 1,
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

  it('replaces an existing template without validating its stale submitted folder or name', async () => {
    const base = { season: 1, parentId: null, description: null, createdAt: millis(1_000) }
    await store.insertNode({ ...base, id: 'node-1', path: '/old', name: 'Old' })
    await store.insertNode({ ...base, id: 'node-2', path: '/new', name: 'New' })
    await store.insertTemplateVersion(templateVersion())
    await store.updateTemplate('template-1', { nodeId: 'node-2', name: 'Renamed' }, millis(2_000))
    await store.deleteNode('node-1')

    await expect(
      store.insertTemplateVersion(
        templateVersion({ versionId: 'version-2', createdAt: millis(3_000) }),
        { requireExisting: true },
      ),
    ).resolves.toBeUndefined()
    await expect(store.readTemplate('template-1')).resolves.toMatchObject({
      nodeId: 'node-2',
      name: 'Renamed',
      currentVersionId: 'version-2',
    })
  })

  it('deletes contribution rows before their template', async () => {
    d1.sqlite.exec("INSERT INTO nodes VALUES ('node-1', 1, NULL, '/node-1', 'Node', NULL, NULL, 1)")
    await store.insertTemplateVersion(templateVersion())
    d1.sqlite
      .prepare('INSERT INTO contributions VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(1, 'template-1', 0, 'c'.repeat(64), 1, 1, 1, 0)

    await expect(
      store.deleteTemplate('template-1', {
        versionId: 'version-1',
        updatedAt: millis(1_000),
      }),
    ).resolves.toBe(true)
    expect(d1.sqlite.prepare('SELECT COUNT(*) AS count FROM contributions').get()).toEqual({
      count: 0,
    })
  })

  it('keeps a newer template revision when deletion presents a stale precondition', async () => {
    d1.sqlite.exec("INSERT INTO nodes VALUES ('node-1', 1, NULL, '/node-1', 'Node', NULL, NULL, 1)")
    await store.insertTemplateVersion(templateVersion())
    await store.insertTemplateVersion(
      templateVersion({ versionId: 'version-2', createdAt: millis(2_000) }),
      { requireExisting: true },
    )

    await expect(
      store.deleteTemplate('template-1', {
        versionId: 'version-1',
        updatedAt: millis(1_000),
      }),
    ).resolves.toBe(false)
    await expect(store.readTemplate('template-1')).resolves.toMatchObject({
      currentVersionId: 'version-2',
      updatedAt: millis(2_000),
    })
    expect(d1.sqlite.prepare('SELECT COUNT(*) AS count FROM template_versions').get()).toEqual({
      count: 2,
    })
  })

  it('deletes a subtree whose root path exceeds D1s LIKE pattern limit', async () => {
    const base = { season: 1, description: null, createdAt: millis(1_000) }
    const path = `/${'deep'.repeat(15)}`
    await store.insertNode({ ...base, id: 'deep-root', parentId: null, path, name: 'Deep root' })
    await store.insertNode({
      ...base,
      id: 'deep-child',
      parentId: 'deep-root',
      path: `${path}/child`,
      name: 'Child',
    })

    await expect(store.deleteNodeCascade('deep-root', { nodes: 2, templates: 0 })).resolves.toEqual(
      { nodes: 2, templates: 0 },
    )
    await expect(store.listNodes(1)).resolves.toEqual([])
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
    await expect(
      store.listAccessTokens({
        after: { createdAt: millis(1_000), tokenHash: 'b'.repeat(64) },
        limit: 1,
      }),
    ).resolves.toMatchObject([{ label: 'c' }])
  })

  it('rejects a replayed event id regardless of the claimed user', () => {
    // The replay guard has to key on the event id alone. Keying it with the attacker-supplied user
    // would let one captured event be replayed once per fabricated identity.
    d1.sqlite.exec("INSERT INTO applied_events VALUES ('e1', 100, 1000)")
    expect(() =>
      d1.sqlite.prepare("INSERT INTO applied_events VALUES ('e1', 200, 2000)").run(),
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/)
  })

  // The manifest's two filters live in SQL and nowhere else: `assemble` is tested against the
  // in-memory store, so a dropped predicate here would serve drafts or another season with the
  // whole suite green. A client asking for a manifest is the actor.
  it('lists only published templates of the asked-for season', async () => {
    d1.sqlite
      .prepare("INSERT INTO nodes VALUES ('node-1', 1, NULL, '/node-1', 'Node', NULL, NULL, 1)")
      .run()
    d1.sqlite
      .prepare("INSERT INTO nodes VALUES ('node-2', 2, NULL, '/node-2', 'Other', NULL, NULL, 1)")
      .run()
    await store.insertTemplateVersion(templateVersion())
    await store.insertTemplateVersion(
      templateVersion({ templateId: 'draft', versionId: 'version-draft' }),
    )
    await store.insertTemplateVersion(
      templateVersion({
        templateId: 'alliance',
        versionId: 'version-alliance',
        surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
        bbox: { minX: -1, minY: -1, maxX: 0, maxY: 0 },
        totalPixels: 1,
        chunks: [{ tileX: -1, tileY: -1, hash: 'c'.repeat(64) }],
      }),
    )
    await store.insertTemplateVersion(
      templateVersion({
        templateId: 'other',
        versionId: 'version-other',
        season: 2,
        nodeId: 'node-2',
      }),
    )
    await store.setTemplatePublishedAt('template-1', millis(5_000), millis(5_000))
    await store.setTemplatePublishedAt('alliance', millis(5_000), millis(5_000))
    await store.setTemplatePublishedAt('other', millis(5_000), millis(5_000))

    const ids = async (includeUnpublished: boolean): Promise<string[]> =>
      (
        await store.listManifestTemplates(
          { season: 1, surface: WORLD_TEMPLATE_SURFACE },
          includeUnpublished,
        )
      )
        .map((row) => row.id)
        .sort()

    await expect(ids(false)).resolves.toEqual(['template-1'])
    // The same call including drafts still refuses the other season. Sorted, because the query has
    // no ORDER BY — the assembler sorts these itself, so row order here is SQLite's to choose.
    await expect(ids(true)).resolves.toEqual(['draft', 'template-1'])
    await expect(
      store.listManifestTemplates(
        {
          season: 1,
          surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
        },
        false,
      ),
    ).resolves.toMatchObject([{ id: 'alliance' }])
  })

  it('lists only tiles of published templates of the asked-for season', async () => {
    d1.sqlite
      .prepare("INSERT INTO nodes VALUES ('node-1', 1, NULL, '/node-1', 'Node', NULL, NULL, 1)")
      .run()
    d1.sqlite
      .prepare("INSERT INTO nodes VALUES ('node-2', 2, NULL, '/node-2', 'Other', NULL, NULL, 1)")
      .run()
    await store.insertTemplateVersion(templateVersion())
    await store.insertTemplateVersion(
      templateVersion({ templateId: 'draft', versionId: 'version-draft' }),
    )
    await store.insertTemplateVersion(
      templateVersion({
        templateId: 'alliance',
        versionId: 'version-alliance',
        surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
        bbox: { minX: -1, minY: -1, maxX: 0, maxY: 0 },
        totalPixels: 1,
        chunks: [{ tileX: -1, tileY: -1, hash: 'c'.repeat(64) }],
      }),
    )
    await store.insertTemplateVersion(
      templateVersion({
        templateId: 'other',
        versionId: 'version-other',
        season: 2,
        nodeId: 'node-2',
      }),
    )
    await store.setTemplatePublishedAt('template-1', millis(5_000), millis(5_000))
    await store.setTemplatePublishedAt('alliance', millis(5_000), millis(5_000))
    await store.setTemplatePublishedAt('other', millis(5_000), millis(5_000))

    const owners = async (includeUnpublished: boolean): Promise<string[]> =>
      [
        ...new Set(
          (
            await store.listManifestTiles(
              { season: 1, surface: WORLD_TEMPLATE_SURFACE },
              includeUnpublished,
            )
          ).map((t) => t.templateId),
        ),
      ].sort()

    await expect(owners(false)).resolves.toEqual(['template-1'])
    // Both arms carry the season predicate, and only this one carries it alone: without the call
    // below, deleting it leaks the other season's tiles while everything stays green.
    await expect(owners(true)).resolves.toEqual(['draft', 'template-1'])
    await expect(
      store.listManifestTiles(
        {
          season: 1,
          surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
        },
        false,
      ),
    ).resolves.toMatchObject([{ templateId: 'alliance', tileX: -1, tileY: -1 }])
  })
})
