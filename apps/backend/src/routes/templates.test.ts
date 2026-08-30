import { encodeIndexedPng, millis } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import type { Ports } from '../ports/index.js'

const BOOTSTRAP = 'bootstrap-operator-token'
const NODE_ID = '01890f3e-7b2c-7abc-8def-0123456789ab'

const harness = async () => {
  const blobs = new MemoryBlobStore()
  const sql = new MemorySqlStore()
  const ports: Ports = {
    blobs,
    sql,
    counters: new MemoryCounterStore(sql, () => millis(Date.now())),
  }
  await sql.insertNode({
    id: NODE_ID,
    surface: { kind: 'world', allianceId: null },
    season: 1,
    parentId: null,
    path: '/templates',
    name: 'Templates',
    description: null,
    createdAt: millis(Date.now()),
  })
  return { blobs, sql, app: createApp(ports, { bootstrapAdminToken: BOOTSTRAP }) }
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

const templateForm = (png: Uint8Array): FormData => {
  const form = new FormData()
  // File wants a definite backing buffer; encodeIndexedPng returns the ArrayBufferLike default, so
  // hand it the bytes rather than the view.
  form.set('png', new File([png.slice()], 'template.png', { type: 'image/png' }))
  form.set('nodeId', NODE_ID)
  form.set('name', 'Route template')
  form.set('originX', '0')
  form.set('originY', '0')
  return form
}

const mintToken = async (
  app: Awaited<ReturnType<typeof harness>>['app'],
  scope: 'read' | 'report' | 'admin',
): Promise<string> => {
  const response = await app.request('/admin/tokens', {
    method: 'POST',
    body: JSON.stringify({ label: scope, scope }),
    ...bearer(BOOTSTRAP),
  })
  const body = (await response.json()) as { token: string }
  return body.token
}

const mintReportToken = (app: Awaited<ReturnType<typeof harness>>['app']): Promise<string> =>
  mintToken(app, 'report')

describe('template routes', () => {
  it('stores a template and serves the exact stored chunk bytes', async () => {
    const { app, blobs } = await harness()
    const png = await encodeIndexedPng(2, 1, new Uint8Array([0, 1]))
    const created = await app.request('/admin/templates', {
      method: 'POST',
      body: templateForm(new Uint8Array(png)),
      ...bearer(BOOTSTRAP),
    })

    expect(created.status).toBe(201)
    const result = (await created.json()) as { chunks: { hash: string }[] }
    const hash = result.chunks[0]?.hash
    if (hash === undefined) throw new Error('expected one created chunk')
    const stored = await blobs.get('chunks', hash)
    if (stored === null) throw new Error('created chunk is missing')

    const fetched = await app.request(`/chunks/${hash}`, bearer(BOOTSTRAP))
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('content-type')).toBe('image/png')
    // `private`, not `public`: the route is read-scoped, and `public` lets a shared cache serve a
    // stored chunk to a request carrying no Authorization. Immutability is still advertised — a
    // client may cache a content-addressed chunk forever, just not on anyone else's behalf.
    expect(fetched.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(stored)
  })

  it('stores a template directly under the server root', async () => {
    const { app } = await harness()
    const png = await encodeIndexedPng(1, 1, new Uint8Array([0]))
    const form = templateForm(png)
    form.delete('nodeId')
    form.set('season', '1')

    const created = await app.request('/admin/templates', {
      method: 'POST',
      body: form,
      ...bearer(BOOTSTRAP),
    })

    expect(created.status).toBe(201)
    const manifest = (await (
      await app.request('/manifest?season=1', bearer(BOOTSTRAP))
    ).json()) as { templates: Array<{ nodeId: string | null }> }
    expect(manifest.templates).toHaveLength(1)
    expect(manifest.templates[0]?.nodeId).toBeNull()
  })

  it('stores a signed headquarters placement with its alliance identity', async () => {
    const { app, sql } = await harness()
    const png = await encodeIndexedPng(2, 1, new Uint8Array([0, 1]))
    const form = templateForm(png)
    form.delete('nodeId')
    form.set('season', '1')
    form.set('surfaceKind', 'alliance-headquarters')
    form.set('allianceId', '535245')
    form.set('originX', '-1')
    form.set('originY', '-1')

    const response = await app.request('/admin/templates', {
      method: 'POST',
      body: form,
      ...bearer(BOOTSTRAP),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as { templateId: string; chunks: Array<{ tile: string }> }
    expect(body.chunks.map(({ tile }) => tile)).toEqual(['-1/-1', '0/-1'])
    expect((await sql.readTemplate(body.templateId))?.surface).toEqual({
      kind: 'alliance-headquarters',
      allianceId: 535245,
    })
  })

  it('requires an alliance id for an alliance surface', async () => {
    const { app } = await harness()
    const png = await encodeIndexedPng(1, 1, new Uint8Array([0]))
    const form = templateForm(png)
    form.set('surfaceKind', 'alliance-picture')

    const response = await app.request('/admin/templates', {
      method: 'POST',
      body: form,
      ...bearer(BOOTSTRAP),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'surfaceKind must be world or an alliance surface with a positive allianceId',
    })
  })

  it('404s an unknown chunk hash', async () => {
    const { app } = await harness()
    const response = await app.request(`/chunks/${'f'.repeat(64)}`, bearer(BOOTSTRAP))
    expect(response.status).toBe(404)
  })

  it('refuses a report-scope holder on template upload', async () => {
    const { app } = await harness()
    const reportToken = await mintReportToken(app)
    const png = await encodeIndexedPng(1, 1, new Uint8Array([0]))

    const response = await app.request('/admin/templates', {
      method: 'POST',
      body: templateForm(new Uint8Array(png)),
      ...bearer(reportToken),
    })

    expect(response.status).toBe(403)
  })

  it('requires a token to read a chunk', async () => {
    const { app } = await harness()
    const response = await app.request(`/chunks/${'a'.repeat(64)}`)
    expect(response.status).toBe(401)
  })

  it('returns 400, not 500, for a node that does not exist', async () => {
    // templates.node_id is a foreign key, but an unknown node is still a client error. The store
    // boundary turns it into NodeNotFoundError so the route does not expose it as a generic 500.
    const { app } = await harness()
    const png = await encodeIndexedPng(1, 1, new Uint8Array([0]))
    const form = templateForm(png)
    form.set('nodeId', '01890f3e-7b2c-7abc-8def-999999999999')

    const response = await app.request('/admin/templates', {
      method: 'POST',
      body: form,
      ...bearer(BOOTSTRAP),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/node does not exist/),
    })
  })

  it('returns 400 for a non-PNG upload', async () => {
    const { app } = await harness()
    const response = await app.request('/admin/templates', {
      method: 'POST',
      body: templateForm(new Uint8Array([1, 2, 3, 4])),
      ...bearer(BOOTSTRAP),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'not a PNG' })
  })

  it('creates templates unpublished and publishes them with PATCH', async () => {
    const { app } = await harness()
    const png = await encodeIndexedPng(1, 1, new Uint8Array([0]))
    const created = await app.request('/admin/templates', {
      method: 'POST',
      body: templateForm(png),
      ...bearer(BOOTSTRAP),
    })
    const template = (await created.json()) as { templateId: string; published: boolean }
    expect(template.published).toBe(false)

    const published = await app.request(`/admin/templates/${template.templateId}`, {
      method: 'PATCH',
      headers: { ...bearer(BOOTSTRAP).headers, 'content-type': 'application/json' },
      body: JSON.stringify({ published: true }),
    })
    expect(published.status).toBe(200)
    await expect(published.json()).resolves.toEqual({
      id: template.templateId,
      published: true,
      updatedAt: expect.any(Number),
    })
  })
})

describe('editing a template', () => {
  const create = async (app: Awaited<ReturnType<typeof harness>>['app']) => {
    const png = await encodeIndexedPng(1, 1, new Uint8Array([0]))
    const response = await app.request('/admin/templates', {
      method: 'POST',
      body: templateForm(png),
      ...bearer(BOOTSTRAP),
    })
    return (await response.json()) as { templateId: string; versionId: string }
  }

  const patch = (
    app: Awaited<ReturnType<typeof harness>>['app'],
    id: string,
    body: Record<string, unknown>,
  ) =>
    app.request(`/admin/templates/${id}`, {
      method: 'PATCH',
      headers: { ...bearer(BOOTSTRAP).headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const manifestFor = async (app: Awaited<ReturnType<typeof harness>>['app']) => {
    const response = await app.request('/manifest?season=1', bearer(BOOTSTRAP))
    return (await response.json()) as {
      templates: Array<{
        id: string
        name: string
        nodeId: string | null
        version: string
        updatedAt: number
      }>
    }
  }

  const deleteUrl = (template: { id: string; version: string; updatedAt: number }): string => {
    const query = new URLSearchParams({
      expectedVersion: template.version,
      expectedUpdatedAt: String(template.updatedAt),
    })
    return `/admin/templates/${template.id}?${query}`
  }

  it('renames a template without touching its pixels', async () => {
    const { app } = await harness()
    const template = await create(app)
    const before = await manifestFor(app)

    const response = await patch(app, template.templateId, { name: 'Renamed' })

    expect(response.status).toBe(200)
    const after = await manifestFor(app)
    expect(after.templates[0]?.name).toBe('Renamed')
    // The version is what says "re-download the chunks", and a rename must not say that — which is
    // exactly why `updatedAt` has to exist alongside it.
    expect(after.templates[0]?.version).toBe(before.templates[0]?.version)
    expect(after.templates[0]?.updatedAt).toBeGreaterThanOrEqual(
      before.templates[0]?.updatedAt ?? 0,
    )
  })

  it('moves a template to another node', async () => {
    const { app } = await harness()
    const template = await create(app)
    const created = await app.request('/admin/nodes', {
      method: 'POST',
      headers: { ...bearer(BOOTSTRAP).headers, 'content-type': 'application/json' },
      body: JSON.stringify({ season: 1, parentId: null, name: 'Elsewhere' }),
    })
    expect(created.status).toBe(201)
    const { id: destination } = (await created.json()) as { id: string }

    const response = await patch(app, template.templateId, { nodeId: destination })

    expect(response.status).toBe(200)
    const after = await manifestFor(app)
    expect(after.templates[0]?.nodeId).toBe(destination)
  })

  it('moves a template directly under the server root', async () => {
    const { app } = await harness()
    const template = await create(app)

    const response = await patch(app, template.templateId, { nodeId: null })

    expect(response.status).toBe(200)
    const after = await manifestFor(app)
    expect(after.templates[0]?.nodeId).toBeNull()
  })

  it('refuses to move a template to a node that does not exist', async () => {
    const { app } = await harness()
    const template = await create(app)

    const response = await patch(app, template.templateId, {
      nodeId: '01890f3e-7b2c-7abc-8def-0123456789ff',
    })

    expect(response.status).toBe(400)
    // Orphaning a template into a node nobody can navigate to is worse than refusing the edit.
    const after = await manifestFor(app)
    expect(after.templates[0]?.nodeId).toBe(NODE_ID)
  })

  it('rejects a patch that sets nothing', async () => {
    const { app } = await harness()
    const template = await create(app)

    const response = await patch(app, template.templateId, {})

    // Always a caller-side mistake — a typo'd field, or a body that failed to serialise. Answering
    // 200 would report success for a request that changed nothing.
    expect(response.status).toBe(400)
  })

  it('freezes and thaws a timelapse through PATCH', async () => {
    const { app, sql } = await harness()
    const template = await create(app)

    const frozen = await patch(app, template.templateId, { timelapseFrozen: true })
    expect(frozen.status).toBe(200)
    await expect(frozen.json()).resolves.toEqual({
      id: template.templateId,
      timelapseFrozen: true,
      updatedAt: expect.any(Number),
    })
    expect((await sql.readTemplate(template.templateId))?.timelapseFrozen).toBe(true)

    const thawed = await patch(app, template.templateId, { timelapseFrozen: false })
    expect(thawed.status).toBe(200)
    expect((await sql.readTemplate(template.templateId))?.timelapseFrozen).toBe(false)
    expect((await patch(app, template.templateId, { timelapseFrozen: 'yes' })).status).toBe(400)
  })

  it('finishes with a frozen archive and reopens without thawing it', async () => {
    const { app, sql } = await harness()
    const template = await create(app)

    const finished = await patch(app, template.templateId, { finished: true })
    expect(finished.status).toBe(200)
    await expect(finished.json()).resolves.toEqual({
      id: template.templateId,
      finished: true,
      finishedAt: expect.any(Number),
      timelapseFrozen: true,
      updatedAt: expect.any(Number),
    })
    await expect(sql.readTemplate(template.templateId)).resolves.toMatchObject({
      finished: true,
      finishedAt: expect.any(Number),
      timelapseFrozen: true,
    })

    const thawedWhileFinished = await patch(app, template.templateId, {
      timelapseFrozen: false,
    })
    expect(thawedWhileFinished.status).toBe(400)
    await expect(thawedWhileFinished.json()).resolves.toEqual({
      error: 'reopen the template before thawing its timelapse',
    })

    const reopened = await patch(app, template.templateId, { finished: false })
    expect(reopened.status).toBe(200)
    await expect(sql.readTemplate(template.templateId)).resolves.toMatchObject({
      finished: false,
      finishedAt: null,
      timelapseFrozen: true,
    })

    expect((await patch(app, template.templateId, { timelapseFrozen: false })).status).toBe(200)
  })

  it('refuses a finished template with a thawed timelapse', async () => {
    const { app } = await harness()
    const template = await create(app)

    expect(
      (
        await patch(app, template.templateId, {
          finished: true,
          timelapseFrozen: false,
        })
      ).status,
    ).toBe(400)
    expect((await patch(app, template.templateId, { finished: 'yes' })).status).toBe(400)
  })

  it('replaces the pixels with a new version, keeping the template', async () => {
    const { app } = await harness()
    const template = await create(app)
    const form = new FormData()
    // A new version may change the pixels and origin, but not the template's dimensions: identity
    // is also what lets contribution history stay meaningful across revisions.
    const png = await encodeIndexedPng(1, 1, new Uint8Array([1]))
    form.set('png', new File([png.slice()], 'v2.png', { type: 'image/png' }))
    form.set('originX', '0')
    form.set('originY', '0')

    const response = await app.request(`/admin/templates/${template.templateId}/versions`, {
      method: 'POST',
      body: form,
      ...bearer(BOOTSTRAP),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as { templateId: string; versionId: string }
    expect(body.templateId).toBe(template.templateId)
    expect(body.versionId).not.toBe(template.versionId)

    const after = await manifestFor(app)
    // One template, not two — and it kept the name it was given at creation.
    expect(after.templates).toHaveLength(1)
    expect(after.templates[0]?.name).toBe('Route template')
  })

  it('404s a new version for a template that does not exist', async () => {
    const { app } = await harness()
    const form = new FormData()
    const png = await encodeIndexedPng(1, 1, new Uint8Array([0]))
    form.set('png', new File([png.slice()], 'v2.png', { type: 'image/png' }))
    form.set('originX', '0')
    form.set('originY', '0')

    const response = await app.request(
      '/admin/templates/01890f3e-7b2c-7abc-8def-0123456789fe/versions',
      { method: 'POST', body: form, ...bearer(BOOTSTRAP) },
    )

    expect(response.status).toBe(404)
  })

  it('deletes a template, and says so only once', async () => {
    const { app } = await harness()
    await create(app)
    const template = (await manifestFor(app)).templates[0]
    if (template === undefined) throw new Error('expected a created template')
    const url = deleteUrl(template)

    const first = await app.request(url, {
      method: 'DELETE',
      ...bearer(BOOTSTRAP),
    })
    const second = await app.request(url, {
      method: 'DELETE',
      ...bearer(BOOTSTRAP),
    })

    expect(first.status).toBe(204)
    expect(second.status).toBe(404)
    const after = await manifestFor(app)
    expect(after.templates).toHaveLength(0)
  })

  it('keeps the source when a released client cannot identify its revision', async () => {
    const { app } = await harness()
    const created = await create(app)

    const response = await app.request(`/admin/templates/${created.templateId}`, {
      method: 'DELETE',
      ...bearer(BOOTSTRAP),
    })

    expect(response.status).toBe(428)
    await expect(response.json()).resolves.toEqual({
      error: 'expectedVersion and expectedUpdatedAt are required for template deletion',
    })
    const after = await manifestFor(app)
    expect(after.templates).toHaveLength(1)
  })

  it('refuses a partially guarded template delete', async () => {
    const { app } = await harness()
    const created = await create(app)

    const response = await app.request(
      `/admin/templates/${created.templateId}?expectedUpdatedAt=1000`,
      {
        method: 'DELETE',
        ...bearer(BOOTSTRAP),
      },
    )

    expect(response.status).toBe(400)
    const after = await manifestFor(app)
    expect(after.templates).toHaveLength(1)
  })

  it('keeps a newer template version when a stale mover tries to delete its source', async () => {
    const { app } = await harness()
    const template = await create(app)
    const before = (await manifestFor(app)).templates[0]
    if (before === undefined) throw new Error('expected a created template')
    const form = new FormData()
    const png = await encodeIndexedPng(1, 1, new Uint8Array([1]))
    form.set('png', new File([png.slice()], 'v2.png', { type: 'image/png' }))
    form.set('originX', '0')
    form.set('originY', '0')
    const replacement = await app.request(`/admin/templates/${template.templateId}/versions`, {
      method: 'POST',
      body: form,
      ...bearer(BOOTSTRAP),
    })
    expect(replacement.status).toBe(201)
    const newer = (await replacement.json()) as { versionId: string }

    const staleDelete = await app.request(deleteUrl(before), {
      method: 'DELETE',
      ...bearer(BOOTSTRAP),
    })

    expect(staleDelete.status).toBe(409)
    await expect(staleDelete.json()).resolves.toEqual({ error: 'template changed concurrently' })
    const after = await manifestFor(app)
    expect(after.templates).toHaveLength(1)
    expect(after.templates[0]?.version).toBe(newer.versionId)
  })

  it('keeps chunks after a delete, because they are shared', async () => {
    const { app, blobs } = await harness()
    const png = await encodeIndexedPng(1, 1, new Uint8Array([0]))
    const created = await app.request('/admin/templates', {
      method: 'POST',
      body: templateForm(png),
      ...bearer(BOOTSTRAP),
    })
    const { templateId, chunks } = (await created.json()) as {
      templateId: string
      chunks: Array<{ hash: string }>
    }
    const hash = chunks[0]?.hash ?? ''
    const template = (await manifestFor(app)).templates.find(
      (candidate) => candidate.id === templateId,
    )
    if (template === undefined) throw new Error('expected a created template')

    await app.request(deleteUrl(template), {
      method: 'DELETE',
      ...bearer(BOOTSTRAP),
    })

    // Content-addressed and shared: another template with the same region points at this exact
    // blob, so deleting by hash here would corrupt it. Reclaiming is a sweep, not a cascade.
    expect(await blobs.get('chunks', hash)).not.toBeNull()
  })

  it('refuses every edit to a caller without admin scope', async () => {
    const { app } = await harness()
    const template = await create(app)
    const readToken = await mintToken(app, 'read')

    const renamed = await app.request(`/admin/templates/${template.templateId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${readToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    })
    const deleted = await app.request(`/admin/templates/${template.templateId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${readToken}` },
    })

    expect(renamed.status).toBe(403)
    expect(deleted.status).toBe(403)
  })
})

describe('chunk delivery is reachable by ordinary members', () => {
  it('serves a chunk to a read-scope token', async () => {
    // Every other chunk test authenticates as the bootstrap admin, which satisfies `read` as well —
    // so tightening this route to `admin` passed the whole suite while locking out every member the
    // read scope exists for. This is the case that fails when that happens.
    const { app } = await harness()
    const png = await encodeIndexedPng(1, 1, new Uint8Array([0]))
    const upload = await app.request('/admin/templates', {
      method: 'POST',
      body: templateForm(png),
      ...bearer(BOOTSTRAP),
    })
    const { chunks } = (await upload.json()) as { chunks: Array<{ hash: string }> }
    const hash = chunks[0]?.hash ?? ''
    const readToken = await mintToken(app, 'read')

    const response = await app.request(`/chunks/${hash}`, bearer(readToken))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
  })
})
