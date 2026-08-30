import type { Manifest } from '@caelestis/shared'
import type { SqlStore } from '../ports/index.js'
import { mergeServerInfo } from '../server-info.js'
import { assembleManifest } from './assemble.js'
import type { ManifestProjectionInput } from './read-model.js'

/** Authoritative manifest source used by both portable and Durable Object read models. */
export const assembleManifestProjection = async (
  sql: SqlStore,
  input: ManifestProjectionInput,
): Promise<Manifest> => {
  const server = mergeServerInfo(input.server, await sql.readServerSettings())
  return assembleManifest(sql, {
    server,
    season: input.season,
    surface: input.surface,
    includeUnpublished: input.scope === 'admin',
  })
}
