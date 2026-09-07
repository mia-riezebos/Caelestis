import { describe, expect, it } from 'vitest'
import { WORLD_TEMPLATE_SURFACE } from './template-surface.js'
import { filterWork, isWorkIdentity, type WorkItem } from './work.js'

const base: WorkItem = {
  id: 'work',
  season: 0,
  surface: WORLD_TEMPLATE_SURFACE,
  title: 'Repair border',
  description: '',
  status: 'open',
  priority: 'high',
  tags: ['repair'],
  blockerIds: [],
  nodeId: 'folder',
  templateIds: ['template'],
  claimant: { wplaceUserId: 7, displayName: 'Painter' },
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
}
describe('coordination filters', () => {
  it('combines folder, template, painter, tag and text filters', () => {
    const others = [
      { ...base, id: 'other', nodeId: null },
      { ...base, id: 'done', status: 'completed' as const },
    ]
    expect(
      filterWork([base, ...others], {
        state: 'claimed',
        nodeIds: new Set(['folder']),
        templateId: 'template',
        claimantId: 7,
        tag: 'repair',
        search: 'BORDER',
      }),
    ).toEqual([base])
    expect(filterWork([base], { tag: 'unknown' })).toEqual([])
    expect(filterWork([base], { state: 'blocked' })).toEqual([])
  })
  it('rejects malformed self-reported identities', () => {
    expect(isWorkIdentity({ displayName: '   ', wplaceUserId: 1 })).toBe(false)
    expect(isWorkIdentity({ displayName: 'Painter', wplaceUserId: 1.5 })).toBe(false)
    expect(isWorkIdentity(base.claimant)).toBe(true)
  })
})
