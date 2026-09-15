import { afterEach, describe, expect, it, vi } from 'vitest'

const serverId = '018f1b8c-7f4e-7a8c-8a01-123456789abc'

const loadState = async () => {
  vi.resetModules()
  return await import('../src/state.js')
}

afterEach(() => vi.restoreAllMocks())

describe('saved server state', () => {
  it('keeps one canonical server and never sends a rejected saved token', async () => {
    localStorage.setItem(
      'caelestis.state.v2',
      JSON.stringify({
        servers: [
          { url: 'https://example.test/', token: 'saved', info: null },
          { url: 'https://example.test', token: 'other', info: null },
          { url: 4 },
        ],
        hiddenColours: [-1, 0, 0, 999],
      }),
    )
    const state = await loadState()
    const loaded = state.loadState()
    expect(loaded.servers).toHaveLength(1)
    expect(loaded.hiddenColours).toEqual([0])
    state.upsertServer({
      ...loaded.servers[0]!,
      status: 'connected',
      token: null,
      tokenUsable: false,
      isAdmin: false,
      season: 1,
    })
    expect(state.activeServerToken(state.getState().servers[0]!)).toBeNull()
    expect(JSON.parse(localStorage.getItem('caelestis.state.v2')!).servers[0].token).toBe('saved')
  })

  it('aborts work belonging to a replaced connection', async () => {
    const state = await loadState()
    const first = {
      url: 'https://example.test',
      info: { id: serverId, name: 'Example', auth: 'none' as const },
      token: 'old',
      status: 'connected' as const,
      isAdmin: true,
      season: 1,
    }
    state.upsertServer(first)
    const signal = state.serverConnectionSignal(state.getState().servers[0]!)
    state.upsertServer({ ...first, token: 'new' })
    expect(signal.aborted).toBe(true)
  })
})

describe('server manifest admission', () => {
  it('rejects duplicate tree paths and accepts valid server identity', async () => {
    const { parseServerInfo, parseTreeNodes } = await import('../src/server-manifest.js')
    expect(parseServerInfo({ id: serverId, name: 'Example', auth: 'none' })).toMatchObject({
      id: serverId,
    })
    expect(
      parseTreeNodes([
        { id: serverId, parentId: null, path: '/Work', name: 'Work', createdAt: 1_700_000_000_000 },
        {
          id: '018f1b8c-7f4e-7a8c-8a01-123456789abd',
          parentId: null,
          path: '/work',
          name: 'work',
          createdAt: 1_700_000_000_000,
        },
      ]),
    ).toBeNull()
  })
})
