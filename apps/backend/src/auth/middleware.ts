import { Effect } from 'effect'
import type { MiddlewareHandler } from 'hono'
import type { AccessToken } from '../ports/index.js'
import {
  AuthenticationConfigService,
  type BackendRuntime,
  SqlStoreService,
} from '../runtime/backend-runtime.js'
import { AuthenticationError, BackendStorageError } from '../runtime/errors.js'
import { hashToken, type Scope, satisfiesScope } from './tokens.js'

/** What a request proved about itself. */
export interface Caller {
  readonly scope: Scope
  /** The stored credential, or null for the bootstrap operator token, which has no row. */
  readonly token: AccessToken | null
  /**
   * The digest of whatever credential authenticated this request, bootstrap included.
   *
   * `token` is null for the operator secret because it has no `access_tokens` row, and callers that
   * record authorship still need something to record. Every author column is a 64-character hex
   * digest by CHECK, so a literal like `'bootstrap'` is not storable — this is.
   */
  readonly tokenHash: string
}

declare module 'hono' {
  interface ContextVariableMap {
    caller: Caller
  }
}

/** Only the `Bearer <token>` form. `Basic` and bare tokens are not accepted. */
const bearerToken = (header: string | undefined): string | null => {
  if (header === undefined) return null
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || rest.length !== 1) return null
  const token = rest[0]
  return token === undefined || token.length === 0 ? null : token
}

/**
 * Constant-time string comparison, for the bootstrap token.
 *
 * The stored tokens are compared by SHA-256 hash, where a timing leak reveals nothing an attacker
 * can use — they would learn a prefix of a hash they cannot invert. The operator token is compared
 * raw, so it gets the real thing.
 */
const equalsConstantTime = (left: string, right: string): boolean => {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  // Length is not secret — it is visible in the request — so returning early on it is fine, and the
  // alternative would compare buffers of different sizes.
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) {
    // biome-ignore lint/style/noNonNullAssertion: index is inside both arrays
    difference |= a[index]! ^ b[index]!
  }
  return difference === 0
}

/**
 * The digest recorded for an anonymous caller on an open server. Not a credential and cannot be one:
 * no token hashes to all zeroes, so it can never collide with a real one, and the author columns
 * still receive something of the right shape.
 */
const OPEN_ACCESS_HASH = '0'.repeat(64)

/**
 * Require at least `required` scope without revealing whether a credential exists or was revoked.
 * The response body is constant per status; 401 versus 403 only tells the caller whether it should
 * authenticate or stop retrying with its current privilege.
 */
const authenticateScope = (
  authorization: string | undefined,
  required: Scope,
): Effect.Effect<
  Caller,
  AuthenticationError | BackendStorageError,
  AuthenticationConfigService | SqlStoreService
> =>
  Effect.gen(function* () {
    const { bootstrapAdminToken, openAccess } = yield* AuthenticationConfigService
    const sql = yield* SqlStoreService
    const presented = bearerToken(authorization)
    const anonymousRead = required === 'read' && openAccess === true
    if (presented === null) {
      if (!anonymousRead) {
        return yield* Effect.fail(new AuthenticationError({ status: 401, message: 'unauthorized' }))
      }
      return { scope: 'read', token: null, tokenHash: OPEN_ACCESS_HASH }
    }

    if (
      bootstrapAdminToken !== undefined &&
      bootstrapAdminToken.length > 0 &&
      equalsConstantTime(presented, bootstrapAdminToken)
    ) {
      const tokenHash = yield* Effect.tryPromise({
        try: () => hashToken(presented),
        catch: (cause) => new BackendStorageError({ operation: 'hashAccessToken', cause }),
      })
      return { scope: 'admin', token: null, tokenHash }
    }

    const tokenHash = yield* Effect.tryPromise({
      try: () => hashToken(presented),
      catch: (cause) => new BackendStorageError({ operation: 'hashAccessToken', cause }),
    })
    const token = yield* Effect.tryPromise({
      try: () => sql.readAccessToken(tokenHash),
      catch: (cause) => new BackendStorageError({ operation: 'readAccessToken', cause }),
    })
    if (token === null) {
      return yield* Effect.fail(new AuthenticationError({ status: 401, message: 'unauthorized' }))
    }
    if (!satisfiesScope(token.scope, required)) {
      return yield* Effect.fail(new AuthenticationError({ status: 403, message: 'forbidden' }))
    }
    return { scope: token.scope, token, tokenHash: token.tokenHash }
  })

export const requireRuntimeScope =
  (runtime: BackendRuntime, required: Scope): MiddlewareHandler =>
  async (c, next) => {
    const result = await runtime.runHandled(
      authenticateScope(c.req.header('authorization'), required),
      (error) => error,
    )
    if (result instanceof AuthenticationError) {
      return c.json({ error: result.message }, result.status)
    }
    if (result instanceof BackendStorageError) {
      console.error(result.cause)
      return c.text('Internal Server Error', 500)
    }
    c.set('caller', result)
    return next()
  }
