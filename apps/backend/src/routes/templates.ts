import { millis, PngError, SliceError } from '@caelestis/shared'
import { Hono } from 'hono'
import { type AuthOptions, requireScope } from '../auth/middleware.js'
import type { Ports } from '../ports/index.js'
import { NodeNotFoundError } from '../ports/index.js'
import { StoreTemplateError, storeTemplate } from '../templates/store.js'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const WHOLE_NUMBER = /^(0|[1-9]\d*)$/
const MAX_NAME_LENGTH = 256

const isValidName = (name: string): boolean => name.length > 0 && name.length <= MAX_NAME_LENGTH

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
    if (typeof name !== 'string' || !isValidName(name)) {
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
        // Always a digest, bootstrap included — `templates_created_with_token_check` requires 64 hex
        // characters, so the old `'bootstrap'` literal could not have been stored.
        createdWithToken: caller.tokenHash,
        // No wplace session on this route: an admin uploads with a token and nothing else. The
        // column is nullable precisely so authorship does not have to invent an account.
        createdByUserId: null,
        originX: parsedOriginX,
        originY: parsedOriginY,
        png: new Uint8Array(await png.arrayBuffer()),
      })
      return c.json(result, 201)
    } catch (error) {
      if (
        error instanceof PngError ||
        error instanceof SliceError ||
        error instanceof StoreTemplateError ||
        error instanceof NodeNotFoundError
      ) {
        return c.json({ error: error.message }, 400)
      }
      throw error
    }
  })

  /**
   * Replace a template's pixels, keeping its identity.
   *
   * A separate route from `POST /` rather than a flag on it, because the two take different inputs:
   * a new template needs somewhere to live and something to be called, and a new version needs
   * neither — it inherits both from the template it belongs to. Folding them together would mean a
   * `nodeId` that is required on one path and ignored on the other.
   *
   * Origin is per version on purpose: moving a template on the canvas is a new slicing, so it is a
   * new version rather than an edit.
   */
  routes.post('/:id/versions', async (c) => {
    const templateId = c.req.param('id')
    if (!UUID_V7.test(templateId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
    }
    if (!c.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data')) {
      return c.json({ error: 'content-type must be multipart/form-data' }, 400)
    }

    const body = await c.req.parseBody().catch(() => null)
    if (body === null) return c.json({ error: 'invalid multipart body' }, 400)

    const { png, originX, originY } = body
    if (!(png instanceof File)) return c.json({ error: 'png must be a file part' }, 400)
    const parsedOriginX = parseWholeNumber(originX)
    const parsedOriginY = parseWholeNumber(originY)
    if (parsedOriginX === null || parsedOriginY === null) {
      return c.json({ error: 'originX and originY must be non-negative integers' }, 400)
    }

    const existing = await ports.sql.readTemplate(templateId)
    if (existing === null) return c.json({ error: 'not found' }, 404)

    try {
      const caller = c.get('caller')
      const result = await storeTemplate(ports, {
        templateId,
        nodeId: existing.nodeId,
        name: existing.name,
        createdWithToken: caller.tokenHash,
        createdByUserId: null,
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

  /**
   * Rename, move, publish or unpublish — anything that leaves the pixels alone.
   *
   * A patch of nothing is rejected rather than treated as a no-op. It is always a mistake on the
   * caller's side (a typo'd field name, a body that failed to serialise), and answering 200 to it
   * would report success for a request that changed nothing.
   */
  routes.patch('/:id', async (c) => {
    const templateId = c.req.param('id')
    if (!UUID_V7.test(templateId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
    }
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid body' }, 400)
    const { name, nodeId, published } = body as {
      name?: unknown
      nodeId?: unknown
      published?: unknown
    }

    if (name !== undefined && (typeof name !== 'string' || !isValidName(name))) {
      return c.json({ error: 'name must be 1..256 characters' }, 400)
    }
    if (nodeId !== undefined && (typeof nodeId !== 'string' || !UUID_V7.test(nodeId))) {
      return c.json({ error: 'nodeId must be a canonical lowercase UUIDv7' }, 400)
    }
    if (published !== undefined && typeof published !== 'boolean') {
      return c.json({ error: 'published must be a boolean' }, 400)
    }
    if (name === undefined && nodeId === undefined && published === undefined) {
      return c.json({ error: 'patch must set at least one of name, nodeId, published' }, 400)
    }

    const now = millis(Date.now())
    if (name !== undefined || nodeId !== undefined) {
      const patch = {
        ...(name === undefined ? {} : { name: name as string }),
        ...(nodeId === undefined ? {} : { nodeId: nodeId as string }),
      }
      try {
        if (!(await ports.sql.updateTemplate(templateId, patch, now))) {
          return c.json({ error: 'not found' }, 404)
        }
      } catch (error) {
        if (error instanceof NodeNotFoundError) return c.json({ error: error.message }, 400)
        throw error
      }
    }
    if (published !== undefined) {
      const updated = await ports.sql.setTemplatePublishedAt(
        templateId,
        published ? now : null,
        now,
      )
      if (!updated) return c.json({ error: 'not found' }, 404)
    }

    return c.json({
      id: templateId,
      ...(name === undefined ? {} : { name }),
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(published === undefined ? {} : { published }),
      updatedAt: now,
    })
  })

  routes.delete('/:id', async (c) => {
    const templateId = c.req.param('id')
    if (!UUID_V7.test(templateId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
    }
    if (!(await ports.sql.deleteTemplate(templateId))) return c.json({ error: 'not found' }, 404)
    return c.body(null, 204)
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

    // `private`, because this route is behind a read scope. `public` invites any standards-compliant
    // shared cache to store the response and hand it to a later request that carries no
    // Authorization at all — so one authorised fetch would make a chunk readable by anyone who knows
    // its hash. Chunks are immutable and content-addressed, so a client may still cache one
    // forever; what it may not do is cache it on someone else's behalf.
    return c.body(new Uint8Array(bytes), 200, {
      'content-type': 'image/png',
      'cache-control': 'private, max-age=31536000, immutable',
    })
  })

  return routes
}
