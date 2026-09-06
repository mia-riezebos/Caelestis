import { describe, expect, it } from 'vitest'
import { isReorderable, progressChangesCanReorder } from './sort.js'

describe('tree sort state', () => {
  it('allows reordering only in custom order', () => {
    expect(isReorderable({ field: 'custom', direction: 'asc' })).toBe(true)
    expect(isReorderable({ field: 'name', direction: 'asc' })).toBe(false)
  })

  it('marks progress sorting as structurally sensitive to progress changes', () => {
    expect(progressChangesCanReorder({ field: 'mismatched', direction: 'desc' })).toBe(true)
    expect(progressChangesCanReorder({ field: 'progress', direction: 'asc' })).toBe(true)
    expect(progressChangesCanReorder({ field: 'custom', direction: 'asc' })).toBe(false)
  })
})
