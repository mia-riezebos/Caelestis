import { PRESENCE_PROTOCOL_V1 } from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { SqliteD1Database } from './adapters/cloudflare/sqlite-d1.test-helper.js'
import type { ManifestProjectionInput } from './manifest/read-model.js'
import { DirectStatusReadModel } from './status-read-model/port.js'
import worker from './worker.js'

// `worker.ts` re-exports the Durable Object, whose module imports `cloudflare:workers` — absent
// outside workerd. Same stub `telemetry-shard.test.ts` uses; nothing on these paths constructs one.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}))

/**
 * The Worker entry point is the only place the runtime bindings are wired to the app, and nothing
 * else exercised it: every other auth test builds the app directly through `createApp`. Dropping
 * `bootstrapAdminToken: env.ADMIN_TOKEN` therefore left the whole suite green while a fresh
 * deployment — which by definition has no stored admin token yet — could not mint its first one.
 *
 * Only `DB` is a real fake. `BLOBS` and `TELEMETRY` are never called on this path, so stubs keep the
 * test about the wiring rather than about R2 or a Durable Object.
 */
const BOOTSTRAP = 'bootstrap-secret'

it('routes presence to the named surface room with authenticated internal headers', async () => {
  const environment = env()
  const fetchPresence = vi.fn(async (_request: Request) => new Response('connected'))
  const getByName = vi.fn(() => ({ fetch: fetchPresence }))
  const configured = { ...environment, PRESENCE: { getByName }, SEASON: '0' } as unknown as Env
  const response = await worker.fetch(
    new Request(
      'https://example.com/telemetry/presence?season=0&surface=alliance-picture&allianceId=7&painterId=42&painterName=Mia%20%F0%9F%8E%A8&client=userscript&clientVersion=0.5.4',
      {
        headers: {
          upgrade: 'websocket',
          'sec-websocket-protocol': `${PRESENCE_PROTOCOL_V1}, caelestis.auth.b64.${btoa(BOOTSTRAP).replace(/=+$/, '')}`,
          'x-caelestis-painter-id': '999',
        },
      },
    ),
    configured,
  )
  expect(response.status).toBe(200)
  expect(getByName).toHaveBeenCalledWith('0:alliance-picture:7')
  const request = fetchPresence.mock.calls[0]?.[0] as Request | undefined
  expect(request).toBeDefined()
  expect(Object.fromEntries(request?.headers ?? [])).toMatchObject({
    'x-caelestis-season': '0',
    'x-caelestis-surface-kind': 'alliance-picture',
    'x-caelestis-alliance-id': '7',
    'x-caelestis-painter-id': '42',
    'x-caelestis-painter-name': encodeURIComponent('Mia 🎨'),
    'x-caelestis-credential-scope': 'admin',
    'x-caelestis-anonymous': '0',
    'x-caelestis-revocable': '0',
    'x-caelestis-token-hash': expect.stringMatching(/^[a-f0-9]{64}$/),
    'x-caelestis-client-hash': expect.stringMatching(/^[a-f0-9]{64}$/),
    'x-caelestis-metric-client': 'userscript',
    'x-caelestis-metric-client-version': '0.5.4',
  })
})

it.each([
  ['surface=world', '0:world'],
  ['surface=alliance-picture&allianceId=7', '0:alliance-picture:7'],
])('reads the presence headcount through one room RPC for %s', async (query, room) => {
  const environment = env()
  const online = vi.fn(async () => 5)
  const getByName = vi.fn(() => ({ online }))
  const configured = {
    ...environment,
    PRESENCE: { getByName },
    SEASON: '0',
    OPEN_ACCESS: 'true',
  } as unknown as Env
  const prepare = vi.spyOn(environment.DB, 'prepare')
  const response = await worker.fetch(
    new Request(`https://example.com/telemetry/presence/online?season=0&${query}`),
    configured,
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ online: 5 })
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(getByName).toHaveBeenCalledExactlyOnceWith(room)
  expect(online).toHaveBeenCalledExactlyOnceWith()
  expect(prepare).not.toHaveBeenCalled()
})

let d1: SqliteD1Database | null = null

afterEach(() => {
  vi.restoreAllMocks()
  d1?.close()
  d1 = null
})

const env = () => {
  d1 = new SqliteD1Database()
  const statusReadModel = new DirectStatusReadModel(new D1SqlStore(d1 as unknown as D1Database))
  return {
    SHARD_STRATEGY: 'single',
    DB: d1,
    BLOBS: {},
    // `DurableObjectCounterStore` resolves its stub in the constructor, so the namespace has to
    // answer `getByName` even on a path that never calls the shard.
    TELEMETRY: { getByName: () => ({}) },
    STATUS_READ_MODEL: {
      getByName: () => ({
        readManifestProjectionMeasured: async (input: ManifestProjectionInput) => ({
          success: true as const,
          value: await statusReadModel.readManifestProjection?.(input),
          usage: { rowsRead: 0, rowsWritten: 0, measuredQueries: 0, unmeasuredQueries: 0 },
        }),
      }),
    },
    ALARM_WATCHER: { getByName: () => ({ schedule: async () => undefined }) },
    ADMIN_TOKEN: BOOTSTRAP,
  } as unknown as Env
}

const mint = (authorization: string) =>
  worker.fetch(
    new Request('https://example.com/admin/tokens', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'first-admin', scope: 'admin' }),
    }),
    env(),
  )

it('mints the first admin token with the configured ADMIN_TOKEN binding', async () => {
  const response = await mint(`Bearer ${BOOTSTRAP}`)

  expect(response.status).toBe(201)
  await expect(response.json()).resolves.toMatchObject({ label: 'first-admin', scope: 'admin' })
})

it('refuses a credential that is not the configured ADMIN_TOKEN', async () => {
  // The binding has to be compared, not merely forwarded: a wiring that passed any truthy value
  // would satisfy the test above on its own.
  expect((await mint('Bearer ABCDEFGHJKMNPQRSTVWXYZ2345')).status).toBe(401)
})

it('refuses an unsupported shard strategy rather than serving on it', async () => {
  await expect(
    worker.fetch(new Request('https://example.com/health'), {
      ...env(),
      SHARD_STRATEGY: 'sharded',
    } as unknown as Env),
  ).rejects.toThrow(/Unsupported telemetry shard strategy/)
})

it.each([['abc'], ['-1'], ['1.5'], ['']])(
  'refuses SEASON=%o rather than serving an unusable season',
  async (season) => {
    // Number('abc') is NaN and NaN serializes to null, which the wire refuses — so a typo in a
    // config var made the deployment's own manifest undecodable, with the operator finding out from
    // a client. Refused where the operator can read it instead.
    await expect(
      worker.fetch(new Request('https://example.com/health'), {
        ...env(),
        SEASON: season,
      } as unknown as Env),
    ).rejects.toThrow(/SEASON is not a season number/)
  },
)

it('forwards the configured identity, season and open access to the app', async () => {
  // Every positive assertion about these options was made against `createApp` directly, so the
  // forwarding itself was pinned only by its refusals. Dropping `serverDescription`, coercing a
  // validated season back to 1, or forwarding `openAccess: false` unconditionally all left the
  // suite green while making a configured deployment advertise defaults, serve the wrong season's
  // manifest, or demand a token it was told not to.
  const configured = {
    ...env(),
    SERVER_ID: '01890f3a-6b7c-7def-8123-456789abcdef',
    SERVER_NAME: 'Second Season Server',
    SERVER_DESCRIPTION: 'Configured, not defaulted',
    SEASON: '0',
    OPEN_ACCESS: 'true',
  } as unknown as Env

  const server = await worker.fetch(new Request('https://example.com/server'), configured)
  // No credential: open access has to be what answers this, not the bootstrap token.
  const manifest = await worker.fetch(new Request('https://example.com/manifest'), configured)

  await expect(server.json()).resolves.toEqual({
    id: '01890f3a-6b7c-7def-8123-456789abcdef',
    name: 'Second Season Server',
    description: 'Configured, not defaulted',
    auth: 'none',
    liveSync: 1,
    liveSyncMax: 2,
    liveTileOffers: 1,
    presence: 1,
  })
  expect(manifest.status).toBe(200)
  await expect(manifest.json()).resolves.toMatchObject({
    season: 0,
    server: { liveSync: 1, liveSyncMax: 2, liveTileOffers: 1 },
  })
})

it.each(['example.com', 'caelestis.mia.cx', 'caelest.is'])(
  'mounts the runtime app beneath its configured base path on %s',
  async (host) => {
    const configured = {
      ...env(),
      BASE_PATH: '/backend',
      ROOT_HOST: 'backend.caelest.is',
    } as unknown as Env

    const mounted = await worker.fetch(new Request(`https://${host}/backend/health`), configured)
    const versioned = await worker.fetch(
      new Request(`https://${host}/backend/v1/server`),
      configured,
    )
    const outside = await worker.fetch(new Request(`https://${host}/health`), configured)

    expect(mounted.status).toBe(200)
    await expect(mounted.json()).resolves.toEqual({ ok: true })
    expect(versioned.status).toBe(200)
    expect(outside.status).toBe(404)
  },
)

it.each(['', '/backend'])('serves the dedicated backend hostname at %s', async (prefix) => {
  const configured = {
    ...env(),
    BASE_PATH: '/backend',
    ROOT_HOST: 'backend.caelest.is',
  } as unknown as Env
  const health = await worker.fetch(
    new Request(`https://backend.caelest.is${prefix}/health`),
    configured,
  )
  const server = await worker.fetch(
    new Request(`https://backend.caelest.is${prefix}/v1/server`),
    configured,
  )
  const protectedRead = await worker.fetch(
    new Request(`https://backend.caelest.is${prefix}/v1/manifest`),
    configured,
  )

  await expect(health.json()).resolves.toEqual({ ok: true })
  expect(server.status).toBe(200)
  expect(protectedRead.status).toBe(401)
})

it('reuses one prepared app and Effect runtime for the same Worker environment', async () => {
  const getByName = vi.fn(() => ({}))
  const configured = {
    ...env(),
    TELEMETRY: { getByName },
  } as unknown as Env

  expect((await worker.fetch(new Request('https://example.com/health'), configured)).status).toBe(
    200,
  )
  expect((await worker.fetch(new Request('https://example.com/server'), configured)).status).toBe(
    200,
  )

  expect(getByName).toHaveBeenCalledTimes(1)
})

it('runs scheduled tile blob GC in configured dry-run mode without R2 deletion', async () => {
  const hash = 'b'.repeat(64)
  const list = vi.fn(async () => ({
    objects: [{ key: `tiles/${hash}` }],
    truncated: false,
  }))
  const remove = vi.fn(async () => undefined)
  const backgrounds: Promise<unknown>[] = []
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const configured = {
    ...env(),
    TILE_BLOB_GC_MODE: 'dry-run',
    BLOBS: { list, delete: remove },
  } as unknown as Env

  await worker.scheduled({} as ScheduledController, configured, {
    waitUntil: (promise: Promise<unknown>) => {
      backgrounds.push(promise)
    },
  } as ExecutionContext)
  await Promise.all(backgrounds)

  expect(list).toHaveBeenCalledWith({ prefix: 'tiles/', limit: 10 })
  expect(remove).not.toHaveBeenCalled()
  expect(
    d1?.sqlite.prepare('SELECT state FROM tile_blob_objects WHERE blob_key = ?').get(hash),
  ).toEqual({ state: 'candidate' })
  expect(log).toHaveBeenCalledWith(expect.stringContaining('"mode":"dry-run"'))
  log.mockRestore()
})

it('refuses an unsupported scheduled tile blob GC mode', async () => {
  await expect(
    worker.scheduled(
      {} as ScheduledController,
      { ...env(), TILE_BLOB_GC_MODE: 'unsafe' } as unknown as Env,
      { waitUntil: () => undefined } as unknown as ExecutionContext,
    ),
  ).rejects.toThrow(/Unsupported TILE_BLOB_GC_MODE/)
})
