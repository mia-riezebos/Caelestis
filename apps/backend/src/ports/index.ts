export type { BlobListPage, BlobNamespace, BlobStore } from './blob-store.js'
export {
  addCounters,
  canAccumulateCounters,
  EVENT_TIME_SKEW_SECONDS,
  isValidCounterDelta,
} from './counter-delta.js'
export {
  type CounterDelta,
  type CounterStore,
  type CounterValues,
  EXPIRES_AFTER_SECONDS,
  FLUSH_BATCH_LIMIT,
  FLUSHABLE_AFTER_SECONDS,
  GRACE_SECONDS,
  MAX_COUNTER_DELTAS_PER_RECORD,
  MAX_TEMPLATE_ID_LENGTH,
  type PendingCounters,
  RESOLUTION_SECONDS,
  RETENTION_SECONDS,
} from './counter-store.js'
export {
  type AccessToken,
  type AccessTokenCursor,
  type AccessTokenQuery,
  type AlarmEvaluationPhase,
  type AlarmPolicyResult,
  type AlarmProbe,
  assertValidAccessToken,
  assertValidBuckets,
  assertValidContributionQuery,
  assertValidPublishedFilter,
  assertValidTemplateVersion,
  assertValidTileHistoryQuery,
  type BucketQuery,
  type BucketStore,
  type ContributionDelta,
  type ContributionQuery,
  compareAccessTokens,
  compareBuckets,
  compareContributionDays,
  DECAY_FOLD_GROUP_LIMIT,
  type DecayEdge,
  type FoldedTileRows,
  foldTileFrames,
  foldTileReporterRows,
  InvalidNodeParentError,
  invalidBucket,
  LADDER_RESOLUTIONS,
  type LatestTileObservation,
  MAX_NODE_PATH_LENGTH,
  MAX_READ_BUCKETS_TEMPLATE_IDS,
  type ManifestTemplateRecord,
  type ManifestTileRecord,
  type NodeDeletion,
  NodeNotEmptyError,
  NodeNotFoundError,
  NodePathConflictError,
  NodePathTooLongError,
  type NodeRecord,
  NodeSubtreeChangedError,
  READ_BUCKETS_CHUNK_SIZE,
  type ServerSettings,
  type SqlStore,
  TELEMETRY_DECAY_EDGES,
  type TelemetryBucket,
  type TelemetryTarget,
  type TemplateAlarmSnapshot,
  type TemplateAlarmState,
  type TemplateDeletePrecondition,
  TemplateIdentityError,
  type TemplateManifestScope,
  TemplateNotFoundError,
  type TemplatePatch,
  type TemplateRecord,
  type TemplateTileStatusRecord,
  type TemplateVersionRecord,
  TILE_HISTORY_DECAY_EDGES,
  TILE_HISTORY_RESOLUTIONS,
  type TileBlobCandidateResult,
  type TileBlobClaimResult,
  type TileBlobObject,
  type TileBlobObjectState,
  type TileBlobReservation,
  type TileBlobScanState,
  type TileFrameCandidate,
  type TileHistoryQuery,
  type TileHistoryReporterRow,
  type TileObservation,
  tooManyTemplateIds,
} from './sql-store.js'

import type { BlobStore } from './blob-store.js'
import type { CounterStore } from './counter-store.js'
import type { SqlStore } from './sql-store.js'

/**
 * Everything the app needs from its platform, and nothing else.
 *
 * `app.ts` takes this and imports no platform SDK, so the Cloudflare-vs-anything-else decision stays
 * confined to the adapters and the worker entry point.
 */
export interface Ports {
  readonly blobs: BlobStore
  readonly sql: SqlStore
  readonly counters: CounterStore
}
