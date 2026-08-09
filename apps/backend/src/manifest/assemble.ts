import { type Manifest, type ServerInfo, sha256Hex, tileKey } from '@wts/shared'
import type { Ports } from '../ports/index.js'

export interface AssembleManifestOptions {
  readonly server: ServerInfo
  readonly season: number
  readonly includeUnpublished: boolean
}

const VERSION_PLACEHOLDER = '0'.repeat(64)

/** Mirrors `MAX_MANIFEST_CHUNKS` in `@wts/wire-schema`, which is what refuses the assembled result. */
const MAX_MANIFEST_CHUNKS = 200_000

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

  // Templates and tiles are separate reads with no snapshot between them, so a publish landing in
  // the gap can be seen by one and not the other. A template that arrives with no tiles is emitted
  // as `chunks: []`, which the wire refuses outright — one admin publish concurrent with one member
  // poll would produce a 200 nobody can decode. Dropping it is the recoverable direction: the next
  // poll, microseconds later, carries it complete. The reverse ordering is already benign, since
  // orphan tile rows simply find no template to attach to.
  const templates = templateRecords
    .filter((template) => (chunksByTemplate.get(template.id)?.length ?? 0) > 0)
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

  // The wire caps a manifest at 200,000 chunks in total, and nothing on the write path enforces an
  // aggregate: 512 chunks per template is bounded, the number of published templates in a season is
  // not, so ~391 of them cross the line. Past it, every client rejects the 200 this would return.
  //
  // INTERIM. Failing here turns a silent client-side break into a server-side error naming the
  // cause, which is strictly better but still an outage for that season's manifest. The real fix is
  // to refuse the publish that crosses the line, so an admin learns at the moment they cause it —
  // that needs the season and the season's current chunk total at the publish route, which is port
  // surface this slice does not have.
  const chunkTotal = templates.reduce((total, template) => total + template.chunks.length, 0)
  if (chunkTotal > MAX_MANIFEST_CHUNKS) {
    throw new Error(
      `season ${options.season} assembles ${chunkTotal} chunks, more than the ${MAX_MANIFEST_CHUNKS} a manifest may carry`,
    )
  }

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
