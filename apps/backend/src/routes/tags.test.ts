import { encodeIndexedPng, millis } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import { makeBackendContext } from '../runtime/backend-runtime.js'
import { DirectStatusReadModel } from '../status-read-model/port.js'

const token = 'bootstrap-operator-token'
const harness = () => {
  const sql = new MemorySqlStore()
  const readModel = new DirectStatusReadModel(sql)
  const notify = vi.spyOn(readModel, 'notifyManifestChange')
  const app = createApp(
    makeBackendContext(
      new MemoryBlobStore(),
      sql,
      new MemoryCounterStore(sql, () => millis(Date.now())),
      readModel,
    ),
    { bootstrapAdminToken: token, openAccess: true },
  )
  const request = (url: string, method = 'GET', body?: unknown, credential = token) =>
    app.request(`/v1${url}`, {
      method,
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { app, request, notify, sql }
}

describe('v1 tag routes', () => {
  it('syncs unassigned tags through an already-cached empty admin manifest', async () => {
    const { request } = harness()
    const before = (await (await request('/manifest')).json()) as { version: string }
    await request('/admin/tags', 'POST', { name: 'Later' })
    const after = (await (await request('/manifest')).json()) as { version: string; tags: unknown }
    expect(after.version).not.toBe(before.version)
    expect(after.tags).toEqual([{ id: expect.any(String), name: 'Later' }])
  })
  it('enforces admin authorization and name validation', async () => {
    const { app, request } = harness()
    const minted = await request('/admin/tokens', 'POST', { label: 'reader', scope: 'read' })
    const reader = ((await minted.json()) as { token: string }).token
    expect(
      (
        await app.request('/v1/admin/tags', {
          method: 'POST',
          body: JSON.stringify({ name: 'Tag' }),
        })
      ).status,
    ).toBe(401)
    expect((await request('/admin/tags', 'POST', { name: 'Tag' }, reader)).status).toBe(403)
    for (const name of ['', '  ', 'x'.repeat(65), 'a\u0000b'])
      expect((await request('/admin/tags', 'POST', { name })).status).toBe(400)
    expect((await request('/admin/tags', 'POST', { name: '  Repair  ' })).status).toBe(201)
    expect((await request('/admin/tags', 'POST', { name: 'REPAIR' })).status).toBe(409)
    expect(await (await request('/admin/tags')).json()).toMatchObject({
      tags: [{ name: 'Repair' }],
    })
  })

  it('invalidates manifests and syncs attach, rename, detach, and delete through v1', async () => {
    const { app, request, notify, sql } = harness()
    const form = new FormData()
    form.set(
      'png',
      new File([(await encodeIndexedPng(1, 1, new Uint8Array([0]))).slice()], 'art.png'),
    )
    for (const [key, value] of Object.entries({
      season: '0',
      name: 'Art',
      originX: '0',
      originY: '0',
    }))
      form.set(key, value)
    const upload = await app.request('/v1/admin/templates', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    })
    const { templateId } = (await upload.json()) as { templateId: string }
    const created = await request('/admin/tags', 'POST', { name: 'Repair' })
    const { id } = (await created.json()) as { id: string }
    const before = await request('/manifest')
    const etag = before.headers.get('etag') ?? ''
    expect((await request(`/admin/tags/${id}/templates/${templateId}`, 'PUT')).status).toBe(204)
    expect(notify).toHaveBeenLastCalledWith(0, undefined, false)
    const changed = await app.request('/v1/manifest', {
      headers: { authorization: `Bearer ${token}`, 'if-none-match': etag },
    })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({ templates: [{ tags: [{ id, name: 'Repair' }] }] })
    expect((await request(`/admin/tags/${id}`, 'PATCH', { name: 'Priority' })).status).toBe(200)
    expect(await (await request('/manifest')).json()).toMatchObject({
      templates: [{ tags: [{ id, name: 'Priority' }] }],
    })
    const scopeRead = vi
      .spyOn(sql, 'listManifestTags')
      .mockRejectedValue(new Error('Manifest-wide assignment scan exceeded the read budget.'))
    expect(await (await request(`/admin/tags?templateId=${templateId}`)).json()).toMatchObject({
      selected: [id],
    })
    scopeRead.mockRestore()
    expect((await request(`/admin/tags/${id}/templates/${templateId}`, 'DELETE')).status).toBe(204)
    expect(await (await request(`/admin/tags?templateId=${templateId}`)).json()).toMatchObject({
      selected: [],
    })
    expect((await request(`/admin/tags/${id}`, 'DELETE')).status).toBe(204)
    expect(await (await request('/manifest')).json()).toMatchObject({
      templates: [{ id: templateId }],
    })
  })
})
