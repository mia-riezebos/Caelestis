import type { PainterIdentity } from './telemetry.js'
import type { TemplateSurface } from './template-surface.js'

export const WORK_STATUSES = ['open', 'blocked', 'completed'] as const
export const WORK_PRIORITIES = ['low', 'normal', 'high'] as const
export const MAX_WORK_ITEMS = 500

/** Coordination uses self-reported Wplace identities until personal authentication exists. */
export interface WorkFields {
  readonly title: string
  readonly description: string
  readonly status: (typeof WORK_STATUSES)[number]
  readonly priority: (typeof WORK_PRIORITIES)[number]
  readonly tags: readonly string[]
  readonly blockerIds: readonly string[]
  readonly nodeId: string | null
  readonly templateIds: readonly string[]
}

export interface WorkItem extends WorkFields {
  readonly id: string
  readonly season: number
  readonly surface: TemplateSurface
  readonly claimant: PainterIdentity | null
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
}

export type WorkAction = 'create' | 'edit' | 'claim' | 'release' | 'assign'

/** Each revision retains the complete result, including links to subsequently deleted artwork. */
export interface WorkActivity {
  readonly id: string
  readonly action: WorkAction
  readonly actor: PainterIdentity
  readonly item: WorkItem
}

export interface WorkMutation {
  readonly action: WorkAction
  readonly actor: PainterIdentity
  readonly expectedRevision: number
  readonly fields?: WorkFields
  readonly claimant?: PainterIdentity | null
}

export interface WorkFilter {
  readonly state?: 'all' | 'open' | 'claimed' | 'blocked' | 'completed'
  readonly nodeIds?: ReadonlySet<string>
  readonly templateId?: string
  readonly claimantId?: number
  readonly tag?: string
  readonly search?: string
}

/** Combine coordination filters without changing the original work order. */
export const filterWork = (items: readonly WorkItem[], filter: WorkFilter): readonly WorkItem[] => {
  const search = filter.search?.trim().toLocaleLowerCase()
  return items.filter((item) => {
    if (filter.state === 'claimed' && (item.claimant === null || item.status === 'completed'))
      return false
    if (
      filter.state !== undefined &&
      filter.state !== 'all' &&
      filter.state !== 'claimed' &&
      item.status !== filter.state
    )
      return false
    if (filter.nodeIds !== undefined && (item.nodeId === null || !filter.nodeIds.has(item.nodeId)))
      return false
    if (filter.templateId !== undefined && !item.templateIds.includes(filter.templateId))
      return false
    if (filter.claimantId !== undefined && item.claimant?.wplaceUserId !== filter.claimantId)
      return false
    if (filter.tag && !item.tags.includes(filter.tag)) return false
    return (
      !search ||
      `${item.title} ${item.description} ${item.tags.join(' ')}`
        .toLocaleLowerCase()
        .includes(search)
    )
  })
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.trim().length >= min && value.length <= max
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const ids = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= 20 &&
  value.every(uuid) &&
  new Set(value).size === value.length

/** Validate public identity labels, without asserting ownership of the Wplace account. */
export const isWorkIdentity = (value: unknown): value is PainterIdentity =>
  record(value) &&
  typeof value.wplaceUserId === 'number' &&
  Number.isSafeInteger(value.wplaceUserId) &&
  value.wplaceUserId >= 0 &&
  text(value.displayName, 1, 128)

/** Validate editable work fields at HTTP and persisted-client boundaries. */
export const isWorkFields = (value: unknown): value is WorkFields =>
  record(value) &&
  text(value.title, 1, 160) &&
  text(value.description, 0, 4096) &&
  WORK_STATUSES.some((status) => status === value.status) &&
  WORK_PRIORITIES.some((priority) => priority === value.priority) &&
  Array.isArray(value.tags) &&
  value.tags.length <= 20 &&
  value.tags.every((tag) => text(tag, 1, 40)) &&
  new Set(value.tags).size === value.tags.length &&
  ids(value.blockerIds) &&
  (value.nodeId === null || uuid(value.nodeId)) &&
  ids(value.templateIds)

/** Validate the work response before rendering data supplied by a server. */
export const isWorkItem = (value: unknown): value is WorkItem => {
  if (!isWorkFields(value) || !record(value)) return false
  const surface = value.surface
  return (
    uuid(value.id) &&
    Number.isSafeInteger(value.season) &&
    Number(value.season) >= 0 &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    Number.isSafeInteger(value.createdAt) &&
    Number.isSafeInteger(value.updatedAt) &&
    Number(value.createdAt) >= 0 &&
    Number(value.updatedAt) >= Number(value.createdAt) &&
    (value.claimant === null || isWorkIdentity(value.claimant)) &&
    record(surface) &&
    ((surface.kind === 'world' && surface.allianceId === null) ||
      (['alliance-headquarters', 'alliance-picture', 'alliance-banner'].includes(
        String(surface.kind),
      ) &&
        Number.isSafeInteger(surface.allianceId) &&
        Number(surface.allianceId) > 0))
  )
}
