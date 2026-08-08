import type { Millis, Seconds } from '@wts/shared'
import { SCOPES, type Scope } from '../auth/tokens.js'

/**
 * Relational storage. D1 today, Postgres later.
 *
 * D1 is the **system of record**: every tier of the decay ladder lands here, along with current
 * status. The counter store in front of it is a write-absorption buffer, not a second source of
 * truth.
 *
 * No generic `query(sql)` escape hatch. One would make every caller a dialect dependency and quietly
 * undo the portability this interface exists for.
 */

/** One folded bucket of the decay ladder. */
export interface TelemetryBucket {
  readonly templateId: string
  /** Bucket width in seconds — 60, 300, 900, 3600, 21600. */
  readonly resolution: number
  /** Unix seconds, floored to `resolution`. */
  readonly bucketStart: Seconds
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

/**
 * Template ids per query. D1 accepts at most 100 bound parameters, ten times tighter than the SQLite
 * default; 90 leaves room for the three non-id bindings in the WHERE clause and a little slack. The
 * test fake is `node:sqlite`, whose limit is 32_766, so no test can observe the real ceiling —
 * `readBuckets issues one statement per parameter chunk` counts statements instead.
 */
export const READ_BUCKETS_CHUNK_SIZE = 90
/**
 * Distinct template ids one `readBuckets` call may ask for, derived from the chunk size rather than
 * restating it: D1 allows 50 queries per Worker invocation on the free plan, and 40 of these chunks
 * leaves headroom. The bound lives on the port because the memory store is the oracle the
 * differential tests measure against — a limit only one adapter enforces is one the oracle denies.
 */
const READ_BUCKETS_CHUNK_BUDGET = 40
export const MAX_READ_BUCKETS_TEMPLATE_IDS = READ_BUCKETS_CHUNK_SIZE * READ_BUCKETS_CHUNK_BUDGET

export const tooManyTemplateIds = (count: number): Error =>
  new Error(
    `readBuckets accepts at most ${MAX_READ_BUCKETS_TEMPLATE_IDS} template ids per call; received ${count}`,
  )

/** Bucket widths the decay ladder folds to, matching `telemetry_buckets_resolution_check`. */
const LADDER_RESOLUTIONS: readonly number[] = [60, 300, 900, 3_600, 21_600]

/**
 * The domain `telemetry_buckets` will actually store, stated where both adapters can honour it.
 *
 * D1 enforces all of this in SQL and the memory store enforced none of it, so the oracle the
 * differential tests measure against accepted five classes of row D1 rejects — a misaligned or
 * negative `bucketStart`, an off-ladder `resolution`, a fractional counter, and counters out of
 * `repairs <= correct <= placed` order. Same defect the read cap had, on the write path, and the
 * consequence is worse than a surprise in production: `TelemetryShard.alarm` catches the rejection
 * and re-arms without clearing `flush_batch`, so one poison row is re-sent every alarm forever and
 * the shard stops flushing entirely while `readPending` keeps counting the stuck batch.
 *
 * Today's only writer floors to 60 and always sends `resolution: 60`, so nothing currently produces
 * one. The ladder-fold writer that fills tiers 300 through 21600 is exactly where a misfloored start
 * would appear.
 */
export const invalidBucket = (bucket: TelemetryBucket): string | null => {
  const { resolution, bucketStart, placed, correct, repairs } = bucket
  if (!LADDER_RESOLUTIONS.includes(resolution))
    return `resolution ${resolution} is not a ladder tier`
  if (!Number.isSafeInteger(bucketStart) || bucketStart < 0) {
    return `bucketStart ${bucketStart} is not a non-negative integer`
  }
  if (bucketStart % resolution !== 0) {
    return `bucketStart ${bucketStart} is not a multiple of resolution ${resolution}`
  }
  if (![placed, correct, repairs].every(Number.isSafeInteger)) return 'counters must be integers'
  if (!(repairs >= 0 && repairs <= correct && correct <= placed)) {
    return `counters must satisfy 0 <= repairs <= correct <= placed, got ${repairs}, ${correct}, ${placed}`
  }
  return null
}

export const assertValidBuckets = (buckets: readonly TelemetryBucket[]): void => {
  for (const bucket of buckets) {
    const reason = invalidBucket(bucket)
    if (reason !== null) throw new Error(`appendBuckets rejected ${bucket.templateId}: ${reason}`)
  }
}

/**
 * The single order every `readBuckets` implementation returns, so the adapters stay comparable.
 *
 * Compared with `<`/`>` rather than `localeCompare`, which matches SQLite's BINARY collation and is
 * total. `localeCompare` treats default-ignorable codepoints as equal — `'a­b'` ties with
 * `'ab'` — and `Array.prototype.sort` is stable, so a tie falls back to input order: SQL order on
 * D1, `Map` insertion order in memory. Two adapters, one input, different arrays, on ids the
 * boundary permits.
 */
export const compareBuckets = (left: TelemetryBucket, right: TelemetryBucket): number => {
  if (left.templateId < right.templateId) return -1
  if (left.templateId > right.templateId) return 1
  return left.bucketStart - right.bucketStart
}

export interface BucketQuery {
  readonly templateIds: readonly string[]
  readonly resolution: number
  readonly fromSeconds: Seconds
  readonly toSeconds: Seconds
}

/**
 * The bucket half of `SqlStore`.
 *
 * The counter path writes and reads buckets and touches nothing else, so it depends on this rather
 * than on the whole store — a narrower dependency, and one that keeps its test doubles honest
 * instead of stubbing out credential methods they never call.
 */
export type BucketStore = Pick<SqlStore, 'appendBuckets' | 'readBuckets'>

/**
 * The scope domain `access_tokens_scope_check` enforces, stated where both adapters can honour it.
 *
 * D1 rejects anything outside this list and the memory store accepted it, so the oracle the
 * differential tests measure against was wider than production — the same defect `invalidBucket`
 * exists to close, on the sibling column. Fails closed either way, since `satisfiesScope` denies an
 * unrecognised scope, but a writer that passes green in tests and throws in D1 is worth catching
 * here rather than there.
 */
export const assertValidAccessToken = (token: AccessToken): void => {
  if (!(SCOPES as readonly string[]).includes(token.scope)) {
    throw new Error(`insertAccessToken rejected ${token.tokenHash}: unknown scope ${token.scope}`)
  }
}

/**
 * The single order every `listAccessTokens` implementation returns.
 *
 * Newest first, and `createdAt` alone is not a total order — `Date.now()` has millisecond
 * resolution and scripted provisioning mints a read and a report token in the same tick. Memory
 * then falls back to `Map` insertion order and SQLite leaves equal keys unspecified, so the two
 * adapters can disagree on input the boundary permits. Same reasoning as `compareBuckets`.
 */
export const compareAccessTokens = (left: AccessToken, right: AccessToken): number =>
  right.createdAt - left.createdAt ||
  (left.tokenHash < right.tokenHash ? -1 : left.tokenHash > right.tokenHash ? 1 : 0)

/** A stored credential. The plaintext token exists only in the response that mints it. */
export interface AccessToken {
  /** Lowercase hex SHA-256 of the token. The primary key. */
  readonly tokenHash: string
  /** Human-facing name, so one leaked credential can be revoked without rotating everyone. */
  readonly label: string
  readonly scope: Scope
  readonly createdBy: string
  readonly createdAt: Millis
}

export interface SqlStore {
  /**
   * Store a freshly minted token.
   *
   * Rejects a hash that already exists rather than overwriting: a collision here would silently
   * transfer one holder's credential to another.
   */
  insertAccessToken(token: AccessToken): Promise<void>

  /** The token with this hash, or null if there is none — which is what revoked looks like. */
  readAccessToken(tokenHash: string): Promise<AccessToken | null>

  /**
   * Every stored token, newest first, tie-broken by hash. Never returns plaintext, which is not
   * stored. Revoked tokens are absent, not listed: revocation deletes the row.
   */
  listAccessTokens(): Promise<readonly AccessToken[]>

  /**
   * Revoke a token by deleting it, idempotently.
   *
   * Revocation is a hard delete, not a flag. A soft `revoked_at_ms` obliged every reader to
   * remember to filter on it, and nothing made them; deleting the row needs no cooperation. A
   * credential is never re-provisioned, so the row has no reason to outlive its usefulness.
   *
   * What this deliberately does **not** touch is what the token already reported. Reported state is
   * canonical — it records what was actually on wplace — so it stays regardless of what later
   * happens to the credential that carried it. Revoking ends a holder's future access; it does not
   * rewrite history.
   */
  revokeAccessToken(tokenHash: string): Promise<void>

  /**
   * Write full folded bucket totals with replace semantics.
   *
   * Idempotent on `(templateId, resolution, bucketStart)` — a retried flush must not double-count.
   * A retained bucket may be rewritten after a late arrival, but the value is always its new
   * cumulative total, never an increment.
   */
  appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void>

  /**
   * Read folded buckets for a set of templates at one resolution over a half-open range.
   *
   * Rejects more than `MAX_READ_BUCKETS_TEMPLATE_IDS` distinct ids. Duplicate ids are read once.
   */
  readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]>
}
