export type SortField = 'custom' | 'name' | 'progress'
export type SortDirection = 'asc' | 'desc'

export interface SortOrder {
  readonly field: SortField
  readonly direction: SortDirection
}

export const DEFAULT_SORT: SortOrder = { field: 'custom', direction: 'asc' }

export const isReorderable = (order: SortOrder): boolean => order.field === 'custom'

export const progressChangesCanReorder = (order: SortOrder): boolean => order.field === 'progress'
