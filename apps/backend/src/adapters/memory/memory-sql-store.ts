import {
  type BucketQuery,
  MAX_READ_BUCKETS_TEMPLATE_IDS,
  type SqlStore,
  type TelemetryBucket,
  tooManyTemplateIds,
} from '../../ports/index.js'

const bucketKey = (bucket: TelemetryBucket): string =>
  `${bucket.templateId}\u0000${bucket.resolution}\u0000${bucket.bucketStart}`

export class MemorySqlStore implements SqlStore {
  private readonly buckets = new Map<string, TelemetryBucket>()

  async appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void> {
    for (const bucket of buckets) {
      this.buckets.set(bucketKey(bucket), { ...bucket })
    }
  }

  async readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]> {
    const templateIds = new Set(query.templateIds)
    if (templateIds.size > MAX_READ_BUCKETS_TEMPLATE_IDS) throw tooManyTemplateIds(templateIds.size)

    return [...this.buckets.values()]
      .filter(
        (bucket) =>
          templateIds.has(bucket.templateId) &&
          bucket.resolution === query.resolution &&
          bucket.bucketStart >= query.fromSeconds &&
          bucket.bucketStart < query.toSeconds,
      )
      .sort(
        (left, right) =>
          left.templateId.localeCompare(right.templateId) || left.bucketStart - right.bucketStart,
      )
      .map((bucket) => ({ ...bucket }))
  }
}
