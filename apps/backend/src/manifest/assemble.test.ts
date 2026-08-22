import { millis, type ServerInfo } from '@caelestis/shared'
import { Manifest } from '@caelestis/wire-schema'
import { Schema } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import type { NodeRecord, TemplateVersionRecord } from '../ports/index.js'
import { assembleManifest } from './assemble.js'

/**
 * The acceptance-critical property nothing could test: does a manifest this server emits actually
 * decode against the schema every client validates it with?
 *
 * `apps/backend` did not depend on `@caelestis/wire-schema` at all — not even for tests — so the question
 * had no way to be asked, and the answer was no. Two templates in one node with intersecting boxes
 * are a normal admin action, and the wire refuses the result.
 */
const expectDecodes = (manifest: unknown) => {
  expect(() => Schema.decodeUnknownSync(Manifest)(manifest)).not.toThrow()
}

const server: ServerInfo = {
  id: '01890f3a-6b7c-7def-8123-456789abcdef',
  name: 'Server',
  auth: 'access_token',
}
const createdAt = millis(1_750_000_000_000)
const node: NodeRecord = {
  id: '01890f3a-6b7c-7def-8123-456789abcde0',
  season: 1,
  parentId: null,
  path: '/group',
  name: 'Group',
  description: null,
  createdAt,
}

const version = (templateId: string, versionId: string, tileX: number): TemplateVersionRecord => ({
  templateId,
  nodeId: node.id,
  name: `Template ${tileX}`,
  versionId,
  createdWithToken: 'a'.repeat(64),
  createdByUserId: null,
  createdAt,
  bbox: { minX: tileX * 1_000, minY: 0, maxX: tileX * 1_000 + 1, maxY: 1 },
  totalPixels: 1,
  chunks: [{ tileX, tileY: 0, hash: String(tileX).padStart(64, 'a') }],
})

/**
 * A store that returns every list reversed.
 *
 * `MemorySqlStore` sorts its own output, so the assembler's sorts cannot be exercised through it —
 * dropping them left the whole suite green. The assembler owns the content hash, so it has to be
 * deterministic regardless of what order a store hands rows back in, and only a store that returns
 * them in a different order can prove that.
 */
const reversing = (inner: MemorySqlStore): MemorySqlStore =>
  new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      if (property !== 'listNodes' && property !== 'listManifestTemplates')
        return value.bind(target)
      return async (...args: unknown[]) => {
        const rows = (await (value as (...a: unknown[]) => Promise<unknown[]>).apply(
          target,
          args,
        )) as unknown[]
        return [...rows].reverse()
      }
    },
  })

describe('assembleManifest', () => {
  let sql: MemorySqlStore

  beforeEach(async () => {
    sql = new MemorySqlStore()
    await sql.insertNode(node)
  })

  it('drops a template whose tiles a concurrent publish has not revealed yet', async () => {
    // The templates and tiles reads are not one snapshot. A publish landing between them shows the
    // template to the first query and not the second, and `chunks: []` is something the wire
    // refuses — so the torn read produced a 200 no client could decode rather than a slightly stale
    // one. Modelled by a store whose tile list is a read behind.
    const sql = new MemorySqlStore()
    await sql.insertNode(node)
    await sql.insertTemplateVersion(
      version('01890f3a-6b7c-7def-8123-4560000000c1', '01890f3a-6b7c-7def-8123-4560000000c2', 0),
    )
    await sql.setTemplatePublishedAt('01890f3a-6b7c-7def-8123-4560000000c1', createdAt, createdAt)
    const torn = {
      listNodes: sql.listNodes.bind(sql),
      listManifestTemplates: sql.listManifestTemplates.bind(sql),
      listManifestTiles: async () => [],
    } as unknown as MemorySqlStore

    const manifest = await assembleManifest(
      { sql: torn },
      { server, season: 1, includeUnpublished: false },
    )

    expect(manifest.templates).toEqual([])
    expectDecodes(manifest)
  })

  it('drops a template whose node a concurrent create has not revealed yet', async () => {
    // The other direction of the same tear, and the one that had no test: the node read can land
    // before a group is created while the template read lands after one is placed in it, leaving a
    // template naming a node the manifest does not carry. The wire refuses that just as firmly as
    // `chunks: []`, so the conjunct guarding it could be deleted and the whole suite stayed green.
    const sql = new MemorySqlStore()
    await sql.insertNode(node)
    await sql.insertTemplateVersion(
      version('01890f3a-6b7c-7def-8123-4560000000d1', '01890f3a-6b7c-7def-8123-4560000000d2', 0),
    )
    await sql.setTemplatePublishedAt('01890f3a-6b7c-7def-8123-4560000000d1', createdAt, createdAt)
    const torn = {
      listNodes: async () => [],
      listManifestTemplates: sql.listManifestTemplates.bind(sql),
      listManifestTiles: sql.listManifestTiles.bind(sql),
    } as unknown as MemorySqlStore

    const manifest = await assembleManifest(
      { sql: torn },
      { server, season: 1, includeUnpublished: false },
    )

    expect(manifest.templates).toEqual([])
    expectDecodes(manifest)
  })

  it('refuses a season with more nodes than a manifest may carry', async () => {
    // Nodes and templates are bounded on the wire exactly as chunks are, and only chunks were
    // guarded. An over-cap season assembles no chunks at all, so it sailed past that guard and broke
    // at the client instead — a 200 nobody can decode, with nothing server-side naming the cause.
    const overCap = Array.from({ length: 100_001 }, (_, index) => ({
      ...node,
      id: `n${index}`,
      path: `/g${index}`,
    }))
    const flooded = {
      listNodes: async () => overCap,
      listManifestTemplates: async () => [],
      listManifestTiles: async () => [],
    } as unknown as MemorySqlStore

    await expect(
      assembleManifest({ sql: flooded }, { server, season: 1, includeUnpublished: false }),
    ).rejects.toThrow(/assembles 100001 nodes, more than the 100000/)
  })

  it('emits a decodable manifest when two templates in a group overlap', async () => {
    // Overlapping templates in one group are the point, not a fault: that is how a group layers, and
    // the client's own ordering decides what draws on top. The wire used to refuse it, so two
    // ordinary uploads into one group produced a 200 every client rejected — the constraint was
    // wrong, not the data, and it is gone.
    const sql = new MemorySqlStore()
    await sql.insertNode(node)
    const overlapping = (templateId: string, versionId: string): TemplateVersionRecord => ({
      ...version(templateId, versionId, 0),
      bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      chunks: [{ tileX: 0, tileY: 0, hash: 'b'.repeat(64) }],
    })
    const templateA = '01890f3a-6b7c-7def-8123-4560000000a1'
    const templateB = '01890f3a-6b7c-7def-8123-4560000000b1'
    await sql.insertTemplateVersion(overlapping(templateA, '01890f3a-6b7c-7def-8123-4560000000a2'))
    await sql.insertTemplateVersion(overlapping(templateB, '01890f3a-6b7c-7def-8123-4560000000b2'))
    await sql.setTemplatePublishedAt(templateA, createdAt, createdAt)
    await sql.setTemplatePublishedAt(templateB, createdAt, createdAt)

    const manifest = await assembleManifest(
      { sql },
      { server, season: 1, includeUnpublished: false },
    )

    expect(manifest.templates).toHaveLength(2)
    expectDecodes(manifest)
  })

  it('assembles the same version regardless of the order rows were written', async () => {
    // Assembling twice from one store pins that the *query* is stable, not that the *output* is
    // sorted — removing every sort in the assembler passes that test. Two stores holding identical
    // data written in opposite orders is what actually pins determinism, and it is what matters:
    // the version is a content hash, so an unsorted assembly makes every poll a full transfer.
    const ids = [
      '01890f3a-6b7c-7def-8123-456789abcd11',
      '01890f3a-6b7c-7def-8123-456789abcd22',
      '01890f3a-6b7c-7def-8123-456789abcd33',
    ]
    const versions = [
      '01890f3a-6b7c-7def-8123-456789abcd44',
      '01890f3a-6b7c-7def-8123-456789abcd55',
      '01890f3a-6b7c-7def-8123-456789abcd66',
    ]

    const extraNodes: NodeRecord[] = [
      { ...node, id: '01890f3a-6b7c-7def-8123-456789abcda1', path: '/alpha', name: 'Alpha' },
      { ...node, id: '01890f3a-6b7c-7def-8123-456789abcda2', path: '/beta', name: 'Beta' },
    ]

    const build = async (order: readonly number[]): Promise<string> => {
      const store = new MemorySqlStore()
      await store.insertNode(node)
      // Written in the same order as the templates, so a run that inserts backwards also stores its
      // nodes backwards — otherwise node ordering never varies and the sort stays unpinned.
      for (const index of order) {
        const extra = extraNodes[index % extraNodes.length]
        if (extra !== undefined && !(await store.readNode(extra.id))) await store.insertNode(extra)
      }
      for (const index of order) {
        // biome-ignore lint/style/noNonNullAssertion: index comes from the fixture arrays above
        await store.insertTemplateVersion(version(ids[index]!, versions[index]!, index))
        // biome-ignore lint/style/noNonNullAssertion: same
        await store.setTemplatePublishedAt(ids[index]!, createdAt, createdAt)
      }
      const manifest = await assembleManifest(
        { sql: store },
        { server, season: 1, includeUnpublished: false },
      )
      return manifest.version
    }

    const forwards = await build([0, 1, 2])
    const backwards = await build([2, 1, 0])

    expect(backwards).toBe(forwards)
  })

  it('sorts nodes and templates itself rather than trusting the store', async () => {
    // Against a store that returns rows reversed, the assembled document must still come out in id
    // order — otherwise the version hash depends on the adapter's iteration order and two adapters
    // holding identical data would disagree about the ETag.
    const ids = ['01890f3a-6b7c-7def-8123-456789abcdc1', '01890f3a-6b7c-7def-8123-456789abcdc2']
    const other: NodeRecord = {
      ...node,
      id: '01890f3a-6b7c-7def-8123-456789abcdc9',
      path: '/other',
      name: 'Other',
    }
    await sql.insertNode(other)
    for (const [index, id] of ids.entries()) {
      await sql.insertTemplateVersion(
        version(id, `01890f3a-6b7c-7def-8123-456789abcdd${index}`, index),
      )
      await sql.setTemplatePublishedAt(id, createdAt, createdAt)
    }

    const manifest = await assembleManifest(
      { sql: reversing(sql) },
      { server, season: 1, includeUnpublished: false },
    )

    expect(manifest.nodes.map((entry) => entry.id)).toEqual([node.id, other.id].sort())
    expect(manifest.templates.map((entry) => entry.id)).toEqual([...ids].sort())
  })

  it('emits multi-chunk templates with their chunks in tile order', async () => {
    // Same argument one level down: a template's chunks are hashed into the version, so their order
    // has to come from the tile key rather than from however the rows came back.
    const templateId = '01890f3a-6b7c-7def-8123-456789abcd77'
    const record: TemplateVersionRecord = {
      ...version(templateId, '01890f3a-6b7c-7def-8123-456789abcd88', 0),
      bbox: { minX: 0, minY: 0, maxX: 3_000, maxY: 1 },
      chunks: [
        { tileX: 2, tileY: 0, hash: 'c'.repeat(64) },
        { tileX: 0, tileY: 0, hash: 'a'.repeat(64) },
        { tileX: 1, tileY: 0, hash: 'b'.repeat(64) },
      ],
    }
    await sql.insertTemplateVersion(record)
    await sql.setTemplatePublishedAt(templateId, createdAt, createdAt)

    const manifest = await assembleManifest(
      { sql },
      { server, season: 1, includeUnpublished: false },
    )

    expect(manifest.templates[0]?.chunks.map((chunk) => chunk.tile)).toEqual(['0/0', '1/0', '2/0'])
    expect(manifest.tiles).toEqual(['0/0', '1/0', '2/0'])
  })

  it('sorts the tile union across templates, not just within one', async () => {
    // tiles is flattened from the templates in id order, so a template sorting first can contribute
    // a higher tile than one sorting later. Without its own sort the union comes out unsorted, and
    // the version hash changes with nothing but insertion order.
    const first = '01890f3a-6b7c-7def-8123-456789abcda7'
    const second = '01890f3a-6b7c-7def-8123-456789abcda8'
    await sql.insertTemplateVersion(version(first, '01890f3a-6b7c-7def-8123-456789abcdb7', 9))
    await sql.setTemplatePublishedAt(first, createdAt, createdAt)
    await sql.insertTemplateVersion(version(second, '01890f3a-6b7c-7def-8123-456789abcdb8', 1))
    await sql.setTemplatePublishedAt(second, createdAt, createdAt)

    const manifest = await assembleManifest(
      { sql },
      { server, season: 1, includeUnpublished: false },
    )

    // Template `first` sorts before `second` by id but covers tile 9/0, so an unsorted union would
    // read ['9/0', '1/0'].
    expect(manifest.tiles).toEqual(['1/0', '9/0'])
  })

  it('is deterministic and changes its hash when the assembled data changes', async () => {
    await sql.insertTemplateVersion(
      version('01890f3a-6b7c-7def-8123-456789abcde1', '01890f3a-6b7c-7def-8123-456789abcde2', 0),
    )
    await sql.setTemplatePublishedAt('01890f3a-6b7c-7def-8123-456789abcde1', createdAt, createdAt)

    const first = await assembleManifest({ sql }, { server, season: 1, includeUnpublished: false })
    const second = await assembleManifest({ sql }, { server, season: 1, includeUnpublished: false })
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first.version).toMatch(/^[0-9a-f]{64}$/)
    expect(first).toMatchObject({
      season: 1,
      server,
      nodes: [{ id: node.id, createdAt }],
      templates: [
        {
          id: '01890f3a-6b7c-7def-8123-456789abcde1',
          published: true,
          createdAt,
          chunks: [{ tile: '0/0' }],
        },
      ],
      tiles: ['0/0'],
    })

    await sql.insertNode({
      ...node,
      id: '01890f3a-6b7c-7def-8123-456789abcde9',
      path: '/another',
      name: 'Another',
    })
    const changed = await assembleManifest(
      { sql },
      { server, season: 1, includeUnpublished: false },
    )
    expect(changed.version).not.toBe(first.version)
  })

  it('omits unpublished templates for members and flags them for admins', async () => {
    const published = version(
      '01890f3a-6b7c-7def-8123-456789abcde1',
      '01890f3a-6b7c-7def-8123-456789abcde2',
      0,
    )
    const draft = version(
      '01890f3a-6b7c-7def-8123-456789abcde3',
      '01890f3a-6b7c-7def-8123-456789abcde4',
      1,
    )
    await sql.insertTemplateVersion(published)
    await sql.insertTemplateVersion(draft)
    await sql.setTemplatePublishedAt(published.templateId, createdAt, createdAt)

    const member = await assembleManifest({ sql }, { server, season: 1, includeUnpublished: false })
    const admin = await assembleManifest({ sql }, { server, season: 1, includeUnpublished: true })

    expect(member.templates).toHaveLength(1)
    expect(admin.templates.map(({ published }) => published)).toEqual([true, false])
    expect(admin.version).not.toBe(member.version)
  })
})
