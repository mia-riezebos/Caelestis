import { describe, expect, it } from 'vitest'
import type { TreeNode } from '../server-manifest.js'
import { serverDestinations } from './server-destinations.js'

const folder = (id: string, path: string): TreeNode => ({
  id,
  parentId: null,
  path,
  name: path.slice(1),
  createdAt: 1,
})

describe('server template destinations', () => {
  it('offers the server root even when the server has no folders', () => {
    expect(serverDestinations([])).toEqual([{ nodeId: null, label: 'Server root' }])
  })

  it('offers the root before every folder', () => {
    expect(serverDestinations([folder('a', '/one'), folder('b', '/two')])).toEqual([
      { nodeId: null, label: 'Server root' },
      { nodeId: 'a', label: '/one' },
      { nodeId: 'b', label: '/two' },
    ])
  })
})
