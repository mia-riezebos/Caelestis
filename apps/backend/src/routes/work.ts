import {
  isWorkFields,
  isWorkIdentity,
  MAX_WORK_ITEMS,
  templateSurface,
  type WorkMutation,
} from '@caelestis/shared'
import { RegionClaimRequest } from '@caelestis/wire-schema'
import { Schema } from 'effect'
import { Hono } from 'hono'
import { type AuthOptions, requireScopeEffect } from '../auth/middleware.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import { deleteRegion, listRegions, putRegion } from '../work/regions.js'
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
  if (
    action === 'claim' ||
    action === 'release' ||
    action === 'claim-template' ||
    action === 'release-template'
  )
    return { action, actor, expectedRevision }
  if ((action === 'assign-template' || action === 'unassign-template') && isWorkIdentity(claimant))
    return { action, actor, expectedRevision, claimant }
  if (action === 'assign' && (claimant === null || isWorkIdentity(claimant)))
    return { action, actor, expectedRevision, claimant }
  return null
}

/** Shared coordination routes. Read-only frontend proxy credentials never authorize mutations. */
export const createWorkRoutes = (runtime: BackendRuntime, auth: AuthOptions) => {
  const routes = new Hono()
  routes.use('/*', requireScopeEffect(runtime, auth, 'read'))
  routes.get('/regions', (c) => {
    const season = natural(c.req.query('season'))
    const allianceId = c.req.query('allianceId')
    const surface = templateSurface(
      c.req.query('surface') ?? 'world',
      allianceId === undefined ? null : natural(allianceId),
    )
    const templateId = c.req.query('templateId')
    if (
      season === null ||
      surface === null ||
      (allianceId !== undefined && natural(allianceId) === null) ||
      (templateId !== undefined && !uuid.test(templateId))
    )
      return c.json({ error: 'Invalid drawing scope or template ID' }, 400)
    return runBackendHttp(c, runtime, listRegions(season, surface, templateId), (regions) =>
      c.json({ regions }),
    )
  })
  routes.put('/regions/:id', requireScopeEffect(runtime, auth, 'report'), async (c) => {
    const id = c.req.param('id')
    const season = natural(c.req.query('season'))
    const allianceId = c.req.query('allianceId')
    const surface = templateSurface(
      c.req.query('surface') ?? 'world',
      allianceId === undefined ? null : natural(allianceId),
    )
    if (
      !uuid.test(id) ||
      season === null ||
      surface === null ||
      (allianceId !== undefined && natural(allianceId) === null)
    )
      return c.json({ error: 'Invalid region ID or drawing scope' }, 400)
    const text = await c.req.text()
    if (text.length > 16_384) return c.json({ error: 'Region request is too large' }, 413)
    let request: Schema.Schema.Type<typeof RegionClaimRequest>
    try {
      request = Schema.decodeUnknownSync(RegionClaimRequest)(JSON.parse(text))
    } catch {
      return c.json({ error: 'Invalid region request' }, 400)
    }
    return runBackendHttp(
      c,
      runtime,
      putRegion(id, season, surface, request, c.get('caller')),
      (region) => c.json(region),
    )
  })
  routes.delete('/regions/:id', requireScopeEffect(runtime, auth, 'report'), async (c) => {
    const id = c.req.param('id')
    if (!uuid.test(id)) return c.json({ error: 'Invalid region ID' }, 400)
    const text = await c.req.text()
    if (text.length > 16_384) return c.json({ error: 'Region request is too large' }, 413)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      !('actor' in body) ||
      !isWorkIdentity(body.actor)
    )
      return c.json({ error: 'Invalid painter identity' }, 400)
    return runBackendHttp(c, runtime, deleteRegion(id, body.actor, c.get('caller')), (result) =>
      c.json(result),
    )
  })
  routes.get('/', (c) => {
    const season = natural(c.req.query('season'))
    const surface = templateSurface(
      c.req.query('surface') ?? 'world',
      natural(c.req.query('allianceId')),
    )
    if (season === null || surface === null) return c.json({ error: 'Invalid drawing scope' }, 400)
    const scope = c.get('caller').scope
    const after = c.req.query('after') ?? ''
    if (after !== '' && !uuid.test(after)) return c.json({ error: 'Invalid work cursor' }, 400)
    return runBackendHttp(c, runtime, listWork(season, surface, after), (items) =>
      c.json({
        items,
        canPlan: scope === 'admin',
        canClaim: scope !== 'read',
        nextCursor: items.length === MAX_WORK_ITEMS ? items.at(-1)?.id : null,
      }),
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
