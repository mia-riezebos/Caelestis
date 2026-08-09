import { millis } from '@wts/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import { hashToken } from '../auth/tokens.js'
import type { Ports, TemplateVersionRecord } from '../ports/index.js'

const BOOTSTRAP = 'bootstrap-operator-token'
const MEMBER = 'member-token'
const createdAt = millis(1_750_000_000_000)
const serverOptions = {
  bootstrapAdminToken: BOOTSTRAP,
  serverId: '01890f3a-6b7c-7def-8123-456789abcdef',
  serverName: 'Test server',
  serverDescription: 'Description',
  currentSeason: 7,
} as const

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

const template = (templateId: string, versionId: string, tileX: number): TemplateVersionRecord => ({
  templateId,
  nodeId: '01890f3a-6b7c-7def-8123-456789abcde0',
  name: `Template ${tileX}`,
  versionId,
  createdWithToken: 'a'.repeat(64),
  createdByUserId: null,
  createdAt,
  bbox: { minX: tileX * 1_000, minY: 0, maxX: tileX * 1_000 + 1, maxY: 1 },
  totalPixels: 1,
  chunks: [{ tileX, tileY: 0, hash: String(tileX).padStart(64, 'b') }],
})

describe('server and manifest routes', () => {
  let sql: MemorySqlStore
  let app: ReturnType<typeof createApp>

  beforeEach(async () => {
    sql = new MemorySqlStore()
    const ports: Ports = {
      blobs: new MemoryBlobStore(),
      sql,
      counters: new MemoryCounterStore(sql, () => createdAt),
    }
    await sql.insertNode({
      id: '01890f3a-6b7c-7def-8123-456789abcde0',
      season: 7,
      parentId: null,
      path: '/group',
      name: 'Group',
      description: null,
      createdAt,
    })
    const published = template(
      '01890f3a-6b7c-7def-8123-456789abcde1',
      '01890f3a-6b7c-7def-8123-456789abcde2',
      0,
    )
    await sql.insertTemplateVersion(published)
    await sql.insertTemplateVersion(
      template('01890f3a-6b7c-7def-8123-456789abcde3', '01890f3a-6b7c-7def-8123-456789abcde4', 1),
    )
    await sql.setTemplatePublishedAt(published.templateId, createdAt)
    await sql.insertAccessToken({
      tokenHash: await hashToken(MEMBER),
      label: 'Member',
      scope: 'read',
      createdWithToken: 'bootstrap',
      createdAt,
    })
    app = createApp(ports, serverOptions)
  })

  it('serves public server information and reports the configured auth mode', async () => {
    const response = await app.request('/server')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      id: serverOptions.serverId,
      name: serverOptions.serverName,
      description: serverOptions.serverDescription,
      auth: 'access_token',
    })

    const ports: Ports = {
      blobs: new MemoryBlobStore(),
      sql,
      counters: new MemoryCounterStore(sql, () => createdAt),
    }
    const open = createApp(ports, { ...serverOptions, openAccess: true })
    await expect((await open.request('/server')).json()).resolves.toMatchObject({ auth: 'none' })

    // And the advertisement has to be true. `/server` is public precisely so a userscript can decide
    // whether to ask its user for a token before adding the server; advertising `auth: 'none'` and
    // then 401ing `/manifest` made that decision wrong, which is the one thing this endpoint exists
    // to prevent. Admin stays shut: publishing a manifest does not publish the write surface.
    expect((await open.request('/manifest')).status).toBe(200)
    expect((await open.request('/chunks/'.concat('c'.repeat(64)))).status).toBe(404)
    expect((await open.request('/admin/nodes?season=7')).status).toBe(401)
  })

  it('authenticates manifests, varies by scope, and answers a matching ETag with 304', async () => {
    expect((await app.request('/manifest')).status).toBe(401)

    const memberResponse = await app.request('/manifest', bearer(MEMBER))
    expect(memberResponse.status).toBe(200)
    expect(memberResponse.headers.get('vary')).toContain('Authorization')
    const member = (await memberResponse.json()) as {
      version: string
      season: number
      templates: Array<{ published: boolean }>
    }
    expect(member).toMatchObject({ season: 7, templates: [{ published: true }] })
    const etag = memberResponse.headers.get('etag')
    expect(etag).toBe(`"${member.version}"`)

    const notModified = await app.request('/manifest', {
      headers: { authorization: `Bearer ${MEMBER}`, 'if-none-match': etag ?? '' },
    })
    expect(notModified.status).toBe(304)
    expect(notModified.headers.get('etag')).toBe(etag)
    expect(notModified.headers.get('vary')).toContain('Authorization')
    expect(await notModified.text()).toBe('')

    const adminResponse = await app.request('/manifest', bearer(BOOTSTRAP))
    const admin = (await adminResponse.json()) as {
      version: string
      templates: Array<{ published: boolean }>
    }
    expect(admin.templates.map(({ published }) => published)).toEqual([true, false])
    expect(admin.version).not.toBe(member.version)
  })
})
