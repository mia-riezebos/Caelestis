import { sha256Hex } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  getState: vi.fn(() => ({ servers: [] })),
  listServerContents: vi.fn(),
  onStateChange: vi.fn(),
}))
const store = vi.hoisted(() => ({
  forgetServerTemplate: vi.fn(),
  hasRoomForServerTemplate: vi.fn(() => true),
  localTemplates: vi.fn(() => []),
  putServerTemplate: vi.fn(),
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
  state.getState.mockReturnValue({ servers: [] })
})

describe('server template sync', () => {
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
