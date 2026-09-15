import { millis } from '@caelestis/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { openRelationalStore } from './support/relational.js'

const stores: Awaited<ReturnType<typeof openRelationalStore>>[] = []

const openStore = async () => {
  const store = await openRelationalStore()
  stores.push(store)
  return store
}

afterEach(() => {
  return Promise.all(stores.splice(0).map((store) => store.close()))
})

describe('SQLite relational contract', () => {
  it('orders equal-timestamp token pages by hash and does not expose a rolled-back write', async () => {
    const { connection, sql } = await openStore()
    const createdAt = millis(42)
    const token = (tokenHash: string) => ({
      tokenHash,
      label: tokenHash,
      scope: 'read' as const,
      createdWithToken: tokenHash,
      createdAt,
    })
    await sql.insertAccessToken(token('b'.repeat(64)))
    await sql.insertAccessToken(token('a'.repeat(64)))

    expect((await sql.listAccessTokens()).map(({ tokenHash }) => tokenHash)).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
    ])

    await expect(
      connection.transaction(async (transaction) => {
        await transaction
          .prepare('INSERT INTO server_settings (id, name, description) VALUES (?, ?, ?)')
          .bind(1, 'rolled back', null)
          .run()
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')
    expect(await sql.readServerSettings()).toEqual({ name: null, description: null })
  })
})
