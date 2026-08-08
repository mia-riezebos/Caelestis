import { type Millis, type PixelBounds, type Seconds, WORLD_PIXELS, WORLD_TILES } from '@wts/shared'
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
/**
 * The domain the `templates`, `template_versions` and `version_tiles` CHECKs enforce, stated where
 * both adapters can honour it.
 *
 * The memory store validated duplicate versions and tiles and nothing else, so it accepted rows D1
 * refuses — `createdWithToken: 'bootstrap'`, a negative author account, a tile off the canvas, a
 * short hash, an inverted bounding box. That is the third time an adapter has been wider than the
 * database it stands in for, and the route tests run against this one: the malformed-attribution
 * bug the last commits fixed would have stayed green here.
 */
export const assertValidTemplateVersion = (version: TemplateVersionRecord): void => {
  const fail = (reason: string): never => {
    throw new Error(`insertTemplateVersion rejected ${version.versionId}: ${reason}`)
  }
  const isDigest = (value: string) => /^[0-9a-f]{64}$/.test(value)
  if (!isDigest(version.createdWithToken))
    fail(`createdWithToken ${version.createdWithToken} is not a sha256 digest`)
  if (
    version.createdByUserId !== null &&
    (!Number.isSafeInteger(version.createdByUserId) || version.createdByUserId < 0)
  ) {
    fail(`createdByUserId ${version.createdByUserId} is not a non-negative integer`)
  }
  const { minX, minY, maxX, maxY } = version.bbox
  if (![minX, minY, maxX, maxY, version.totalPixels].every(Number.isSafeInteger)) {
    fail('bounding box and total pixels must be integers')
  }
  // x wraps through zero so minX may exceed maxX; y does not. Zero width or height is not a
  // placement. These are the same bounds `template_versions_pixel_bounds_check` states.
  if (minX < 0 || minX >= WORLD_PIXELS || minY < 0 || minY >= WORLD_PIXELS) {
    fail('bounding box minimum is outside the canvas')
  }
  if (maxX < 1 || maxX > WORLD_PIXELS || maxY < 1 || maxY > WORLD_PIXELS) {
    fail('bounding box maximum is outside the canvas')
  }
  if (minX === maxX || minY >= maxY) fail('bounding box covers no pixels')
  if (version.totalPixels < 0) fail('total pixels is negative')
  for (const chunk of version.chunks) {
    if (
      !Number.isSafeInteger(chunk.tileX) ||
      !Number.isSafeInteger(chunk.tileY) ||
      chunk.tileX < 0 ||
      chunk.tileX >= WORLD_TILES ||
      chunk.tileY < 0 ||
      chunk.tileY >= WORLD_TILES
    ) {
      fail(`chunk tile ${chunk.tileX}/${chunk.tileY} is outside the canvas`)
    }
    if (!isDigest(chunk.hash)) fail(`chunk hash ${chunk.hash} is not a sha256 digest`)
  }
}

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
  readonly createdWithToken: string
  readonly createdAt: Millis
}

export interface TemplateVersionRecord {
  readonly templateId: string
  readonly nodeId: string
  readonly name: string
  readonly versionId: string
  /**
   * Who uploaded this — the digest of the access token used, and the wplace `/me` id of the account
   * that used it when the client presented one. The account is optional here and mandatory on the
   * reporter columns, because quorum counts distinct accounts while authorship only has to name the
   * credential that acted: a server-side admin upload has a token and no wplace session.
   */
  readonly createdWithToken: string
  readonly createdByUserId: number | null
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

/** A template's own row: what it is called and where it sits, with no pixels attached. */
export interface TemplateRecord {
  readonly id: string
  readonly nodeId: string
  readonly name: string
  readonly currentVersionId: string | null
  readonly published: boolean
  readonly createdAt: Millis
  readonly updatedAt: Millis
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

/** Everything a cascading delete removed, so a caller can say what it did. */
export interface NodeDeletion {
  readonly nodes: number
  readonly templates: number
  /** Chunk hashes the deleted versions referenced, which may or may not still be in use. */
  readonly hashes: readonly string[]
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
  readonly updatedAt: Millis
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

/**
 * The longest a node path may be, mirroring `nodes_path_check` and the wire's `NodePath`.
 *
 * Lives here rather than in the route because a rename is what can exceed it without anyone naming
 * an over-long string: renaming an ancestor lengthens every path beneath it, so the request that
 * breaks the bound is one whose own path is comfortably inside it.
 */
export const MAX_NODE_PATH_LENGTH = 256

export class NodePathTooLongError extends Error {
  override readonly name = 'NodePathTooLongError'
}

export class InvalidNodeParentError extends Error {
  override readonly name = 'InvalidNodeParentError'
}

export class NodeNotFoundError extends Error {
  override readonly name = 'NodeNotFoundError'
}

/**
 * A new version of an existing template that is not a version of the same thing.
 *
 * A version replaces a template's content in place, and every client that already has the template
 * keeps its own placement, ordering and progress against it. So the identity has to hold: the name
 * and the dimensions must match the version being replaced. Position may move — that is a re-place,
 * not a different template — and the content hash obviously differs, which is the point of
 * uploading at all.
 *
 * **No route reaches this yet.** `storeTemplate` mints a fresh template id on every upload, so
 * "upload a new version of an existing template" is not an operation the API exposes — the rule is
 * here so that the store holds it when that route lands, rather than being remembered then. The
 * route-level 409 was removed with the rest of the dead branch; add it back with the route.
 *
 * One thing to settle when it does: the bounds compared here are the *painted extent*, which
 * `sliceTemplate` derives from non-transparent pixels rather than from the image rectangle. Editing
 * artwork at its outer edge changes that extent and would be refused as a different template.
 */
export class TemplateIdentityError extends Error {
  override readonly name = 'TemplateIdentityError'
}

export class NodeNotEmptyError extends Error {
  override readonly name = 'NodeNotEmptyError'
}

/**
 * What a template edit may change, beside its pixels.
 *
 * Pixels are not here on purpose: replacing them is `insertTemplateVersion`, which mints a new
 * version id and a new chunk index. Everything in this patch leaves the chunks exactly where they
 * are, which is the whole reason `updatedAt` exists alongside the version.
 *
 * An absent field is "leave it alone", which is why every one is optional rather than nullable —
 * neither a name nor a parent can be cleared, only replaced.
 */
export interface TemplatePatch {
  readonly name?: string
  /** Moving a template to another node. Rejected with `NodeNotFoundError` if it does not exist. */
  readonly nodeId?: string
}

/**
 * What an admin has renamed this server to, or nulls where they have not.
 *
 * Null is "not decided" and falls back to the deployment's own configuration — which is different
 * from an empty string, and is why these are nullable rather than defaulted.
 */
export interface ServerSettings {
  readonly name: string | null
  readonly description: string | null
}

export interface SqlStore {
  /** The operator's overrides. Nulls throughout when nobody has set anything. */
  readServerSettings(): Promise<ServerSettings>

  /** Update only the supplied fields; explicit null clears the configured override. */
  writeServerSettings(patch: {
    readonly name?: string
    readonly description?: string | null
  }): Promise<void>

  /**
   * Insert a node, and answer with the row as stored.
   *
   * Only the last segment of `node.path` is honoured. The prefix is taken from the parent row at the
   * moment of the write, because a caller derives it from its own earlier read and a rename landing
   * in between would otherwise attach the child under a prefix its parent no longer has. Everything
   * downstream — the uniqueness check, the length bound, the returned record — is decided on the
   * composed path, so nothing can disagree about which path this node has.
   *
   * Throws `NodePathConflictError` when that composed path is taken, `NodePathTooLongError` when it
   * exceeds `MAX_NODE_PATH_LENGTH`, and `InvalidNodeParentError` when the parent is missing or in
   * another season.
   */
  insertNode(node: NodeRecord): Promise<NodeRecord>

  readNode(nodeId: string): Promise<NodeRecord | null>

  listNodes(season: number): Promise<readonly NodeRecord[]>

  /**
   * Rename a node and rewrite the paths of everything beneath it.
   *
   * `path` is a materialized prefix, so a rename is not a one-row update: every descendant carries
   * the old path as a prefix and has to move with it, atomically.
   *
   * Takes the new last segment rather than the whole path, and composes the destination from the
   * node's own current path. A caller that derived the full path would be deriving it from a read
   * that can go stale: two concurrent renames, one of a node and one of its parent, could each
   * compute a destination under a prefix the other is in the middle of moving, and the loser writes
   * a path its own `parentId` contradicts. The prefix is never the caller's to supply.
   *
   * Returns the renamed node, or null when the id does not exist. Throws `NodePathConflictError`
   * when the destination collides with a sibling, and `NodePathTooLongError` when the rename would
   * push the node or any descendant past `MAX_NODE_PATH_LENGTH`.
   */
  renameNode(nodeId: string, name: string, segment: string): Promise<NodeRecord | null>

  /**
   * Re-parent a node and rewrite the paths of everything beneath it.
   *
   * Returns false when the node does not exist. Throws `InvalidNodeParentError` when the destination
   * does not exist, belongs to another season, or is the node itself or one of its own descendants;
   * `NodePathConflictError` when the new path collides with a sibling.
   */
  moveNode(nodeId: string, parentId: string | null, path: string): Promise<boolean>

  deleteNode(nodeId: string): Promise<void>

  deleteNodeCascade(nodeId: string): Promise<NodeDeletion>

  /** Of these hashes, the ones no surviving template version references. Safe to delete from blobs. */
  unreferencedHashes(hashes: readonly string[]): Promise<readonly string[]>

  /** How much a cascading delete would remove, without removing it. */
  countNodeSubtree(nodeId: string): Promise<{ nodes: number; templates: number }>

  /** Atomically add a version, its tile index, and make it the template's current version. */
  insertTemplateVersion(version: TemplateVersionRecord): Promise<void>

  /** A version with its template metadata and complete tile index, or null if absent. */
  readTemplateVersion(versionId: string): Promise<TemplateVersionRecord | null>

  /**
   * A template's own row, without a version or a tile index.
   *
   * What "does this exist, and where does it live" needs, which is every edit and a new version —
   * none of which care what the pixels currently are. `readTemplateVersion` answers a different
   * question and reads the whole chunk index to do it.
   */
  readTemplate(templateId: string): Promise<TemplateRecord | null>

  setTemplatePublishedAt(
    templateId: string,
    publishedAt: Millis | null,
    updatedAt: Millis,
  ): Promise<boolean>

  /**
   * Rename a template, move it to another node, or both. Returns false when the id does not exist.
   *
   * Unlike `renameNode` this rewrites nothing else: a template is a leaf, so it carries no
   * materialized path and nothing hangs beneath it. Moving one is a single column.
   *
   * Throws `NodeNotFoundError` when the destination node does not exist — otherwise a typo would
   * silently orphan a template into a node nobody can navigate to.
   */
  updateTemplate(templateId: string, patch: TemplatePatch, updatedAt: Millis): Promise<boolean>

  /**
   * Delete a template with every version and tile index it owns. Returns false if it was not there.
   *
   * **Chunks are deliberately left behind.** They are content-addressed and shared: two templates
   * with the same region, or two versions of one template that differ elsewhere, refer to the same
   * blob. Deleting by hash here would corrupt whatever else pointed at it, so reclaiming storage is
   * a sweep over hashes no version references — a separate job, and a safe one to never run.
   */
  deleteTemplate(templateId: string): Promise<boolean>

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
