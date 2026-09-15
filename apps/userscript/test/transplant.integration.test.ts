import { decodeWplaceIndexedPng } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { moveServerTemplateToServer, transplant } from '../src/application/transplant.js'
import '../src/application/tree-server-state.js'
import { createLocalFolder } from '../src/local-folders.js'
import {
  admittedServerContentsFor,
  type ConnectedServer,
  getState,
  upsertServer,
} from '../src/state.js'
import { addLocalTemplate, setTemplateFolder, templateById } from '../src/templates/local-store.js'
import { serverTemplateKey } from '../src/templates/server-sync.js'
import { adminToken, createTestBackend } from './backend.js'

const ids = {
  source: '018f1b8c-7f4e-7a8c-8234-123456789abc',
  destination: '018f1b8c-7f4e-7a8c-8234-123456789abd',
  sourceVersion: '018f1b8c-7f4e-7a8c-8234-223456789abc',
  destinationVersion: '018f1b8c-7f4e-7a8c-8234-223456789abd',
}
const stamp = 1_700_000_000_000
const server = (url: string, id: string): ConnectedServer => ({
  url,
  info: { id, name: url, auth: 'access_token' },
  token: 'admin',
  status: 'connected',
  isAdmin: true,
  season: 7,
})
const published = {
  id: ids.source,
  nodeId: null,
  name: 'Transferred art',
  version: ids.sourceVersion,
  published: true,
  updatedAt: stamp,
}
const fullManifest = (owner: ConnectedServer) => ({
  version: 'revision',
  season: 7,
  surface: { kind: 'world', allianceId: null },
  server: owner.info,
  nodes: [],
  tiles: ['0/0'],
  templates: [
    {
      id: ids.destination,
      nodeId: null,
      name: published.name,
      version: ids.destinationVersion,
      totalPixels: 4,
      published: true,
      createdAt: stamp,
      updatedAt: stamp,
      bbox: { minX: 10, minY: 20, maxX: 12, maxY: 22 },
      chunks: [{ tile: '0/0', hash: 'a'.repeat(64) }],
    },
  ],
})

afterEach(() => vi.unstubAllGlobals())

describe('cross-server template transplant', () => {
  it('admits a Local folder branch at the server before removing its persisted source', async () => {
    const { app } = await createTestBackend()
    const destination: ConnectedServer = {
      url: 'https://destination-local-folder.test',
      info: {
        id: '00000000-0000-7000-8000-000000000000',
        name: 'Userscript contract server',
        auth: 'access_token',
      },
      token: adminToken,
      status: 'connected',
      isAdmin: true,
      season: 3,
    }
    upsertServer(destination)
    const currentDestination = getState().servers.find((item) => item.url === destination.url)
    if (currentDestination === undefined) throw new Error('destination connection was not retained')
    const sourceFolder = createLocalFolder(null, 'Local collection')
    if (sourceFolder === null) throw new Error('source folder was not created')
    const sourceTemplate = await addLocalTemplate(
      {
        id: `local-folder-${crypto.randomUUID()}`,
        name: 'Local pixels',
        source: 'wplace',
        originX: 10,
        originY: 20,
        width: 2,
        height: 2,
        indices: new Uint8Array([4, 3, 2, 1]),
        moved: 0,
        opaque: 4,
      },
      undefined,
      true,
    )
    expect(await setTemplateFolder(sourceTemplate.id, sourceFolder.id)).toBe(true)

    let upload: Uint8Array | undefined
    let sourceWasPresentWhenDestinationWasListed = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(String(input), init)
      const url = new URL(request.url)
      if (url.hostname !== 'destination-local-folder.test') {
        throw new Error(`unexpected request: ${request.method} ${url}`)
      }
      if (url.pathname.endsWith('/admin/templates') && request.method === 'POST') {
        upload = new Uint8Array(
          await ((await request.clone().formData()).get('png') as Blob).arrayBuffer(),
        )
      }
      if (url.pathname.endsWith('/manifest')) {
        sourceWasPresentWhenDestinationWasListed =
          templateById(sourceTemplate.id) !== undefined &&
          getState().localFolders.some((folder) => folder.id === sourceFolder.id)
      }
      const backendPath = url.pathname.replace(/^\/backend\/v1(?=\/|$)/, '')
      return await app.fetch(
        new Request(`https://backend.test${backendPath}${url.search}`, request),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    window.fetch = fetchMock as typeof window.fetch

    const result = await transplant(
      { kind: 'local', folderId: sourceFolder.id },
      { kind: 'server', server: currentDestination, nodeId: null },
      () => [],
    )

    if (!result.ok || result.destinationRootId === undefined) throw new Error(result.message)
    expect(result).toMatchObject({ ok: true, nodes: 1, templates: 1 })
    if (upload === undefined) throw new Error('template upload was not captured')
    expect(await decodeWplaceIndexedPng(upload)).toEqual({
      width: 2,
      height: 2,
      indices: new Uint8Array([4, 3, 2, 1]),
    })
    expect(sourceWasPresentWhenDestinationWasListed).toBe(true)
    const admitted = admittedServerContentsFor(currentDestination)
    if (admitted === null) throw new Error('destination manifest was not admitted')
    expect(admitted).toMatchObject({
      nodes: [expect.objectContaining({ id: result.destinationRootId, name: sourceFolder.name })],
      templates: [
        expect.objectContaining({
          nodeId: result.destinationRootId,
          name: sourceTemplate.name,
        }),
      ],
    })
    expect(templateById(sourceTemplate.id)).toBeUndefined()
    expect(getState().localFolders.some((folder) => folder.id === sourceFolder.id)).toBe(false)
  })

  it('uses real persisted pixels, admits a canonical manifest, then deletes the source', async () => {
    const source = server('https://source.test', '018f1b8c-7f4e-7a8c-8a01-123456789abc')
    const destination = server('https://destination.test', '018f1b8c-7f4e-7a8c-8a01-123456789abd')
    upsertServer(source)
    upsertServer(destination)
    const currentSource = getState().servers.find((item) => item.url === source.url)!
    const currentDestination = getState().servers.find((item) => item.url === destination.url)!
    const drawn = await addLocalTemplate(
      {
        id: serverTemplateKey(source.url, ids.source),
        name: published.name,
        source: 'wplace',
        originX: 10,
        originY: 20,
        width: 2,
        height: 2,
        indices: new Uint8Array([1, 2, 3, 4]),
        moved: 0,
        opaque: 4,
      },
      undefined,
      true,
    )
    let upload: Uint8Array | undefined
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (
        url.hostname === 'destination.test' &&
        url.pathname.endsWith('/admin/templates') &&
        init?.method === 'POST'
      ) {
        upload = new Uint8Array(
          await new Response((init.body as FormData).get('png') as Blob).arrayBuffer(),
        )
        return Response.json(
          { templateId: ids.destination, versionId: ids.destinationVersion },
          { status: 201 },
        )
      }
      if (
        url.hostname === 'destination.test' &&
        url.pathname.endsWith(`/admin/templates/${ids.destination}`)
      )
        return Response.json({})
      if (url.hostname === 'destination.test' && url.pathname.endsWith('/manifest'))
        return Response.json(fullManifest(currentDestination))
      if (url.hostname === 'source.test' && url.pathname.endsWith(`/admin/templates/${ids.source}`))
        return Response.json({})
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    window.fetch = fetchMock as typeof window.fetch
    const serverDrawn = Object.assign(templateById(drawn.id)!, { serverVersion: ids.sourceVersion })
    const result = await moveServerTemplateToServer(
      currentSource,
      currentDestination,
      null,
      published,
      serverDrawn,
      () => published,
      async () => {},
    )
    expect(result).toMatchObject({ ok: true, destinationId: ids.destination })
    expect(await decodeWplaceIndexedPng(upload!)).toEqual({
      width: 2,
      height: 2,
      indices: new Uint8Array([1, 2, 3, 4]),
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/admin/templates/${ids.source}`),
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('keeps the persisted source when a destination manifest cannot be admitted', async () => {
    const source = server('https://source-refusal.test', '018f1b8c-7f4e-7a8c-8a01-123456789abc')
    const destination = server(
      'https://destination-refusal.test',
      '018f1b8c-7f4e-7a8c-8a01-123456789abd',
    )
    upsertServer(source)
    upsertServer(destination)
    const currentSource = getState().servers.find((item) => item.url === source.url)!
    const currentDestination = getState().servers.find((item) => item.url === destination.url)!
    const drawn = await addLocalTemplate(
      {
        id: serverTemplateKey(source.url, ids.source),
        name: published.name,
        source: 'wplace',
        originX: 10,
        originY: 20,
        width: 2,
        height: 2,
        indices: new Uint8Array([1, 2, 3, 4]),
        moved: 0,
        opaque: 4,
      },
      undefined,
      true,
    )
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (
        url.hostname === 'destination-refusal.test' &&
        url.pathname.endsWith('/admin/templates') &&
        init?.method === 'POST'
      )
        return Response.json(
          { templateId: ids.destination, versionId: ids.destinationVersion },
          { status: 201 },
        )
      if (
        url.hostname === 'destination-refusal.test' &&
        url.pathname.endsWith(`/admin/templates/${ids.destination}`)
      )
        return Response.json({})
      if (url.hostname === 'destination-refusal.test' && url.pathname.endsWith('/manifest'))
        return Response.json({})
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    window.fetch = fetchMock as typeof window.fetch
    const serverDrawn = Object.assign(templateById(drawn.id)!, { serverVersion: ids.sourceVersion })
    const result = await moveServerTemplateToServer(
      currentSource,
      currentDestination,
      null,
      published,
      serverDrawn,
      () => published,
      async () => {},
    )
    expect(result).toMatchObject({ ok: false, destinationId: ids.destination })
    expect(templateById(drawn.id)).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining(`/admin/templates/${ids.source}`),
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
