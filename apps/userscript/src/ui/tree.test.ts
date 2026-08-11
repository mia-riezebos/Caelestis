import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ConnectedServer, probeServer, setState } from '../state.js'
import {
  nodeSiblingItems,
  nodeTreeKey,
  refreshNodes,
  reorderedSiblings,
  replaceSiblingOrder,
} from './tree.js'

const SERVER_ID = '019fed50-87a1-7523-a88c-bdeafad49681'
const NODE_ID = '019fed50-87a1-7523-a88c-bdeafad49682'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const server = (id: string, season: number): ConnectedServer => ({
  url: 'https://example.com',
  info: { id, name: 'Example', auth: 'none' },
  token: null,
  status: 'connected',
  isAdmin: true,
  season,
})

describe('tree identity and ordering', () => {
  it('does not admit a key from another sibling group', () => {
    expect(reorderedSiblings(['a', 'b'], 'foreign', 'b', false)).toBeNull()
    expect(reorderedSiblings(['a', 'b'], 'a', 'b', true)).toEqual(['b', 'a'])
  })

  it('replaces a very large sibling order without spreading function arguments', () => {
    const siblings = Array.from({ length: 70_000 }, (_, index) => `node:${index}`)
    const first = siblings[0]
    const second = siblings[1]
    if (first === undefined || second === undefined) throw new Error('expected sibling fixtures')
    const next = [second, first, ...siblings.slice(2)]

    const replaced = replaceSiblingOrder(['before', ...siblings, 'after'], siblings, next)

    expect(replaced).toHaveLength(70_002)
    expect(replaced.slice(0, 4)).toEqual(['before', 'node:1', 'node:0', 'node:2'])
    expect(replaced.at(-1)).toBe('after')
  })

  it('namespaces node UI state by verified server identity and season', () => {
    const first = nodeTreeKey(server(SERVER_ID, 0), NODE_ID)
    const otherServer = nodeTreeKey(server('019fed50-87a1-7523-a88c-bdeafad49683', 0), NODE_ID)
    const nextSeason = nodeTreeKey(server(SERVER_ID, 1), NODE_ID)

    expect(new Set([first, otherServer, nextSeason])).toHaveLength(3)
  })

  it('uses the same scoped keys for server node rows and their sibling order', () => {
    const connected = server(SERVER_ID, 0)
    const node = { id: NODE_ID, parentId: null, path: '/group', name: 'Group' }

    expect(nodeSiblingItems(connected, [node])).toEqual([
      { key: nodeTreeKey(connected, NODE_ID), name: 'Group', node },
    ])
  })

  it('notifies every view waiting on one in-flight node refresh', async () => {
    let release: ((response: Response) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      ),
    )
    const connected = server(SERVER_ID, 0)
    setState({ servers: [connected] })
    const firstView = vi.fn()
    const rebuiltView = vi.fn()

    const first = refreshNodes(connected, firstView)
    const rebuilt = refreshNodes(connected, rebuiltView)
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledOnce()
    release?.(new Response('[]', { status: 200 }))
    await Promise.all([first, rebuilt])
    await Promise.resolve()

    expect(firstView).toHaveBeenCalledOnce()
    expect(rebuiltView).toHaveBeenCalledOnce()
  })

  it('defers the rerender when reusing nodes from the admin probe', async () => {
    const info = { id: SERVER_ID, name: 'Example', auth: 'none' as const }
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(info), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              version: 'v1',
              season: 0,
              server: info,
              nodes: [],
              templates: [],
              tiles: [],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response('[]', { status: 200 })),
    )
    const connected = await probeServer('https://example.com', null)
    setState({ servers: [connected] })
    const rerender = vi.fn()

    const refreshing = refreshNodes(connected, rerender)
    expect(rerender).not.toHaveBeenCalled()
    await refreshing
    await Promise.resolve()

    expect(rerender).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
