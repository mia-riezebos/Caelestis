import { encodeIndexedPng, millis } from '@wts/shared'
import { describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import type { Ports } from '../ports/index.js'

const BOOTSTRAP = 'bootstrap-operator-token'
const NODE_ID = '01890f3e-7b2c-7abc-8def-0123456789ab'

const harness = () => {
  const blobs = new MemoryBlobStore()
  const sql = new MemorySqlStore()
  const ports: Ports = {
    blobs,
    sql,
    counters: new MemoryCounterStore(sql, () => millis(Date.now())),
  }
  return { blobs, app: createApp(ports, { bootstrapAdminToken: BOOTSTRAP }) }
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

const templateForm = (png: Uint8Array): FormData => {
  const form = new FormData()
  // File wants a definite backing buffer; encodeIndexedPng returns the ArrayBufferLike default, so
  // hand it the bytes rather than the view.
  form.set('png', new File([png.slice()], 'template.png', { type: 'image/png' }))
  form.set('nodeId', NODE_ID)
  form.set('name', 'Route template')
  form.set('season', '1')
  form.set('originX', '0')
  form.set('originY', '0')
  return form
}

const mintToken = async (
  app: ReturnType<typeof harness>['app'],
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

const mintReportToken = (app: ReturnType<typeof harness>['app']): Promise<string> =>
  mintToken(app, 'report')

describe('template routes', () => {
  it('stores a template and serves the exact stored chunk bytes', async () => {
    const { app, blobs } = harness()
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

  it('404s an unknown chunk hash', async () => {
    const { app } = harness()
    const response = await app.request(`/chunks/${'f'.repeat(64)}`, bearer(BOOTSTRAP))
    expect(response.status).toBe(404)
  })

  it('refuses a report-scope holder on template upload', async () => {
    const { app } = harness()
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
    const { app } = harness()
    const response = await app.request(`/chunks/${'a'.repeat(64)}`)
    expect(response.status).toBe(401)
  })

  it('returns 400 for a non-PNG upload', async () => {
    const { app } = harness()
    const response = await app.request('/admin/templates', {
      method: 'POST',
      body: templateForm(new Uint8Array([1, 2, 3, 4])),
      ...bearer(BOOTSTRAP),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'not a PNG' })
  })
})

describe('chunk delivery is reachable by ordinary members', () => {
  it('serves a chunk to a read-scope token', async () => {
    // Every other chunk test authenticates as the bootstrap admin, which satisfies `read` as well —
    // so tightening this route to `admin` passed the whole suite while locking out every member the
    // read scope exists for. This is the case that fails when that happens.
    const { app } = harness()
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
