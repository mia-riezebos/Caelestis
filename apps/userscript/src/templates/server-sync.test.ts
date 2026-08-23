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
})
