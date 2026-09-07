/** Choices combine with OR within a category and AND between categories. */
export const TEMPLATE_FILTER_OPTIONS = {
  source: { local: 'Local', server: 'Server' },
  visibility: { visible: 'Visible', hidden: 'Hidden' },
  lifecycle: { active: 'Active', finished: 'Finished', frozen: 'Timelapse frozen' },
  alarm: {
    regression: 'Regression',
    'sustained-griefing': 'Sustained griefing',
    none: 'No active alarm',
  },
} as const

export type TemplateFilterCategory = keyof typeof TEMPLATE_FILTER_OPTIONS
export type TemplateFilters = {
  readonly [Category in TemplateFilterCategory]: readonly (keyof (typeof TEMPLATE_FILTER_OPTIONS)[Category])[]
}

export const EMPTY_TEMPLATE_FILTERS: TemplateFilters = {
  source: [],
  visibility: [],
  lifecycle: [],
  alarm: [],
}

/** Read saved preferences, dropping unknown choices and duplicates. */
export const parseTemplateFilters = (value: unknown): TemplateFilters => {
  const saved: Record<string, unknown> =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const choices = <Category extends TemplateFilterCategory>(category: Category) => {
    const values = saved[category]
    return (
      Object.keys(
        TEMPLATE_FILTER_OPTIONS[category],
      ) as (keyof (typeof TEMPLATE_FILTER_OPTIONS)[Category])[]
    ).filter((choice) => Array.isArray(values) && values.includes(choice))
  }
  return {
    source: choices('source'),
    visibility: choices('visibility'),
    lifecycle: choices('lifecycle'),
    alarm: choices('alarm'),
  }
}

/** Number of selected choices, independent of the current result set. */
export const templateFilterCount = (filters: TemplateFilters): number =>
  Object.values(filters).reduce((count, choices) => count + choices.length, 0)

export interface TemplateFilterFacts {
  readonly source: 'local' | 'server'
  readonly visible: boolean
  /** Local templates have no server lifecycle or alarm data. */
  readonly lifecycle?: { readonly finished: boolean; readonly frozen: boolean }
  readonly alarm?: 'regression' | 'sustained-griefing' | 'none'
}

/** Match one template before selecting a tree or grid presentation. */
export const matchesTemplateFilters = (
  facts: TemplateFilterFacts,
  filters: TemplateFilters,
): boolean => {
  if (filters.source.length > 0 && !filters.source.includes(facts.source)) return false
  if (
    filters.visibility.length > 0 &&
    !filters.visibility.includes(facts.visible ? 'visible' : 'hidden')
  )
    return false
  if (
    filters.alarm.length > 0 &&
    (facts.alarm === undefined || !filters.alarm.includes(facts.alarm))
  )
    return false
  if (filters.lifecycle.length === 0) return true
  const lifecycle = facts.lifecycle
  if (lifecycle === undefined) return false
  return filters.lifecycle.some((choice) =>
    choice === 'active'
      ? !lifecycle.finished
      : choice === 'finished'
        ? lifecycle.finished
        : lifecycle.frozen,
  )
}
