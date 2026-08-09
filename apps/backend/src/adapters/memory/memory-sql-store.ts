import { type Millis, WORLD_PIXELS } from '@wts/shared'
import {
  type AccessToken,
  assertValidAccessToken,
  assertValidBuckets,
  assertValidTemplateVersion,
  type BucketQuery,
  compareAccessTokens,
  compareBuckets,
  InvalidNodeParentError,
  MAX_READ_BUCKETS_TEMPLATE_IDS,
  type ManifestTemplateRecord,
  type ManifestTileRecord,
  NodeNotEmptyError,
  NodeNotFoundError,
  NodePathConflictError,
  type NodeRecord,
  type SqlStore,
  type TelemetryBucket,
  TemplateIdentityError,
  type TemplateVersionRecord,
  tooManyTemplateIds,
} from '../../ports/index.js'

/**
 * Fold a path the way SQLite's `lower()` does, which is ASCII only.
 *
 * `nodes_season_path_idx` is a unique index on `lower(path)`, so D1 treats `/QUÉBEC` and `/québec`
 * as different paths and stores both. JavaScript's `toLowerCase` folds all of Unicode and made the
 * oracle refuse a pair production accepts — the same asymmetry the wire schema already documents at
 * `foldPath`, reintroduced here. Stricter than production is the safer direction, but it is still a
 * divergence, and this store is what the route tests measure against.
 */
const foldPath = (path: string): string => path.replace(/[A-Z]/g, (c) => c.toLowerCase())

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
          candidate.season === node.season && foldPath(candidate.path) === foldPath(node.path),
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
    assertValidTemplateVersion(version)
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

    const previous = this.templates.get(version.templateId)
    if (previous !== undefined) {
      const current = this.templateVersions.get(previous.currentVersionId)
      const dimensions = (bbox: TemplateVersionRecord['bbox']) => ({
        width:
          bbox.maxX >= bbox.minX ? bbox.maxX - bbox.minX : WORLD_PIXELS - bbox.minX + bbox.maxX,
        height: bbox.maxY - bbox.minY,
      })
      const was = current === undefined ? null : dimensions(current.bbox)
      const now = dimensions(version.bbox)
      if (previous.name !== version.name) {
        throw new TemplateIdentityError(
          `template ${version.templateId} is named ${previous.name}, not ${version.name}`,
        )
      }
      if (was !== null && (was.width !== now.width || was.height !== now.height)) {
        throw new TemplateIdentityError(
          `template ${version.templateId} is ${was.width}x${was.height}, not ${now.width}x${now.height}`,
        )
      }
    }

    const existingTemplate = previous
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
