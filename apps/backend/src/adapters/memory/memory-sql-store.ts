import type { Millis } from '@wts/shared'
import type {
  AccessToken,
  BucketQuery,
  ManifestTemplateRecord,
  ManifestTileRecord,
  NodeRecord,
  SqlStore,
  TelemetryBucket,
  TemplateVersionRecord,
} from '../../ports/index.js'
import {
  InvalidNodeParentError,
  NodeNotEmptyError,
  NodeNotFoundError,
  NodePathConflictError,
} from '../../ports/index.js'

const bucketKey = (bucket: TelemetryBucket): string =>
  `${bucket.templateId}\u0000${bucket.resolution}\u0000${bucket.bucketStart}`

export class MemorySqlStore implements SqlStore {
  private readonly buckets = new Map<string, TelemetryBucket>()
  private readonly nodes = new Map<string, NodeRecord>()
  private readonly templates = new Map<
    string,
    Pick<TemplateVersionRecord, 'nodeId' | 'name' | 'createdAt'> & {
      currentVersionId: string
      publishedAt: Millis | null
    }
  >()
  private readonly templateVersions = new Map<string, TemplateVersionRecord>()
  private readonly tokens = new Map<string, AccessToken>()

  async insertNode(node: NodeRecord): Promise<void> {
    if (this.nodes.has(node.id)) throw new Error(`node already exists: ${node.id}`)
    if (
      [...this.nodes.values()].some(
        (candidate) =>
          candidate.season === node.season &&
          candidate.path.toLowerCase() === node.path.toLowerCase(),
      )
    ) {
      throw new NodePathConflictError(`node path is already taken in season ${node.season}`)
    }
    if (node.parentId !== null) {
      const parent = this.nodes.get(node.parentId)
      if (parent === undefined) throw new InvalidNodeParentError('parent node does not exist')
      if (parent.season !== node.season) {
        throw new InvalidNodeParentError('parent node belongs to a different season')
      }
    }
    this.nodes.set(node.id, { ...node })
  }

  async readNode(nodeId: string): Promise<NodeRecord | null> {
    const node = this.nodes.get(nodeId)
    return node === undefined ? null : { ...node }
  }

  async listNodes(season: number): Promise<readonly NodeRecord[]> {
    return [...this.nodes.values()]
      .filter((node) => node.season === season)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => ({ ...node }))
  }

  async deleteNode(nodeId: string): Promise<void> {
    if (!this.nodes.has(nodeId)) return
    const hasChildren = [...this.nodes.values()].some((node) => node.parentId === nodeId)
    const hasTemplates = [...this.templates.values()].some((template) => template.nodeId === nodeId)
    if (hasChildren || hasTemplates) {
      throw new NodeNotEmptyError('node has children or templates')
    }
    this.nodes.delete(nodeId)
  }

  async insertTemplateVersion(version: TemplateVersionRecord): Promise<void> {
    if (!this.nodes.has(version.nodeId)) {
      throw new NodeNotFoundError(`node does not exist: ${version.nodeId}`)
    }
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
      createdAt: version.createdAt,
      currentVersionId: version.versionId,
      publishedAt: null,
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
      bbox: { ...version.bbox },
      chunks: version.chunks.map((chunk) => ({ ...chunk })),
    }
  }

  async setTemplatePublishedAt(templateId: string, publishedAt: Millis | null): Promise<boolean> {
    const template = this.templates.get(templateId)
    if (template === undefined) return false
    this.templates.set(templateId, { ...template, publishedAt })
    return true
  }

  async listManifestTemplates(
    season: number,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTemplateRecord[]> {
    const records: ManifestTemplateRecord[] = []
    for (const [id, template] of this.templates) {
      const node = this.nodes.get(template.nodeId)
      const version = this.templateVersions.get(template.currentVersionId)
      if (
        node === undefined ||
        node.season !== season ||
        version === undefined ||
        (!includeUnpublished && template.publishedAt === null)
      ) {
        continue
      }
      records.push({
        id,
        nodeId: template.nodeId,
        name: template.name,
        versionId: version.versionId,
        bbox: { ...version.bbox },
        totalPixels: version.totalPixels,
        published: template.publishedAt !== null,
        createdAt: template.createdAt,
      })
    }
    return records.sort((left, right) => left.id.localeCompare(right.id))
  }

  async listManifestTiles(
    season: number,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTileRecord[]> {
    const records: ManifestTileRecord[] = []
    for (const [templateId, template] of this.templates) {
      const node = this.nodes.get(template.nodeId)
      const version = this.templateVersions.get(template.currentVersionId)
      if (
        node === undefined ||
        node.season !== season ||
        version === undefined ||
        (!includeUnpublished && template.publishedAt === null)
      ) {
        continue
      }
      records.push(...version.chunks.map((chunk) => ({ templateId, ...chunk })))
    }
    return records
  }

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
