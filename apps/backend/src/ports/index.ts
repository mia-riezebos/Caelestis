export type { BlobNamespace, BlobStore } from './blob-store.js'
export { EVENT_TIME_SKEW_SECONDS, isValidCounterDelta } from './counter-delta.js'
export {
  type CounterDelta,
  type CounterStore,
  EXPIRES_AFTER_SECONDS,
  FLUSH_BATCH_LIMIT,
  FLUSHABLE_AFTER_SECONDS,
  GRACE_SECONDS,
  MAX_COUNTER_DELTA_VALUE,
  MAX_COUNTER_DELTAS_PER_RECORD,
  MAX_TEMPLATE_ID_LENGTH,
  type PendingCounters,
  RESOLUTION_SECONDS,
  RETENTION_SECONDS,
} from './counter-store.js'
export {
  type AccessToken,
  assertValidAccessToken,
  assertValidBuckets,
  assertValidTemplateVersion,
  type BucketQuery,
  type BucketStore,
  compareAccessTokens,
  compareBuckets,
  InvalidNodeParentError,
  invalidBucket,
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
  type TelemetryBucket,
  TemplateIdentityError,
  TemplateNotFoundError,
  type TemplatePatch,
  type TemplateRecord,
  type TemplateVersionRecord,
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
