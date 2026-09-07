import { tagName, uuidV7 } from '@caelestis/shared'
import { Hono } from 'hono'
import { type AuthOptions, requireScopeEffect } from '../auth/middleware.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import { mutateTag, readTags } from '../tags/use-cases.js'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Tags share the admin boundary of server template metadata. */
export const createTagRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  currentSeason: number,
) => {
  const routes = new Hono()
  routes.use('/*', requireScopeEffect(runtime, auth, 'admin'))
  routes.get('/', (c) => {
    const templateId = c.req.query('templateId')
    if (templateId !== undefined && !UUID_V7.test(templateId))
      return c.json({ error: 'Invalid template ID.' }, 400)
    return runBackendHttp(c, runtime, readTags(templateId), (result) => c.json(result))
  })
  routes.post('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const name = tagName(
      typeof body === 'object' && body !== null && 'name' in body ? body.name : null,
    )
    if (name === null)
      return c.json({ error: 'Use 1–64 characters without control characters.' }, 400)
    return runBackendHttp(
      c,
      runtime,
      mutateTag({ type: 'create', id: uuidV7(), name }, currentSeason),
      (result) => c.json(result, 201),
    )
  })
  routes.use('/:id/*', async (c, next) => {
    if (!UUID_V7.test(c.req.param('id') ?? '')) return c.json({ error: 'Invalid tag ID.' }, 400)
    await next()
  })
  routes.patch('/:id', async (c) => {
    const id = c.req.param('id')
    if (!UUID_V7.test(id)) return c.json({ error: 'Invalid tag ID.' }, 400)
    const body: unknown = await c.req.json().catch(() => null)
    const name = tagName(
      typeof body === 'object' && body !== null && 'name' in body ? body.name : null,
    )
    if (name === null)
      return c.json({ error: 'Use 1–64 characters without control characters.' }, 400)
    return runBackendHttp(
      c,
      runtime,
      mutateTag({ type: 'rename', id, name }, currentSeason),
      (result) => c.json(result),
    )
  })
  routes.delete('/:id', (c) => {
    const id = c.req.param('id')
    if (!UUID_V7.test(id)) return c.json({ error: 'Invalid tag ID.' }, 400)
    return runBackendHttp(c, runtime, mutateTag({ type: 'delete', id }, currentSeason), () =>
      c.body(null, 204),
    )
  })
  for (const attached of [true, false]) {
    routes.on(attached ? 'PUT' : 'DELETE', '/:id/templates/:templateId', (c) => {
      const id = c.req.param('id')
      const templateId = c.req.param('templateId')
      if (!UUID_V7.test(id) || !UUID_V7.test(templateId))
        return c.json({ error: 'Invalid tag or template ID.' }, 400)
      return runBackendHttp(
        c,
        runtime,
        mutateTag({ type: 'assign', id, templateId, attached }, currentSeason),
        () => c.body(null, 204),
      )
    })
  }
  return routes
}
