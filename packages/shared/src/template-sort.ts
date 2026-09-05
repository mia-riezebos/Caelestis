/** Default directions: stored order, newest, A-Z, highest completion, largest, most mismatched. */
export const TEMPLATE_SORTS = {
  custom: { label: 'Custom order', direction: 'asc' },
  recent: { label: 'Recent', direction: 'desc' },
  name: { label: 'Name A-Z', direction: 'asc' },
  progress: { label: 'Progress', direction: 'desc' },
  size: { label: 'Size', direction: 'desc' },
  mismatched: { label: 'Most mismatched', direction: 'desc' },
} as const

export type TemplateSortField = keyof typeof TEMPLATE_SORTS
export type TemplateSortDirection = 'asc' | 'desc'
export interface TemplateSortOrder {
  readonly field: TemplateSortField
  readonly direction: TemplateSortDirection
}

/** Validate a persisted or user-selected sorting field. */
export const isTemplateSortField = (value: unknown): value is TemplateSortField =>
  typeof value === 'string' && Object.hasOwn(TEMPLATE_SORTS, value)

/** Select a field with its documented default direction. */
export const defaultTemplateSort = (field: TemplateSortField): TemplateSortOrder => ({
  field,
  direction: TEMPLATE_SORTS[field].direction,
})
