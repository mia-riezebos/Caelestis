import { afterEach, describe, expect, it } from 'vitest'
import { hashToken } from '../src/auth/tokens.js'
import type { SqlStore } from '../src/ports/sql-store.js'
import { adminToken, createTestBackend } from './support/backend.js'
import { openRelationalStore } from './support/relational.js'

const itemId = '01890f3e-7b2c-7abc-8def-012345678901'
const actor = { wplaceUserId: 42, displayName: 'Mia' }
const fields = {
  title: 'Restore mural',
  description: 'Fill the missing corner.',
  status: 'open',
  priority: 'normal',
  tags: ['repair'],
  blockerIds: [],
  nodeId: null,
  templateIds: [],
} as const

type Handle = { readonly sql: SqlStore; readonly close: () => Promise<void> }
const memory = async (): Promise<Handle> => ({
  sql: new (await import('../src/adapters/memory/memory-sql-store.js')).MemorySqlStore(),
  close: async () => {},
})
const sqlite = async (): Promise<Handle> => {
  const opened = await openRelationalStore()
  return { sql: opened.sql, close: opened.close }
}

for (const [name, open] of [
  ['memory', memory],
  ['sqlite', sqlite],
] as const) {
  describe(`${name} work lifecycle through HTTP`, () => {
    const handles: Handle[] = []
    afterEach(async () => {
      await Promise.all(handles.splice(0).map((handle) => handle.close()))
    })

    it('persists create, claim, stale refusal, and completion while rejecting read-only writes', async () => {
      const handle = await open()
      handles.push(handle)
      const { app, sql } = await createTestBackend({ sql: handle.sql })
      const readToken = 'READ-WORK-TOKEN'
      const readHash = await hashToken(readToken)
      await sql.insertAccessToken({
        tokenHash: readHash,
        label: 'read-only work client',
        scope: 'read',
        createdWithToken: readHash,
        createdAt: 1 as never,
      })
      const url = `https://backend.test/work/${itemId}?season=3&surface=world`
      const request = (token: string, body: unknown) =>
        app.fetch(
          new Request(url, {
            method: 'PUT',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        )

      expect(
        (await request(readToken, { action: 'create', actor, expectedRevision: 0, fields })).status,
      ).toBe(403)
      expect(
        (await request(adminToken, { action: 'create', actor, expectedRevision: 0, fields }))
          .status,
      ).toBe(200)
      expect(await sql.work.read(itemId)).toMatchObject({
        revision: 1,
        claimant: null,
        status: 'open',
      })

      expect(
        (await request(adminToken, { action: 'claim', actor, expectedRevision: 1 })).status,
      ).toBe(200)
      expect(await sql.work.read(itemId)).toMatchObject({ revision: 2, claimant: actor })
      const stale = await request(adminToken, {
        action: 'edit',
        actor,
        expectedRevision: 1,
        fields: { ...fields, status: 'completed' },
      })
      expect(stale.status).toBe(409)
      expect(await stale.json()).toMatchObject({
        item: { revision: 2, status: 'open', claimant: actor },
      })

      expect(
        (
          await request(adminToken, {
            action: 'edit',
            actor,
            expectedRevision: 2,
            fields: { ...fields, status: 'completed' },
          })
        ).status,
      ).toBe(200)
      expect(await sql.work.read(itemId)).toMatchObject({
        revision: 3,
        status: 'completed',
        claimant: actor,
      })
      expect(
        (await sql.work.history(itemId, Number.MAX_SAFE_INTEGER)).map(({ action }) => action),
      ).toEqual(['edit', 'claim', 'create'])
    })
  })
}
