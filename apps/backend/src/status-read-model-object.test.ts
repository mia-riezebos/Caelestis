import { type Manifest, millis } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1Database } from './adapters/cloudflare/sqlite-d1.test-helper.js'
import { createSeasonManifestReadModel } from './manifest/read-model.js'
import {
  createChunkedManifestPersistence,
  createChunkedStatusPersistence,
  createLiveSessionFence,
  StatusReadModelObject,
} from './status-read-model-object.js'

class FakeWebSocketRequestResponsePair {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
}

vi.stubGlobal('WebSocketRequestResponsePair', FakeWebSocketRequestResponsePair)

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}))

let database: SqliteD1Database | null = null

afterEach(() => {
  database?.close()
  database = null
})

describe('status read-model Durable Object', () => {
  const serializedBytes = (manifest: Manifest): number =>
    new TextEncoder().encode(JSON.stringify(manifest)).byteLength

  const objectState = (
    held: Map<string, unknown>,
    maximumValueBytes = Number.POSITIVE_INFINITY,
    sockets: readonly WebSocket[] = [],
  ) => {
    const storage = (target: Map<string, unknown>) => ({
      get: async <A>(key: string) => target.get(key) as A | undefined,
      put: async (key: string, value: unknown) => {
        if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumValueBytes) {
          throw new RangeError('value exceeds Durable Object storage limit')
        }
        target.set(key, structuredClone(value))
      },
      delete: async (key: string | string[]) =>
        Array.isArray(key)
          ? key.reduce((deleted, item) => Number(target.delete(item)) + deleted, 0)
          : target.delete(key),
    })
    return {
      getWebSockets: (tag?: string) => (tag === undefined || tag === 'status' ? sockets : []),
      setWebSocketAutoResponse: vi.fn(),
      storage: {
        ...storage(held),
        transaction: async (run: (transaction: ReturnType<typeof storage>) => Promise<void>) => {
          const staged = new Map(held)
          await run(storage(staged))
          held.clear()
          for (const [key, value] of staged) held.set(key, value)
        },
      },
    } as unknown as DurableObjectState
  }

  it('persists a reconstructible season projection across object eviction', async () => {
    database = new SqliteD1Database()
    const held = new Map<string, unknown>()
    const state = objectState(held)
    const env = { DB: database } as unknown as Env

    const first = new StatusReadModelObject(state, env)
    await expect(first.reconcileSnapshot(3, 'public')).resolves.toEqual({
      cacheOutcome: 'miss',
      snapshot: { revision: 1, templates: [] },
    })
    expect(held.get('status-read-model:v2:manifest')).toMatchObject({ season: 3, revision: 1 })

    const recovered = new StatusReadModelObject(state, env)
    await expect(recovered.reconcileSnapshot(3, 'admin')).resolves.toEqual({
      cacheOutcome: 'hit',
      snapshot: { revision: 1, templates: [] },
    })
  })

  it('returns D1 usage with a measured status cache miss', async () => {
    database = new SqliteD1Database()
    const object = new StatusReadModelObject(objectState(new Map()), {
      DB: database,
    } as unknown as Env)

    const measured = await object.reconcileSnapshotMeasured(3, 'public')

    expect(measured).toMatchObject({ success: true, value: { cacheOutcome: 'miss' } })
    expect(measured.usage.measuredQueries + measured.usage.unmeasuredQueries).toBeGreaterThan(0)
  })

  it('lets hibernation answer heartbeat pings without waking the object', () => {
    database = new SqliteD1Database()
    const state = objectState(new Map())

    new StatusReadModelObject(state, { DB: database } as unknown as Env)

    expect(state.setWebSocketAutoResponse).toHaveBeenCalledWith(
      expect.objectContaining({ request: 'ping', response: 'pong' }),
    )
  })

  it('fans one committed status update out to five clients within two seconds', async () => {
    database = new SqliteD1Database()
    const socket = () =>
      ({
        deserializeAttachment: () => ({
          season: 8,
          scope: 'public',
          tokenHash: 'a'.repeat(64),
          revocable: false,
          lastRevision: 1,
        }),
        send: vi.fn(),
        close: vi.fn(),
      }) as unknown as WebSocket
    const subscribers = Array.from({ length: 5 }, socket)
    const object = new StatusReadModelObject(
      objectState(new Map(), Number.POSITIVE_INFINITY, subscribers),
      { DB: database } as unknown as Env,
    )
    await object.reconcileSnapshot(8, 'public')

    const startedAt = performance.now()
    await object.applyCommittedChange(8, {
      baseRevision: 1,
      revision: 2,
      changes: [
        {
          templateId: '01890f3e-7b2c-7abc-8def-000000000008',
          published: true,
          total: 1,
          previous: null,
          current: { correct: 1, wrong: 0, blank: 0, observedAt: millis(1_750_000_000_000) },
        },
      ],
    })

    expect(performance.now() - startedAt).toBeLessThan(2_000)
    for (const subscriber of subscribers) {
      expect(subscriber.send).toHaveBeenCalledOnce()
      expect(subscriber.send).toHaveBeenCalledWith(expect.stringContaining('"type":"status-delta"'))
    }
  })

  it('acknowledges ten distinct same-hash live observations from one warm generation', async () => {
    database = new SqliteD1Database()
    const object = new StatusReadModelObject(objectState(new Map()), {
      DB: database,
    } as unknown as Env)
    await object.applyCommittedTileGeneration(8, {
      tile: { x: 1, y: 2 },
      hash: 'a'.repeat(64),
      observedAt: millis(1_750_000_000_000),
      commitOrder: 1,
      coverageToken: object.resolveCurrentTileOffers(8, 'public', []).coverageToken ?? '',
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    const send = vi.fn()
    const socket = {
      deserializeAttachment: () => ({
        season: 8,
        scope: 'public',
        credentialScope: 'report',
        tokenHash: 'a'.repeat(64),
        revocable: true,
        lastRevision: 1,
      }),
      send,
      close: vi.fn(),
    } as unknown as WebSocket

    for (let index = 0; index < 10; index++) {
      const suffix = String(index).padStart(12, '0')
      object.webSocketMessage(
        socket,
        JSON.stringify({
          type: 'tile-offer-cache',
          requestId: `01890f3e-7b2c-7abc-8def-${suffix}`,
          batch: {
            wplaceUserId: 42,
            displayName: 'Mia',
            season: 8,
            offers: [
              {
                deliveryId: `01890f3f-7b2c-7abc-8def-${suffix}`,
                tile: '1/2',
                sha256: 'a'.repeat(64),
                ts: 1_750_000_000,
              },
            ],
          },
        }),
      )
    }

    expect(send).toHaveBeenCalledTimes(10)
    for (const [message] of send.mock.calls) {
      expect(JSON.parse(String(message))).toMatchObject({
        type: 'tile-offer-cache-result',
        response: { unresolvedDeliveryIds: [] },
      })
    }
  })

  it('refuses tile offers from a read-only live session', () => {
    database = new SqliteD1Database()
    const object = new StatusReadModelObject(objectState(new Map()), {
      DB: database,
    } as unknown as Env)
    const send = vi.fn()
    const socket = {
      deserializeAttachment: () => ({
        season: 8,
        scope: 'public',
        credentialScope: 'read',
        tokenHash: 'a'.repeat(64),
        revocable: true,
        lastRevision: 1,
      }),
      send,
      close: vi.fn(),
    } as unknown as WebSocket

    object.webSocketMessage(
      socket,
      JSON.stringify({
        type: 'tile-offer-cache',
        requestId: '01890f3e-7b2c-7abc-8def-000000000001',
        batch: {
          wplaceUserId: 42,
          displayName: 'Mia',
          season: 8,
          offers: [
            {
              deliveryId: '01890f3f-7b2c-7abc-8def-000000000001',
              tile: '1/2',
              sha256: 'a'.repeat(64),
              ts: 1_750_000_000,
            },
          ],
        },
      }),
    )

    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toMatchObject({
      response: {
        acknowledgedDeliveryIds: [],
        unresolvedDeliveryIds: ['01890f3f-7b2c-7abc-8def-000000000001'],
        error: 'forbidden',
      },
    })
  })

  it('rejects an old object incarnation token after eviction', async () => {
    database = new SqliteD1Database()
    const held = new Map<string, unknown>()
    const state = objectState(held)
    const env = { DB: database } as unknown as Env
    const first = new StatusReadModelObject(state, env)

    const oldToken = first.resolveCurrentTileOffers(8, 'public', []).coverageToken ?? ''

    const recovered = new StatusReadModelObject(state, env)
    await recovered.applyCommittedTileGeneration(8, {
      tile: { x: 1, y: 2 },
      hash: 'a'.repeat(64),
      observedAt: millis(1_000),
      commitOrder: 1,
      coverageToken: oldToken,
      visibleToPublic: true,
      visibleToAdmin: true,
    })

    expect(
      recovered.resolveCurrentTileOffers(8, 'public', [
        { deliveryId: 'one', tile: { x: 1, y: 2 }, hash: 'a'.repeat(64) },
      ]),
    ).toMatchObject({ acknowledgedDeliveryIds: [], cacheOutcome: 'miss' })
  })

  it('chunks a valid projection larger than the per-value storage limit and reconstructs it', async () => {
    const statuses = Array.from({ length: 18_000 }, (_, index) => ({
      templateId: `01890f3e-7b2c-7abc-8def-${String(index).padStart(12, '0')}`,
      correct: index,
      wrong: 0,
      blank: 1,
      total: index + 1,
      colours: [{ index: 0, correct: index, wrong: 0, blank: 1, total: index + 1 }],
      observedAt: millis(1_750_000_000_000),
    }))
    expect(new TextEncoder().encode(JSON.stringify(statuses)).byteLength).toBeGreaterThan(
      2 * 1024 * 1024,
    )
    const held = new Map<string, unknown>()
    const state = objectState(held, 2 * 1024 * 1024)
    const persistence = createChunkedStatusPersistence(state.storage, 4)

    await persistence.save({
      season: 4,
      revision: 1,
      reconciledAt: 1_750_000_000_000,
      publicTemplates: statuses,
      adminTemplates: statuses,
    })
    expect([...held.keys()].filter((key) => key.includes(':public:')).length).toBeGreaterThan(1)

    const recovered = createChunkedStatusPersistence(state.storage, 4)
    await expect(recovered.load()).resolves.toMatchObject({
      season: 4,
      revision: 1,
      publicTemplates: statuses,
      adminTemplates: statuses,
    })
  })

  it('chunks a large manifest projection and preserves its revision when a chunk needs repair', async () => {
    const manifest: Manifest = {
      version: 'a'.repeat(64),
      season: 4,
      server: {
        id: '01890f3a-6b7c-7def-8123-456789abcdef',
        name: 'Server',
        auth: 'none',
      },
      nodes: Array.from({ length: 12_000 }, (_, index) => ({
        id: `node-${index}`,
        parentId: null,
        path: `/node-${index}`,
        name: `Node ${index} ${'x'.repeat(180)}`,
        createdAt: millis(1_750_000_000_000),
      })),
      templates: [],
      tiles: [],
    }
    expect(new TextEncoder().encode(JSON.stringify(manifest)).byteLength).toBeGreaterThan(
      2 * 1024 * 1024,
    )
    const held = new Map<string, unknown>()
    const state = objectState(held, 2 * 1024 * 1024)
    const persistence = createChunkedManifestPersistence(state.storage, 4)

    await persistence.save({
      season: 4,
      revision: 7,
      entries: [
        {
          key: 'public:world',
          configuredServer: '{}',
          cachedAt: 1_750_000_000_000,
          expiresAt: 1_750_000_180_000,
          serializedBytes: serializedBytes(manifest),
          manifest,
        },
      ],
    })
    const chunks = [...held.keys()].filter((key) => key.startsWith('manifest-read-model:v1:chunk:'))
    expect(chunks.length).toBeGreaterThan(1)
    await expect(createChunkedManifestPersistence(state.storage, 4).load()).resolves.toMatchObject({
      season: 4,
      revision: 7,
      entries: [{ manifest }],
    })

    await state.storage.delete(chunks[0] as string)
    const broken = createChunkedManifestPersistence(state.storage, 4)
    await expect(broken.load()).resolves.toEqual({
      season: 4,
      revision: 7,
      entries: [],
    })
    const input = {
      server: manifest.server,
      season: 4,
      surface: { kind: 'world' as const, allianceId: null },
      scope: 'public' as const,
      ifNoneMatch: [] as string[],
    }
    const source = vi.fn(async () => manifest)
    const repair = createSeasonManifestReadModel({ season: 4, source, persistence: broken })
    const put = state.storage.put.bind(state.storage)
    let failPublication = true
    state.storage.put = vi.fn(async (key, value) => {
      if (failPublication && key === 'manifest-read-model:v1:index') {
        failPublication = false
        throw new Error('index publication failed')
      }
      await put(key, value)
    })
    await expect(repair.read(input)).rejects.toThrow('index publication failed')
    state.storage.put = put
    await repair.read(input)
    expect(source).toHaveBeenCalledTimes(2)

    const recoveredPersistence = createChunkedManifestPersistence(state.storage, 4)
    await expect(recoveredPersistence.load()).resolves.toMatchObject({
      season: 4,
      revision: 7,
      entries: [{ manifest }],
    })
    const recoveredSource = vi.fn(async () => manifest)
    const recovered = createSeasonManifestReadModel({
      season: 4,
      source: recoveredSource,
      persistence: recoveredPersistence,
    })
    await expect(recovered.read(input)).resolves.toMatchObject({ cacheOutcome: 'hit' })
    expect(recoveredSource).not.toHaveBeenCalled()
  })

  it('keeps the previously published manifest cache when a replacement chunk write fails', async () => {
    const held = new Map<string, unknown>()
    const state = objectState(held)
    const persistence = createChunkedManifestPersistence(state.storage, 6)
    const first: Manifest = {
      version: 'a'.repeat(64),
      season: 6,
      server: {
        id: '01890f3a-6b7c-7def-8123-456789abcdef',
        name: 'Server',
        auth: 'none',
      },
      nodes: [],
      templates: [],
      tiles: [],
    }
    const entry = {
      key: 'public:world',
      configuredServer: '{}',
      cachedAt: 1_750_000_000_000,
      expiresAt: 1_750_000_180_000,
      serializedBytes: serializedBytes(first),
      manifest: first,
    }
    await persistence.save({ season: 6, revision: 3, entries: [entry] })
    const transaction = state.storage.transaction.bind(state.storage)
    state.storage.transaction = vi.fn(async () => Promise.reject(new Error('storage failed')))

    await expect(
      persistence.save({
        season: 6,
        revision: 4,
        entries: [
          {
            ...entry,
            cachedAt: entry.cachedAt + 1,
            manifest: { ...first, version: 'b'.repeat(64) },
          },
        ],
      }),
    ).rejects.toThrow('storage failed')
    state.storage.transaction = transaction

    await expect(createChunkedManifestPersistence(state.storage, 6).load()).resolves.toMatchObject({
      revision: 3,
      entries: [{ manifest: { version: 'a'.repeat(64) } }],
    })
  })

  it('publishes a replacement manifest even when retired-chunk cleanup must retry', async () => {
    const held = new Map<string, unknown>()
    const state = objectState(held)
    const persistence = createChunkedManifestPersistence(state.storage, 6)
    const first: Manifest = {
      version: 'a'.repeat(64),
      season: 6,
      server: {
        id: '01890f3a-6b7c-7def-8123-456789abcdef',
        name: 'Server',
        auth: 'none',
      },
      nodes: [],
      templates: [],
      tiles: [],
    }
    const entry = {
      key: 'public:world',
      configuredServer: '{}',
      cachedAt: 1_750_000_000_000,
      expiresAt: 1_750_000_180_000,
      serializedBytes: serializedBytes(first),
      manifest: first,
    }
    await persistence.save({ season: 6, revision: 3, entries: [entry] })
    const remove = state.storage.delete.bind(state.storage)
    state.storage.delete = vi.fn(async () => Promise.reject(new Error('cleanup failed')))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(
      persistence.save({
        season: 6,
        revision: 4,
        entries: [
          {
            ...entry,
            cachedAt: entry.cachedAt + 1,
            manifest: { ...first, version: 'b'.repeat(64) },
          },
        ],
      }),
    ).resolves.toBeUndefined()
    state.storage.delete = remove

    await expect(createChunkedManifestPersistence(state.storage, 6).load()).resolves.toMatchObject({
      revision: 4,
      entries: [{ manifest: { version: 'b'.repeat(64) } }],
    })
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'cleanup failed' }),
    )
  })

  it('never reactivates a retired generation after eviction cleanup fails', async () => {
    const held = new Map<string, unknown>()
    const state = objectState(held)
    const persistence = createChunkedManifestPersistence(state.storage, 6)
    const manifest: Manifest = {
      version: 'a'.repeat(64),
      season: 6,
      server: {
        id: '01890f3a-6b7c-7def-8123-456789abcdef',
        name: 'Server',
        auth: 'none',
      },
      nodes: [],
      templates: [],
      tiles: [],
    }
    const entry = {
      key: 'public:world',
      configuredServer: '{}',
      cachedAt: 1_750_000_000_000,
      expiresAt: 1_750_000_180_000,
      serializedBytes: serializedBytes(manifest),
      manifest,
    }
    await persistence.save({ season: 6, revision: 3, entries: [entry] })
    const remove = state.storage.delete.bind(state.storage)
    state.storage.delete = vi.fn(async () => Promise.reject(new Error('cleanup failed')))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(persistence.save({ season: 6, revision: 3, entries: [] })).resolves.toBeUndefined()
    state.storage.delete = remove
    await persistence.save({ season: 6, revision: 3, entries: [entry] })

    const recovered = createChunkedManifestPersistence(state.storage, 6)
    await expect(recovered.load()).resolves.toMatchObject({
      revision: 3,
      entries: [{ manifest: { version: 'a'.repeat(64) } }],
    })
    consoleError.mockRestore()
  })

  it('keeps the previously published manifest reconstructible when a chunk transaction fails', async () => {
    const held = new Map<string, unknown>()
    const state = objectState(held)
    const first = createChunkedStatusPersistence(state.storage, 5)
    const initial = {
      season: 5,
      revision: 1,
      reconciledAt: 1_750_000_000_000,
      publicTemplates: [],
      adminTemplates: [],
    }
    await first.save(initial)
    await first.load()
    const transaction = state.storage.transaction.bind(state.storage)
    state.storage.transaction = vi.fn(async () => Promise.reject(new Error('storage failed')))

    await expect(
      first.save({ ...initial, revision: 2, reconciledAt: initial.reconciledAt + 1 }),
    ).rejects.toThrow('storage failed')
    state.storage.transaction = transaction

    const recovered = createChunkedStatusPersistence(state.storage, 5)
    await expect(recovered.load()).resolves.toMatchObject({ revision: 1 })
  })

  it('rejects an invalid season before touching authoritative storage', async () => {
    database = new SqliteD1Database()
    const state = objectState(new Map())
    const get = vi.spyOn(state.storage, 'get')
    const object = new StatusReadModelObject(state, { DB: database } as unknown as Env)

    expect(() => object.reconcileSnapshot(-1, 'public')).toThrow('non-negative')
    expect(get).not.toHaveBeenCalled()
  })

  it('reconstructs hibernating subscriber scope from serialized socket attachments', async () => {
    database = new SqliteD1Database()
    const held = new Map<string, unknown>()
    const socket = (attachment: unknown) => {
      let heldAttachment = attachment
      return {
        deserializeAttachment: () => heldAttachment,
        serializeAttachment: (next: unknown) => {
          heldAttachment = next
        },
        send: vi.fn(),
        close: vi.fn(),
      } as unknown as WebSocket
    }
    const publicSocket = socket({
      season: 8,
      scope: 'public',
      tokenHash: 'a'.repeat(64),
      revocable: true,
      lastRevision: 2,
    })
    const adminSocket = socket({
      season: 8,
      scope: 'admin',
      tokenHash: 'b'.repeat(64),
      revocable: true,
      lastRevision: 2,
    })
    const otherSeason = socket({
      season: 9,
      scope: 'public',
      tokenHash: 'a'.repeat(64),
      revocable: true,
      lastRevision: 2,
    })
    const missingAttachment = socket(undefined)
    const state = objectState(held, Number.POSITIVE_INFINITY, [
      publicSocket,
      adminSocket,
      otherSeason,
      missingAttachment,
    ])

    const initial = new StatusReadModelObject(state, { DB: database } as unknown as Env)
    await initial.reconcileSnapshot(8, 'public')
    const recovered = new StatusReadModelObject(state, { DB: database } as unknown as Env)
    await recovered.applyCommittedChange(8, {
      baseRevision: 1,
      revision: 2,
      changes: [
        {
          templateId: '01890f3e-7b2c-7abc-8def-000000000008',
          published: true,
          total: 1,
          previous: null,
          current: { correct: 1, wrong: 0, blank: 0, observedAt: millis(1_750_000_000_000) },
        },
      ],
    })
    await recovered.notifyManifestChange(8)
    await recovered.notifyAlarmChange(8)
    await recovered.closeCredential(8, 'b'.repeat(64))

    for (const subscriber of [publicSocket, adminSocket]) {
      expect(subscriber.send).toHaveBeenCalledWith(expect.stringContaining('"type":"status-delta"'))
      expect(subscriber.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'manifest-reconcile', revision: 2 }),
      )
      expect(subscriber.send).toHaveBeenCalledWith(JSON.stringify({ type: 'alarms-reconcile' }))
    }
    expect(otherSeason.send).not.toHaveBeenCalled()
    expect(missingAttachment.send).not.toHaveBeenCalled()
    expect(adminSocket.close).toHaveBeenCalledWith(1008, 'credential revoked')
    expect(publicSocket.close).not.toHaveBeenCalled()

    vi.mocked(publicSocket.send).mockClear()
    vi.mocked(adminSocket.send).mockClear()
    await recovered.notifyAlarmChange(8)
    expect(publicSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'alarms-reconcile' }))
    expect(adminSocket.send).not.toHaveBeenCalled()
    recovered.webSocketMessage(adminSocket, 'ping')
    expect(adminSocket.send).not.toHaveBeenCalled()
  })

  it('rejects missing internal routing headers before creating a socket pair', async () => {
    database = new SqliteD1Database()
    const object = new StatusReadModelObject(objectState(new Map()), {
      DB: database,
    } as unknown as Env)
    const response = await object.fetch(
      new Request('https://object.test/', { headers: { upgrade: 'websocket' } }),
    )

    expect(response.status).toBe(400)
    await expect(response.text()).resolves.toBe('Invalid season')

    const missingIdentity = await object.fetch(
      new Request('https://object.test/', {
        headers: {
          upgrade: 'websocket',
          'x-caelestis-season': '8',
          'x-caelestis-scope': 'public',
        },
      }),
    )
    expect(missingIdentity.status).toBe(400)
    await expect(missingIdentity.text()).resolves.toBe('Invalid credential identity')
  })

  it('serializes an in-flight attachment ahead of revocation cleanup', async () => {
    const fence = createLiveSessionFence()
    let release!: (active: boolean) => void
    let attached = false
    const close = vi.fn()
    const attaching = fence.attach(
      async () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
      () => {
        attached = true
        return 'attached'
      },
    )
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const revoking = fence.revoke(() => {
      if (attached) close()
    })

    release(true)
    await expect(attaching).resolves.toBe('attached')
    await expect(revoking).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects attachment after revocation and propagates cleanup failure', async () => {
    const fence = createLiveSessionFence()
    await expect(fence.revoke(() => Promise.reject(new Error('close failed')))).rejects.toThrow(
      'close failed',
    )
    const attach = vi.fn(() => 'attached')

    await expect(fence.attach(async () => false, attach)).resolves.toBeNull()
    expect(attach).not.toHaveBeenCalled()
  })
})
