import { millis } from '@wts/shared'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import type { AccessToken, Ports } from '../ports/index.js'
import { hashToken, mintToken, SCOPES, type Scope, satisfiesScope, TOKEN_LENGTH } from './tokens.js'

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

  // Raw header values, not `bearer(...)`: the scheme cases are about what the parser accepts, and
  // wrapping them would have re-tested the token instead. The non-bearer row used to pass
  // `undefined`, which sent no header at all and silently duplicated the first row, leaving the
  // scheme check unpinned — dropping it accepts `Basic <ADMIN_TOKEN>`.
  it.each([
    ['no authorization header', undefined],
    ['a token that does not exist', 'Bearer ABCDEFGHJKMNPQRSTVWXYZ2345'],
    ['a non-bearer scheme', `Basic ${BOOTSTRAP}`],
    ['a bare token with no scheme', BOOTSTRAP],
    ['a scheme with no token', 'Bearer'],
  ])('refuses to mint with %s', async (_label, authorization) => {
    const { app } = harness()
    const response = await app.request('/admin/tokens', {
      method: 'POST',
      body: JSON.stringify({ label: 'x', scope: 'read' }),
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    })
    expect(response.status).toBe(401)
  })

  it('hashes the whole token, not a prefix of it', async () => {
    // A known SHA-256 vector over a non-empty input. The empty-string vector alone left
    // `encode(token)` mutable to `encode(token.slice(0, 8))` — mint and read share the hash, so
    // every test still passed while any two tokens agreeing in their first eight base32 characters
    // authenticated as each other. That is ~40 bits, not 128.
    await expect(hashToken('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    // The vector alone is not enough — it is shorter than any prefix a truncation would keep. Two
    // full-length tokens agreeing in their first eight characters have to hash differently.
    const [left, right] = await Promise.all([
      hashToken(`ABCDEFGH${'J'.repeat(TOKEN_LENGTH - 8)}`),
      hashToken(`ABCDEFGH${'K'.repeat(TOKEN_LENGTH - 8)}`),
    ])
    expect(left).not.toBe(right)
  })

  // A view over the array the caller passed, not a copy of it: `new Uint8Array(typedArray)` clones,
  // so filling that writes nothing back and the stub silently returns untouched entropy.
  const withRandomBytes = <T>(fill: (bytes: Uint8Array) => void, run: () => T): T => {
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(((
      array: ArrayBufferView,
    ) => {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
      bytes.fill(0)
      fill(bytes)
      return array
    }) as typeof crypto.getRandomValues)
    try {
      return run()
    } finally {
      spy.mockRestore()
    }
  }

  it('takes its bytes from the CSPRNG', () => {
    // Swapping crypto.getRandomValues for Math.random passed the uniqueness, length and alphabet
    // tests: none of them can tell a cryptographic source from a predictable one. Assert the source
    // itself, and that the bytes it hands back are the bytes encoded — all-zero encodes to the
    // alphabet's first character, once per position.
    let calls = 0
    const token = withRandomBytes(
      () => {
        calls += 1
      },
      () => mintToken(),
    )
    expect([token, calls]).toEqual(['A'.repeat(TOKEN_LENGTH), 1])
  })

  it('carries the last three bits in the final character', () => {
    // 128 bits is 25 characters of 5 bits plus 3 left over. Emitting a constant tail keeps the
    // length, the alphabet and 500-token uniqueness intact while dropping every token to 125 bits,
    // so inputs differing only in those 3 bits have to differ in the last character.
    const mintFrom = (lastByte: number) =>
      withRandomBytes(
        (bytes) => {
          bytes[bytes.length - 1] = lastByte
        },
        () => mintToken(),
      )
    expect(new Set([mintFrom(0), mintFrom(1), mintFrom(2)]).size).toBe(3)
  })

  it.each([['read'], ['report']])(
    'refuses a %s holder every method of the admin surface',
    async (scope) => {
      // A report holder that could mint itself admin would make the ladder decorative — and this
      // test did not check that, because `app.request` with no `method` sends GET. The mint it was
      // named for went untested, and so did the revoke: scoping the guard to `routes.use('/')`
      // left DELETE open, a read token could revoke an admin credential, and the suite stayed
      // green. Every method the surface exposes, or the guard is only pinned where it happens to
      // be exercised.
      const { app } = harness()
      const victim = await mint(app, 'victim-admin', 'admin')
      const holder = await mint(app, scope, scope)
      const auth = bearer(holder.body.token as string)

      const listed = await app.request('/admin/tokens', auth)
      const minted = await app.request('/admin/tokens', {
        method: 'POST',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'escalated', scope: 'admin' }),
      })
      const revoked = await app.request(`/admin/tokens/${victim.body.tokenHash}`, {
        method: 'DELETE',
        ...auth,
      })

      expect([listed.status, minted.status, revoked.status]).toEqual([403, 403, 403])
    },
  )

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

  it('answers a repeated revoke the same way, because absence is the outcome', async () => {
    // 204 both times. Absence *is* revocation, so a caller that finds the token already gone has
    // what it asked for — 404 on a retry after a lost response reported failure for a request that
    // had succeeded. It also stops the status distinguishing "already revoked" from "no such hash",
    // which was an existence oracle, admin-gated but free to close.
    const { app, sql } = harness()
    const holder = await mint(app, 'leaked', 'read')
    const url = `/admin/tokens/${holder.body.tokenHash}`

    expect((await app.request(url, { method: 'DELETE', ...bearer(BOOTSTRAP) })).status).toBe(204)
    expect((await app.request(url, { method: 'DELETE', ...bearer(BOOTSTRAP) })).status).toBe(204)
    await expect(sql.readAccessToken(holder.body.tokenHash as string)).resolves.toBeNull()
  })

  it('answers an unknown token hash the same as a revoked one', async () => {
    // Deliberately not a 404: the response must not tell an admin whether a hash it does not hold
    // exists, and there is nothing for the caller to do differently either way.
    const { app } = harness()
    const response = await app.request(`/admin/tokens/${'f'.repeat(64)}`, {
      method: 'DELETE',
      ...bearer(BOOTSTRAP),
    })
    expect(response.status).toBe(204)
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
    }
    await sql.insertAccessToken(token)

    await expect(sql.insertAccessToken({ ...token, label: 'second' })).rejects.toThrow()
    await expect(sql.readAccessToken(token.tokenHash)).resolves.toMatchObject({ label: 'first' })
  })

  it('refuses a scope D1 would refuse', async () => {
    // access_tokens_scope_check rejects anything off the ladder and the memory store accepted it,
    // so the oracle the differential tests measure against was wider than production. Same defect
    // assertValidBuckets closes on the sibling column.
    await expect(
      new MemorySqlStore().insertAccessToken({
        tokenHash: 'e'.repeat(64),
        label: 'x',
        scope: 'superadmin' as Scope,
        createdBy: 'bootstrap',
        createdAt: millis(1_000),
      }),
    ).rejects.toThrow(/unknown scope/)
  })

  it('orders tokens minted in the same millisecond deterministically', async () => {
    // createdAt alone is not a total order: Date.now() has millisecond resolution and scripted
    // provisioning mints a read and a report token in one tick. Memory then fell back to Map
    // insertion order and SQL leaves equal keys unspecified, so the two adapters could disagree.
    const sql = new MemorySqlStore()
    for (const hash of ['c', 'a', 'b']) {
      await sql.insertAccessToken({
        tokenHash: hash.repeat(64),
        label: hash,
        scope: 'read',
        createdBy: 'bootstrap',
        createdAt: millis(1_000),
      })
    }
    await expect(sql.listAccessTokens()).resolves.toMatchObject([
      { label: 'a' },
      { label: 'b' },
      { label: 'c' },
    ])
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
      })
    }
    await expect(sql.listAccessTokens()).resolves.toMatchObject([
      { label: '3000' },
      { label: '2000' },
      { label: '1000' },
    ])
  })
})
