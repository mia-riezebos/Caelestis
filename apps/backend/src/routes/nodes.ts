import { millis, uuidV7 } from '@wts/shared'
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
// Seasons are 1-based, matching `Season` in the wire and the Worker's own `SEASON` refusal.
const SEASON_NUMBER = /^[1-9]\d*$/
const MAX_NAME_LENGTH = 256
const MAX_DESCRIPTION_LENGTH = 4_096

const parseSeason = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 1 ? value : null
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
 */
const ASTRAL = /[\u{10000}-\u{10FFFF}]/gu

const slug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(ASTRAL, '-')
    .replace(/[^\p{L}\p{N}.]+/gu, '-')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()

const publicNode = ({ season: _season, description, ...node }: NodeRecord) =>
  description === null ? node : { ...node, description }

export const createNodeRoutes = (ports: Pick<Ports, 'blobs' | 'sql'>, auth: AuthOptions) => {
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
      return c.json({ error: 'season must be a positive integer' }, 400)
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
    if (season === null) return c.json({ error: 'season must be a positive integer' }, 400)
    return c.json((await sql.listNodes(season)).map(publicNode))
  })

  routes.patch('/:id', async (c) => {
    const nodeId = c.req.param('id')
    if (!UUID_V7.test(nodeId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
    }
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid body' }, 400)
    const { name } = body as { name?: unknown }
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
      return c.json({ error: 'name must be 1..256 characters' }, 400)
    }
    const segment = slug(name)
    if (segment.length === 0) return c.json({ error: 'name must contain a letter or number' }, 400)

    // The destination prefix is the store's to compose, not this route's: it comes from the node's
    // own path at the moment of the write, so a concurrent rename of an ancestor cannot leave this
    // one writing a path under a prefix that has since moved.
    try {
      const renamed = await sql.renameNode(nodeId, name, segment)
      if (renamed === null) return c.json({ error: 'not found' }, 404)
      return c.json(publicNode(renamed))
    } catch (error) {
      if (error instanceof NodePathConflictError) return c.json({ error: error.message }, 409)
      if (error instanceof NodePathTooLongError) return c.json({ error: error.message }, 400)
      throw error
    }
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
        const hashes = await sql.unreferencedHashes(deleted.hashes)
        await ports.blobs.delete('chunks', hashes)
        return c.json({ nodes: deleted.nodes, templates: deleted.templates, chunks: hashes.length })
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
