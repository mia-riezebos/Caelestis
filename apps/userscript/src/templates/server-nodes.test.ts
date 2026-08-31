import { beforeEach, describe, expect, it, vi } from 'vitest'

const hidden = vi.hoisted(() => new Set<string>())

vi.mock('../state.js', () => ({
  isScopeVisible: (key: string) => !hidden.has(key),
}))

import {
  forgetNodes,
  nodeChainVisible,
  nodeScopeKey,
  rememberNodes,
  serverNodeParents,
} from './server-nodes.js'

const serverUrl = 'https://example.test'
const allianceSurface = { kind: 'alliance-banner', allianceId: 535_245 } as const

beforeEach(() => {
  hidden.clear()
  forgetNodes(serverUrl)
})

describe('server folder parents', () => {
  it('keeps visibility parent chains isolated by drawing surface', () => {
    rememberNodes(serverUrl, [
      { id: 'world-parent', parentId: null },
      { id: 'world-child', parentId: 'world-parent' },
    ])
    rememberNodes(
      serverUrl,
      [
        { id: 'alliance-parent', parentId: null },
        { id: 'alliance-child', parentId: 'alliance-parent' },
      ],
      allianceSurface,
    )
    hidden.add(nodeScopeKey(serverUrl, 'alliance-parent'))

    expect(nodeChainVisible(serverUrl, 'world-child')).toBe(true)
    expect(nodeChainVisible(serverUrl, 'alliance-child', allianceSurface)).toBe(false)
    expect(serverNodeParents(serverUrl)).toEqual([
      ['world-parent', null],
      ['world-child', 'world-parent'],
    ])
    expect(serverNodeParents(serverUrl, allianceSurface)).toEqual([
      ['alliance-parent', null],
      ['alliance-child', 'alliance-parent'],
    ])
  })
})
