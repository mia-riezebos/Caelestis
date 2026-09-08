import { parseTemplateFilters } from '@caelestis/shared'
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
  it('keeps ancestors of tagged leaves and independently matches tagged folders', () => {
    const tag = '019fed50-87a1-7523-a88c-bdeafad49681'
    const root = row('Root', 'root')
    const folder = {
      ...row('Folder', 'folder'),
      filterFacts: { source: 'local' as const, visible: true, tags: [tag] },
    }
    const child = {
      ...row('Art', null),
      filterFacts: {
        source: 'local' as const,
        visible: true,
        tags: [tag],
        claims: { mine: true, claimed: true },
      },
    }
    const source = groupedTreeSource([
      { parentId: null, item: root },
      { parentId: 'root', item: folder },
      { parentId: 'folder', item: child },
    ])
    expect(
      [root, folder, child].filter(treeMatcher(source, '', parseTemplateFilters({ tags: [tag] }))),
    ).toEqual([root, folder, child])
    expect(
      [root, folder, child].filter(
        treeMatcher(source, 'art', parseTemplateFilters({ tags: [tag], claims: ['mine'] })),
      ),
    ).toEqual([root, folder, child])
    expect(
      [root, folder, child].filter(
        treeMatcher(source, '', parseTemplateFilters({ claims: ['unclaimed'] })),
      ),
    ).toEqual([])
    const folderOnly = groupedTreeSource([
      { parentId: null, item: root },
      { parentId: 'root', item: folder },
      { parentId: 'folder', item: { ...child, filterFacts: { ...child.filterFacts, tags: [] } } },
    ])
    expect(
      folderOnly
        .children('folder')
        .filter(treeMatcher(folderOnly, '', parseTemplateFilters({ tags: [tag] }))),
    ).toEqual([])
    expect(treeMatcher(folderOnly, '', parseTemplateFilters({ tags: [tag] }))(root)).toBe(true)
  })
  it('matches folder tags and preserves ancestors without assigning tags to descendants', () => {
    const root = row('Local', 'local')
    const folder = row('Folder', 'folder', ['Repair'])
    const child = row('Art', null)
    const source = groupedTreeSource([
      { parentId: null, item: root },
      { parentId: 'local', item: folder },
      { parentId: 'folder', item: child },
    ])
    expect(
      [root, folder, child].filter(treeMatcher(source, 'repair')).map(({ key }) => key),
    ).toEqual(['Local', 'Folder'])
  })
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
