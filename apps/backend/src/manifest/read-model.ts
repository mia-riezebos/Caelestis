import type { Manifest, ServerInfo, TemplateSurface } from '@caelestis/shared'

export type ManifestVisibilityScope = 'public' | 'admin'

export interface ManifestProjectionInput {
  readonly server: ServerInfo
  readonly season: number
  readonly surface: TemplateSurface
  readonly scope: ManifestVisibilityScope
  readonly ifNoneMatch: readonly string[]
}

export type ManifestProjectionRead =
  | {
      readonly notModified: true
      readonly version: string
      readonly revision: number
      readonly coverageRevision: number
      readonly cacheOutcome: 'hit' | 'miss' | 'stale'
      readonly revisionChanged: boolean
    }
  | {
      readonly notModified: false
      readonly manifest: Manifest
      readonly version: string
      readonly revision: number
      readonly coverageRevision: number
      readonly cacheOutcome: 'hit' | 'miss' | 'stale'
      readonly revisionChanged: boolean
    }

export interface PersistedManifestProjection {
  readonly key: string
  readonly configuredServer: string
  readonly cachedAt: number
  readonly expiresAt: number
  readonly serializedBytes: number
  readonly manifest: Manifest
}

export interface PersistedManifestReadModel {
  readonly season: number
  readonly revision: number
  /** Absent in older snapshots, where every manifest revision also changed tile coverage. */
  readonly coverageRevision?: number
  readonly entries: readonly PersistedManifestProjection[]
}

export interface ManifestReadModelPersistence {
  readonly load: () => Promise<PersistedManifestReadModel | null>
  /** Read the durable tile coverage revision without loading manifest projections. */
  readonly loadCoverageRevision?: () => Promise<number | null>
  readonly save: (state: PersistedManifestReadModel) => Promise<void>
}

export interface SeasonManifestReadModel {
  readonly read: (input: ManifestProjectionInput) => Promise<ManifestProjectionRead>
  readonly invalidate: (surface?: TemplateSurface, affectsTileCoverage?: boolean) => Promise<number>
  readonly coverageRevision: () => Promise<number>
  /** Current unexpired version, or null when an authoritative manifest read is required. */
  readonly knownVersion: (
    scope: ManifestVisibilityScope,
    surface: TemplateSurface,
  ) => Promise<string | null>
}

export const MANIFEST_READ_MODEL_TTL_MILLISECONDS = 3 * 60_000
export const MAX_MANIFEST_PROJECTIONS_PER_SEASON = 16
export const MAX_MANIFEST_PROJECTION_BYTES_PER_SEASON = 16 * 1024 * 1024

const projectionKey = (scope: ManifestVisibilityScope, surface: TemplateSurface): string =>
  surface.kind === 'world' ? `${scope}:world` : `${scope}:${surface.kind}:${surface.allianceId}`

const configuredServer = (server: ServerInfo): string => JSON.stringify(server)

const matches = (candidates: readonly string[], version: string): boolean => {
  const etag = `"${version}"`
  return candidates.includes(etag) || candidates.includes('*')
}

/** Bounded, revisioned manifest cache. The source remains authoritative on misses and TTL repair. */
export const createSeasonManifestReadModel = (options: {
  readonly season: number
  readonly source: (input: ManifestProjectionInput) => Promise<Manifest>
  readonly persistence: ManifestReadModelPersistence
  readonly now?: () => number
  readonly ttlMilliseconds?: number
  readonly maximumEntries?: number
  readonly maximumBytes?: number
}): SeasonManifestReadModel => {
  const now = options.now ?? Date.now
  const ttl = options.ttlMilliseconds ?? MANIFEST_READ_MODEL_TTL_MILLISECONDS
  const maximumEntries = options.maximumEntries ?? MAX_MANIFEST_PROJECTIONS_PER_SEASON
  const maximumBytes = options.maximumBytes ?? MAX_MANIFEST_PROJECTION_BYTES_PER_SEASON
  let state: PersistedManifestReadModel | null = null
  let loaded = false
  let tail = Promise.resolve()

  const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
    const running = tail.then(operation, operation)
    tail = running.then(
      () => undefined,
      () => undefined,
    )
    return running
  }

  const load = async (): Promise<PersistedManifestReadModel> => {
    if (!loaded) {
      const persisted = await options.persistence.load()
      state = persisted?.season === options.season ? persisted : null
      loaded = true
    }
    state ??= { season: options.season, revision: 1, entries: [] }
    return state
  }

  return {
    read: (input) =>
      exclusive(async () => {
        const current = await load()
        const key = projectionKey(input.scope, input.surface)
        const server = configuredServer(input.server)
        const keyed = current.entries.find((entry) => entry.key === key)
        const held = keyed?.configuredServer === server ? keyed : undefined
        const readAt = now()
        if (held !== undefined && held.expiresAt > readAt) {
          const base = {
            version: held.manifest.version,
            revision: current.revision,
            coverageRevision: current.coverageRevision ?? current.revision,
            cacheOutcome: 'hit' as const,
            revisionChanged: false,
          }
          return matches(input.ifNoneMatch, held.manifest.version)
            ? { ...base, notModified: true as const }
            : { ...base, notModified: false as const, manifest: held.manifest }
        }

        const manifest = await options.source(input)
        const serializedBytes = new TextEncoder().encode(JSON.stringify(manifest)).byteLength
        const revisionChanged = keyed !== undefined && keyed.manifest.version !== manifest.version
        const revision = revisionChanged ? current.revision + 1 : current.revision
        const coverageRevision = revisionChanged
          ? revision
          : (current.coverageRevision ?? current.revision)
        const configuredServerChanged = keyed !== undefined && keyed.configuredServer !== server
        const retained = configuredServerChanged
          ? []
          : current.entries.filter((entry) => entry.key !== key)
        const entries = [
          ...retained,
          {
            key,
            configuredServer: server,
            cachedAt: readAt,
            expiresAt: readAt + ttl,
            serializedBytes,
            manifest,
          },
        ]
          .sort((left, right) => right.cachedAt - left.cachedAt)
          .reduce<PersistedManifestProjection[]>((bounded, entry) => {
            const retainedBytes = bounded.reduce(
              (total, retained) => total + retained.serializedBytes,
              0,
            )
            if (
              bounded.length < maximumEntries &&
              retainedBytes + entry.serializedBytes <= maximumBytes
            ) {
              bounded.push(entry)
            }
            return bounded
          }, [])
        const next = { season: options.season, revision, coverageRevision, entries }
        await options.persistence.save(next)
        state = next
        const base = {
          version: manifest.version,
          revision,
          coverageRevision,
          cacheOutcome: keyed === undefined ? ('miss' as const) : ('stale' as const),
          revisionChanged,
        }
        return matches(input.ifNoneMatch, manifest.version)
          ? { ...base, notModified: true as const }
          : { ...base, notModified: false as const, manifest }
      }),
    invalidate: (surface, affectsTileCoverage = true) =>
      exclusive(async () => {
        const current = await load()
        const invalidatedKeys =
          surface === undefined
            ? null
            : new Set([projectionKey('public', surface), projectionKey('admin', surface)])
        const next = {
          season: options.season,
          revision: current.revision + 1,
          coverageRevision: affectsTileCoverage
            ? current.revision + 1
            : (current.coverageRevision ?? current.revision),
          entries:
            invalidatedKeys === null
              ? []
              : current.entries.filter((entry) => !invalidatedKeys.has(entry.key)),
        }
        await options.persistence.save(next)
        state = next
        return next.revision
      }),
    coverageRevision: async () => {
      if (options.persistence.loadCoverageRevision !== undefined) {
        return (await options.persistence.loadCoverageRevision()) ?? 1
      }
      return exclusive(async () => {
        const current = await load()
        return current.coverageRevision ?? current.revision
      })
    },
    knownVersion: (scope, surface) =>
      exclusive(async () => {
        const current = await load()
        const entry = current.entries.find(
          (candidate) => candidate.key === projectionKey(scope, surface),
        )
        return entry !== undefined && entry.expiresAt > now() ? entry.manifest.version : null
      }),
  }
}
