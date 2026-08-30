import type { Manifest, ServerInfo, TemplateSurface } from '@caelestis/shared'
import { Effect } from 'effect'
import { resolveServerInfoEffect } from '../routes/server.js'
import type { SqlStoreService } from '../runtime/backend-runtime.js'
import type { BackendStorageError, SqlStoreReadError } from '../runtime/errors.js'
import { assembleManifestEffect } from './assemble.js'

export interface ReadManifestInput {
  readonly server: ServerInfo
  readonly season: number
  readonly surface: TemplateSurface
  readonly includeUnpublished: boolean
}

/** Resolve mutable server metadata and assemble the matching visibility-scoped manifest. */
export const readManifest = (
  input: ReadManifestInput,
): Effect.Effect<Manifest, SqlStoreReadError | BackendStorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const server = yield* resolveServerInfoEffect(input.server)
    return yield* assembleManifestEffect({
      server,
      season: input.season,
      surface: input.surface,
      includeUnpublished: input.includeUnpublished,
    })
  })
