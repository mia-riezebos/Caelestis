import type { Manifest } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import { createSeasonManifestReadModel, type PersistedManifestReadModel } from './read-model.js'

const manifest = (version: string, name = 'Server'): Manifest => ({
  version,
  season: 7,
  server: {
    id: '01890f3a-6b7c-7def-8123-456789abcdef',
    name,
    auth: 'none',
  },
  nodes: [],
  templates: [],
  tiles: [],
})

const input = {
  server: manifest('ignored').server,
  season: 7,
  surface: { kind: 'world' as const, allianceId: null },
  scope: 'public' as const,
  ifNoneMatch: [] as string[],
}

describe('manifest read model', () => {
  it('advances metadata independently of tile coverage, including subsequent reads and restart', async () => {
    let persisted: PersistedManifestReadModel | null = null
    const source = vi.fn(async () => manifest('a'.repeat(64)))
    const options = {
      season: 7,
      source,
      persistence: {
        load: async () => persisted,
        save: async (next: PersistedManifestReadModel) => {
          persisted = next
        },
      },
    }
    const model = createSeasonManifestReadModel(options)
    await model.read(input)
    source.mockResolvedValue(manifest('b'.repeat(64)))
    await model.invalidate(input.surface, false)
    await expect(model.read(input)).resolves.toMatchObject({
      revision: 2,
      coverageRevision: 1,
      version: 'b'.repeat(64),
    })
    const restarted = createSeasonManifestReadModel(options)
    await expect(restarted.coverageRevision()).resolves.toBe(1)
    await restarted.invalidate(input.surface)
    await expect(restarted.read(input)).resolves.toMatchObject({ revision: 3, coverageRevision: 3 })
  })

  it('answers a conditional cache hit before invoking the assembly source', async () => {
    let persisted: PersistedManifestReadModel | null = null
    const source = vi.fn(async () => manifest('a'.repeat(64)))
    const model = createSeasonManifestReadModel({
      season: 7,
      source,
      persistence: {
        load: async () => persisted,
        save: async (next) => {
          persisted = next
        },
      },
    })
    await model.read(input)
    source.mockClear()

    await expect(
      model.read({ ...input, ifNoneMatch: [`"${'a'.repeat(64)}"`] }),
    ).resolves.toMatchObject({ notModified: true, cacheOutcome: 'hit', revision: 1 })
    expect(source).not.toHaveBeenCalled()
  })

  it('separates visibility and surface keys and bounds retained projections', async () => {
    let persisted: PersistedManifestReadModel | null = null
    const source = vi.fn(async () => manifest('a'.repeat(64)))
    const model = createSeasonManifestReadModel({
      season: 7,
      source,
      maximumEntries: 2,
      persistence: {
        load: async () => persisted,
        save: async (next) => {
          persisted = next
        },
      },
    })
    await model.read(input)
    await model.read({ ...input, scope: 'admin' })
    await model.read({
      ...input,
      surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
    })

    const saved = persisted as PersistedManifestReadModel | null
    expect(source).toHaveBeenCalledTimes(3)
    expect(saved?.entries).toHaveLength(2)
    expect(new Set(saved?.entries.map(({ key }) => key)).size).toBe(2)
  })

  it('bounds retained projections by aggregate serialized bytes', async () => {
    let now = 1_000
    let persisted: PersistedManifestReadModel | null = null
    const projected = manifest('a'.repeat(64))
    const bytes = new TextEncoder().encode(JSON.stringify(projected)).byteLength
    const source = vi.fn(async () => projected)
    const model = createSeasonManifestReadModel({
      season: 7,
      source,
      now: () => now++,
      maximumBytes: bytes + 1,
      persistence: {
        load: async () => persisted,
        save: async (next) => {
          persisted = next
        },
      },
    })
    await model.read(input)
    await model.read({ ...input, scope: 'admin' })

    const saved = persisted as PersistedManifestReadModel | null
    expect(saved?.entries).toHaveLength(1)
    expect(
      saved?.entries.reduce((total, entry) => total + entry.serializedBytes, 0),
    ).toBeLessThanOrEqual(bytes + 1)
  })

  it('uses TTL only to repair a missed invalidation and advances revision on changed content', async () => {
    let now = 1_000
    let persisted: PersistedManifestReadModel | null = null
    const source = vi
      .fn()
      .mockResolvedValueOnce(manifest('a'.repeat(64)))
      .mockResolvedValueOnce(manifest('b'.repeat(64)))
    const model = createSeasonManifestReadModel({
      season: 7,
      source,
      now: () => now,
      ttlMilliseconds: 100,
      persistence: {
        load: async () => persisted,
        save: async (next) => {
          persisted = next
        },
      },
    })
    await model.read(input)
    await expect(model.knownVersion('public', input.surface)).resolves.toBe('a'.repeat(64))
    now += 101
    await expect(model.knownVersion('public', input.surface)).resolves.toBeNull()

    await expect(model.read(input)).resolves.toMatchObject({
      cacheOutcome: 'stale',
      revision: 2,
      revisionChanged: true,
    })
  })

  it('treats changed configured server metadata as stale and advances a changed projection', async () => {
    let persisted: PersistedManifestReadModel | null = null
    const source = vi
      .fn()
      .mockResolvedValueOnce(manifest('a'.repeat(64)))
      .mockResolvedValueOnce(manifest('b'.repeat(64), 'Renamed'))
    const model = createSeasonManifestReadModel({
      season: 7,
      source,
      persistence: {
        load: async () => persisted,
        save: async (next) => {
          persisted = next
        },
      },
    })
    await model.read(input)

    await expect(
      model.read({ ...input, server: { ...input.server, name: 'Renamed' } }),
    ).resolves.toMatchObject({
      cacheOutcome: 'stale',
      revision: 2,
      revisionChanged: true,
    })
  })

  it('invalidates every visibility and surface projection after commit', async () => {
    let persisted: PersistedManifestReadModel | null = null
    const source = vi.fn(async () => manifest('a'.repeat(64)))
    const model = createSeasonManifestReadModel({
      season: 7,
      source,
      persistence: {
        load: async () => persisted,
        save: async (next) => {
          persisted = next
        },
      },
    })
    await model.read(input)
    await model.read({ ...input, scope: 'admin' })

    await expect(model.invalidate()).resolves.toBe(2)
    expect(persisted).toMatchObject({ revision: 2, entries: [] })
  })

  it('invalidates only the changed drawing surface', async () => {
    let persisted: PersistedManifestReadModel | null = null
    const source = vi.fn(async () => manifest('a'.repeat(64)))
    const model = createSeasonManifestReadModel({
      season: 7,
      source,
      persistence: {
        load: async () => persisted,
        save: async (next) => {
          persisted = next
        },
      },
    })
    const headquarters = {
      ...input,
      surface: { kind: 'alliance-headquarters' as const, allianceId: 42 },
    }
    const picture = {
      ...input,
      surface: { kind: 'alliance-picture' as const, allianceId: 42 },
    }
    const banner = {
      ...input,
      surface: { kind: 'alliance-banner' as const, allianceId: 42 },
    }
    await model.read(input)
    await model.read(headquarters)
    await model.read(picture)
    await model.read(banner)

    await expect(model.invalidate(picture.surface)).resolves.toBe(2)
    const saved = persisted as PersistedManifestReadModel | null
    expect(saved?.entries.map(({ key }) => key).sort()).toEqual([
      'public:alliance-banner:42',
      'public:alliance-headquarters:42',
      'public:world',
    ])
    source.mockClear()
    await model.read(input)
    await model.read(headquarters)
    await model.read(banner)
    expect(source).not.toHaveBeenCalled()
    await model.read(picture)
    expect(source).toHaveBeenCalledOnce()
  })

  it('keeps the last durable projection when invalidation persistence fails', async () => {
    let persisted: PersistedManifestReadModel | null = null
    let fail = false
    const source = vi.fn(async () => manifest('a'.repeat(64)))
    const model = createSeasonManifestReadModel({
      season: 7,
      source,
      persistence: {
        load: async () => persisted,
        save: async (next) => {
          if (fail) throw new Error('storage failed')
          persisted = next
        },
      },
    })
    await model.read(input)
    fail = true
    await expect(model.invalidate()).rejects.toThrow('storage failed')
    fail = false

    await expect(model.read(input)).resolves.toMatchObject({
      cacheOutcome: 'hit',
      revision: 1,
    })
    expect(source).toHaveBeenCalledOnce()
  })

  it('reads a lightweight durable revision without waiting for an active projection refresh', async () => {
    let releaseSource!: (value: Manifest) => void
    const source = vi.fn(
      () =>
        new Promise<Manifest>((resolve) => {
          releaseSource = resolve
        }),
    )
    const loadCoverageRevision = vi.fn(async () => 9)
    const model = createSeasonManifestReadModel({
      season: 7,
      source,
      persistence: {
        load: async () => ({ season: 7, revision: 9, entries: [] }),
        loadCoverageRevision,
        save: async () => undefined,
      },
    })
    const refreshing = model.read(input)
    await vi.waitFor(() => expect(source).toHaveBeenCalledOnce())

    await expect(model.coverageRevision()).resolves.toBe(9)
    expect(loadCoverageRevision).toHaveBeenCalledOnce()
    releaseSource(manifest('a'.repeat(64)))
    await refreshing
  })
})
