import {
  type AccessToken,
  assertValidAccessToken,
  assertValidBuckets,
  assertValidTemplateVersion,
  type BucketQuery,
  compareAccessTokens,
  compareBuckets,
  MAX_READ_BUCKETS_TEMPLATE_IDS,
  type SqlStore,
  type TelemetryBucket,
  type TemplateVersionRecord,
  tooManyTemplateIds,
} from '../../ports/index.js'

const bucketKey = (bucket: TelemetryBucket): string =>
  `${bucket.templateId}\u0000${bucket.resolution}\u0000${bucket.bucketStart}`

export class MemorySqlStore implements SqlStore {
  private readonly buckets = new Map<string, TelemetryBucket>()
  private readonly templates = new Map<
    string,
    Pick<TemplateVersionRecord, 'nodeId' | 'name' | 'season' | 'createdAt'> & {
      currentVersionId: string
    }
  >()
  private readonly templateVersions = new Map<string, TemplateVersionRecord>()
  private readonly tokens = new Map<string, AccessToken>()

  async insertTemplateVersion(version: TemplateVersionRecord): Promise<void> {
    assertValidTemplateVersion(version)
    if (this.templateVersions.has(version.versionId)) {
      throw new Error(`template version already exists: ${version.versionId}`)
    }
    const tileKeys = new Set(version.chunks.map((chunk) => `${chunk.tileX}/${chunk.tileY}`))
    if (tileKeys.size !== version.chunks.length) {
      throw new Error(`template version repeats a tile: ${version.versionId}`)
    }

    const existingTemplate = this.templates.get(version.templateId)
    const template = existingTemplate ?? {
      nodeId: version.nodeId,
      name: version.name,
      season: version.season,
      createdAt: version.createdAt,
      currentVersionId: version.versionId,
    }
    this.templateVersions.set(version.versionId, {
      ...version,
      bbox: { ...version.bbox },
      chunks: version.chunks.map((chunk) => ({ ...chunk })),
    })
    this.templates.set(version.templateId, { ...template, currentVersionId: version.versionId })
  }

  async readTemplateVersion(versionId: string): Promise<TemplateVersionRecord | null> {
    const version = this.templateVersions.get(versionId)
    if (version === undefined) return null
    const template = this.templates.get(version.templateId)
    if (template === undefined) return null

    return {
      ...version,
      nodeId: template.nodeId,
      name: template.name,
      season: template.season,
      bbox: { ...version.bbox },
      chunks: version.chunks.map((chunk) => ({ ...chunk })),
    }
  }

  async appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void> {
    assertValidBuckets(buckets)
    for (const bucket of buckets) {
      this.buckets.set(bucketKey(bucket), { ...bucket })
    }
  }

  async insertAccessToken(token: AccessToken): Promise<void> {
    assertValidAccessToken(token)
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
    return [...this.tokens.values()].sort(compareAccessTokens).map((token) => ({ ...token }))
  }

  async revokeAccessToken(tokenHash: string): Promise<void> {
    // Idempotent because deleting an absent key is a no-op. Reports the credential wrote are held
    // elsewhere and are untouched by this, which is the point: revoking ends future access, it does
    // not edit what was observed.
    this.tokens.delete(tokenHash)
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
      .sort(compareBuckets)
      .map((bucket) => ({ ...bucket }))
  }
}
