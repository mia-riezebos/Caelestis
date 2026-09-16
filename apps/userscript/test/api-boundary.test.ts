import { decodeWplaceIndexedPng, encodeIndexedPng } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminToken, backendFetch, createTestBackend, readToken } from './backend.js'

const origin = 'https://userscript-api-boundary.test'

const installBackend = async (options?: Parameters<typeof createTestBackend>[0]) => {
  const { app } = await createTestBackend(options)
  const fetch = vi.fn(backendFetch(app, origin))
  vi.stubGlobal('fetch', fetch)
  window.fetch = fetch
  return fetch
}

const connect = async (token = adminToken) => {
  const state = await import('../src/state.js')
  const probed = await state.probeServer(origin, token)
  expect(probed.status).toBe('connected')
  state.upsertServer(probed)
  const server = state.getState().servers.find((candidate) => candidate.url === origin)
  if (server === undefined) throw new Error('probed server was not retained')
  return { state, server }
}

const png = async (): Promise<Blob> => {
  const bytes = await encodeIndexedPng(2, 2, new Uint8Array([1, 2, 3, 4]))
  return new Blob([new Uint8Array(bytes).buffer], { type: 'image/png' })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
  localStorage.clear()
})

describe('userscript to backend API boundary', () => {
  it('probes, writes, reads, and synchronizes a persisted server template', async () => {
    await installBackend()
    const { state, server } = await connect()

    expect(server).toMatchObject({
      info: { name: 'Userscript contract server', auth: 'access_token' },
      season: 3,
      isAdmin: true,
    })

    const folder = await state.createNode(server, 'Contract art', null)
    expect(folder).toMatchObject({ ok: true, node: { name: 'Contract art', parentId: null } })
    if (!folder.ok) throw new Error(folder.message)
    const child = await state.createNode(server, 'Drafts', folder.node.id)
    if (!child.ok) throw new Error(child.message)

    const uploaded = await state.uploadTemplate(server, {
      nodeId: folder.node.id,
      name: 'Boundary pixels',
      originX: 10,
      originY: 20,
      png: await png(),
    })
    expect(uploaded.ok).toBe(true)
    if (!uploaded.ok) throw new Error(uploaded.message)

    expect(await state.patchTemplate(server, uploaded.id, { published: true })).toEqual({
      ok: true,
    })
    const contents = await state.listServerContents(server)
    expect(contents).not.toBeNull()
    const template = contents?.templates.find((candidate) => candidate.id === uploaded.id)
    expect(template).toMatchObject({
      name: 'Boundary pixels',
      nodeId: folder.node.id,
      published: true,
    })
    const hash = template?.chunks[0]?.hash
    if (hash === undefined) throw new Error('published template had no stored chunk')

    const { fetchChunkWithinBudget } = await import('../src/templates/server-sync.js')
    const bytes = await fetchChunkWithinBudget(
      server,
      hash,
      new AbortController().signal,
      1_000_000,
    )
    if (bytes === null) throw new Error('chunk transfer was refused')
    expect(await decodeWplaceIndexedPng(bytes)).toMatchObject({ width: 2, height: 2 })

    expect(await state.renameNode(server, child.node.id, 'Reviewed drafts')).toEqual({ ok: true })
    expect(await state.countNodeSubtree(server, folder.node.id)).toEqual({ nodes: 2, templates: 1 })
    expect(await state.moveNode(server, child.node.id, null)).toEqual({ ok: true })
    expect(await state.deleteNode(server, child.node.id, { nodes: 1, templates: 0 })).toEqual({
      ok: true,
    })

    const replacement = await state.uploadTemplateVersion(server, uploaded.id, {
      name: 'Boundary pixels',
      originX: 11,
      originY: 21,
      png: await png(),
    })
    expect(replacement).toMatchObject({ ok: true, versionId: expect.any(String) })

    expect(await state.mutateServerTag(server, { type: 'create', name: 'priority' })).toEqual({
      ok: true,
    })
    const tags = await state.listServerTags(server, uploaded.id)
    expect(tags).toMatchObject({ ok: true, selected: [] })
    if (!tags.ok) throw new Error(tags.message)
    const tag = tags.tags.find((candidate) => candidate.name === 'priority')
    if (tag === undefined) throw new Error('created tag was not listed')
    expect(
      await state.mutateServerTag(server, {
        type: 'assign',
        id: tag.id,
        templateId: uploaded.id,
        attached: true,
      }),
    ).toEqual({ ok: true })
    expect(await state.listServerTags(server, uploaded.id)).toMatchObject({
      ok: true,
      selected: [tag.id],
    })
    expect(
      await state.mutateServerTag(server, { type: 'rename', id: tag.id, name: 'reviewed' }),
    ).toEqual({
      ok: true,
    })
    expect(
      await state.mutateServerTag(server, {
        type: 'assign-folder',
        id: tag.id,
        folderId: folder.node.id,
        attached: true,
      }),
    ).toEqual({ ok: true })
    expect(await state.listServerTags(server, undefined, folder.node.id)).toMatchObject({
      ok: true,
      selected: [tag.id],
    })
    expect(
      await state.mutateServerTag(server, {
        type: 'assign-folder',
        id: tag.id,
        folderId: folder.node.id,
        attached: false,
      }),
    ).toEqual({ ok: true })
    expect(await state.listServerTags(server, undefined, folder.node.id)).toMatchObject({
      ok: true,
      selected: [],
    })
    expect(
      await state.mutateServerTag(server, {
        type: 'assign',
        id: tag.id,
        templateId: uploaded.id,
        attached: false,
      }),
    ).toEqual({ ok: true })
    expect(await state.mutateServerTag(server, { type: 'delete', id: tag.id })).toEqual({
      ok: true,
    })

    const minted = await state.createAccessToken(server, 'contract reader', 'read')
    expect(minted).toMatchObject({ ok: true, token: expect.any(String) })
    const tokens = await state.listAccessTokens(server)
    expect(tokens?.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'contract reader', scope: 'read' }),
      ]),
    )
    const mintedRecord = tokens?.tokens.find(
      (token) => token.bootstrap !== true && token.label === 'contract reader',
    )
    if (mintedRecord === undefined || mintedRecord.bootstrap === true)
      throw new Error('minted token was not listed')
    expect(await state.revokeAccessToken(server, mintedRecord.tokenHash)).toEqual({ ok: true })
    expect((await state.listAccessTokens(server))?.tokens).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ tokenHash: mintedRecord.tokenHash })]),
    )

    expect(
      await state.deleteNode(server, folder.node.id, { nodes: 1, templates: 0 }),
    ).toMatchObject({
      ok: false,
    })
    expect(await state.countNodeSubtree(server, folder.node.id)).toEqual({ nodes: 1, templates: 1 })
    expect(await state.deleteNode(server, folder.node.id, { nodes: 1, templates: 1 })).toEqual({
      ok: true,
    })
    expect(await state.listServerContents(server)).toMatchObject({ nodes: [], templates: [] })
  })

  it('keeps a newer template when the backend refuses a stale delete', async () => {
    await installBackend()
    const { state, server } = await connect()
    let now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const uploaded = await state.uploadTemplate(server, {
      nodeId: null,
      name: 'Versioned pixels',
      originX: 0,
      originY: 0,
      png: await png(),
    })
    if (!uploaded.ok) throw new Error(uploaded.message)
    expect(await state.patchTemplate(server, uploaded.id, { published: true })).toEqual({
      ok: true,
    })

    const before = (await state.listServerContents(server))?.templates.find(
      (template) => template.id === uploaded.id,
    )
    if (before === undefined) throw new Error('uploaded template was not in the manifest')
    now++
    expect(await state.patchTemplate(server, uploaded.id, { name: 'Newer pixels' })).toEqual({
      ok: true,
    })

    const refused = await state.deleteTemplate(server, uploaded.id, {
      version: before.version,
      updatedAt: before.updatedAt,
    })
    expect(refused.ok).toBe(false)
    expect(
      (await state.listServerContents(server))?.templates.some(
        (template) => template.id === uploaded.id && template.name === 'Newer pixels',
      ),
    ).toBe(true)

    const current = (await state.listServerContents(server))?.templates.find(
      (template) => template.id === uploaded.id,
    )
    if (current === undefined) throw new Error('template disappeared after stale delete')
    expect(
      await state.deleteTemplate(server, uploaded.id, {
        version: current.version,
        updatedAt: current.updatedAt,
      }),
    ).toEqual({ ok: true })
    expect(
      (await state.listServerContents(server))?.templates.some(
        (template) => template.id === uploaded.id,
      ),
    ).toBe(false)
  })

  it('admits read scope but refuses its admin mutation through the real authorization boundary', async () => {
    await installBackend()
    const { state, server } = await connect(readToken)
    expect(server).toMatchObject({ isAdmin: false, token: readToken })

    expect(await state.listServerContents(server)).toMatchObject({ nodes: [], templates: [] })
    await expect(state.createNode(server, 'Forbidden folder', null)).resolves.toMatchObject({
      ok: false,
      message: 'That code cannot create folders — it needs admin access.',
    })
    expect(state.getState().servers.find((candidate) => candidate.url === origin)).toMatchObject({
      isAdmin: false,
      error: 'admin access required',
    })
  })

  it('retries an actual open server without a rejected saved credential', async () => {
    const fetch = await installBackend({ openAccess: true })
    const { server } = await connect('stale-open-token')
    expect(server).toMatchObject({ token: 'stale-open-token', tokenUsable: false, isAdmin: false })

    const manifestCredentials = fetch.mock.calls
      .filter(([input]) => new URL(String(input)).pathname.endsWith('/manifest'))
      .map(([, init]) => new Headers(init?.headers).get('authorization'))
    expect(manifestCredentials).toEqual(['Bearer stale-open-token', null])
  })

  it('loads a second real token page through the access-token controller', async () => {
    await installBackend()
    const { state, server } = await connect()
    await Promise.all(
      Array.from({ length: 48 }, async (_, index) => {
        const result = await state.createAccessToken(server, `page ${index}`, 'read')
        if (!result.ok) throw new Error(result.message)
      }),
    )

    const accessTokens = await import('../src/application/access-tokens.js')
    let firstPage: (() => void) | undefined
    let finalPage: (() => void) | undefined
    const firstReady = new Promise<void>((resolve) => {
      firstPage = resolve
    })
    const allPagesReady = new Promise<void>((resolve) => {
      finalPage = resolve
    })
    const changed = () => {
      const model = accessTokens.accessTokensModel(server, changed)
      if (model.status !== 'ready') return
      if (model.hasMore) firstPage?.()
      else finalPage?.()
    }
    expect(accessTokens.accessTokensModel(server, changed).status).toBe('loading')
    await firstReady
    const first = accessTokens.accessTokensModel(server, changed)
    expect(first.status).toBe('ready')
    expect(first.hasMore).toBe(true)
    expect(first.tokens).toHaveLength(50)

    accessTokens.loadMoreAccessTokens(server, changed)
    await allPagesReady
    const all = accessTokens.accessTokensModel(server, changed)
    expect(all.status).toBe('ready')
    expect(all.hasMore).toBe(false)
    expect(all.tokens).toHaveLength(51)
  })

  it('uses legacy reads and writes after the versioned metadata route is absent', async () => {
    const backend = await installBackend()
    const legacy = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname.startsWith('/backend/v1/')) {
        return new Response(null, { status: 404 })
      }
      return backend(request)
    })
    vi.stubGlobal('fetch', legacy)
    window.fetch = legacy
    const { state, server } = await connect()
    const result = await state.createNode(server, 'Legacy folder', null)
    if (!result.ok) throw new Error(result.message)
    expect(await state.listServerContents(server)).toMatchObject({
      nodes: [expect.objectContaining({ id: result.node.id, name: 'Legacy folder' })],
    })
    const paths = legacy.mock.calls.map(
      ([input]) => new URL(input instanceof Request ? input.url : String(input)).pathname,
    )
    expect(paths[0]).toBe('/backend/v1/server')
    expect(paths.slice(1).every((path) => !path.startsWith('/backend/v1/'))).toBe(true)
    expect(paths).toContain('/backend/admin/nodes')
  })
})
