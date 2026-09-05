import { defaultTemplateSort, type TemplateSortOrder } from '@caelestis/shared'

export type {
  TemplateSortDirection as SortDirection,
  TemplateSortField as SortField,
  TemplateSortOrder as SortOrder,
} from '@caelestis/shared'

type SortOrder = TemplateSortOrder

export const DEFAULT_SORT = defaultTemplateSort('custom')

export const isReorderable = (order: SortOrder): boolean => order.field === 'custom'

export const progressChangesCanReorder = (order: SortOrder): boolean =>
  order.field === 'progress' || order.field === 'mismatched'
