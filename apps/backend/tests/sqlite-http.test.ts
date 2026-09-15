import { millis } from '@caelestis/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../src/adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../src/adapters/memory/memory-counter-store.js'
import { createApp } from '../src/app.js'
import { hashToken } from '../src/auth/tokens.js'
import { makeBackendContext } from '../src/runtime/backend-runtime.js'
import { openRelationalStore } from './support/relational.js'

const adminToken = 'SQLITE-HTTP-ADMIN'
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  ),
  (byte) => byte.charCodeAt(0),
)
const stores: Awaited<ReturnType<typeof openRelationalStore>>[] = []

afterEach(() => Promise.all(stores.splice(0).map((store) => store.close())))

describe('SQLite HTTP persistence flow', () => {
  it('uploads a template, publishes it, and serves the persisted manifest with a reusable ETag', async () => {
    const store = await openRelationalStore()
    stores.push(store)
    const tokenHash = await hashToken(adminToken)
    await store.sql.insertAccessToken({
      tokenHash,
      label: 'SQLite HTTP administrator',
      scope: 'admin',
      createdWithToken: tokenHash,
      createdAt: millis(1),
    })
    const blobs = new MemoryBlobStore()
    const app = createApp(makeBackendContext(blobs, store.sql, new MemoryCounterStore(store.sql)), {
      serverId: '00000000-0000-7000-8000-000000000000',
      serverName: 'SQLite HTTP server',
      currentSeason: 1,
    })
    const form = new FormData()
    form.set('png', new File([png], 'pixel.png', { type: 'image/png' }))
    form.set('season', '1')
    form.set('name', 'Persisted pixel')
    form.set('originX', '0')
    form.set('originY', '0')
    const headers = { authorization: `Bearer ${adminToken}` }
    const created = await app.fetch(
      new Request('https://backend.test/admin/templates', { method: 'POST', headers, body: form }),
    )

    expect(created.status).toBe(201)
    const template = (await created.json()) as { templateId: string }
    expect(
      (
        await app.fetch(
          new Request(`https://backend.test/admin/templates/${template.templateId}`, {
            method: 'PATCH',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ published: true }),
          }),
        )
      ).status,
    ).toBe(200)

    const manifest = await app.fetch(
      new Request('https://backend.test/manifest?season=1', { headers }),
    )
    expect(manifest.status).toBe(200)
    const etag = manifest.headers.get('etag')
    expect(etag).not.toBeNull()
    expect(await manifest.json()).toMatchObject({ templates: [{ id: template.templateId }] })
    expect(
      (
        await app.fetch(
          new Request('https://backend.test/manifest?season=1', {
            headers: { ...headers, 'if-none-match': etag ?? '' },
          }),
        )
      ).status,
    ).toBe(304)
  })
})
