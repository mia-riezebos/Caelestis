import { defaultTemplateSort, type TemplateSortOrder } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type OrderedTreeItem, orderedTreeItems } from './tree-order.js'

const state = vi.hoisted(() => ({
  sort: { field: 'custom', direction: 'asc' } as TemplateSortOrder,
}))
vi.mock('../state.js', () => ({ getState: () => state, setState: vi.fn() }))

const row = (key: string, value: number): OrderedTreeItem => ({
  key,
  name: key,
  updatedAt: value,
  totalPixels: value,
  mismatched: value,
  progress: { total: 100, completed: value, mismatched: value, known: 100, unpainted: 0 },
  progressSortable: true,
})
const items = [row('B', 20), { key: 'folder', name: 'Folder' }, row('A', 10), row('C', 30)]
const rank = new Map(items.map((item, index) => [item.key, index]))
const keys = (values: readonly OrderedTreeItem[]) => values.map((item) => item.key)

beforeEach(() => {
  state.sort = defaultTemplateSort('custom')
})

describe('template sort projections', () => {
  it.each(['recent', 'progress', 'size', 'mismatched'] as const)(
    'sorts %s in both directions with fixed folder slots',
    (field) => {
      state.sort = defaultTemplateSort(field)
      expect(state.sort.direction).toBe('desc')
      expect(keys(orderedTreeItems(items, rank))).toEqual(['C', 'folder', 'B', 'A'])
      state.sort = { field, direction: 'asc' }
      expect(keys(orderedTreeItems(items, rank))).toEqual(['A', 'folder', 'B', 'C'])
      expect(keys(orderedTreeItems(items, rank, 2))).toEqual(['A', 'folder'])
      state.sort = defaultTemplateSort('custom')
      expect(keys(orderedTreeItems(items, rank))).toEqual(['B', 'folder', 'A', 'C'])
      expect([...rank.keys()]).toEqual(['B', 'folder', 'A', 'C'])
    },
  )

  it('defaults to A-Z and reverses name order, including bounded results', () => {
    state.sort = defaultTemplateSort('name')
    expect(keys(orderedTreeItems(items, rank, 2))).toEqual(['A', 'B'])
    state.sort = { field: 'name', direction: 'desc' }
    expect(keys(orderedTreeItems(items, rank))).toEqual(['folder', 'C', 'B', 'A'])
  })

  it.each(['name', 'recent', 'progress', 'size', 'mismatched'] as const)(
    'keeps %s ties stable through reversal',
    (field) => {
      const ties = [
        { ...row('b', 10), name: 'Same' },
        { ...row('a', 10), name: 'Same' },
      ]
      for (const direction of ['asc', 'desc'] as const) {
        state.sort = { field, direction }
        expect(keys(orderedTreeItems(ties, new Map()))).toEqual(['a', 'b'])
        expect(keys(orderedTreeItems(ties, new Map(), 1))).toEqual(['a'])
      }
    },
  )

  it.each(['recent', 'progress', 'size', 'mismatched'] as const)(
    'keeps unknown %s values last without duplicating leaves',
    (field) => {
      const unknown = { key: 'unknown', name: 'Unknown', progressSortable: true as const }
      for (const direction of ['asc', 'desc'] as const) {
        state.sort = { field, direction }
        expect(keys(orderedTreeItems([unknown, row('known', 0)], new Map()))).toEqual([
          'known',
          'unknown',
        ])
      }
    },
  )

  it('uses mismatch count rather than completion or size', () => {
    state.sort = defaultTemplateSort('mismatched')
    expect(
      keys(
        orderedTreeItems(
          [
            { ...row('large', 90), mismatched: 1 },
            { ...row('small', 10), mismatched: 5 },
          ],
          new Map(),
        ),
      ),
    ).toEqual(['small', 'large'])
  })
})
