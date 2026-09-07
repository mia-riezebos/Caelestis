import type { TemplateSurface } from './template-surface.js'
import {
  isWorkIdentity,
  isWorkItem,
  MAX_WORK_ITEMS,
  type WorkActivity,
  type WorkItem,
  type WorkMutation,
} from './work.js'

export interface WorkCollection {
  readonly items: readonly WorkItem[]
  readonly canPlan: boolean
  readonly canClaim: boolean
}

/** The hosts supply credentials and transport; response validation and work URLs stay shared. */
export const createWorkClient = (
  request: (path: string, init?: RequestInit) => Promise<Response>,
  season: number,
  surface: TemplateSurface,
) => {
  const scope = new URLSearchParams({ season: String(season), surface: surface.kind })
  if (surface.allianceId !== null) scope.set('allianceId', String(surface.allianceId))
  const json = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await request(path, init)
    const body: unknown = await response.json()
    if (!response.ok) {
      const message =
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof body.error === 'string'
          ? body.error
          : `Work request failed (${response.status})`
      throw Object.assign(new Error(message), { status: response.status })
    }
    return body
  }
  return {
    async list(): Promise<WorkCollection> {
      const items: WorkItem[] = []
      let cursor = ''
      while (true) {
        const body = await json(
          `/work?${scope}${cursor === '' ? '' : `&after=${encodeURIComponent(cursor)}`}`,
        )
        if (
          typeof body !== 'object' ||
          body === null ||
          !('items' in body) ||
          !Array.isArray(body.items) ||
          body.items.length > MAX_WORK_ITEMS ||
          !body.items.every(isWorkItem) ||
          !('canPlan' in body) ||
          typeof body.canPlan !== 'boolean' ||
          !('canClaim' in body) ||
          typeof body.canClaim !== 'boolean'
        )
          throw new Error('Server returned invalid work items')
        if (
          body.items.some(
            (item) =>
              item.season !== season ||
              item.surface.kind !== surface.kind ||
              item.surface.allianceId !== surface.allianceId,
          )
        )
          throw new Error('Server returned work from a different drawing scope')
        items.push(...body.items)
        const next = 'nextCursor' in body ? body.nextCursor : null
        if (next === null) return { items, canPlan: body.canPlan, canClaim: body.canClaim }
        if (typeof next !== 'string' || next <= cursor || next !== body.items.at(-1)?.id)
          throw new Error('Server returned an invalid work cursor')
        cursor = next
      }
    },
    async mutate(id: string, mutation: WorkMutation): Promise<WorkItem> {
      const body = await json(`/work/${encodeURIComponent(id)}?${scope}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mutation),
      })
      if (!isWorkItem(body) || body.id !== id)
        throw new Error('Server returned an invalid work item')
      return body
    },
    async history(id: string, before = Number.MAX_SAFE_INTEGER): Promise<readonly WorkActivity[]> {
      const body = await json(`/work/${encodeURIComponent(id)}/history?before=${before}`)
      if (
        !Array.isArray(body) ||
        body.length > 50 ||
        !body.every(
          (event): event is WorkActivity =>
            typeof event === 'object' &&
            event !== null &&
            typeof event.id === 'string' &&
            ['create', 'edit', 'claim', 'release', 'assign'].includes(event.action) &&
            isWorkIdentity(event.actor) &&
            isWorkItem(event.item) &&
            event.item.id === id,
        )
      )
        throw new Error('Server returned invalid work history')
      return body
    },
  }
}

export type WorkClient = ReturnType<typeof createWorkClient>
