import { Context as Services } from 'effect'
import { type Context, Hono } from 'hono'
import { type AuthOptions, requireScopeEffect } from '../auth/middleware.js'
import type { BackfillClients, BackfillReply } from '../backfill/port.js'
import { mergeD1Usage } from '../metrics/request-metrics.js'
import {
  type BackendRuntime,
  BlobStoreService,
  SqlStoreService,
} from '../runtime/backend-runtime.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const respond = <T>(c: Context, result: BackfillReply<T>): Response => {
  mergeD1Usage(result.usage)
  return result.ok ? Response.json(result.value) : c.json({ error: result.error }, result.status)
}

/** Admin-only preview/start/status/cancel for one selected server template. */
export const createBackfillAdminRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  clients?: BackfillClients,
) => {
  const routes = new Hono()
  routes.use('/*', requireScopeEffect(runtime, auth, 'admin'))
  routes.use('/:templateId/*', async (c, next) => {
    if (!UUID.test(c.req.param('templateId') ?? ''))
      return c.json({ error: 'Invalid template ID.' }, 400)
    if (clients === undefined)
      return c.json({ error: 'This server does not support backfill yet.' }, 503)
    await next()
  })
  const clientFor = (id: string) => {
    if (clients === undefined) throw new Error('Backfill is unavailable')
    return clients(id)
  }
  routes.get('/:templateId/preview', async (c) =>
    respond(c, await clientFor(c.req.param('templateId')).preview(c.req.param('templateId'))),
  )
  routes.get('/:templateId/job', async (c) =>
    respond(c, await clientFor(c.req.param('templateId')).job()),
  )
  routes.post('/:templateId/start', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (
      body === null ||
      typeof body !== 'object' ||
      !('versionId' in body) ||
      !('snapshotId' in body) ||
      typeof body.versionId !== 'string' ||
      !UUID.test(body.versionId) ||
      typeof body.snapshotId !== 'number' ||
      !Number.isSafeInteger(body.snapshotId) ||
      body.snapshotId < 0
    )
      return c.json({ error: 'Choose a template version and available snapshot.' }, 400)
    return respond(
      c,
      await clientFor(c.req.param('templateId')).start(
        c.req.param('templateId'),
        body.versionId,
        body.snapshotId,
      ),
    )
  })
  routes.post('/:templateId/cancel', async (c) =>
    respond(c, await clientFor(c.req.param('templateId')).cancel()),
  )
  return routes
}

/** Sparse reads share template visibility rules; PNGs remain outside live tile GC. */
export const createArchiveRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  clients?: BackfillClients,
) => {
  const routes = new Hono()
  const sql = Services.get(runtime.context, SqlStoreService)
  const blobs = Services.get(runtime.context, BlobStoreService)
  routes.use('/*', requireScopeEffect(runtime, auth, 'read'))
  routes.get('/templates/:templateId', async (c) => {
    const id = c.req.param('templateId')
    if (!UUID.test(id)) return c.json({ error: 'Invalid template ID.' }, 400)
    const template = await sql.readTemplate(id)
    if (template === null || (c.get('caller').scope !== 'admin' && !template.published))
      return c.json({ error: 'Template not found.' }, 404)
    const version = c.req.query('version') ?? template.currentVersionId
    if (version === null || !UUID.test(version))
      return c.json({ error: 'Invalid template version.' }, 400)
    const record = await sql.readTemplateVersion(version)
    if (record?.templateId !== id) return c.json({ error: 'Template version not found.' }, 404)
    const x = c.req.query('x'),
      y = c.req.query('y')
    if (
      (x === undefined) !== (y === undefined) ||
      (x !== undefined &&
        (!/^\d+$/.test(x) || !/^\d+$/.test(y ?? '') || Number(x) > 2047 || Number(y) > 2047))
    )
      return c.json({ error: 'Invalid tile coordinates.' }, 400)
    if (clients === undefined)
      return c.json({ source: 'eralyon', basis: null, samples: [], frames: [] })
    return respond(
      c,
      await clients(id).history(
        version,
        x === undefined ? undefined : { x: Number(x), y: Number(y) },
      ),
    )
  })
  routes.get('/tiles/:hash', async (c) => {
    const hash = c.req.param('hash')
    if (!/^[0-9a-f]{64}$/.test(hash)) return c.json({ error: 'Invalid tile hash.' }, 400)
    const bytes = await blobs.get('archives', hash)
    if (bytes === null) return c.notFound()
    return new Response(Uint8Array.from(bytes), {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'private, max-age=31536000, immutable',
      },
    })
  })
  return routes
}
