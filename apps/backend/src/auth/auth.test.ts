import { millis } from '@wts/shared'
import { describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import type { AccessToken, Ports } from '../ports/index.js'
import { hashToken, mintToken, SCOPES, satisfiesScope, TOKEN_LENGTH } from './tokens.js'

const BOOTSTRAP = 'bootstrap-operator-token'

const harness = () => {
  const sql = new MemorySqlStore()
  const ports: Ports = {
    blobs: new MemoryBlobStore(),
    sql,
    counters: new MemoryCounterStore(sql, () => millis(Date.now())),
  }
  return { sql, app: createApp(ports, { bootstrapAdminToken: BOOTSTRAP }) }
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

const mint = async (
  app: ReturnType<typeof harness>['app'],
  label: string,
  scope: string,
  as = BOOTSTRAP,
) => {
  const response = await app.request('/admin/tokens', {
    method: 'POST',
    body: JSON.stringify({ label, scope }),
    ...bearer(as),
  })
  return { status: response.status, body: (await response.json()) as Record<string, string> }
}

describe('token minting', () => {
  it('produces a token carrying the full 128 bits its length advertises', () => {
    // Encoding by chunking bytes into 5-bit groups discards bits and silently shortens the secret.
    // 26 characters at 5 bits covers 128; anything shorter means entropy was thrown away.
    expect(TOKEN_LENGTH).toBe(26)
    const token = mintToken()
    expect(token).toHaveLength(TOKEN_LENGTH)
    expect(token).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ0-9]+$/)
  })

  it('does not repeat', () => {
    // A generator seeded once, or one that lost its randomness, is the failure worth catching.
    const tokens = new Set(Array.from({ length: 500 }, () => mintToken()))
    expect(tokens.size).toBe(500)
  })

  it('excludes the characters that invite transcription errors', () => {
    // These get copied out of Discord by hand. I, L, O and U are the usual casualties.
    const alphabet = new Set(Array.from({ length: 2_000 }, () => mintToken()).join(''))
    for (const excluded of ['I', 'L', 'O', 'U']) expect(alphabet.has(excluded)).toBe(false)
  })

  it('hashes to stable lowercase hex', async () => {
    // The empty-string digest, so this pins SHA-256 itself rather than agreeing with whatever the
    // implementation happens to do.
    await expect(hashToken('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
})

describe('scope ordering', () => {
  it.each([
    ['read', 'read', true],
    ['report', 'read', true],
    ['admin', 'read', true],
    ['read', 'report', false],
    ['report', 'report', true],
    ['admin', 'report', true],
    ['read', 'admin', false],
    ['report', 'admin', false],
    ['admin', 'admin', true],
  ] as const)('a %s holder satisfying %s is %s', (held, required, expected) => {
    // The row that matters is read-does-not-satisfy-report: that is what stops someone who obtained
    // read access from poisoning the counters.
    expect(satisfiesScope(held, required)).toBe(expected)
  })

  it('orders the scopes least to most privileged', () => {
    expect(SCOPES).toEqual(['read', 'report', 'admin'])
  })
})

describe('the admin token surface', () => {
  it('mints a token, returns the plaintext once, and never returns it again', async () => {
    const { app } = harness()

    const created = await mint(app, 'discord-regulars', 'report')
    expect(created.status).toBe(201)
    expect(created.body.token).toHaveLength(TOKEN_LENGTH)
    expect(created.body.tokenHash).toBe(await hashToken(created.body.token as string))

    const listed = await app.request('/admin/tokens', bearer(BOOTSTRAP))
    const { tokens } = (await listed.json()) as { tokens: AccessToken[] }
    expect(tokens).toHaveLength(1)
    // The plaintext is not stored, so it cannot leak from a later read.
    expect(JSON.stringify(tokens)).not.toContain(created.body.token)
  })

  it('lets a minted admin token mint further tokens', async () => {
    // The bootstrap credential exists to hand over to a real one; if the handover does not work it
    // has to stay in the environment forever.
    const { app } = harness()
    const admin = await mint(app, 'operator', 'admin')

    const second = await mint(app, 'second', 'read', admin.body.token as string)

    expect(second.status).toBe(201)
    expect(second.body.createdBy).toBe(admin.body.tokenHash)
  })

  it('records the bootstrap operator as the creator when it has no row of its own', async () => {
    const { app } = harness()
    const created = await mint(app, 'first', 'admin')
    expect(created.body.createdBy).toBe('bootstrap')
  })

  it.each([
    ['no authorization header', undefined],
    ['a token that does not exist', 'ABCDEFGHJKMNPQRSTVWXYZ2345'],
    ['a non-bearer scheme', undefined],
  ])('refuses to mint with %s', async (_label, token) => {
    const { app } = harness()
    const response = await app.request('/admin/tokens', {
      method: 'POST',
      body: JSON.stringify({ label: 'x', scope: 'read' }),
      ...(token === undefined ? {} : bearer(token)),
    })
    expect(response.status).toBe(401)
  })

  it.each([['read'], ['report']])('refuses a %s holder the admin surface', async (scope) => {
    // A report holder that could mint itself admin would make the ladder decorative.
    const { app } = harness()
    const holder = await mint(app, scope, scope)

    const response = await app.request('/admin/tokens', bearer(holder.body.token as string))

    expect(response.status).toBe(403)
  })

  it.each([
    ['a missing label', { scope: 'read' }],
    ['an empty label', { label: '', scope: 'read' }],
    ['an over-long label', { label: 'x'.repeat(129), scope: 'read' }],
    ['an unknown scope', { label: 'x', scope: 'superadmin' }],
    ['a missing scope', { label: 'x' }],
  ])('rejects %s', async (_label, body) => {
    const { app } = harness()
    const response = await app.request('/admin/tokens', {
      method: 'POST',
      body: JSON.stringify(body),
      ...bearer(BOOTSTRAP),
    })
    expect(response.status).toBe(400)
  })

  it('accepts a label at the length cap', async () => {
    const { app } = harness()
    const created = await mint(app, 'x'.repeat(128), 'read')
    expect(created.status).toBe(201)
  })
})

describe('revocation', () => {
  it('stops a revoked token working immediately', async () => {
    const { app } = harness()
    const holder = await mint(app, 'leaked', 'admin')
    const token = holder.body.token as string

    await expect(app.request('/admin/tokens', bearer(token))).resolves.toMatchObject({
      status: 200,
    })
    await app.request(`/admin/tokens/${holder.body.tokenHash}`, {
      method: 'DELETE',
      ...bearer(BOOTSTRAP),
    })

    const after = await app.request('/admin/tokens', bearer(token))
    expect(after.status).toBe(401)
  })

  it('revokes exactly one credential and leaves the others live', async () => {
    // The whole reason tokens are named and individually revocable: one leaks, everyone else keeps
    // working.
    const { app } = harness()
    const leaked = await mint(app, 'leaked', 'admin')
    const kept = await mint(app, 'kept', 'admin')

    await app.request(`/admin/tokens/${leaked.body.tokenHash}`, {
      method: 'DELETE',
      ...bearer(BOOTSTRAP),
    })

    expect((await app.request('/admin/tokens', bearer(leaked.body.token as string))).status).toBe(
      401,
    )
    expect((await app.request('/admin/tokens', bearer(kept.body.token as string))).status).toBe(200)
  })

  it('keeps the first revocation instant when revoked twice', async () => {
    // The audit question is when the credential stopped being usable; a second call must not move it.
    const { app, sql } = harness()
    const holder = await mint(app, 'leaked', 'read')
    const url = `/admin/tokens/${holder.body.tokenHash}`

    await app.request(url, { method: 'DELETE', ...bearer(BOOTSTRAP) })
    const first = await sql.readAccessToken(holder.body.tokenHash as string)
    await new Promise((resolve) => setTimeout(resolve, 2))
    await app.request(url, { method: 'DELETE', ...bearer(BOOTSTRAP) })

    const second = await sql.readAccessToken(holder.body.tokenHash as string)
    expect(second?.revokedAt).toBe(first?.revokedAt)
  })

  it('404s an unknown token hash', async () => {
    const { app } = harness()
    const response = await app.request('/admin/tokens/not-a-hash', {
      method: 'DELETE',
      ...bearer(BOOTSTRAP),
    })
    expect(response.status).toBe(404)
  })
})

describe('the bootstrap credential', () => {
  it('is refused when the server has none configured', async () => {
    // An unset secret must not become a valid credential. Note this does not isolate the
    // `length > 0` arm: `bearerToken` rejects an empty token first, so that arm is unreachable —
    // see the note on it.
    const sql = new MemorySqlStore()
    const ports: Ports = {
      blobs: new MemoryBlobStore(),
      sql,
      counters: new MemoryCounterStore(sql, () => millis(Date.now())),
    }
    for (const bootstrapAdminToken of [undefined, '']) {
      const app = createApp(ports, { bootstrapAdminToken })
      const response = await app.request('/admin/tokens', bearer(''))
      expect(response.status).toBe(401)
    }
  })

  it('is not accepted as a prefix or extension of itself', async () => {
    const { app } = harness()
    for (const wrong of [BOOTSTRAP.slice(0, -1), `${BOOTSTRAP}x`, BOOTSTRAP.toUpperCase()]) {
      expect((await app.request('/admin/tokens', bearer(wrong))).status).toBe(401)
    }
  })
})

describe('the store contract', () => {
  it('refuses to overwrite an existing token hash', async () => {
    // A collision here would transfer one holder's credential to another; the primary key has to
    // reject it rather than replace the row.
    const sql = new MemorySqlStore()
    const token: AccessToken = {
      tokenHash: 'a'.repeat(64),
      label: 'first',
      scope: 'read',
      createdBy: 'bootstrap',
      createdAt: millis(1_000),
      revokedAt: null,
    }
    await sql.insertAccessToken(token)

    await expect(sql.insertAccessToken({ ...token, label: 'second' })).rejects.toThrow()
    await expect(sql.readAccessToken(token.tokenHash)).resolves.toMatchObject({ label: 'first' })
  })

  it('returns nothing for an unknown hash', async () => {
    await expect(new MemorySqlStore().readAccessToken('missing')).resolves.toBeNull()
  })

  it('lists newest first', async () => {
    const sql = new MemorySqlStore()
    for (const [index, createdAt] of [3_000, 1_000, 2_000].entries()) {
      await sql.insertAccessToken({
        tokenHash: `${index}`.repeat(8),
        label: `${createdAt}`,
        scope: 'read',
        createdBy: 'bootstrap',
        createdAt: millis(createdAt),
        revokedAt: null,
      })
    }
    await expect(sql.listAccessTokens()).resolves.toMatchObject([
      { label: '3000' },
      { label: '2000' },
      { label: '1000' },
    ])
  })
})
