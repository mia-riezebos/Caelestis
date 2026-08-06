import type { Millis, PixelBounds, Seconds } from '@wts/shared'
import type { Scope } from '../auth/tokens.js'

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

/** A stored credential. The plaintext token exists only in the response that mints it. */
export interface AccessToken {
  /** Lowercase hex SHA-256 of the token. The primary key. */
  readonly tokenHash: string
  /** Human-facing name, so one leaked credential can be revoked without rotating everyone. */
  readonly label: string
  readonly scope: Scope
  readonly createdBy: string
  readonly createdAt: Millis
  /** Null while live. */
  readonly revokedAt: Millis | null
}

export interface TemplateVersionRecord {
  readonly templateId: string
  readonly nodeId: string
  readonly name: string
  readonly versionId: string
  readonly createdBy: string
  /** Used for both rows when the template is new; existing templates retain their original date. */
  readonly createdAt: Millis
  readonly bbox: PixelBounds
  readonly totalPixels: number
  readonly chunks: readonly {
    readonly tileX: number
    readonly tileY: number
    readonly hash: string
  }[]
}

export interface NodeRecord {
  readonly id: string
  readonly season: number
  readonly parentId: string | null
  readonly path: string
  readonly name: string
  readonly description: string | null
  readonly createdAt: Millis
}

export interface ManifestTemplateRecord {
  readonly id: string
  readonly nodeId: string
  readonly name: string
  readonly versionId: string
  readonly bbox: PixelBounds
  readonly totalPixels: number
  readonly published: boolean
  readonly createdAt: Millis
}

export interface ManifestTileRecord {
  readonly templateId: string
  readonly tileX: number
  readonly tileY: number
  readonly hash: string
}

export class NodePathConflictError extends Error {
  override readonly name = 'NodePathConflictError'
}

export class InvalidNodeParentError extends Error {
  override readonly name = 'InvalidNodeParentError'
}

export class NodeNotFoundError extends Error {
  override readonly name = 'NodeNotFoundError'
}

export class NodeNotEmptyError extends Error {
  override readonly name = 'NodeNotEmptyError'
}

export interface SqlStore {
  insertNode(node: NodeRecord): Promise<void>

  readNode(nodeId: string): Promise<NodeRecord | null>

  listNodes(season: number): Promise<readonly NodeRecord[]>

  /**
   * Rename a node and rewrite the paths of everything beneath it.
   *
   * `path` is a materialized prefix, so a rename is not a one-row update: every descendant carries
   * the old path as a prefix and has to move with it, atomically. Returns false when the id does not
   * exist, and throws `NodePathConflictError` when the new path collides with a sibling.
   */
  renameNode(nodeId: string, name: string, path: string): Promise<boolean>

  deleteNode(nodeId: string): Promise<void>

  /** Atomically add a version, its tile index, and make it the template's current version. */
  insertTemplateVersion(version: TemplateVersionRecord): Promise<void>

  /** A version with its template metadata and complete tile index, or null if absent. */
  readTemplateVersion(versionId: string): Promise<TemplateVersionRecord | null>

  setTemplatePublishedAt(templateId: string, publishedAt: Millis | null): Promise<boolean>

  listManifestTemplates(
    season: number,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTemplateRecord[]>

  listManifestTiles(
    season: number,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTileRecord[]>

  /**
   * Store a freshly minted token.
   *
   * Rejects a hash that already exists rather than overwriting: a collision here would silently
   * transfer one holder's credential to another.
   */
  insertAccessToken(token: AccessToken): Promise<void>

  /** The token with this hash, live or revoked, or null if there is none. */
  readAccessToken(tokenHash: string): Promise<AccessToken | null>

  /** Every token, revoked included, newest first. Never returns plaintext, which is not stored. */
  listAccessTokens(): Promise<readonly AccessToken[]>

  /**
   * Mark a token revoked, idempotently.
   *
   * Re-revoking keeps the original instant: the audit question is when a credential stopped being
   * usable, and a second call must not move that.
   */
  revokeAccessToken(tokenHash: string, revokedAt: Millis): Promise<void>

  /**
   * Write full folded bucket totals with replace semantics.
   *
   * Idempotent on `(templateId, resolution, bucketStart)` — a retried flush must not double-count.
   * A retained bucket may be rewritten after a late arrival, but the value is always its new
   * cumulative total, never an increment.
   */
  appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void>

  readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]>
}
