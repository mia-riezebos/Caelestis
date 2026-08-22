import { millis, nodeSlug, uuidV7 } from '@caelestis/shared'
import { Hono } from 'hono'
import { type AuthOptions, requireScope } from '../auth/middleware.js'
import type { NodeRecord, Ports } from '../ports/index.js'
import {
  InvalidNodeParentError,
  NodeNotEmptyError,
  NodeNotFoundError,
  NodePathConflictError,
  NodePathTooLongError,
} from '../ports/index.js'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Wplace's first and current canvas is season 0; later seasons increment from there.
const SEASON_NUMBER = /^(?:0|[1-9]\d*)$/
const MAX_NAME_LENGTH = 256
const MAX_DESCRIPTION_LENGTH = 4_096

const parseSeason = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
  if (typeof value !== 'string' || !SEASON_NUMBER.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
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

const publicNode = ({ season: _season, description, ...node }: NodeRecord) =>
  description === null ? node : { ...node, description }

export const createNodeRoutes = (ports: Pick<Ports, 'sql'>, auth: AuthOptions) => {
  const routes = new Hono()
  const { sql } = ports

  routes.use('/*', requireScope(auth, 'admin'))

  routes.post('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid body' }, 400)
    const { season, parentId, name, description } = body as {
      season?: unknown
      parentId?: unknown
      name?: unknown
      description?: unknown
    }
    const parsedSeason = parseSeason(season)
    if (parsedSeason === null) {
      return c.json({ error: 'season must be a non-negative integer' }, 400)
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
    let parentPath = ''
    if (parentId !== null) {
      const parent = await sql.readNode(parentId)
      if (parent === null) return c.json({ error: 'parent node does not exist' }, 400)
      if (parent.season !== parsedSeason) {
        return c.json({ error: 'parent node belongs to a different season' }, 400)
      }
      parentPath = parent.path
    }
    // Not bounded here: the store composes the path it will actually store and bounds that, and a
    // check on the path assembled from this read could only ever agree with it or be wrong.
    const path = `${parentPath}/${segment}`

    const node: NodeRecord = {
      id: uuidV7(),
      season: parsedSeason,
      parentId,
      path,
      name,
      description: description ?? null,
      createdAt: millis(Date.now()),
    }
    let inserted: NodeRecord
    try {
      // The store composes the prefix from the parent row, so the record it answers with is the one
      // to report — the path assembled here is only a bound check and a proposal.
      inserted = await sql.insertNode(node)
    } catch (error) {
      if (
        error instanceof NodePathConflictError ||
        error instanceof InvalidNodeParentError ||
        error instanceof NodePathTooLongError
      ) {
        return c.json({ error: error.message }, 400)
      }
      throw error
    }
    return c.json(publicNode(inserted), 201)
  })

  routes.get('/', async (c) => {
    const season = parseSeason(c.req.query('season'))
    if (season === null) return c.json({ error: 'season must be a non-negative integer' }, 400)
    return c.json((await sql.listNodes(season)).map(publicNode))
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

    const node = await sql.readNode(nodeId)
    if (node === null) return c.json({ error: 'not found' }, 404)
    const segment = requestedSegment ?? slug(node.name)

    const nextParentId = parentId === undefined ? node.parentId : parentId
    let parentPath = node.path.slice(0, node.path.lastIndexOf('/'))
    if (parentId !== undefined) {
      if (nextParentId === null) parentPath = ''
      else {
        const parent = await sql.readNode(nextParentId as string)
        if (parent === null) return c.json({ error: 'parent node does not exist' }, 400)
        parentPath = parent.path
      }
    }
    const path = `${parentPath}/${segment}`
    try {
      if (parentId !== undefined) {
        const moved = await sql.moveNode(nodeId, nextParentId as string | null, path, {
          ...(name === undefined ? {} : { name: name as string }),
        })
        if (!moved) return c.json({ error: 'not found' }, 404)
      } else if (name !== undefined) {
        const renamed = await sql.renameNode(nodeId, name, segment)
        if (renamed === null) return c.json({ error: 'not found' }, 404)
      }
    } catch (error) {
      if (error instanceof InvalidNodeParentError) return c.json({ error: error.message }, 400)
      if (error instanceof NodePathConflictError) return c.json({ error: error.message }, 409)
      if (error instanceof NodePathTooLongError) return c.json({ error: error.message }, 400)
      throw error
    }
    const updated = await sql.readNode(nodeId)
    if (updated === null) return c.json({ error: 'not found' }, 404)
    return c.json(publicNode(updated))
  })

  routes.get('/:id/subtree', async (c) => {
    const nodeId = c.req.param('id')
    if (!UUID_V7.test(nodeId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
    }
    try {
      return c.json(await sql.countNodeSubtree(nodeId))
    } catch (error) {
      if (error instanceof NodeNotFoundError) return c.json({ error: 'not found' }, 404)
      throw error
    }
  })

  routes.delete('/:id', async (c) => {
    const nodeId = c.req.param('id')
    if (!UUID_V7.test(nodeId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
    }
    if (c.req.query('cascade') === 'true') {
      try {
        const deleted = await sql.deleteNodeCascade(nodeId)
        // R2 and D1 have no shared transaction. Deleting blobs after the D1 commit can race a new
        // reference and corrupt it; retaining content-addressed blobs is the safe interim until a
        // durable, retryable garbage collector can prove a hash remains unreferenced.
        return c.json({ nodes: deleted.nodes, templates: deleted.templates, chunks: 0 })
      } catch (error) {
        if (error instanceof NodeNotFoundError) return c.json({ error: 'not found' }, 404)
        throw error
      }
    }

    if ((await sql.readNode(nodeId)) === null) return c.json({ error: 'not found' }, 404)
    try {
      await sql.deleteNode(nodeId)
    } catch (error) {
      if (error instanceof NodeNotEmptyError) return c.json({ error: error.message }, 409)
      throw error
    }
    return c.body(null, 204)
  })

  return routes
}
