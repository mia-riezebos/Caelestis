import {
  type Millis,
  millis,
  type TemplateSurface,
  templateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { Hono } from 'hono'
import { requireRuntimeScope } from '../auth/middleware.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import {
  createTemplate,
  createTemplateVersion,
  deleteTemplate,
  patchTemplate,
  readBlob,
} from '../templates/use-cases.js'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const WHOLE_NUMBER = /^(0|[1-9]\d*)$/
const INTEGER = /^-?(?:0|[1-9]\d*)$/
const MAX_NAME_LENGTH = 256

const isValidName = (name: string): boolean => name.length > 0 && name.length <= MAX_NAME_LENGTH

const parseWholeNumber = (value: unknown): number | null => {
  if (typeof value !== 'string' || !WHOLE_NUMBER.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const parseInteger = (value: unknown): number | null => {
  if (typeof value !== 'string' || !INTEGER.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const parseSurface = (kind: unknown, allianceId: unknown): TemplateSurface | null => {
  if (kind === undefined && allianceId === undefined) return WORLD_TEMPLATE_SURFACE
  if (typeof kind !== 'string') return null
  if (kind === 'world') return allianceId === undefined ? WORLD_TEMPLATE_SURFACE : null
  const parsedAllianceId = parseWholeNumber(allianceId)
  return parsedAllianceId === null ? null : templateSurface(kind, parsedAllianceId)
}

export const createTemplateRoutes = (runtime: BackendRuntime) => {
  const routes = new Hono()

  routes.use('/*', requireRuntimeScope(runtime, 'admin'))

  routes.post('/', async (c) => {
    if (!c.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data')) {
      return c.json({ error: 'content-type must be multipart/form-data' }, 400)
    }

    const body = await c.req.parseBody().catch(() => null)
    if (body === null) return c.json({ error: 'invalid multipart body' }, 400)

    const {
      png,
      nodeId: rawNodeId,
      season: rawSeason,
      name,
      originX,
      originY,
      surfaceKind,
      allianceId,
    } = body
    if (!(png instanceof File)) return c.json({ error: 'png must be a file part' }, 400)
    const nodeId = rawNodeId === undefined ? null : rawNodeId
    if (nodeId !== null && (typeof nodeId !== 'string' || !UUID_V7.test(nodeId))) {
      return c.json({ error: 'nodeId must be a canonical lowercase UUIDv7 or omitted' }, 400)
    }
    const season = parseWholeNumber(rawSeason)
    if (season === null && !(rawSeason === undefined && typeof nodeId === 'string')) {
      return c.json({ error: 'season must be a non-negative integer for a root template' }, 400)
    }
    if (typeof name !== 'string' || !isValidName(name)) {
      return c.json({ error: 'name must be 1..256 characters' }, 400)
    }

    const surface = parseSurface(surfaceKind, allianceId)
    if (surface === null) {
      return c.json(
        { error: 'surfaceKind must be world or an alliance surface with a positive allianceId' },
        400,
      )
    }
    const parsedOriginX =
      surface.kind === 'world' ? parseWholeNumber(originX) : parseInteger(originX)
    const parsedOriginY =
      surface.kind === 'world' ? parseWholeNumber(originY) : parseInteger(originY)
    if (parsedOriginX === null || parsedOriginY === null) {
      return c.json(
        {
          error:
            surface.kind === 'world'
              ? 'originX and originY must be non-negative integers'
              : 'originX and originY must be integers',
        },
        400,
      )
    }

    const caller = c.get('caller')
    const bytes = new Uint8Array(await png.arrayBuffer())
    return runBackendHttp(
      c,
      runtime,
      createTemplate({
        surface,
        ...(season === null ? {} : { season }),
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
        png: bytes,
      }),
      (result) => c.json(result, 201),
    )
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
    const parsedOriginX = parseInteger(originX)
    const parsedOriginY = parseInteger(originY)
    if (parsedOriginX === null || parsedOriginY === null) {
      return c.json({ error: 'originX and originY must be integers' }, 400)
    }

    const caller = c.get('caller')
    const bytes = new Uint8Array(await png.arrayBuffer())
    return runBackendHttp(
      c,
      runtime,
      createTemplateVersion({
        templateId,
        createdWithToken: caller.tokenHash,
        createdByUserId: null,
        originX: parsedOriginX,
        originY: parsedOriginY,
        png: bytes,
      }),
      (result) => c.json(result, 201),
    )
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
    const { name, nodeId, published, timelapseFrozen, finished } = body as {
      name?: unknown
      nodeId?: unknown
      published?: unknown
      timelapseFrozen?: unknown
      finished?: unknown
    }

    if (name !== undefined && (typeof name !== 'string' || !isValidName(name))) {
      return c.json({ error: 'name must be 1..256 characters' }, 400)
    }
    if (
      nodeId !== undefined &&
      nodeId !== null &&
      (typeof nodeId !== 'string' || !UUID_V7.test(nodeId))
    ) {
      return c.json({ error: 'nodeId must be a canonical lowercase UUIDv7 or null' }, 400)
    }
    if (published !== undefined && typeof published !== 'boolean') {
      return c.json({ error: 'published must be a boolean' }, 400)
    }
    if (timelapseFrozen !== undefined && typeof timelapseFrozen !== 'boolean') {
      return c.json({ error: 'timelapseFrozen must be a boolean' }, 400)
    }
    if (finished !== undefined && typeof finished !== 'boolean') {
      return c.json({ error: 'finished must be a boolean' }, 400)
    }
    if (finished === true && timelapseFrozen === false) {
      return c.json({ error: 'a finished template must keep its timelapse frozen' }, 400)
    }
    if (
      name === undefined &&
      nodeId === undefined &&
      published === undefined &&
      timelapseFrozen === undefined &&
      finished === undefined
    ) {
      return c.json(
        {
          error:
            'patch must set at least one of name, nodeId, published, timelapseFrozen, finished',
        },
        400,
      )
    }

    return runBackendHttp(
      c,
      runtime,
      patchTemplate({
        templateId,
        ...(name === undefined ? {} : { name: name as string }),
        ...(nodeId === undefined ? {} : { nodeId: nodeId as string | null }),
        ...(published === undefined ? {} : { published: published as boolean }),
        ...(timelapseFrozen === undefined ? {} : { timelapseFrozen: timelapseFrozen as boolean }),
        ...(finished === undefined ? {} : { finished: finished as boolean }),
      }),
      (result) => c.json(result),
    )
  })

  routes.delete('/:id', async (c) => {
    const templateId = c.req.param('id')
    if (!UUID_V7.test(templateId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
    }
    const expectedVersionQuery = c.req.query('expectedVersion')
    const expectedUpdatedAtQuery = c.req.query('expectedUpdatedAt')
    const parsedUpdatedAt = parseWholeNumber(expectedUpdatedAtQuery)
    if (expectedVersionQuery === undefined && expectedUpdatedAtQuery === undefined) {
      // Released movers cannot identify the revision they copied. Accepting their unguarded cleanup
      // would let a replacement published during that copy be deleted, so fail safely and retain the
      // source until the revision-aware userscript is installed.
      return c.json(
        { error: 'expectedVersion and expectedUpdatedAt are required for template deletion' },
        428,
      )
    }
    if (!UUID_V7.test(expectedVersionQuery ?? '') || parsedUpdatedAt === null) {
      return c.json(
        { error: 'expectedVersion and expectedUpdatedAt must identify the confirmed revision' },
        400,
      )
    }
    const expected: { versionId: string; updatedAt: Millis } = {
      versionId: expectedVersionQuery as string,
      updatedAt: millis(parsedUpdatedAt),
    }
    return runBackendHttp(c, runtime, deleteTemplate(templateId, expected), () => c.body(null, 204))
  })

  return routes
}

const createBlobRoutes = (runtime: BackendRuntime, namespace: 'chunks' | 'tiles') => {
  const routes = new Hono()

  routes.use('/*', requireRuntimeScope(runtime, 'read'))

  routes.get('/:hash', async (c) => {
    const hash = c.req.param('hash')
    if (!SHA256_HEX.test(hash)) return c.json({ error: `invalid ${namespace} hash` }, 400)

    return runBackendHttp(c, runtime, readBlob(namespace, hash), (bytes) =>
      // `private`, because this route is behind a read scope. Shared caches must not serve an
      // authorised immutable blob to a later caller without that authorization.
      c.body(new Uint8Array(bytes), 200, {
        'content-type': 'image/png',
        'cache-control': 'private, max-age=31536000, immutable',
      }),
    )
  })

  return routes
}

export const createChunkRoutes = (runtime: BackendRuntime) => createBlobRoutes(runtime, 'chunks')

/**
 * Mirrored canvas tiles, served exactly like template chunks: the timelapse endpoint answers with
 * hashes, and this is where a frontend exchanges one for its pixels.
 */
export const createTileRoutes = (runtime: BackendRuntime) => createBlobRoutes(runtime, 'tiles')
