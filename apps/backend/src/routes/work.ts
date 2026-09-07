import { isWorkFields, isWorkIdentity, templateSurface, type WorkMutation } from '@caelestis/shared'
import { Hono } from 'hono'
import { type AuthOptions, requireScopeEffect } from '../auth/middleware.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import { listWork, mutateWork, workHistory } from '../work/use-cases.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const natural = (text: string | undefined): number | null => {
  if (text === undefined || !/^(0|[1-9]\d*)$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}
const parseMutation = (body: unknown): WorkMutation | null => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  const { action, actor, expectedRevision, fields, claimant } = value
  if (
    !isWorkIdentity(actor) ||
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  )
    return null
  if (action === 'create' || action === 'edit')
    return isWorkFields(fields) ? { action, actor, expectedRevision, fields } : null
  if (action === 'claim' || action === 'release') return { action, actor, expectedRevision }
  if (action === 'assign' && (claimant === null || isWorkIdentity(claimant)))
    return { action, actor, expectedRevision, claimant }
  return null
}

/** Shared coordination routes. Read-only frontend proxy credentials never authorize mutations. */
export const createWorkRoutes = (runtime: BackendRuntime, auth: AuthOptions) => {
  const routes = new Hono()
  routes.use('/*', requireScopeEffect(runtime, auth, 'read'))
  routes.get('/', (c) => {
    const season = natural(c.req.query('season'))
    const surface = templateSurface(
      c.req.query('surface') ?? 'world',
      natural(c.req.query('allianceId')),
    )
    if (season === null || surface === null) return c.json({ error: 'Invalid drawing scope' }, 400)
    const scope = c.get('caller').scope
    return runBackendHttp(c, runtime, listWork(season, surface), (items) =>
      c.json({ items, canPlan: scope === 'admin', canClaim: scope !== 'read' }),
    )
  })
  routes.get('/:id/history', (c) => {
    const id = c.req.param('id')
    const before =
      c.req.query('before') === undefined ? Number.MAX_SAFE_INTEGER : natural(c.req.query('before'))
    if (!uuid.test(id) || before === null) return c.json({ error: 'Invalid history cursor' }, 400)
    return runBackendHttp(c, runtime, workHistory(id, before), (activity) => c.json(activity))
  })
  routes.put('/:id', requireScopeEffect(runtime, auth, 'report'), async (c) => {
    const id = c.req.param('id')
    const season = natural(c.req.query('season'))
    const surface = templateSurface(
      c.req.query('surface') ?? 'world',
      natural(c.req.query('allianceId')),
    )
    if (!uuid.test(id) || season === null || surface === null)
      return c.json({ error: 'Invalid work ID or drawing scope' }, 400)
    // Bound text before parsing so an authenticated client cannot submit an unbounded document.
    const body = await c.req.text()
    if (body.length > 16_384) return c.json({ error: 'Work request is too large' }, 413)
    let decoded: unknown
    try {
      decoded = JSON.parse(body)
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }
    const mutation = parseMutation(decoded)
    if (mutation === null) return c.json({ error: 'Invalid work action, identity, or fields' }, 400)
    return runBackendHttp(
      c,
      runtime,
      mutateWork(id, season, surface, mutation, c.get('caller')),
      (result) => {
        if (!result.conflict) return c.json(result.item)
        const claimant = result.item?.claimant
        return c.json(
          {
            error:
              claimant === null || claimant === undefined
                ? 'Work changed. Review the current item and retry.'
                : `Claimed by ${claimant.displayName} #${claimant.wplaceUserId}. Review the current item.`,
            item: result.item,
          },
          409,
        )
      },
    )
  })
  return routes
}
