import { millis, PngError, SliceError } from '@wts/shared'
import { Hono } from 'hono'
import { type AuthOptions, requireScope } from '../auth/middleware.js'
import type { Ports } from '../ports/index.js'
import { NodeNotFoundError } from '../ports/index.js'
import { storeTemplate } from '../templates/store.js'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const WHOLE_NUMBER = /^(0|[1-9]\d*)$/
const MAX_NAME_LENGTH = 256

const parseWholeNumber = (value: unknown): number | null => {
  if (typeof value !== 'string' || !WHOLE_NUMBER.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export const createTemplateRoutes = (ports: Pick<Ports, 'blobs' | 'sql'>, auth: AuthOptions) => {
  const routes = new Hono()

  routes.use('/*', requireScope(auth, 'admin'))

  routes.post('/', async (c) => {
    if (!c.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data')) {
      return c.json({ error: 'content-type must be multipart/form-data' }, 400)
    }

    const body = await c.req.parseBody().catch(() => null)
    if (body === null) return c.json({ error: 'invalid multipart body' }, 400)

    const { png, nodeId, name, originX, originY } = body
    if (!(png instanceof File)) return c.json({ error: 'png must be a file part' }, 400)
    if (typeof nodeId !== 'string' || !UUID_V7.test(nodeId)) {
      return c.json({ error: 'nodeId must be a canonical lowercase UUIDv7' }, 400)
    }
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
      return c.json({ error: 'name must be 1..256 characters' }, 400)
    }

    const parsedOriginX = parseWholeNumber(originX)
    const parsedOriginY = parseWholeNumber(originY)
    if (parsedOriginX === null || parsedOriginY === null) {
      return c.json({ error: 'originX and originY must be non-negative integers' }, 400)
    }

    try {
      const caller = c.get('caller')
      const result = await storeTemplate(ports, {
        nodeId,
        name,
        createdBy: caller.token?.tokenHash ?? 'bootstrap',
        originX: parsedOriginX,
        originY: parsedOriginY,
        png: new Uint8Array(await png.arrayBuffer()),
      })
      return c.json(result, 201)
    } catch (error) {
      if (
        error instanceof PngError ||
        error instanceof SliceError ||
        error instanceof NodeNotFoundError
      ) {
        return c.json({ error: error.message }, 400)
      }
      throw error
    }
  })

  routes.patch('/:id', async (c) => {
    const templateId = c.req.param('id')
    if (!UUID_V7.test(templateId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
    }
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid body' }, 400)
    const { published } = body as { published?: unknown }
    if (typeof published !== 'boolean') return c.json({ error: 'published must be a boolean' }, 400)

    const updated = await ports.sql.setTemplatePublishedAt(
      templateId,
      published ? millis(Date.now()) : null,
    )
    if (!updated) return c.json({ error: 'not found' }, 404)
    return c.json({ id: templateId, published })
  })

  return routes
}

export const createChunkRoutes = (ports: Pick<Ports, 'blobs' | 'sql'>, auth: AuthOptions) => {
  const routes = new Hono()

  routes.use('/*', requireScope(auth, 'read'))

  routes.get('/:hash', async (c) => {
    const hash = c.req.param('hash')
    if (!SHA256_HEX.test(hash)) return c.json({ error: 'invalid chunk hash' }, 400)

    const bytes = await ports.blobs.get('chunks', hash)
    if (bytes === null) return c.json({ error: 'not found' }, 404)

    return c.body(new Uint8Array(bytes), 200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=31536000, immutable',
    })
  })

  return routes
}
