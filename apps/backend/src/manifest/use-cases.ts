import type { Manifest, ServerInfo, TemplateSurface } from '@caelestis/shared'
import { Effect } from 'effect'
import { resolveServerInfoEffect } from '../routes/server.js'
import { type SqlStoreService, StatusReadModelService } from '../runtime/backend-runtime.js'
import { BackendStorageError, type SqlStoreReadError } from '../runtime/errors.js'
import { assembleManifestEffect } from './assemble.js'
import type { ManifestProjectionRead } from './read-model.js'

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

export const readManifestProjection = (
  input: ReadManifestInput & {
    readonly ifNoneMatch: readonly string[]
    readonly cacheable: boolean
  },
): Effect.Effect<
  ManifestProjectionRead,
  SqlStoreReadError | BackendStorageError,
  SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const readModel = yield* StatusReadModelService
    const cachedRead = readModel.readManifestProjection?.bind(readModel)
    if (input.cacheable && cachedRead !== undefined) {
      return yield* Effect.tryPromise({
        try: () =>
          cachedRead({
            server: input.server,
            season: input.season,
            surface: input.surface,
            scope: input.includeUnpublished ? 'admin' : 'public',
            ifNoneMatch: input.ifNoneMatch,
          }),
        catch: (cause) => new BackendStorageError({ operation: 'readManifestProjection', cause }),
      })
    }
    const manifest = yield* readManifest(input)
    const etag = `"${manifest.version}"`
    const base = {
      version: manifest.version,
      revision: 1,
      cacheOutcome: 'miss' as const,
      revisionChanged: false,
    }
    return input.ifNoneMatch.includes(etag) || input.ifNoneMatch.includes('*')
      ? { ...base, notModified: true as const }
      : { ...base, notModified: false as const, manifest }
  })
