import {
  type Alarm,
  type ContributionDay,
  type Millis,
  PALETTE_SIZE,
  type PixelBounds,
  type Seconds,
  seconds,
  type TemplateStatus,
  type TemplateSurface,
  TILE_SIZE,
  type TileCoord,
  type TileHistoryFrame,
  TRANSPARENT_INDEX,
  templateSurface,
  templateSurfaceBounds,
  WORLD_PIXELS,
  WORLD_TILES,
} from '@caelestis/shared'
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

export const tooManyTemplateIds = (count: number, method = 'readBuckets'): Error =>
  new Error(
    `${method} accepts at most ${MAX_READ_BUCKETS_TEMPLATE_IDS} template ids per call; received ${count}`,
  )

/** Bucket widths the decay ladder folds to, matching `telemetry_buckets_resolution_check`. */
export const LADDER_RESOLUTIONS: readonly number[] = [60, 300, 900, 3_600, 21_600]

export interface DecayEdge {
  readonly source: number
  readonly target: number
  readonly retainSeconds: number
}

/** Delta buckets compact only after the complete target window has aged past this boundary. */
export const TELEMETRY_DECAY_EDGES: readonly DecayEdge[] = [
  { source: 60, target: 300, retainSeconds: 6 * 3_600 },
  { source: 300, target: 900, retainSeconds: 24 * 3_600 },
  { source: 900, target: 3_600, retainSeconds: 7 * 86_400 },
  { source: 3_600, target: 21_600, retainSeconds: 30 * 86_400 },
]

/** Target groups processed per tier and write touch. Backlogs drain over later saves. */
export const DECAY_FOLD_GROUP_LIMIT = 20

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
  /** One exact tier for legacy callers, or several retained tiers for a lossless server-side read. */
  readonly resolution: number | readonly number[]
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
export type BucketStore = Pick<SqlStore, 'appendBuckets' | 'readBuckets' | 'foldTelemetryBuckets'>

/**
 * What `readContributions` may be asked for.
 *
 * At least one of `season` and `templateIds` is required — with neither, the query is a full-table
 * scan over every season's contributions, which no caller means and which grows without bound.
 * `season` widens to every template in that season; `templateIds` narrows to the named ones; both
 * together intersect. The time range is half-open `[from, to)` on `day` and optional at this layer,
 * because the leaderboard legitimately reads a whole season.
 */
export interface ContributionQuery {
  /** Restrict to templates in this season, resolved through the `templates` table. */
  readonly season?: number
  /** Restrict to these templates. Duplicate ids are read once; the read-cap applies. */
  readonly templateIds?: readonly string[]
  readonly fromSeconds?: Seconds
  readonly toSeconds?: Seconds
  /**
   * Whether unpublished templates' rows may appear, mirroring the manifest's admin gate.
   *
   * Required rather than defaulted, and enforced in the adapter rather than the route, for the
   * same reason `includeUnpublished` is everywhere else in this store: an unpublished template is
   * invisible to a read-scoped caller, and a caller that merely *knows* its id — from a manifest
   * poll made before it was unpublished — must not be able to keep reading its telemetry through
   * this side door. Explicit-id and season queries are filtered alike.
   */
  readonly includeUnpublished: boolean
}

/**
 * The domain `readContributions` accepts, stated where both adapters can honour it.
 *
 * The id cap is D1's bound-parameter budget wearing a port-level name, exactly as `readBuckets`
 * documents — and the "name a season or some templates" rule is here rather than in a route so the
 * memory oracle refuses the unbounded scan production would.
 */
export const assertValidContributionQuery = (query: ContributionQuery): void => {
  if (query.season === undefined && query.templateIds === undefined) {
    throw new Error('readContributions requires a season or template ids')
  }
  const distinct = new Set(query.templateIds ?? []).size
  if (distinct > MAX_READ_BUCKETS_TEMPLATE_IDS) {
    throw tooManyTemplateIds(distinct, 'readContributions')
  }
}

/** The id-cap for `filterPublishedTemplateIds`, stated where both adapters can honour it. */
export const assertValidPublishedFilter = (ids: readonly string[]): void => {
  const distinct = new Set(ids).size
  if (distinct > MAX_READ_BUCKETS_TEMPLATE_IDS) {
    throw tooManyTemplateIds(distinct, 'filterPublishedTemplateIds')
  }
}

/**
 * The single order every `readContributions` implementation returns. Binary comparison for the same
 * reason as `compareBuckets`: it matches SQLite's collation and `localeCompare` does not.
 */
export const compareContributionDays = (left: ContributionDay, right: ContributionDay): number => {
  if (left.templateId < right.templateId) return -1
  if (left.templateId > right.templateId) return 1
  return left.day - right.day || left.wplaceUserId - right.wplaceUserId
}

/** Bucket widths `tile_history` folds to, matching `tile_history_resolution_s_check`. 0 is raw. */
export const TILE_HISTORY_RESOLUTIONS: readonly number[] = [0, 3_600, 21_600, 86_400]

export const TILE_HISTORY_DECAY_EDGES: readonly DecayEdge[] = [
  { source: 0, target: 3_600, retainSeconds: 86_400 },
  { source: 3_600, target: 21_600, retainSeconds: 7 * 86_400 },
  { source: 21_600, target: 86_400, retainSeconds: 30 * 86_400 },
]

/** One physical reporter row carried between tile-history tiers. */
export interface TileHistoryReporterRow {
  readonly season: number
  readonly tile: TileCoord
  readonly resolution: number
  readonly bucketStart: Seconds
  readonly hash: string
  readonly reportedWithToken: string
  readonly reportedByUserId: number
}

export interface FoldedTileRows {
  readonly rows: readonly TileHistoryReporterRow[]
  readonly deletedHashes: readonly string[]
}

/** Latest source bucket wins; quorum chooses its hash; every winning reporter row survives. */
export const foldTileReporterRows = (
  rows: readonly TileHistoryReporterRow[],
  targetResolution: number,
): FoldedTileRows => {
  const targetGroups = new Map<number, TileHistoryReporterRow[]>()
  for (const row of rows) {
    const targetStart = Math.floor(row.bucketStart / targetResolution) * targetResolution
    const held = targetGroups.get(targetStart)
    if (held === undefined) targetGroups.set(targetStart, [row])
    else held.push(row)
  }

  const folded: TileHistoryReporterRow[] = []
  for (const [targetStart, group] of targetGroups) {
    const reporters = new Map<string, Set<number>>()
    for (const row of group) {
      const key = `${row.bucketStart}\u0000${row.hash}`
      const held = reporters.get(key)
      if (held === undefined) reporters.set(key, new Set([row.reportedByUserId]))
      else held.add(row.reportedByUserId)
    }
    const frames = foldTileFrames(
      [...reporters].map(([key, accounts]) => {
        const separator = key.indexOf('\u0000')
        return {
          bucketStart: seconds(Number(key.slice(0, separator))),
          hash: key.slice(separator + 1),
          reporters: accounts.size,
        }
      }),
    )
    const latest = frames.at(-1)
    if (latest === undefined) continue
    folded.push(
      ...group
        .filter((row) => row.bucketStart === latest.bucketStart && row.hash === latest.hash)
        .map((row) => ({
          ...row,
          resolution: targetResolution,
          bucketStart: seconds(targetStart),
        })),
    )
  }
  return { rows: folded, deletedHashes: [...new Set(rows.map((row) => row.hash))] }
}

export interface TileHistoryQuery {
  readonly season: number
  readonly tile: TileCoord
  /** A `TILE_HISTORY_RESOLUTIONS` tier — 0 reads the raw observations. */
  readonly resolution: number
  readonly fromSeconds: Seconds
  readonly toSeconds: Seconds
}

/** The domain `readTileHistory` accepts, stated once so the two adapters cannot drift apart. */
export const assertValidTileHistoryQuery = (query: TileHistoryQuery): void => {
  if (!TILE_HISTORY_RESOLUTIONS.includes(query.resolution)) {
    throw new Error(`readTileHistory resolution ${query.resolution} is not a ladder tier`)
  }
  const { x, y } = query.tile
  if (![x, y].every(Number.isSafeInteger) || x < 0 || x >= WORLD_TILES || y < 0 || y >= WORLD_TILES)
    throw new Error(`readTileHistory tile ${x}/${y} is outside the canvas`)
}

/** One grouped `tile_history` row: a hash and how many distinct accounts reported it. */
export interface TileFrameCandidate {
  readonly bucketStart: Seconds
  readonly hash: string
  readonly reporters: number
}

/**
 * Collapse grouped tile-history rows to one frame per bucket, sorted by bucket start ascending.
 *
 * Kept here rather than in either adapter because the tie rules are the contract: the hash with the
 * most distinct reporters wins, and an even split goes to the lexically smaller hash — `<`, not
 * `localeCompare`, for the reason `compareBuckets` states. A timelapse must not flicker between
 * competing hashes depending on which adapter, or which map iteration order, answered.
 */
export const foldTileFrames = (
  candidates: readonly TileFrameCandidate[],
): readonly TileHistoryFrame[] => {
  const best = new Map<number, TileFrameCandidate>()
  for (const candidate of candidates) {
    const held = best.get(candidate.bucketStart)
    if (
      held === undefined ||
      candidate.reporters > held.reporters ||
      (candidate.reporters === held.reporters && candidate.hash < held.hash)
    ) {
      best.set(candidate.bucketStart, candidate)
    }
  }
  return [...best.values()]
    .sort((left, right) => left.bucketStart - right.bucketStart)
    .map(({ bucketStart, hash, reporters }) => ({ bucketStart, hash, reporters }))
}

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
  if (!Number.isSafeInteger(version.season) || version.season < 0) {
    fail(`season ${version.season} is not a non-negative integer`)
  }
  if (templateSurface(version.surface.kind, version.surface.allianceId) === null) {
    fail(`surface ${version.surface.kind}/${version.surface.allianceId} is invalid`)
  }
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
  const surfaceBounds = templateSurfaceBounds(version.surface)
  if (surfaceBounds === null) {
    // World x wraps through zero, so minX may exceed maxX; y does not.
    if (minX < 0 || minX >= WORLD_PIXELS || minY < 0 || minY >= WORLD_PIXELS) {
      fail('bounding box minimum is outside the canvas')
    }
    if (maxX < 1 || maxX > WORLD_PIXELS || maxY < 1 || maxY > WORLD_PIXELS) {
      fail('bounding box maximum is outside the canvas')
    }
    if (minX === maxX || minY >= maxY) fail('bounding box covers no pixels')
  } else if (
    minX < surfaceBounds.minX ||
    minY < surfaceBounds.minY ||
    maxX > surfaceBounds.maxX ||
    maxY > surfaceBounds.maxY ||
    minX >= maxX ||
    minY >= maxY
  ) {
    fail('bounding box is outside its alliance surface')
  }
  if (version.totalPixels < 0) fail('total pixels is negative')
  if (version.colourTotals !== undefined) {
    const indices = new Set<number>()
    let total = 0
    for (const colour of version.colourTotals) {
      if (
        !Number.isSafeInteger(colour.index) ||
        colour.index < 0 ||
        colour.index >= PALETTE_SIZE ||
        colour.index === TRANSPARENT_INDEX ||
        indices.has(colour.index) ||
        !Number.isSafeInteger(colour.total) ||
        colour.total <= 0
      ) {
        fail('colour totals contain an invalid or duplicate palette entry')
      }
      indices.add(colour.index)
      total += colour.total
    }
    if (total !== version.totalPixels) fail('colour totals do not sum to total pixels')
  }
  const minTile =
    surfaceBounds === null
      ? { x: 0, y: 0 }
      : {
          x: Math.floor(surfaceBounds.minX / TILE_SIZE),
          y: Math.floor(surfaceBounds.minY / TILE_SIZE),
        }
  const maxTile =
    surfaceBounds === null
      ? { x: WORLD_TILES - 1, y: WORLD_TILES - 1 }
      : {
          x: Math.floor((surfaceBounds.maxX - 1) / TILE_SIZE),
          y: Math.floor((surfaceBounds.maxY - 1) / TILE_SIZE),
        }
  for (const chunk of version.chunks) {
    if (
      !Number.isSafeInteger(chunk.tileX) ||
      !Number.isSafeInteger(chunk.tileY) ||
      chunk.tileX < minTile.x ||
      chunk.tileX > maxTile.x ||
      chunk.tileY < minTile.y ||
      chunk.tileY > maxTile.y
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

/** The last row of a token page, used for a stable newest-first keyset scan. */
export interface AccessTokenCursor {
  readonly createdAt: Millis
  readonly tokenHash: string
}

export interface AccessTokenQuery {
  readonly after?: AccessTokenCursor
  readonly limit?: number
}

export interface TemplateVersionRecord {
  readonly templateId: string
  readonly surface: TemplateSurface
  readonly season: number
  readonly nodeId: string | null
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
  /** Histogram persisted for server-backed per-colour progress; absent on legacy fixtures/rows. */
  readonly colourTotals?: readonly { readonly index: number; readonly total: number }[]
  readonly chunks: readonly {
    readonly tileX: number
    readonly tileY: number
    readonly hash: string
  }[]
}

/** A template's own row: what it is called and where it sits, with no pixels attached. */
export interface TemplateRecord {
  readonly id: string
  readonly surface: TemplateSurface
  readonly season: number
  readonly nodeId: string | null
  readonly name: string
  readonly currentVersionId: string | null
  readonly published: boolean
  /** Frozen timelapses are exempt from decay through their freeze instant. */
  readonly timelapseFrozen: boolean
  readonly finished: boolean
  readonly finishedAt: Millis | null
  readonly createdAt: Millis
  readonly updatedAt: Millis
}

/** The exact source revision an administrator confirmed before a destructive delete. */
export interface TemplateDeletePrecondition {
  readonly versionId: string
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
}

export interface ManifestTemplateRecord {
  readonly id: string
  readonly nodeId: string | null
  readonly name: string
  readonly versionId: string
  readonly bbox: PixelBounds
  readonly totalPixels: number
  readonly published: boolean
  readonly finished: boolean
  readonly finishedAt: Millis | null
  readonly timelapseFrozen: boolean
  readonly createdAt: Millis
  readonly updatedAt: Millis
}

/** One complete current-state observation used by the server-owned alarm policy. */
export interface TemplateAlarmSnapshot {
  readonly templateId: string
  readonly versionId: string
  readonly total: number
  readonly correct: number
  readonly observedAt: Millis
}

export interface TemplateAlarmState {
  readonly templateId: string
  readonly versionId: string
  readonly total: number
  readonly peakCorrect: number
  readonly alarm: Alarm | null
}

export type AlarmEvaluationPhase =
  | { readonly kind: 'scan' }
  | {
      readonly kind: 'follow-up'
      readonly alarmId: string
      readonly pixelsLost: number
    }

export interface AlarmPolicyResult {
  readonly state: TemplateAlarmState
  readonly scheduleFollowUp: boolean
}

/** A durable delayed recheck claimed by the alarm-watcher Durable Object. */
export interface AlarmProbe {
  readonly templateId: string
  readonly versionId: string
  readonly season: number
  readonly alarmId: string
  readonly pixelsLost: number
  readonly dueAt: Millis
}

export interface ManifestTileRecord {
  readonly templateId: string
  readonly versionId: string
  readonly tileX: number
  readonly tileY: number
  readonly hash: string
}

/** One current template chunk affected by a canvas tile observation or paint event. */
export interface TelemetryTarget extends ManifestTileRecord {
  readonly bbox: PixelBounds
  readonly finished: boolean
}

export interface TileObservation {
  readonly season: number
  readonly tile: TileCoord
  readonly hash: string
  readonly observedAt: Millis
  readonly reportedAt: Seconds
  readonly reportedWithToken: string
  readonly reportedByUserId: number
}

export type LatestTileObservation = Pick<TileObservation, 'season' | 'tile' | 'hash' | 'observedAt'>

export type TileBlobObjectState = 'uploading' | 'active' | 'candidate' | 'deleting' | 'deleted'

/** One physical R2 object carrying the bytes for a public content hash. */
export interface TileBlobObject {
  /** Key relative to `tiles/`. A suffix makes a restored generation immune to an older delete. */
  readonly blobKey: string
  readonly hash: string
  readonly state: TileBlobObjectState
  readonly discoveredAt: Millis
  readonly deleteStartedAt: Millis | null
  readonly deleteAttempts: number
  readonly reclaimedAt: Millis | null
}

/** A live ingest claim. GC may not fence this hash until the claim commits or expires. */
export interface TileBlobReservation {
  readonly id: string
  readonly hash: string
  readonly blobKey: string
  readonly expiresAt: Millis
}

export type TileBlobCandidateResult = 'candidate' | 'referenced' | 'deleting' | 'deleted'
export type TileBlobClaimResult = 'claimed' | 'blocked' | 'missing'

export interface TileBlobScanState {
  readonly cursor?: string
  readonly completedSweeps: number
}

export interface TemplateTileStatusRecord {
  readonly templateId: string
  readonly versionId: string
  readonly tile: TileCoord
  readonly correct: number
  readonly wrong: number
  readonly blank: number
  readonly colours?: readonly {
    readonly index: number
    readonly correct: number
    readonly wrong: number
    readonly blank: number
    readonly total: number
  }[]
  readonly observedAt: Millis
}

export interface ContributionDelta {
  readonly templateId: string
  readonly wplaceUserId: number
  readonly day: Seconds
  readonly reportedWithToken: string
  readonly reportedByUserId: number
  readonly placed: number
  readonly correct: number
  readonly repairs: number
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

/** The subtree no longer matches the snapshot an administrator confirmed deleting. */
export class NodeSubtreeChangedError extends Error {
  override readonly name = 'NodeSubtreeChangedError'
}

export class TemplateNotFoundError extends Error {
  override readonly name = 'TemplateNotFoundError'
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
 * neither a name nor a publication state uses null as "leave alone". A null parent explicitly
 * places the template at the server root; absence leaves the parent alone.
 */
export interface TemplatePatch {
  readonly name?: string
  /** Moving to another node, or to the server root with null. */
  readonly nodeId?: string | null
  /** Null unpublishes; absent leaves publication alone. */
  readonly publishedAt?: Millis | null
  /** Null thaws; absent leaves the freeze alone. */
  readonly timelapseFrozenAt?: Millis | null
  /** Null reopens; a timestamp finishes; absent leaves the lifecycle alone. */
  readonly finishedAt?: Millis | null
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
  moveNode(
    nodeId: string,
    parentId: string | null,
    path: string,
    patch?: { readonly name?: string },
  ): Promise<boolean>

  deleteNode(nodeId: string): Promise<void>

  deleteNodeCascade(nodeId: string, expected: NodeDeletion): Promise<NodeDeletion>

  /** How much a cascading delete would remove, without removing it. */
  countNodeSubtree(nodeId: string): Promise<{ nodes: number; templates: number }>

  /** Atomically add a version, its tile index, and make it the template's current version. */
  insertTemplateVersion(
    version: TemplateVersionRecord,
    options?: { readonly requireExisting?: boolean },
  ): Promise<void>

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
   * Rename a template, move it to another node, or both. Returns false when the id does not exist,
   * or when a guarded move loses a race with another move or delete. A caller that distinguishes
   * those outcomes must re-read the row.
   *
   * Unlike `renameNode` this rewrites nothing else: a template is a leaf, so it carries no
   * materialized path and nothing hangs beneath it. Moving one is a single column.
   *
   * Throws `NodeNotFoundError` when the destination node does not exist — otherwise a typo would
   * silently orphan a template into a node nobody can navigate to.
   */
  updateTemplate(templateId: string, patch: TemplatePatch, updatedAt: Millis): Promise<boolean>

  /**
   * Delete a template with every version and tile index it owns. Returns false if it is absent or
   * no longer matches the revision the caller confirmed.
   *
   * **Chunks are deliberately left behind.** They are content-addressed and shared: two templates
   * with the same region, or two versions of one template that differ elsewhere, refer to the same
   * blob. Deleting by hash here would corrupt whatever else pointed at it, so reclaiming storage is
   * a sweep over hashes no version references — a separate job, and a safe one to never run.
   */
  deleteTemplate(templateId: string, expected: TemplateDeletePrecondition): Promise<boolean>

  listManifestTemplates(
    scope: TemplateManifestScope,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTemplateRecord[]>

  listManifestTiles(
    scope: TemplateManifestScope,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTileRecord[]>

  listTelemetryTargets(
    season: number,
    tile: TileCoord,
    includeUnpublished: boolean,
  ): Promise<readonly TelemetryTarget[]>

  readLatestTile(season: number, tile: TileCoord): Promise<LatestTileObservation | null>

  recordTileObservation(
    observation: TileObservation,
    statuses: readonly TemplateTileStatusRecord[],
    recordHistory?: boolean,
  ): Promise<void>

  /** The preferred readable physical object for a hash, if one is registered and unfenced. */
  readTileBlob(hash: string): Promise<TileBlobObject | null>

  /**
   * Reserve existing bytes for an observation. A candidate returns to active before its fence;
   * a deleting hash refuses until its old physical key has been reconciled.
   */
  reserveTileBlob(
    hash: string,
    reservationId: string,
    now: Millis,
    expiresAt: Millis,
  ): Promise<TileBlobReservation | null>

  /** Reuse an active/uploading generation, or reserve a fresh key before its bytes are written. */
  reserveTileBlobUpload(
    hash: string,
    blobKey: string,
    reservationId: string,
    now: Millis,
    expiresAt: Millis,
  ): Promise<TileBlobReservation | null>

  /**
   * Atomically verify the reservation, activate its object, and create both SQL reference kinds.
   * False means the reservation expired or a deletion fence won first; no reference was created.
   */
  commitTileBlobReservation(
    reservationId: string,
    now: Millis,
    observation: TileObservation,
    statuses: readonly TemplateTileStatusRecord[],
    recordHistory?: boolean,
  ): Promise<boolean>

  releaseTileBlobReservation(reservationId: string): Promise<void>

  /** Record one object found by a bounded R2 scan and classify it against live SQL references. */
  noteTileBlobObject(hash: string, blobKey: string, now: Millis): Promise<TileBlobCandidateResult>

  /** Deleting rows come first so interrupted work resumes before new candidates start. */
  listTileBlobDeletionWork(limit: number): Promise<readonly TileBlobObject[]>

  /** Fence a candidate only after atomically rechecking both reference tables and reservations. */
  claimTileBlobDeletion(blobKey: string, now: Millis): Promise<TileBlobClaimResult>

  /** Finalize an idempotent R2 delete. Only a fenced row can become deleted. */
  finishTileBlobDeletion(blobKey: string, reclaimedAt: Millis): Promise<void>

  readTileBlobScanState(): Promise<TileBlobScanState>

  writeTileBlobScanState(cursor: string | undefined): Promise<void>

  /** Fold the SQL history for one touched tile. Physical blob GC needs a separately safe protocol. */
  foldTileHistory(season: number, tile: TileCoord, now: Seconds): Promise<void>

  readTemplateStatuses(
    season: number,
    includeUnpublished: boolean,
  ): Promise<readonly TemplateStatus[]>

  /** Atomically evaluate and persist one complete template snapshot. */
  evaluateTemplateAlarm(
    snapshot: TemplateAlarmSnapshot,
    phase: AlarmEvaluationPhase,
    alarmId: string,
  ): Promise<AlarmPolicyResult>

  readActiveAlarms(season: number, includeUnpublished: boolean): Promise<readonly Alarm[]>

  listDueAlarmProbes(now: Millis): Promise<readonly AlarmProbe[]>

  nextAlarmProbeAt(): Promise<Millis | null>

  /** Drop a probe that could not produce a complete snapshot, if it still names this episode. */
  clearAlarmProbe(templateId: string, alarmId: string): Promise<void>

  /** Claims an idempotency key. False means this paint event was already accepted. */
  claimPaintEvent(eventId: string, wplaceUserId: number, seenAt: Millis): Promise<boolean>

  rememberPainter(wplaceUserId: number, displayName: string, seenAt: Millis): Promise<void>

  addContributions(deltas: readonly ContributionDelta[]): Promise<void>

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
   * Stored tokens newest first, tie-broken by hash. A query can continue strictly after a cursor and
   * bound the returned rows, so HTTP pagination never has to load the complete inventory.
   */
  listAccessTokens(query?: AccessTokenQuery): Promise<readonly AccessToken[]>

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

  /** Fold and prune eligible delta buckets for templates touched by the current write. */
  foldTelemetryBuckets(templateIds: readonly string[], now: Seconds): Promise<void>

  /**
   * Read folded buckets for a set of templates at one resolution over a half-open range.
   *
   * Rejects more than `MAX_READ_BUCKETS_TEMPLATE_IDS` distinct ids. Duplicate ids are read once.
   */
  readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]>

  /**
   * Per-painter-per-day contributions, reduced across reporters before anything sums them.
   *
   * `(wplace_user_id, template_id, day_s)` is deliberately not unique — every member of an alliance
   * reports, so several rows describe one painter's day. This read collapses them with the maximum
   * of each counter per (user, template, day), because a reporter that saw less of a day cannot
   * disprove one that saw more, and returns rows a caller may then sum freely. **No caller ever
   * sums the raw reporter rows** — that multiplies a painter's credit by their reporter count,
   * which is the exact failure mode the `contributions` schema comment exists to name.
   *
   * `displayName` comes from `painters` and falls back to the user id as a string, so a painter
   * seen only through another member's reports still has a label.
   *
   * Ordered by `compareContributionDays`. Rejects a query naming neither season nor templates, and
   * more than `MAX_READ_BUCKETS_TEMPLATE_IDS` distinct ids.
   */
  readContributions(query: ContributionQuery): Promise<readonly ContributionDay[]>

  /**
   * The subset of `ids` that name published templates, in input order with duplicates dropped.
   *
   * The publish gate for reads that take raw template ids and do not go through the manifest —
   * `/telemetry/history` resolves a read-scoped caller's ids through this before touching buckets,
   * so an unpublished template's telemetry is exactly as invisible as the template itself. An id
   * that names nothing is dropped silently: to a non-admin caller, missing and unpublished are
   * deliberately the same answer.
   *
   * Rejects more than `MAX_READ_BUCKETS_TEMPLATE_IDS` distinct ids — the same D1 bound-parameter
   * budget as every other id-list read.
   */
  filterPublishedTemplateIds(ids: readonly string[]): Promise<readonly string[]>

  /**
   * The latest accepted observation of every observed tile in a season, ordered by x then y.
   *
   * Unbounded on purpose: only observed tiles have rows, and reporters only observe tiles a
   * template covers, so this is thousands of rows at the outside — not the canvas's four million.
   */
  listLatestTiles(season: number): Promise<readonly LatestTileObservation[]>

  /**
   * One tile's timelapse frames at one `tile_history` tier over a half-open range.
   *
   * Rows are grouped by (bucketStart, hash) with reporters counted as distinct accounts, then
   * folded to one frame per bucket by `foldTileFrames` — most reporters wins, ties to the lexically
   * smaller hash — and returned in bucket order.
   */
  readTileHistory(query: TileHistoryQuery): Promise<readonly TileHistoryFrame[]>
}

/** Exact drawing surface selected by one manifest request. */
export interface TemplateManifestScope {
  readonly season: number
  readonly surface: TemplateSurface
}
