import { millis } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  surface: { kind: 'world', allianceId: null },
  season: 7,
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
    await sql.setTemplatePublishedAt(published.templateId, createdAt, createdAt)
    const allianceTemplate: TemplateVersionRecord = {
      ...template(
        '01890f3a-6b7c-7def-8123-456789abcde5',
        '01890f3a-6b7c-7def-8123-456789abcde6',
        0,
      ),
      surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
      bbox: { minX: -1, minY: -1, maxX: 1, maxY: 0 },
      chunks: [
        { tileX: -1, tileY: -1, hash: 'c'.repeat(64) },
        { tileX: 0, tileY: -1, hash: 'd'.repeat(64) },
      ],
      totalPixels: 2,
    }
    await sql.insertTemplateVersion(allianceTemplate)
    await sql.setTemplatePublishedAt(allianceTemplate.templateId, createdAt, createdAt)
    await sql.insertAccessToken({
      tokenHash: await hashToken(MEMBER),
      label: 'Member',
      scope: 'read',
      createdWithToken: 'bootstrap',
      createdAt,
    })
    app = createApp(ports, serverOptions)
  })

  afterEach(() => vi.restoreAllMocks())

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
    // An admin on an open server still has to see drafts. Treating open access as a short circuit
    // rather than a fallback downgraded every authenticated caller to `read`, so the one caller the
    // unpublished view exists for stopped getting it.
    const openAdmin = await open.request('/manifest', bearer(BOOTSTRAP))
    const openAnonymous = await open.request('/manifest')
    expect(((await openAdmin.json()) as { templates: unknown[] }).templates.length).toBeGreaterThan(
      ((await openAnonymous.json()) as { templates: unknown[] }).templates.length,
    )
    // And a credential that is presented and invalid still fails rather than silently downgrading.
    expect((await open.request('/manifest', bearer('ABCDEFGHJKMNPQRSTVWXYZ2345'))).status).toBe(401)
    expect((await open.request('/chunks/'.concat('c'.repeat(64)))).status).toBe(404)
    expect((await open.request('/admin/nodes?season=7')).status).toBe(401)
  })

  it('maps a typed server-settings read failure to the existing 500 response', async () => {
    const error = new Error('database unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    sql.readServerSettings = async () => {
      throw error
    }

    const response = await app.request('/server')

    expect(response.status).toBe(500)
    expect(await response.text()).toBe('Internal Server Error')
    expect(consoleError).toHaveBeenCalledWith(error)
  })

  it('honours a weak or listed If-None-Match, and a season query', async () => {
    // The one conditional test sent a single exact strong tag, which the old `header === etag`
    // compare satisfied too — so the RFC 9110 parsing was untested. And no test sent `?season=` at
    // all: the route's parse and its 400 could both be deleted with the suite green, while
    // season-scoping is an acceptance criterion covered only at the store level.
    const first = await app.request('/manifest', bearer(MEMBER))
    const etag = first.headers.get('etag') as string

    const weak = await app.request('/manifest', {
      headers: { ...bearer(MEMBER).headers, 'if-none-match': `W/${etag}` },
    })
    const listed = await app.request('/manifest', {
      headers: { ...bearer(MEMBER).headers, 'if-none-match': `"other", ${etag}` },
    })
    const wildcard = await app.request('/manifest', {
      headers: { ...bearer(MEMBER).headers, 'if-none-match': '*' },
    })
    const stale = await app.request('/manifest', {
      headers: { ...bearer(MEMBER).headers, 'if-none-match': '"stale"' },
    })

    expect([weak.status, listed.status, wildcard.status, stale.status]).toEqual([
      304, 304, 304, 200,
    ])

    // The ETag has to be readable cross-origin or none of the above is reachable by the userscript,
    // which is the only client and is cross-origin by definition.
    expect(first.headers.get('access-control-expose-headers')).toContain('ETag')

    // A season the caller asks for, and a season that is not one.
    const other = await app.request('/manifest?season=99', bearer(MEMBER))
    expect(other.status).toBe(200)
    expect(((await other.json()) as { season: number }).season).toBe(99)
    expect((await app.request('/manifest?season=abc', bearer(MEMBER))).status).toBe(400)
  })

  it('selects one alliance surface without leaking world or another alliance', async () => {
    const response = await app.request(
      '/manifest?surface=alliance-headquarters&allianceId=535245',
      bearer(MEMBER),
    )

    expect(response.status).toBe(200)
    const manifest = (await response.json()) as {
      surface?: { kind: string; allianceId: number }
      templates: Array<{ id: string; chunks: Array<{ tile: string }> }>
      tiles: string[]
    }
    expect(manifest.surface).toEqual({
      kind: 'alliance-headquarters',
      allianceId: 535245,
    })
    expect(manifest.templates.map(({ id }) => id)).toEqual(['01890f3a-6b7c-7def-8123-456789abcde5'])
    expect(manifest.tiles).toEqual(['-1/-1', '0/-1'])

    const other = await app.request(
      '/manifest?surface=alliance-headquarters&allianceId=1',
      bearer(MEMBER),
    )
    expect(((await other.json()) as { templates: unknown[] }).templates).toEqual([])
    const world = (await (await app.request('/manifest', bearer(MEMBER))).json()) as {
      surface?: unknown
      templates: Array<{ id: string }>
    }
    expect(world.surface).toBeUndefined()
    expect(world.templates.some(({ id }) => id === '01890f3a-6b7c-7def-8123-456789abcde5')).toBe(
      false,
    )
  })

  it('rejects incomplete or contradictory surface selectors', async () => {
    for (const query of [
      'surface=alliance-headquarters',
      'allianceId=535245',
      'surface=world&allianceId=535245',
      'surface=alliance-avatar&allianceId=535245',
      'surface=alliance-picture&allianceId=0',
    ]) {
      expect((await app.request(`/manifest?${query}`, bearer(MEMBER))).status).toBe(400)
    }
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

  describe('renaming the server', () => {
    const patch = (body: Record<string, unknown>, token = BOOTSTRAP) =>
      app.request('/admin/server', {
        method: 'PATCH',
        headers: { ...bearer(token).headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    it('renames it for everyone, without a redeploy', async () => {
      expect((await patch({ name: 'Caelestis' })).status).toBe(200)

      const info = (await (await app.request('/server')).json()) as { name: string }
      expect(info.name).toBe('Caelestis')
      const manifest = (await (await app.request('/manifest', bearer(MEMBER))).json()) as {
        server: { name: string }
      }
      // The manifest carries the name too, and it is where anyone would look to check a rename
      // worked — so a rename visible on one and not the other is worse than no rename at all.
      expect(manifest.server.name).toBe('Caelestis')
    })

    it('leaves the description alone when only the name is set', async () => {
      await patch({ name: 'Caelestis' })
      const info = (await (await app.request('/server')).json()) as { description?: string }
      expect(info.description).toBe(serverOptions.serverDescription)
    })

    it('clears a description back to the deployment default when set to null', async () => {
      await patch({ description: 'Set by an admin' })
      expect(
        ((await (await app.request('/server')).json()) as { description?: string }).description,
      ).toBe('Set by an admin')

      await patch({ description: null })

      // Null is "undecided", not "empty": it falls back to what the deployment configured.
      expect(
        ((await (await app.request('/server')).json()) as { description?: string }).description,
      ).toBe(serverOptions.serverDescription)
    })

    it('refuses a blank name, and a patch that sets nothing', async () => {
      expect((await patch({ name: '   ' })).status).toBe(400)
      expect((await patch({})).status).toBe(400)
    })

    it('refuses a member, and anyone without a token at all', async () => {
      expect((await patch({ name: 'Nope' }, MEMBER)).status).toBe(403)
      const anonymous = await app.request('/admin/server', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Nope' }),
      })
      expect(anonymous.status).toBe(401)
      // And the read stays public throughout, which is what a userscript needs to decide whether
      // it has to ask for a code.
      expect((await app.request('/server')).status).toBe(200)
    })
  })
})
