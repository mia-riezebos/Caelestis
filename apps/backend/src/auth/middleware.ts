import { Effect } from 'effect'
import type { MiddlewareHandler } from 'hono'
import type { AccessToken } from '../ports/index.js'
import { type BackendRuntime, SqlStoreService } from '../runtime/backend-runtime.js'
import { BackendStorageError, ForbiddenError, UnauthorizedError } from '../runtime/errors.js'
import { runBackendMiddleware } from '../runtime/hono.js'
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

export interface AuthOptions {
  /**
   * The operator's bootstrap credential, from the environment.
   *
   * It mints the first real admin token and is not expected on ordinary requests. Absent or empty
   * means the server has no bootstrap path, which is the right default once real tokens exist.
   */
  readonly bootstrapAdminToken?: string | undefined

  /**
   * Serve the read surface without a credential.
   *
   * `/server` advertises `auth: 'none'` when this is set, and that advertisement is the entire
   * reason `/server` is public: a userscript reads it to decide whether to ask its user for a token
   * before adding the server. When the flag only changed the advertisement, a client that believed
   * it got a 401 from `/manifest` — the one thing the endpoint exists to prevent.
   *
   * `read` only. `report` writes counters and `admin` writes everything, and neither becomes public
   * because a server chose to publish its manifest.
   *
   * A credential that is presented is still read: an admin on an open server must keep seeing
   * drafts. A credential that is presented and invalid still fails, rather than quietly falling back
   * to anonymous — a holder whose token was revoked needs to learn that, and anyone who wants the
   * anonymous view can have it by sending no header at all.
   */
  readonly openAccess?: boolean | undefined
}

/**
 * Require at least `required` scope.
 *
 * Every rejection is a bare 401 or 403 with no detail. Distinguishing "no such token" from "revoked"
 * from "wrong scope" would let a holder of one credential probe for the existence of others.
 *
 * "Bare" is about detail, not about the body. Three reviewers have now read it as "send no body at
 * all" and filed the `{"error":"unauthorized"}` payload as a violation, so: the body is a constant
 * per status, identical for a missing header, a malformed scheme, an unknown token and a deleted
 * one. Nothing in it varies with the cause, which is the whole property. 401 versus 403 is the one
 * distinction that is deliberate — it tells a caller whether to authenticate or give up, and it
 * says nothing about any credential the caller does not already hold.
 */
/**
 * The digest recorded for an anonymous caller on an open server. Not a credential and cannot be one:
 * no token hashes to all zeroes, so it can never collide with a real one, and the author columns
 * still receive something of the right shape.
 */
const OPEN_ACCESS_HASH = '0'.repeat(64)

/** Authenticate one request against the SQL service supplied by the prepared Effect runtime. */
export const authenticateRequest = (
  authorization: string | undefined,
  config: AuthOptions,
  required: Scope,
): Effect.Effect<
  Caller,
  UnauthorizedError | ForbiddenError | BackendStorageError,
  SqlStoreService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const presented = bearerToken(authorization)
    const anonymousRead = required === 'read' && config.openAccess === true
    if (presented === null) {
      if (!anonymousRead) {
        return yield* Effect.fail(new UnauthorizedError({ message: 'unauthorized' }))
      }
      return { scope: 'read', token: null, tokenHash: OPEN_ACCESS_HASH }
    }

    if (
      config.bootstrapAdminToken !== undefined &&
      config.bootstrapAdminToken.length > 0 &&
      equalsConstantTime(presented, config.bootstrapAdminToken)
    ) {
      const tokenHash = yield* Effect.tryPromise({
        try: () => hashToken(presented),
        catch: (cause) => new BackendStorageError({ operation: 'hashToken', cause }),
      })
      return { scope: 'admin', token: null, tokenHash }
    }

    const tokenHash = yield* Effect.tryPromise({
      try: () => hashToken(presented),
      catch: (cause) => new BackendStorageError({ operation: 'hashToken', cause }),
    })
    const token = yield* Effect.tryPromise({
      try: () => sql.readAccessToken(tokenHash),
      catch: (cause) => new BackendStorageError({ operation: 'readAccessToken', cause }),
    })
    if (token === null) {
      return yield* Effect.fail(new UnauthorizedError({ message: 'unauthorized' }))
    }
    if (!satisfiesScope(token.scope, required)) {
      return yield* Effect.fail(new ForbiddenError({ message: 'forbidden' }))
    }
    return { scope: token.scope, token, tokenHash: token.tokenHash }
  })

/** Effect-backed scope middleware for routes migrated off hand-passed SQL authentication. */
export const requireScopeEffect =
  (runtime: BackendRuntime, config: AuthOptions, required: Scope): MiddlewareHandler =>
  async (c, next) =>
    runBackendMiddleware(
      c,
      runtime,
      authenticateRequest(c.req.header('authorization'), config, required),
      (caller) => {
        c.set('caller', caller)
        return next()
      },
    )
