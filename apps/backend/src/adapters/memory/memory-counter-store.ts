import {
  type CounterDelta,
  type CounterStore,
  EXPIRES_AFTER_SECONDS,
  FLUSH_BATCH_LIMIT,
  GRACE_SECONDS,
  isValidCounterDelta,
  MAX_COUNTER_DELTAS_PER_RECORD,
  type PendingCounters,
  RESOLUTION_SECONDS,
  type SqlStore,
  type TelemetryBucket,
} from '../../ports/index.js'

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

const expiresAt = (bucketStart: number): number => bucketStart + EXPIRES_AFTER_SECONDS

const hasActivity = ({ placed, correct, repairs }: CounterDelta): boolean =>
  placed > 0 || correct > 0 || repairs > 0

const INITIAL_FLUSH_RETRY_DELAY_MILLISECONDS = 1_000
const MAX_FLUSH_RETRY_DELAY_MILLISECONDS = 60_000

const flushRetryDelay = (failureCount: number): number =>
  Math.min(
    INITIAL_FLUSH_RETRY_DELAY_MILLISECONDS * 2 ** Math.max(0, failureCount - 1),
    MAX_FLUSH_RETRY_DELAY_MILLISECONDS,
  )

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
  private consecutiveFlushFailures = 0

  constructor(
    private readonly sql: SqlStore,
    private readonly clock: () => number = Date.now,
  ) {
    this.pruneRetained(Math.floor(this.clock() / 1_000))
  }

  async record(deltas: readonly CounterDelta[]): Promise<void> {
    const nowMilliseconds = this.clock()
    const nowSeconds = Math.floor(nowMilliseconds / 1_000)

    // Validation consults local traces, so sweep stale retained rows before asking that question.
    this.pruneRetained(nowSeconds)

    const boundedDeltas = deltas.slice(0, MAX_COUNTER_DELTAS_PER_RECORD)
    this.droppedLateCount += deltas.length - boundedDeltas.length

    for (const delta of boundedDeltas) {
      // Match TelemetryShard: invalid and out-of-window input share the existing rejection counter
      // because both have the same operational outcome and remediation.
      if (
        !isValidCounterDelta(delta, nowSeconds, (templateId, bucketStart) =>
          this.hasLocalTrace(templateId, bucketStart, nowSeconds),
        )
      ) {
        this.droppedLateCount += 1
        continue
      }
      if (!hasActivity(delta)) continue

      const bucketStart = eventBucketStart(delta.occurredAt)
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

    this.pruneZeroPending()
    this.recomputeAlarm(nowMilliseconds)
  }

  async readPending(templateIds: readonly string[]): Promise<readonly PendingCounters[]> {
    this.recomputeAlarm(this.clock())
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
      // from the last value confirmed persisted in SqlStore is still pending.
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
    this.pruneZeroPending()

    if (this.flushBatch.size === 0) {
      // Pending activity accumulated during a failed SqlStore write stays put. Once the preserved
      // batch succeeds and clears, the next alarm promotes and drains that pending activity.
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

    const batchEntries = [...this.flushBatch.entries()]
      .sort(([, left], [, right]) => {
        if (left.templateId < right.templateId) return -1
        if (left.templateId > right.templateId) return 1
        return left.bucketStart - right.bucketStart
      })
      .slice(0, FLUSH_BATCH_LIMIT)
    const buckets: readonly TelemetryBucket[] = batchEntries.map(([, counters]) => ({
      templateId: counters.templateId,
      resolution: RESOLUTION_SECONDS,
      bucketStart: counters.bucketStart,
      placed: counters.placed,
      correct: counters.correct,
      repairs: counters.repairs,
    }))

    if (buckets.length > 0) {
      // SqlStore must commit before retained advances. Advancing retained first makes readPending
      // subtract the batch from itself and report zero for an unbounded SqlStore outage. Writing
      // SqlStore first instead risks a transient over-count if the process dies after the commit but
      // before local bookkeeping; the next successful alarm rewrites the same cumulative value and
      // self-heals. Prefer that one-alarm crash window over incorrect totals for a whole outage.
      try {
        await this.sql.appendBuckets(buckets)
      } catch (error) {
        this.consecutiveFlushFailures += 1
        this.alarmAt = this.clock() + flushRetryDelay(this.consecutiveFlushFailures)
        throw error
      }

      this.consecutiveFlushFailures = 0
      for (const [key, counters] of batchEntries) {
        this.retained.set(key, { ...counters })
        this.flushedAt.set(counters.templateId, nowMilliseconds)
        this.flushBatch.delete(key)
      }
    }

    this.pruneRetained(nowSeconds)
    this.recomputeAlarm(nowMilliseconds)
  }

  private hasLocalTrace(templateId: string, bucketStart: number, nowSeconds: number): boolean {
    // The expiry instant is exclusive, so no local trace may rescue an expired bucket.
    if (expiresAt(bucketStart) <= nowSeconds) return false

    const key = bucketKey(templateId, bucketStart)
    return this.pending.has(key) || this.flushBatch.has(key) || this.retained.has(key)
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

  private pruneZeroPending(): void {
    // Defensive: valid deltas currently cannot create a zero row, but keep cleanup safe if input or
    // migration rules change later.
    for (const [key, counters] of this.pending) {
      if (counters.placed === 0 && counters.correct === 0 && counters.repairs === 0) {
        this.pending.delete(key)
      }
    }
  }

  private recomputeAlarm(nowMilliseconds: number): void {
    if (this.flushBatch.size > 0) {
      // readPending must preserve a future retry chosen by exponential backoff.
      if (this.alarmAt === null || this.alarmAt <= nowMilliseconds) {
        this.alarmAt = nowMilliseconds
      }
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
