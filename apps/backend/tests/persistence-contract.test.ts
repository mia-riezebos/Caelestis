import { millis, seconds, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { MemorySqlStore } from '../src/adapters/memory/memory-sql-store.js'
import type { SqlStore } from '../src/ports/sql-store.js'
import { openRelationalStore } from './support/relational.js'
import { nodeTemplateContractExpected, runNodeTemplateContract } from './support/sql-contract.js'

const ids = {
  template: '01890f3e-7b2c-7abc-8def-012345678904',
  version: '01890f3e-7b2c-7abc-8def-012345678905',
  tag: '01890f3e-7b2c-7abc-8def-012345678907',
}
const createdAt = millis(1_000)
const hash = 'a'.repeat(64)
const token = (tokenHash: string) => ({
  tokenHash,
  label: tokenHash,
  scope: 'read' as const,
  createdWithToken: tokenHash,
  createdAt,
})
const version = (
  versionId: string,
  overrides: Partial<{ name: string; nodeId: string | null }> = {},
) => ({
  templateId: ids.template,
  versionId,
  surface: WORLD_TEMPLATE_SURFACE,
  season: 1,
  nodeId: overrides.nodeId ?? null,
  name: overrides.name ?? 'Template',
  createdWithToken: 'f'.repeat(64),
  createdByUserId: null,
  createdAt,
  bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  totalPixels: 1,
  chunks: [{ tileX: 0, tileY: 0, hash }],
})

type StoreHandle = { readonly sql: SqlStore; readonly close: () => Promise<void> }
const openMemory = async (): Promise<StoreHandle> => ({
  sql: new MemorySqlStore(),
  close: async () => {},
})
const openSqlite = async (): Promise<StoreHandle> => {
  const opened = await openRelationalStore()
  return { sql: opened.sql, close: opened.close }
}

for (const [name, open] of [
  ['memory', openMemory],
  ['sqlite', openSqlite],
] as const) {
  describe(`${name} SqlStore contract`, () => {
    const handles: StoreHandle[] = []
    const store = async () => {
      const handle = await open()
      handles.push(handle)
      return handle.sql
    }
    afterEach(async () => {
      await Promise.all(handles.splice(0).map((handle) => handle.close()))
    })

    it('keeps node and template guards aligned with the relational contract', async () => {
      const sql = await store()
      expect(await runNodeTemplateContract(sql)).toEqual(nodeTemplateContractExpected)
    })

    it('keeps tag assignment within existing template ownership and paginates equal-time tokens stably', async () => {
      const sql = await store()
      await sql.insertTemplateVersion(version(ids.version))
      expect(
        await sql.mutateTag({ type: 'create', id: ids.tag, name: 'Important' }, createdAt),
      ).toBe(true)
      expect(
        await sql.mutateTag(
          { type: 'assign', id: ids.tag, templateId: ids.template, attached: true },
          createdAt,
        ),
      ).toBe(true)
      expect(await sql.listTemplateTagIds(ids.template)).toEqual([ids.tag])
      expect(
        await sql.mutateTag(
          { type: 'assign', id: ids.tag, templateId: 'missing', attached: true },
          createdAt,
        ),
      ).toBe(false)

      await sql.insertAccessToken(token('b'.repeat(64)))
      await sql.insertAccessToken(token('a'.repeat(64)))
      const page = await sql.listAccessTokens({ limit: 1 })
      expect(page.map((entry) => entry.tokenHash)).toEqual(['a'.repeat(64)])
      const cursor = page[0]
      if (cursor === undefined) throw new Error('token page unexpectedly empty')
      expect(
        (await sql.listAccessTokens({ after: cursor, limit: 1 })).map((entry) => entry.tokenHash),
      ).toEqual(['b'.repeat(64)])
    })

    it('makes observation and paint delivery idempotent at the persistence boundary', async () => {
      const sql = await store()
      const observation = {
        season: 1,
        tile: { x: 0, y: 0 },
        hash,
        observedAt: millis(5_000),
        reportedAt: seconds(5),
        reportedWithToken: 'e'.repeat(64),
        reportedByUserId: 42,
      }
      await sql.recordTileObservation(observation, [])
      await sql.recordTileObservation(observation, [])
      expect(await sql.readLatestTile(1, { x: 0, y: 0 })).toMatchObject({
        hash,
        observedAt: millis(5_000),
      })

      const accounting = { counters: [], contributions: [] }
      expect(
        await sql.applyPaintEvent('event-1', 42, 'Mia', millis(5_000), accounting),
      ).toMatchObject({
        applied: true,
      })
      expect(
        await sql.applyPaintEvent('event-1', 42, 'Mia', millis(5_001), accounting),
      ).toMatchObject({
        applied: false,
        accounting,
      })
    })

    it('orders claims, refuses a different owner, and removes expired ownership', async () => {
      const sql = await store()
      const now = Date.now()
      const document = {
        items: [
          {
            id: 'shape',
            op: 'add' as const,
            shape: { kind: 'rectangle' as const, x: 0, y: 0, w: 2, h: 2 },
          },
        ],
      }
      const region = (id: string, createdAt: number, expiresAt: number) => ({
        id,
        season: 1,
        surface: WORLD_TEMPLATE_SURFACE,
        templateId: null,
        claimant: { wplaceUserId: 42, displayName: 'Mia' },
        document,
        rect: { x: 0, y: 0, w: 2, h: 2 },
        label: id,
        createdAt,
        expiresAt,
      })
      await sql.regions.createRegion(region('b', now, now + 10_000), 'owner')
      await sql.regions.createRegion(region('a', now, now + 10_000), 'owner')
      expect(
        (await sql.regions.listRegions(1, WORLD_TEMPLATE_SURFACE)).map(({ id }) => id),
      ).toEqual(['a', 'b'])
      expect(
        await sql.regions.updateRegion('a', document, 'other', null, {
          tokenHash: 'other',
          actorId: 42,
          admin: false,
        }),
      ).toBeNull()
      expect(await sql.regions.expireRegions(now + 10_000)).toBeUndefined()
      expect(await sql.regions.readRegion('a')).toBeNull()
      expect(await sql.regions.readRegion('b')).toBeNull()
    })
  })
}
