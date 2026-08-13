import { millis, seconds } from '@wts/shared'
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

  it('rejects a replayed event id regardless of the claimed user', () => {
    // The replay guard has to key on the event id alone. Keying it with the attacker-supplied user
    // would let one captured event be replayed once per fabricated identity.
    d1.sqlite.exec("INSERT INTO applied_events VALUES ('e1', 100, 1000)")
    expect(() =>
      d1.sqlite.prepare("INSERT INTO applied_events VALUES ('e1', 200, 2000)").run(),
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/)
  })
})
