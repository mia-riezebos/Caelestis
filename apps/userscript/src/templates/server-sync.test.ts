import { sha256Hex } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface MockServer {
  readonly url: string
  readonly token: string | null
  readonly status: string
  readonly isAdmin: boolean
  readonly season: number | null
  readonly info: { readonly id: string; readonly name?: string; readonly auth: string } | null
}

const state = vi.hoisted(() => ({
  getState: vi.fn((): { servers: readonly MockServer[] } => ({ servers: [] })),
  isCurrentServerConnection: vi.fn((server: MockServer) =>
    state.getState().servers.some((candidate) => state.sameServerConnection(candidate, server)),
  ),
  isLatestServerContents: vi.fn(() => true),
  listServerContents: vi.fn(),
  onStateChange: vi.fn(),
  sameServerConnection: vi.fn(
    (
      left: {
        url: string
        token: string | null
        status: string
        isAdmin: boolean
        season: number | null
        info: { id: string; auth: string } | null
      },
      right: {
        url: string
        token: string | null
        status: string
        isAdmin: boolean
        season: number | null
        info: { id: string; auth: string } | null
      },
    ) =>
      left.url === right.url &&
      left.token === right.token &&
      left.status === right.status &&
      left.isAdmin === right.isAdmin &&
      left.season === right.season &&
      left.info?.id === right.info?.id &&
      left.info?.auth === right.info?.auth,
  ),
}))
const store = vi.hoisted(() => ({
  forgetServerTemplate: vi.fn(),
  hasRoomForServerTemplate: vi.fn(() => true),
  localTemplates: vi.fn(
    (): Array<{ id: string; serverUrl?: string; serverVersion?: string }> => [],
  ),
  putServerTemplate: vi.fn(async () => true),
  updateServerTemplateMetadata: vi.fn(),
}))

vi.mock('../state.js', () => state)
vi.mock('./local-store.js', () => store)
vi.mock('./server-nodes.js', () => ({ rememberNodes: vi.fn() }))
vi.mock('../debug.js', () => ({ count: vi.fn(), warn: vi.fn() }))

const connected = {
  url: 'https://example.test',
  info: { id: '019fed50-87a1-7523-a88c-bdeafad49681', name: 'Example', auth: 'none' as const },
  token: null,
  status: 'connected' as const,
  isAdmin: false,
  season: 0,
  lastVerified: { serverId: '019fed50-87a1-7523-a88c-bdeafad49681', season: 0 },
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  state.getState.mockReturnValue({ servers: [connected] })
  state.isLatestServerContents.mockReturnValue(true)
  store.localTemplates.mockReturnValue([])
})

describe('server template sync', () => {
  it('ignores refresh callbacks from a removed or replaced connection', async () => {
    state.getState.mockReturnValue({ servers: [{ ...connected }] })
    const { syncServerTemplates } = await import('./server-sync.js')

    await syncServerTemplates(connected, [])

    expect(state.listServerContents).not.toHaveBeenCalled()
    expect(store.putServerTemplate).not.toHaveBeenCalled()
  })

  it('bounds a template by both chunk count and cumulative encoded work', async () => {
    const { syncServerTemplates, templateTransferWithinBudget } = await import('./server-sync.js')
    const chunks = Array.from({ length: 401 }, (_, index) => ({
      tile: `${index}/0`,
      hash: index.toString(16).padStart(64, '0'),
    }))
    const template = {
      id: 'too-wide',
      nodeId: 'folder',
      name: 'Too wide',
      version: 'v1',
      published: true,
      updatedAt: 1,
      bbox: { minX: 0, minY: 0, maxX: 401_000, maxY: 1 },
      chunks,
    }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await syncServerTemplates(connected, [template])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(templateTransferWithinBudget(64 * 1024 * 1024 - 1, 1)).toBe(true)
    expect(templateTransferWithinBudget(64 * 1024 * 1024, 1)).toBe(false)
  })

  it('does not cache a chunk that exceeds the template remaining transfer budget', async () => {
    const bytes = new Uint8Array([1, 2])
    const hash = await sha256Hex(bytes)
    const fetchMock = vi.fn(async () => new Response(bytes))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchChunkWithinBudget } = await import('./server-sync.js')
    const signal = new AbortController().signal

    await expect(fetchChunkWithinBudget(connected, hash, signal, 1)).resolves.toBeNull()
    await expect(fetchChunkWithinBudget(connected, hash, signal, 2)).resolves.toEqual(bytes)
    await expect(fetchChunkWithinBudget(connected, hash, signal, 2)).resolves.toEqual(bytes)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses an encoded server identity that cannot collide with a longer URL', async () => {
    const { serverTemplateKey } = await import('./server-sync.js')

    expect(
      serverTemplateKey('https://host/a:b', 'id').startsWith(
        serverTemplateKey('https://host/a', ''),
      ),
    ).toBe(false)
  })

  it('coalesces polls while one sync for that server is still running', async () => {
    let release = (_value: { nodes: never[]; templates: never[] }): void => undefined
    const firstContents = new Promise<{ nodes: never[]; templates: never[] }>((resolve) => {
      release = resolve
    })
    state.listServerContents
      .mockReturnValueOnce(firstContents)
      .mockResolvedValueOnce({ nodes: [], templates: [] })
    const { syncServerTemplates } = await import('./server-sync.js')

    const first = syncServerTemplates(connected)
    await vi.waitFor(() => expect(state.listServerContents).toHaveBeenCalledOnce())
    const second = syncServerTemplates(connected)
    const third = syncServerTemplates(connected)
    expect(state.listServerContents).toHaveBeenCalledOnce()

    release({ nodes: [], templates: [] })
    await Promise.all([first, second, third])

    expect(state.listServerContents).toHaveBeenCalledTimes(2)
  })

  it('does not let a blind poll displace a pending mutation manifest', async () => {
    let release = (_value: { nodes: never[]; templates: never[] }): void => undefined
    const firstContents = new Promise<{ nodes: never[]; templates: never[] }>((resolve) => {
      release = resolve
    })
    state.listServerContents.mockReturnValueOnce(firstContents)
    const { syncServerTemplates } = await import('./server-sync.js')

    const first = syncServerTemplates(connected)
    await vi.waitFor(() => expect(state.listServerContents).toHaveBeenCalledOnce())
    const mutation = syncServerTemplates(connected, [])
    const blindPoll = syncServerTemplates(connected)
    release({ nodes: [], templates: [] })
    await Promise.all([first, mutation, blindPoll])

    expect(state.listServerContents).toHaveBeenCalledOnce()
  })

  it('drops a manifest response superseded by a newer request', async () => {
    state.listServerContents.mockResolvedValueOnce({ nodes: [], templates: [] })
    state.isLatestServerContents.mockReturnValueOnce(false)
    const { syncServerTemplates } = await import('./server-sync.js')

    await syncServerTemplates(connected)

    expect(store.forgetServerTemplate).not.toHaveBeenCalled()
    expect(store.putServerTemplate).not.toHaveBeenCalled()
  })

  it('does not reconcile a blind manifest rejected by aggregate admission', async () => {
    const contents = { nodes: [], templates: [] }
    state.listServerContents.mockResolvedValueOnce(contents)
    store.localTemplates.mockReturnValue([
      { id: 'srv:https%3A%2F%2Fexample.test:held', serverUrl: connected.url },
    ])
    const { rejectServerContentsForSync, syncServerTemplates } = await import('./server-sync.js')
    rejectServerContentsForSync(contents)

    await syncServerTemplates(connected)

    expect(store.forgetServerTemplate).not.toHaveBeenCalled()
    expect(store.putServerTemplate).not.toHaveBeenCalled()
  })

  it('queues the newest full snapshot when superseded during removal', async () => {
    let releaseForget = (): void => undefined
    let current = true
    const template = {
      id: 'template',
      nodeId: 'folder-b',
      name: 'Template',
      version: 'v1',
      published: true,
      updatedAt: 1,
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      chunks: [],
    }
    const held = {
      id: 'srv:https%3A%2F%2Fexample.test:template',
      serverUrl: connected.url,
      serverVersion: 'v1',
    }
    store.localTemplates.mockReturnValue([held])
    store.forgetServerTemplate.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          releaseForget = resolve
        }),
    )
    const { syncServerTemplates } = await import('./server-sync.js')

    const syncing = syncServerTemplates(connected, [], () => current)
    await vi.waitFor(() => expect(store.forgetServerTemplate).toHaveBeenCalledOnce())
    current = false
    const repair = syncServerTemplates(connected, [template])
    releaseForget()
    await Promise.all([syncing, repair])

    expect(store.updateServerTemplateMetadata).toHaveBeenCalledWith(
      held.id,
      template.name,
      template.nodeId,
    )
  })

  it('stops an active drain when its connection object is replaced', async () => {
    let releaseForget = (): void => undefined
    const wanted = {
      id: 'wanted',
      nodeId: 'folder',
      name: 'Wanted',
      version: 'v1',
      published: true,
      updatedAt: 1,
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      chunks: [],
    }
    store.localTemplates.mockReturnValue([
      { id: 'srv:https%3A%2F%2Fexample.test:obsolete', serverUrl: connected.url },
      {
        id: 'srv:https%3A%2F%2Fexample.test:wanted',
        serverUrl: connected.url,
        serverVersion: 'v1',
      },
    ])
    store.forgetServerTemplate.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          releaseForget = resolve
        }),
    )
    const { syncServerTemplates } = await import('./server-sync.js')

    const syncing = syncServerTemplates(connected, [wanted])
    await vi.waitFor(() => expect(store.forgetServerTemplate).toHaveBeenCalledOnce())
    state.getState.mockReturnValue({ servers: [{ ...connected, token: 'replacement' }] })
    releaseForget()
    await syncing

    expect(store.updateServerTemplateMetadata).not.toHaveBeenCalled()
    expect(store.putServerTemplate).not.toHaveBeenCalled()
  })

  it('keeps active work across a cosmetic server rename', async () => {
    const template = {
      id: 'wanted',
      nodeId: 'folder',
      name: 'Wanted',
      version: 'v1',
      published: true,
      updatedAt: 1,
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      chunks: [],
    }
    const held = {
      id: 'srv:https%3A%2F%2Fexample.test:wanted',
      serverUrl: connected.url,
      serverVersion: 'v1',
    }
    store.localTemplates.mockReturnValue([held])
    state.getState.mockReturnValue({
      servers: [{ ...connected, info: { ...connected.info, name: 'Renamed' } }],
    })
    const { syncServerTemplates } = await import('./server-sync.js')

    await syncServerTemplates(connected, [template])

    expect(store.updateServerTemplateMetadata).toHaveBeenCalledWith(
      held.id,
      template.name,
      template.nodeId,
    )
  })

  it('aborts an obsolete chunk drain and lets the same URL reconnect immediately', async () => {
    let requestedSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
          await new Promise<Response>((_resolve, reject) => {
            requestedSignal = init?.signal instanceof AbortSignal ? init.signal : undefined
            requestedSignal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            })
          }),
      ),
    )
    const template = {
      id: 'template',
      nodeId: 'folder',
      name: 'Template',
      version: 'v1',
      published: true,
      updatedAt: 1,
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      chunks: [{ tile: '0/0', hash: '0'.repeat(64) }],
    }
    const { endServerGeneration, syncServerTemplates } = await import('./server-sync.js')

    const stale = syncServerTemplates(connected, [template])
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    endServerGeneration(connected.url)

    await expect(syncServerTemplates(connected, [])).resolves.toBeUndefined()
    await expect(stale).resolves.toBeUndefined()
    expect(requestedSignal?.aborted).toBe(true)
  })
})
