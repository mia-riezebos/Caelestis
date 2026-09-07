import { describe, expect, it } from 'vitest'
import { groupedTreeSource, type TreeItem, treeMatcher } from './tree-source.js'

const row = (
  key: string,
  childrenOf: string | null,
  tagNames: readonly string[] = [],
): TreeItem => ({
  key,
  name: key,
  childrenOf,
  tagNames,
  kind: childrenOf === null ? 'image' : 'folder',
  visible: true,
  setVisible: () => true,
  canReparent: true,
})

describe('tag search', () => {
  it('keeps the complete folder path to matching local and server templates', () => {
    for (const owner of ['Local', 'Server']) {
      const folder = row(owner, owner)
      const nested = row('Nested', 'nested')
      const artwork = row('Tower', null, ['Repair', 'Priority'])
      const sibling = row('Lake', null, ['Landscape'])
      const source = groupedTreeSource([
        { parentId: null, item: folder },
        { parentId: owner, item: nested },
        { parentId: 'nested', item: artwork },
        { parentId: owner, item: sibling },
      ])
      const matches = treeMatcher(source, 'priority')
      expect([folder, nested, artwork, sibling].filter(matches).map((item) => item.key)).toEqual([
        owner,
        'Nested',
        'Tower',
      ])
      expect(source.children(owner).map((item) => item.key)).toEqual(['Nested', 'Lake'])
      expect(treeMatcher(source, 'tower')(artwork)).toBe(true)
      expect(treeMatcher(source, 'nested')(nested)).toBe(true)
    }
  })
})
