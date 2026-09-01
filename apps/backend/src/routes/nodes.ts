import {
  nodeSlug,
  type TemplateSurface,
  templateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { Hono } from 'hono'
import { type AuthOptions, requireScopeEffect } from '../auth/middleware.js'
import {
  countNodeSubtree,
  createNode,
  deleteEmptyNode,
  deleteNodeCascade,
  listNodes,
  patchNode,
} from '../nodes/use-cases.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Wplace's first and current canvas is season 0; later seasons increment from there.
const SEASON_NUMBER = /^(?:0|[1-9]\d*)$/
const MAX_NAME_LENGTH = 256
const MAX_DESCRIPTION_LENGTH = 4_096
const POSITIVE_NUMBER = /^[1-9]\d*$/

const parseSeason = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
  if (typeof value !== 'string' || !SEASON_NUMBER.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const parseSurface = (kind: unknown, allianceId: unknown): TemplateSurface | null => {
  if (kind === undefined && allianceId === undefined) return WORLD_TEMPLATE_SURFACE
  if (kind === 'world') return allianceId === undefined ? WORLD_TEMPLATE_SURFACE : null
  if (typeof kind !== 'string') return null
  const text = typeof allianceId === 'number' ? String(allianceId) : allianceId
  if (typeof text !== 'string' || !POSITIVE_NUMBER.test(text)) return null
  const parsedAllianceId = Number(text)
  return Number.isSafeInteger(parsedAllianceId) ? templateSurface(kind, parsedAllianceId) : null
}

/**
 * Derive a path segment from a display name.
 *
 * Astral characters are replaced rather than kept, which is what keeps the three places that bound a
 * path agreeing with each other. SQLite's `length()` counts characters and JavaScript's `.length`
 * counts UTF-16 units, and a code point outside the BMP is one of the former and two of the latter —
 * so `nodes_path_check`, the store guards and the wire's `NodePath` were measuring the same string
 * and getting different numbers. Three separate defects came out of that gap. Confined to the BMP
 * the two counts are equal by construction and the gap cannot reopen.
 *
 * The name keeps every character the caller sent; only the derived path is narrowed. A name with
 * nothing but astral letters therefore slugs to nothing and is refused, which the route reports.
 *
 * It lives in `@caelestis/shared` because it is an agreement rather than a local detail: a client
 * that picks names without knowing this rule picks names this route then rejects.
 */
const slug = nodeSlug

export const createNodeRoutes = (runtime: BackendRuntime, auth: AuthOptions) => {
  const routes = new Hono()

  routes.use('/*', requireScopeEffect(runtime, auth, 'admin'))

  routes.post('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid body' }, 400)
    const { season, surfaceKind, allianceId, parentId, name, description } = body as {
      season?: unknown
      surfaceKind?: unknown
      allianceId?: unknown
      parentId?: unknown
      name?: unknown
      description?: unknown
    }
    const parsedSeason = parseSeason(season)
    if (parsedSeason === null) {
      return c.json({ error: 'season must be a non-negative integer' }, 400)
    }
    const surface = parseSurface(surfaceKind, allianceId)
    if (surface === null) {
      return c.json(
        { error: 'surfaceKind must be world or an alliance surface with a positive allianceId' },
        400,
      )
    }
    if (parentId !== null && (typeof parentId !== 'string' || !UUID_V7.test(parentId))) {
      return c.json({ error: 'parentId must be null or a canonical lowercase UUIDv7' }, 400)
    }
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
      return c.json({ error: 'name must be 1..256 characters' }, 400)
    }
    if (
      description !== undefined &&
      (typeof description !== 'string' ||
        description.length === 0 ||
        description.length > MAX_DESCRIPTION_LENGTH)
    ) {
      return c.json({ error: 'description must be 1..4096 characters when provided' }, 400)
    }

    const segment = slug(name)
    if (segment.length === 0) return c.json({ error: 'name must contain a letter or number' }, 400)
    return runBackendHttp(
      c,
      runtime,
      createNode({
        season: parsedSeason,
        surface,
        parentId,
        name,
        ...(description === undefined ? {} : { description: description as string }),
      }),
      (node) => c.json(node, 201),
    )
  })

  routes.get('/', (c) => {
    const season = parseSeason(c.req.query('season'))
    if (season === null) return c.json({ error: 'season must be a non-negative integer' }, 400)
    const surface = parseSurface(c.req.query('surface'), c.req.query('allianceId'))
    if (surface === null) {
      return c.json(
        { error: 'surface must be world or an alliance surface with a positive allianceId' },
        400,
      )
    }
    return runBackendHttp(c, runtime, listNodes(season, surface), (nodes) => c.json(nodes))
  })

  routes.patch('/:id', async (c) => {
    const nodeId = c.req.param('id')
    if (!UUID_V7.test(nodeId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
    }
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid body' }, 400)
    const { name, parentId } = body as { name?: unknown; parentId?: unknown }
    if (
      name !== undefined &&
      (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH)
    ) {
      return c.json({ error: 'name must be 1..256 characters' }, 400)
    }
    if (
      parentId !== undefined &&
      parentId !== null &&
      (typeof parentId !== 'string' || !UUID_V7.test(parentId))
    ) {
      return c.json({ error: 'parentId must be null or a canonical lowercase UUIDv7' }, 400)
    }
    if (name === undefined && parentId === undefined) {
      return c.json({ error: 'patch must set at least one of name, parentId' }, 400)
    }
    const requestedSegment = name === undefined ? undefined : slug(name)
    if (requestedSegment !== undefined && requestedSegment.length === 0) {
      return c.json({ error: 'name must contain a letter or number' }, 400)
    }

    return runBackendHttp(
      c,
      runtime,
      patchNode({
        nodeId,
        ...(name === undefined ? {} : { name: name as string }),
        ...(parentId === undefined ? {} : { parentId: parentId as string | null }),
      }),
      (node) => c.json(node),
    )
  })

  routes.get('/:id/subtree', (c) => {
    const nodeId = c.req.param('id')
    if (!UUID_V7.test(nodeId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
    }
    return runBackendHttp(c, runtime, countNodeSubtree(nodeId), (counts) => c.json(counts))
  })

  routes.delete('/:id', async (c) => {
    const nodeId = c.req.param('id')
    if (!UUID_V7.test(nodeId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
    }
    if (c.req.query('cascade') === 'true') {
      const expectedNodes = parseSeason(c.req.query('expectedNodes'))
      const expectedTemplates = parseSeason(c.req.query('expectedTemplates'))
      if (expectedNodes === null || expectedNodes < 1 || expectedTemplates === null) {
        return c.json({ error: 'cascade requires non-negative expected counts' }, 400)
      }
      return runBackendHttp(
        c,
        runtime,
        deleteNodeCascade(nodeId, {
          nodes: expectedNodes,
          templates: expectedTemplates,
        }),
        (deleted) =>
          // R2 and D1 have no shared transaction. Deleting blobs after the D1 commit can race a new
          // reference and corrupt it; retaining content-addressed blobs is the safe interim until a
          // durable, retryable garbage collector can prove a hash remains unreferenced.
          c.json({ nodes: deleted.nodes, templates: deleted.templates, chunks: 0 }),
      )
    }

    return runBackendHttp(c, runtime, deleteEmptyNode(nodeId), () => c.body(null, 204))
  })

  return routes
}
