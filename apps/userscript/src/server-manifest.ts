import {
  sameTemplateSurface,
  type TemplateSurface,
  TILE_SIZE,
  templateSurface,
  templateSurfaceBounds,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
  WORLD_TILES,
} from '@caelestis/shared'
import type { ServerTemplate } from './server-cache.js'

export type ServerAuthMode = 'none' | 'access_token'

export interface ServerInfo {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly auth: ServerAuthMode
  readonly liveSync?: 1
}

export interface TreeNode {
  readonly id: string
  readonly parentId: string | null
  readonly path: string
  readonly name: string
  readonly description?: string
  readonly createdAt: number
}

export interface ServerManifest {
  readonly version: string
  readonly season: number
  readonly surface: TemplateSurface
  readonly server: ServerInfo
  readonly nodes: readonly TreeNode[]
  readonly templates: readonly ServerTemplate[]
}

export const MAX_TREE_NODES = 100_000
export const MAX_MANIFEST_TEMPLATES = 100_000
export const MAX_MANIFEST_CHUNKS = 200_000

const MAX_MANIFEST_TILES = WORLD_TILES * WORLD_TILES
const MIN_EPOCH_MILLISECONDS = 1_577_836_800_000
const MAX_EPOCH_MILLISECONDS = 4_102_444_800_000
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const NODE_PATH = /^(\/[\p{L}\p{N}][\p{L}\p{N}\p{M}. -]*)+$/u

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const plausibleMillis = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= MIN_EPOCH_MILLISECONDS &&
  value < MAX_EPOCH_MILLISECONDS

export const parseServerInfo = (value: unknown): ServerInfo | null => {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || !UUID_V7.test(value.id)) return null
  if (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 256)
    return null
  if (value.auth !== 'none' && value.auth !== 'access_token') return null
  if (value.liveSync !== undefined && value.liveSync !== 1) return null
  if (
    value.description !== undefined &&
    (typeof value.description !== 'string' ||
      value.description.length < 1 ||
      value.description.length > 4_096)
  )
    return null
  return {
    id: value.id,
    name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    auth: value.auth,
    ...(value.liveSync === 1 ? { liveSync: 1 as const } : {}),
  }
}

export const parseTreeNode = (raw: unknown): TreeNode | null => {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !UUID_V7.test(raw.id)) return null
  if (raw.parentId !== null && (typeof raw.parentId !== 'string' || !UUID_V7.test(raw.parentId))) {
    return null
  }
  if (
    typeof raw.path !== 'string' ||
    raw.path.length < 1 ||
    raw.path.length > 256 ||
    !NODE_PATH.test(raw.path)
  )
    return null
  if (typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > 256) return null
  if (
    raw.description !== undefined &&
    (typeof raw.description !== 'string' ||
      raw.description.length < 1 ||
      raw.description.length > 4_096)
  )
    return null
  if (!plausibleMillis(raw.createdAt)) return null
  return {
    id: raw.id,
    parentId: raw.parentId,
    path: raw.path,
    name: raw.name,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    createdAt: raw.createdAt,
  }
}

export const parseTreeNodes = (value: unknown): readonly TreeNode[] | null => {
  if (!Array.isArray(value) || value.length > MAX_TREE_NODES) return null
  const nodes: TreeNode[] = []
  const ids = new Set<string>()
  for (const raw of value) {
    const node = parseTreeNode(raw)
    if (node === null || ids.has(node.id)) return null
    ids.add(node.id)
    nodes.push(node)
  }
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const foldPath = (path: string): string =>
    path.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const foldedPaths = nodes.map((node) => foldPath(node.path))
  if (new Set(foldedPaths).size !== foldedPaths.length) return null
  const validated = new Set<string>()
  for (const node of nodes) {
    if (node.parentId === null) {
      if (node.path.indexOf('/', 1) !== -1) return null
    } else {
      const parent = byId.get(node.parentId)
      if (parent === undefined) return null
      const path = foldPath(node.path)
      const parentPath = foldPath(parent.path)
      if (!path.startsWith(parentPath)) return null
      const suffix = path.slice(parentPath.length)
      if (!suffix.startsWith('/') || suffix.indexOf('/', 1) !== -1) return null
    }
    if (validated.has(node.id)) continue
    const path = new Set<string>()
    let cursor: TreeNode | undefined = node
    while (cursor !== undefined && !validated.has(cursor.id)) {
      if (path.has(cursor.id)) return null
      path.add(cursor.id)
      if (cursor.parentId !== null && !byId.has(cursor.parentId)) return null
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
    }
    for (const id of path) validated.add(id)
  }
  return nodes
}

const manifestTileKey = (value: unknown, surface: TemplateSurface): value is string => {
  if (typeof value !== 'string') return false
  const match = /^(0|-?[1-9]\d*)\/(0|-?[1-9]\d*)$/.exec(value)
  if (match === null) return false
  const x = Number(match[1])
  const y = Number(match[2])
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return false
  return surface.kind === 'world'
    ? x >= 0 && y >= 0 && x < WORLD_TILES && y < WORLD_TILES
    : x >= -1 && x <= 0 && y >= -1 && y <= 0
}

interface ManifestBbox {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

const manifestXSpans = (
  bbox: ManifestBbox,
  wraps: boolean,
): ReadonlyArray<{ start: number; end: number }> =>
  bbox.minX < bbox.maxX || !wraps
    ? [{ start: bbox.minX, end: bbox.maxX }]
    : [
        { start: bbox.minX, end: WORLD_PIXELS },
        { start: 0, end: bbox.maxX },
      ]

const tileCoordinates = (tile: string): { x: number; y: number } => {
  const separator = tile.indexOf('/')
  return {
    x: Number(tile.slice(0, separator)),
    y: Number(tile.slice(separator + 1)),
  }
}

const chunkIntersectionArea = (
  tile: string,
  bbox: ManifestBbox,
  surface: TemplateSurface,
): number => {
  const { x, y } = tileCoordinates(tile)
  const tileMinX = x * TILE_SIZE
  const tileMinY = y * TILE_SIZE
  const height = Math.min(tileMinY + TILE_SIZE, bbox.maxY) - Math.max(tileMinY, bbox.minY)
  if (height <= 0) return 0
  const width = manifestXSpans(bbox, surface.kind === 'world').reduce(
    (total, span) =>
      total +
      Math.max(0, Math.min(tileMinX + TILE_SIZE, span.end) - Math.max(tileMinX, span.start)),
    0,
  )
  return width * height
}

const manifestContentsValid = (
  value: Record<string, unknown>,
  nodes: readonly TreeNode[],
  surface: TemplateSurface,
): boolean => {
  const rawNodes = value.nodes as readonly unknown[]
  if (
    rawNodes.some(
      (raw) =>
        !isRecord(raw) ||
        !plausibleMillis(raw.createdAt) ||
        (raw.description !== undefined &&
          (typeof raw.description !== 'string' ||
            raw.description.length < 1 ||
            raw.description.length > 4_096)),
    )
  )
    return false

  if (
    !Array.isArray(value.tiles) ||
    value.tiles.length > MAX_MANIFEST_TILES ||
    value.tiles.length > MAX_MANIFEST_CHUNKS
  )
    return false
  const declaredTiles = new Set<string>()
  for (const tile of value.tiles) {
    if (!manifestTileKey(tile, surface) || declaredTiles.has(tile)) return false
    declaredTiles.add(tile)
  }

  if (!Array.isArray(value.templates) || value.templates.length > MAX_MANIFEST_TEMPLATES)
    return false
  const nodeIds = new Set(nodes.map((node) => node.id))
  const templateIds = new Set<string>()
  const referencedTiles = new Set<string>()
  let chunks = 0
  for (const raw of value.templates) {
    if (!isRecord(raw)) return false
    if (typeof raw.id !== 'string' || !UUID_V7.test(raw.id) || templateIds.has(raw.id)) return false
    templateIds.add(raw.id)
    if (raw.nodeId !== null && (typeof raw.nodeId !== 'string' || !nodeIds.has(raw.nodeId)))
      return false
    if (typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > 256) return false
    if (typeof raw.version !== 'string' || !UUID_V7.test(raw.version)) return false
    if (!Number.isSafeInteger(raw.totalPixels) || Number(raw.totalPixels) <= 0) return false
    if (
      typeof raw.published !== 'boolean' ||
      (raw.finished !== undefined && typeof raw.finished !== 'boolean') ||
      (raw.finishedAt !== undefined &&
        raw.finishedAt !== null &&
        !plausibleMillis(raw.finishedAt)) ||
      (raw.timelapseFrozen !== undefined && typeof raw.timelapseFrozen !== 'boolean') ||
      !plausibleMillis(raw.createdAt) ||
      (raw.updatedAt !== undefined && !plausibleMillis(raw.updatedAt))
    )
      return false
    if (!isRecord(raw.bbox)) return false
    const { minX, minY, maxX, maxY } = raw.bbox
    if (![minX, minY, maxX, maxY].every(Number.isSafeInteger)) return false
    if (surface.kind === 'world') {
      if (
        Number(minX) < 0 ||
        Number(minX) >= WORLD_PIXELS ||
        Number(maxX) < 1 ||
        Number(maxX) > WORLD_PIXELS ||
        Number(minX) === Number(maxX) ||
        Number(minY) < 0 ||
        Number(minY) >= WORLD_PIXELS ||
        Number(maxY) < 1 ||
        Number(maxY) > WORLD_PIXELS ||
        Number(minY) >= Number(maxY)
      )
        return false
    } else {
      const bounds = templateSurfaceBounds(surface)
      if (
        bounds === null ||
        Number(minX) < bounds.minX ||
        Number(minY) < bounds.minY ||
        Number(maxX) > bounds.maxX ||
        Number(maxY) > bounds.maxY ||
        Number(minX) >= Number(maxX) ||
        Number(minY) >= Number(maxY)
      )
        return false
    }
    if (!Array.isArray(raw.chunks) || raw.chunks.length === 0) return false
    chunks += raw.chunks.length
    if (chunks > MAX_MANIFEST_CHUNKS) return false
    const ownTiles = new Set<string>()
    let capacity = 0
    const bbox = {
      minX: Number(minX),
      minY: Number(minY),
      maxX: Number(maxX),
      maxY: Number(maxY),
    }
    for (const chunk of raw.chunks) {
      if (
        !isRecord(chunk) ||
        !manifestTileKey(chunk.tile, surface) ||
        typeof chunk.hash !== 'string' ||
        !SHA256_HEX.test(chunk.hash) ||
        ownTiles.has(chunk.tile)
      )
        return false
      const intersection = chunkIntersectionArea(chunk.tile, bbox, surface)
      if (intersection === 0) return false
      capacity += intersection
      ownTiles.add(chunk.tile)
      referencedTiles.add(chunk.tile)
    }
    if (Number(raw.totalPixels) > capacity) return false
  }
  return (
    referencedTiles.size === declaredTiles.size &&
    [...referencedTiles].every((tile) => declaredTiles.has(tile))
  )
}

export const parseServerManifest = (
  value: unknown,
  expected: ServerInfo,
  expectedSurface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): ServerManifest | null => {
  if (
    !isRecord(value) ||
    typeof value.version !== 'string' ||
    value.version.length < 1 ||
    value.version.length > 64
  )
    return null
  if (!Number.isSafeInteger(value.season) || Number(value.season) < 0) return null
  const surface =
    value.surface === undefined
      ? WORLD_TEMPLATE_SURFACE
      : isRecord(value.surface)
        ? templateSurface(value.surface.kind, value.surface.allianceId)
        : null
  if (surface === null || !sameTemplateSurface(surface, expectedSurface)) return null
  const server = parseServerInfo(value.server)
  if (server === null || server.id !== expected.id) return null
  const nodes = parseTreeNodes(value.nodes)
  if (nodes === null || !manifestContentsValid(value, nodes, surface)) return null
  const templates = (value.templates as readonly Record<string, unknown>[]).map(
    (template): ServerTemplate => ({
      id: String(template.id),
      nodeId: template.nodeId === null ? null : String(template.nodeId),
      name: String(template.name),
      version: String(template.version),
      totalPixels: Number(template.totalPixels),
      published: template.published === true,
      finished: template.finished === true,
      finishedAt: typeof template.finishedAt === 'number' ? template.finishedAt : null,
      timelapseFrozen: template.timelapseFrozen === true,
      updatedAt:
        typeof template.updatedAt === 'number'
          ? template.updatedAt
          : typeof template.createdAt === 'number'
            ? template.createdAt
            : 0,
      bbox: template.bbox as ServerTemplate['bbox'],
      chunks: template.chunks as ServerTemplate['chunks'],
      surface,
    }),
  )
  return {
    version: value.version,
    season: Number(value.season),
    surface,
    server,
    nodes,
    templates,
  }
}
