import { millis, uuidV7 } from '@wts/shared'
import { Hono } from 'hono'
import { type AuthOptions, requireScope } from '../auth/middleware.js'
import type { NodeRecord, SqlStore } from '../ports/index.js'
import { InvalidNodeParentError, NodeNotEmptyError, NodePathConflictError } from '../ports/index.js'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Seasons are 1-based, matching `Season` in the wire and the Worker's own `SEASON` refusal.
const SEASON_NUMBER = /^[1-9]\d*$/
const MAX_NAME_LENGTH = 256
const MAX_DESCRIPTION_LENGTH = 4_096
const MAX_PATH_LENGTH = 256

const parseSeason = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 1 ? value : null
  if (typeof value !== 'string' || !SEASON_NUMBER.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const slug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, '-')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()

const publicNode = ({ season: _season, description, ...node }: NodeRecord) =>
  description === null ? node : { ...node, description }

export const createNodeRoutes = (sql: SqlStore, auth: AuthOptions) => {
  const routes = new Hono()

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
    const path = `${parentPath}/${segment}`
    if (path.length > MAX_PATH_LENGTH) return c.json({ error: 'derived path is too long' }, 400)

    const node: NodeRecord = {
      id: uuidV7(),
      season: parsedSeason,
      parentId,
      path,
      name,
      description: description ?? null,
      createdAt: millis(Date.now()),
    }
    try {
      await sql.insertNode(node)
    } catch (error) {
      if (error instanceof NodePathConflictError || error instanceof InvalidNodeParentError) {
        return c.json({ error: error.message }, 400)
      }
      throw error
    }
    return c.json(publicNode(node), 201)
  })

  routes.get('/', async (c) => {
    const season = parseSeason(c.req.query('season'))
    if (season === null) return c.json({ error: 'season must be a positive integer' }, 400)
    return c.json((await sql.listNodes(season)).map(publicNode))
  })

  routes.delete('/:id', async (c) => {
    const nodeId = c.req.param('id')
    if (!UUID_V7.test(nodeId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
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
