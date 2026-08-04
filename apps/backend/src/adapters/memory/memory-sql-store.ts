import type { Millis } from '@wts/shared'
import type { AccessToken, BucketQuery, SqlStore, TelemetryBucket } from '../../ports/index.js'

const bucketKey = (bucket: TelemetryBucket): string =>
  `${bucket.templateId}\u0000${bucket.resolution}\u0000${bucket.bucketStart}`

export class MemorySqlStore implements SqlStore {
  private readonly buckets = new Map<string, TelemetryBucket>()
  private readonly tokens = new Map<string, AccessToken>()

  async appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void> {
    for (const bucket of buckets) {
      this.buckets.set(bucketKey(bucket), { ...bucket })
    }
  }

  async insertAccessToken(token: AccessToken): Promise<void> {
    if (this.tokens.has(token.tokenHash)) {
      throw new Error(`access token already exists: ${token.tokenHash}`)
    }
    this.tokens.set(token.tokenHash, { ...token })
  }

  async readAccessToken(tokenHash: string): Promise<AccessToken | null> {
    const token = this.tokens.get(tokenHash)
    return token === undefined ? null : { ...token }
  }

  async listAccessTokens(): Promise<readonly AccessToken[]> {
    return [...this.tokens.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((token) => ({ ...token }))
  }

  async revokeAccessToken(tokenHash: string, revokedAt: Millis): Promise<void> {
    const token = this.tokens.get(tokenHash)
    // Idempotent, and the first instant wins: the audit question is when the credential stopped
    // being usable, so a second call must not move it.
    if (token === undefined || token.revokedAt !== null) return
    this.tokens.set(tokenHash, { ...token, revokedAt })
  }

  async readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]> {
    const templateIds = new Set(query.templateIds)

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
