import {
  type CounterDelta,
  type CounterStore,
  GRACE_SECONDS,
  type PendingCounters,
  RESOLUTION_SECONDS,
  RETENTION_SECONDS,
  type SqlStore,
  type TelemetryBucket,
} from '../../ports/index.js'
import { MemorySqlStore } from './memory-sql-store.js'

interface BucketCounters {
  readonly templateId: string
  readonly bucketStart: number
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

const bucketKey = (templateId: string, bucketStart: number): string =>
  `${templateId}\u0000${bucketStart}`

const eventBucketStart = (occurredAt: number): number =>
  Math.floor(occurredAt / RESOLUTION_SECONDS) * RESOLUTION_SECONDS

const flushableAt = (bucketStart: number): number =>
  bucketStart + RESOLUTION_SECONDS + GRACE_SECONDS

const expiresAt = (bucketStart: number): number => flushableAt(bucketStart) + RETENTION_SECONDS

const hasActivity = ({ placed, correct, repairs }: CounterDelta): boolean =>
  placed !== 0 || correct !== 0 || repairs !== 0

/**
 * Portable counter-buffer implementation used by tests and non-Cloudflare entry points.
 *
 * `clock` returns Unix milliseconds, matching `Date.now` and Durable Object alarm timestamps.
 * Tests may call `alarm` at the injected time to emulate delivery of `nextAlarmAt`.
 */
export class MemoryCounterStore implements CounterStore {
  private readonly pending = new Map<string, BucketCounters>()
  private readonly flushBatch = new Map<string, BucketCounters>()
  private readonly retained = new Map<string, BucketCounters>()
  private readonly flushedAt = new Map<string, number>()
  private droppedLateCount = 0
  private alarmAt: number | null = null

  constructor(
    private readonly sql: SqlStore = new MemorySqlStore(),
    private readonly clock: () => number = Date.now,
  ) {}

  async record(deltas: readonly CounterDelta[]): Promise<void> {
    const nowMilliseconds = this.clock()
    const nowSeconds = Math.floor(nowMilliseconds / 1_000)

    for (const delta of deltas) {
      if (!hasActivity(delta)) continue

      const bucketStart = eventBucketStart(delta.occurredAt)
      if (expiresAt(bucketStart) <= nowSeconds) {
        this.droppedLateCount += 1
        continue
      }

      const key = bucketKey(delta.templateId, bucketStart)
      const current = this.pending.get(key)
      this.pending.set(key, {
        templateId: delta.templateId,
        bucketStart,
        placed: (current?.placed ?? 0) + delta.placed,
        correct: (current?.correct ?? 0) + delta.correct,
        repairs: (current?.repairs ?? 0) + delta.repairs,
      })
    }

    this.pruneRetained(nowSeconds)
    this.recomputeAlarm(nowMilliseconds)
  }

  async readPending(templateIds: readonly string[]): Promise<readonly PendingCounters[]> {
    const requested = new Set(templateIds)
    const totals = new Map<string, BucketCounters>()

    for (const counters of this.pending.values()) {
      if (!requested.has(counters.templateId)) continue

      const current = totals.get(counters.templateId)
      totals.set(counters.templateId, {
        templateId: counters.templateId,
        bucketStart: 0,
        placed: (current?.placed ?? 0) + counters.placed,
        correct: (current?.correct ?? 0) + counters.correct,
        repairs: (current?.repairs ?? 0) + counters.repairs,
      })
    }

    for (const [key, counters] of this.flushBatch) {
      if (!requested.has(counters.templateId)) continue

      // A late rewrite carries the full cumulative bucket total to SqlStore. Only the difference
      // from the retained, already-persisted value is still pending.
      const retained = this.retained.get(key)
      const current = totals.get(counters.templateId)
      totals.set(counters.templateId, {
        templateId: counters.templateId,
        bucketStart: 0,
        placed: (current?.placed ?? 0) + counters.placed - (retained?.placed ?? 0),
        correct: (current?.correct ?? 0) + counters.correct - (retained?.correct ?? 0),
        repairs: (current?.repairs ?? 0) + counters.repairs - (retained?.repairs ?? 0),
      })
    }

    return templateIds.map((templateId) => {
      const counters = totals.get(templateId)
      return {
        templateId,
        placed: counters?.placed ?? 0,
        correct: counters?.correct ?? 0,
        repairs: counters?.repairs ?? 0,
        flushedAt: this.flushedAt.get(templateId) ?? null,
      }
    })
  }

  async readDroppedLateCount(): Promise<number> {
    return this.droppedLateCount
  }

  /** Scheduled Unix-millisecond alarm, exposed so adapter tests can verify scheduling. */
  nextAlarmAt(): number | null {
    return this.alarmAt
  }

  /** Emulates one Durable Object alarm delivery at the injected clock time. */
  async alarm(): Promise<void> {
    const nowMilliseconds = this.clock()
    const nowSeconds = Math.floor(nowMilliseconds / 1_000)

    this.pruneRetained(nowSeconds)

    if (this.flushBatch.size === 0) {
      for (const [key, counters] of this.pending) {
        if (flushableAt(counters.bucketStart) > nowSeconds) continue

        const retained = this.retained.get(key)
        this.flushBatch.set(key, {
          templateId: counters.templateId,
          bucketStart: counters.bucketStart,
          placed: (retained?.placed ?? 0) + counters.placed,
          correct: (retained?.correct ?? 0) + counters.correct,
          repairs: (retained?.repairs ?? 0) + counters.repairs,
        })
        this.pending.delete(key)
      }
    }

    const buckets: readonly TelemetryBucket[] = [...this.flushBatch.values()].map((counters) => ({
      templateId: counters.templateId,
      resolution: RESOLUTION_SECONDS,
      bucketStart: counters.bucketStart,
      placed: counters.placed,
      correct: counters.correct,
      repairs: counters.repairs,
    }))

    if (buckets.length > 0) {
      try {
        await this.sql.appendBuckets(buckets)
      } catch (error) {
        this.recomputeAlarm(nowMilliseconds)
        throw error
      }

      for (const [key, counters] of this.flushBatch) {
        this.retained.set(key, { ...counters })
        this.flushedAt.set(counters.templateId, nowMilliseconds)
      }
      this.flushBatch.clear()
    }

    this.pruneRetained(nowSeconds)
    this.recomputeAlarm(nowMilliseconds)
  }

  private pruneRetained(nowSeconds: number): void {
    for (const [key, counters] of this.retained) {
      if (
        expiresAt(counters.bucketStart) <= nowSeconds &&
        !this.pending.has(key) &&
        !this.flushBatch.has(key)
      ) {
        this.retained.delete(key)
      }
    }
  }

  private recomputeAlarm(nowMilliseconds: number): void {
    if (this.flushBatch.size > 0) {
      this.alarmAt = nowMilliseconds
      return
    }

    let next: number | null = null
    for (const counters of this.pending.values()) {
      const candidate = Math.max(nowMilliseconds, flushableAt(counters.bucketStart) * 1_000)
      if (next === null || candidate < next) next = candidate
    }
    this.alarmAt = next
  }
}
