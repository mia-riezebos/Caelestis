export type { BlobNamespace, BlobStore } from './blob-store.js'
export type { CounterDelta, CounterStore, PendingCounters } from './counter-store.js'
export type { BucketQuery, SqlStore, TelemetryBucket } from './sql-store.js'

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
