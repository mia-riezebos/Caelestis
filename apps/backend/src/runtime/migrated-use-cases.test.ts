import { encodeIndexedPng, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { authenticateRequest } from '../auth/middleware.js'
import { listAccessTokens, mintAccessToken, revokeAccessToken } from '../auth/use-cases.js'
import { readManifest } from '../manifest/use-cases.js'
import { createNode, listNodes } from '../nodes/use-cases.js'
import { resolveServerInfoEffect, writeServerSettings } from '../routes/server.js'
import { createTemplate } from '../templates/use-cases.js'
import { BlobStoreService, SqlStoreService } from './backend-runtime.js'

const withSql = <A, E>(sql: MemorySqlStore, effect: Effect.Effect<A, E, SqlStoreService>) =>
  Effect.provideService(effect, SqlStoreService, sql)

describe('migrated Effect use cases', () => {
  it('resolves authentication and node behavior from an isolated SQL service', async () => {
    const sql = new MemorySqlStore()
    const caller = await Effect.runPromise(
      withSql(sql, authenticateRequest(undefined, { openAccess: true }, 'read')),
    )
    expect(caller).toEqual({ scope: 'read', token: null, tokenHash: '0'.repeat(64) })

    const created = await Effect.runPromise(
      withSql(
        sql,
        createNode({ season: 1, parentId: null, name: 'Effect node', description: 'isolated' }),
      ),
    )
    await expect(Effect.runPromise(withSql(sql, listNodes(1)))).resolves.toEqual([created])
  })

  it('assembles manifests and maps rejected reads into a typed storage failure', async () => {
    const sql = new MemorySqlStore()
    const input = {
      server: {
        id: '00000000-0000-7000-8000-000000000000',
        name: 'Effect server',
        auth: 'access_token' as const,
      },
      season: 1,
      surface: WORLD_TEMPLATE_SURFACE,
      includeUnpublished: false,
    }
    const manifest = await Effect.runPromise(withSql(sql, readManifest(input)))
    expect(manifest).toMatchObject({ season: 1, nodes: [], templates: [] })

    vi.spyOn(sql, 'listNodes').mockRejectedValueOnce(new Error('D1 unavailable'))
    const failure = await Effect.runPromise(Effect.flip(withSql(sql, readManifest(input))))
    expect(failure).toMatchObject({ _tag: 'BackendStorageError', operation: 'assembleManifest' })
  })

  it('stores template bytes through isolated SQL and blob services', async () => {
    const sql = new MemorySqlStore()
    const blobs = new MemoryBlobStore()
    const png = await encodeIndexedPng(1, 1, new Uint8Array([0]))
    const program = createTemplate({
      surface: WORLD_TEMPLATE_SURFACE,
      season: 1,
      nodeId: null,
      name: 'Effect template',
      createdWithToken: 'a'.repeat(64),
      originX: 0,
      originY: 0,
      png,
    }).pipe(
      Effect.provideService(SqlStoreService, sql),
      Effect.provideService(BlobStoreService, blobs),
    )

    const stored = await Effect.runPromise(program)
    expect(stored).toMatchObject({ published: false, totalPixels: 1 })
    await expect(sql.readTemplate(stored.templateId)).resolves.toMatchObject({
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    })
  })

  it('administers server metadata and access tokens through the SQL service', async () => {
    const sql = new MemorySqlStore()
    await Effect.runPromise(
      withSql(sql, writeServerSettings({ name: 'Renamed', description: 'Effect-owned' })),
    )
    await expect(
      Effect.runPromise(
        withSql(
          sql,
          resolveServerInfoEffect({
            id: '00000000-0000-7000-8000-000000000000',
            name: 'Configured',
            auth: 'access_token',
          }),
        ),
      ),
    ).resolves.toMatchObject({ name: 'Renamed', description: 'Effect-owned' })

    const minted = await Effect.runPromise(
      withSql(
        sql,
        mintAccessToken({ label: 'isolated', scope: 'read', createdWithToken: 'bootstrap' }),
      ),
    )
    await expect(Effect.runPromise(withSql(sql, listAccessTokens({ limit: 2 })))).resolves.toEqual([
      minted.record,
    ])
    await Effect.runPromise(withSql(sql, revokeAccessToken(minted.record.tokenHash)))
    await expect(Effect.runPromise(withSql(sql, listAccessTokens({ limit: 2 })))).resolves.toEqual(
      [],
    )
  })
})
