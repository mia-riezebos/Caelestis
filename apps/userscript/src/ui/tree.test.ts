import { describe, expect, it } from 'vitest'
import type { ConnectedServer } from '../state.js'
import { nodeTreeKey, reorderedSiblings } from './tree.js'

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

  it('namespaces node UI state by verified server identity and season', () => {
    const nodeId = '019fed50-87a1-7523-a88c-bdeafad49682'
    const first = nodeTreeKey(server('019fed50-87a1-7523-a88c-bdeafad49681', 0), nodeId)
    const otherServer = nodeTreeKey(server('019fed50-87a1-7523-a88c-bdeafad49683', 0), nodeId)
    const nextSeason = nodeTreeKey(server('019fed50-87a1-7523-a88c-bdeafad49681', 1), nodeId)

    expect(new Set([first, otherServer, nextSeason])).toHaveLength(3)
  })
})
