import { describe, expect, it } from 'vitest'
import {
  EMPTY_TEMPLATE_FILTERS,
  matchesTemplateFilters,
  parseTemplateFilters,
  templateFilterCount,
} from './template-filters.js'

describe('template filters', () => {
  it('uses OR within categories and AND between categories', () => {
    const filters = parseTemplateFilters({
      source: ['local', 'server'],
      visibility: ['hidden'],
      lifecycle: ['finished', 'frozen'],
      alarm: ['regression', 'sustained-griefing'],
    })
    const facts = {
      source: 'server',
      visible: false,
      lifecycle: { finished: true, frozen: false },
      alarm: 'regression',
    } as const
    expect(matchesTemplateFilters(facts, filters)).toBe(true)
    expect(
      matchesTemplateFilters(
        { ...facts, lifecycle: { finished: false, frozen: true }, alarm: 'sustained-griefing' },
        filters,
      ),
    ).toBe(true)
    expect(matchesTemplateFilters({ ...facts, visible: true }, filters)).toBe(false)
    expect(matchesTemplateFilters({ ...facts, alarm: 'none' }, filters)).toBe(false)
    expect(
      matchesTemplateFilters({ ...facts, lifecycle: { finished: false, frozen: false } }, filters),
    ).toBe(false)
  })

  it('does not infer lifecycle or alarm states when data is absent', () => {
    const local = { source: 'local', visible: true } as const
    expect(matchesTemplateFilters(local, EMPTY_TEMPLATE_FILTERS)).toBe(true)
    expect(matchesTemplateFilters(local, parseTemplateFilters({ lifecycle: ['active'] }))).toBe(
      false,
    )
    expect(matchesTemplateFilters(local, parseTemplateFilters({ alarm: ['none'] }))).toBe(false)
  })

  it('accepts old preferences and removes invalid or duplicate saved choices', () => {
    for (const value of [undefined, null, 42, 'hidden', { source: 'local' }]) {
      expect(parseTemplateFilters(value)).toEqual(EMPTY_TEMPLATE_FILTERS)
    }
    const filters = parseTemplateFilters({
      source: ['server', 'server', 'invalid'],
      visibility: ['hidden', null],
      lifecycle: false,
      alarm: ['none'],
    })
    expect(filters).toEqual({
      source: ['server'],
      visibility: ['hidden'],
      lifecycle: [],
      alarm: ['none'],
    })
    expect(templateFilterCount(filters)).toBe(3)
  })
})
