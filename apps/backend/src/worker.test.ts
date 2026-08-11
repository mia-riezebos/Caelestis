import { afterEach, expect, it, vi } from 'vitest'
import { SqliteD1Database } from './adapters/cloudflare/sqlite-d1.test-helper.js'
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

let d1: SqliteD1Database | null = null

afterEach(() => {
  d1?.close()
  d1 = null
})

const env = () => {
  d1 = new SqliteD1Database()
  return {
    SHARD_STRATEGY: 'single',
    DB: d1,
    BLOBS: {},
    // `DurableObjectCounterStore` resolves its stub in the constructor, so the namespace has to
    // answer `getByName` even on a path that never calls the shard.
    TELEMETRY: { getByName: () => ({}) },
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
  })
  expect(manifest.status).toBe(200)
  await expect(manifest.json()).resolves.toMatchObject({ season: 0 })
})
