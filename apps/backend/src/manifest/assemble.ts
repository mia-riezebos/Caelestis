import { type Manifest, type ServerInfo, sha256Hex, tileKey } from '@wts/shared'
import type { Ports } from '../ports/index.js'

export interface AssembleManifestOptions {
  readonly server: ServerInfo
  readonly season: number
  readonly includeUnpublished: boolean
}

const VERSION_PLACEHOLDER = '0'.repeat(64)

export const assembleManifest = async (
  ports: Pick<Ports, 'sql'>,
  options: AssembleManifestOptions,
): Promise<Manifest> => {
  const [nodeRecords, templateRecords, tileRecords] = await Promise.all([
    ports.sql.listNodes(options.season),
    ports.sql.listManifestTemplates(options.season, options.includeUnpublished),
    ports.sql.listManifestTiles(options.season, options.includeUnpublished),
  ])

  const nodes = nodeRecords
    .map(({ id, parentId, path, name, description, createdAt }) =>
      description === null
        ? { id, parentId, path, name, createdAt }
        : { id, parentId, path, name, description, createdAt },
    )
    .sort((left, right) => left.id.localeCompare(right.id))

  const chunksByTemplate = new Map<
    string,
    Array<{ tile: ReturnType<typeof tileKey>; hash: string }>
  >()
  for (const record of tileRecords) {
    const chunk = { tile: tileKey({ x: record.tileX, y: record.tileY }), hash: record.hash }
    const chunks = chunksByTemplate.get(record.templateId)
    if (chunks === undefined) chunksByTemplate.set(record.templateId, [chunk])
    else chunks.push(chunk)
  }

  const templates = templateRecords
    .map((template) => ({
      id: template.id,
      nodeId: template.nodeId,
      name: template.name,
      version: template.versionId,
      bbox: { ...template.bbox },
      totalPixels: template.totalPixels,
      chunks: (chunksByTemplate.get(template.id) ?? []).sort((left, right) =>
        left.tile.localeCompare(right.tile),
      ),
      published: template.published,
      createdAt: template.createdAt,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  const tiles = [
    ...new Set(templates.flatMap((template) => template.chunks.map(({ tile }) => tile))),
  ].sort((left, right) => left.localeCompare(right))
  const normalizedServer: ServerInfo =
    options.server.description === undefined
      ? { id: options.server.id, name: options.server.name, auth: options.server.auth }
      : {
          id: options.server.id,
          name: options.server.name,
          description: options.server.description,
          auth: options.server.auth,
        }
  const unsigned: Manifest = {
    version: VERSION_PLACEHOLDER,
    season: options.season,
    server: normalizedServer,
    nodes,
    templates,
    tiles,
  }
  const version = await sha256Hex(new TextEncoder().encode(JSON.stringify(unsigned)))
  return { ...unsigned, version }
}
