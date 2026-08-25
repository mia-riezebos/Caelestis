import { type Millis, type TemplateStatus, tileKey, WORLD_PIXELS } from '@caelestis/shared'
import {
  type AccessToken,
  type AccessTokenQuery,
  assertValidAccessToken,
  assertValidBuckets,
  assertValidTemplateVersion,
  type BucketQuery,
  type ContributionDelta,
  compareAccessTokens,
  compareBuckets,
  InvalidNodeParentError,
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
  type ServerSettings,
  type SqlStore,
  type TelemetryBucket,
  type TelemetryTarget,
  TemplateIdentityError,
  TemplateNotFoundError,
  type TemplatePatch,
  type TemplateRecord,
  type TemplateTileStatusRecord,
  type TemplateVersionRecord,
  type TileObservation,
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
    Pick<TemplateVersionRecord, 'season' | 'nodeId' | 'name' | 'createdAt'> & {
      currentVersionId: string
      publishedAt: Millis | null
      updatedAt: Millis
    }
  >()
  private readonly templateVersions = new Map<string, TemplateVersionRecord>()
  private readonly tokens = new Map<string, AccessToken>()
  private readonly canvasTiles = new Map<string, TileObservation>()
  private readonly templateTileStatuses = new Map<string, TemplateTileStatusRecord>()
  private readonly appliedEvents = new Set<string>()
  private readonly painters = new Map<number, { displayName: string; seenAt: Millis }>()
  private readonly contributions = new Map<string, ContributionDelta>()

  private settings: ServerSettings = { name: null, description: null }

  async readServerSettings(): Promise<ServerSettings> {
    return { ...this.settings }
  }

  async writeServerSettings(patch: { name?: string; description?: string | null }): Promise<void> {
    this.settings = {
      name: patch.name ?? this.settings.name,
      description: patch.description === undefined ? this.settings.description : patch.description,
    }
  }

  async insertNode(node: NodeRecord): Promise<NodeRecord> {
    if (this.nodes.has(node.id)) throw new Error(`node already exists: ${node.id}`)

    // Composed before anything is checked. Checking the caller's path and storing a different one
    // let a child land on a path the check had already cleared as free — two rows, one path, and the
    // oracle disagreeing with a database that has a unique index to stop exactly that.
    // Roots get the same treatment as children: only the last segment is the caller's, so a stale
    // multi-segment proposal cannot create a root whose path claims to be nested.
    const segment = node.path.slice(node.path.lastIndexOf('/') + 1)
    let path = `/${segment}`
    if (node.parentId !== null) {
      const parent = this.nodes.get(node.parentId)
      if (parent === undefined) throw new InvalidNodeParentError('parent node does not exist')
      if (parent.season !== node.season) {
        throw new InvalidNodeParentError('parent node belongs to a different season')
      }
      path = `${parent.path}/${segment}`
    }

    if (path.length > MAX_NODE_PATH_LENGTH) {
      throw new NodePathTooLongError(`node path is longer than ${MAX_NODE_PATH_LENGTH}`)
    }
    if (
      [...this.nodes.values()].some(
        (candidate) =>
          candidate.season === node.season && foldPath(candidate.path) === foldPath(path),
      )
    ) {
      throw new NodePathConflictError(`node path is already taken in season ${node.season}`)
    }

    const inserted = { ...node, path }
    this.nodes.set(node.id, inserted)
    return inserted
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

  async renameNode(nodeId: string, name: string, segment: string): Promise<NodeRecord | null> {
    const node = this.nodes.get(nodeId)
    if (node === undefined) return null
    // Composed from the parent row rather than from this node's own path — see the port docstring on
    // why a caller-supplied path is a race. Reading it off the node's own path would keep whatever
    // case that prefix was stored in, so a child at `/CANADA/x` under a parent at `/canada` renamed
    // to `/CANADA/new` here and `/canada/new` in production. Both are legal; only one can be right.
    const parentPath = node.parentId === null ? '' : (this.nodes.get(node.parentId)?.path ?? '')
    const path = `${parentPath}/${segment}`

    const oldPrefix = `${node.path}/`
    // Folded, because SQLite's LIKE is case-insensitive over ASCII and so selects `/CANADA/x` under
    // the prefix `/canada/`. A case-sensitive match here would leave that child behind in the oracle
    // while production moved it.
    //
    // No reachable state needs it any more: `insertNode` composes a child's prefix from its parent,
    // so a tree cannot hold two spellings of one prefix, and there is deliberately no test for it.
    // Kept because the fold is what SQLite does, and this store's job is to answer as SQLite would —
    // if such a row ever arrives, from a migration or a future write path, the two still agree.
    const foldedPrefix = foldPath(oldPrefix)
    const descendants = [...this.nodes.values()].filter(
      (candidate) =>
        candidate.season === node.season && foldPath(candidate.path).startsWith(foldedPrefix),
    )

    const rewritten = descendants.map((descendant) => ({
      ...descendant,
      path: `${path}${descendant.path.slice(node.path.length)}`,
    }))

    // Length before collision, matching D1 — which cannot ask its unique index anything until the
    // write, so the order is not a choice there. Checked the other way round, a rename that both
    // collides and overflows answered 409 here and 400 in production.
    // Reduced rather than spread: a season may hold 100,000 nodes and that many arguments is a
    // RangeError, not a large number.
    const longest = rewritten.reduce(
      (worst, entry) => Math.max(worst, entry.path.length),
      path.length,
    )
    if (longest > MAX_NODE_PATH_LENGTH) {
      throw new NodePathTooLongError(
        `rename would derive a path longer than ${MAX_NODE_PATH_LENGTH}`,
      )
    }

    const taken = [...this.nodes.values()].some(
      (candidate) =>
        candidate.id !== nodeId &&
        candidate.season === node.season &&
        foldPath(candidate.path) === foldPath(path),
    )
    if (taken) {
      throw new NodePathConflictError(`node path is already taken in season ${node.season}`)
    }

    const renamed = { ...node, name, path }
    this.nodes.set(nodeId, renamed)
    for (const descendant of rewritten) this.nodes.set(descendant.id, descendant)
    return renamed
  }

  async moveNode(
    nodeId: string,
    parentId: string | null,
    proposedPath: string,
    patch: { readonly name?: string } = {},
  ): Promise<boolean> {
    const node = this.nodes.get(nodeId)
    if (node === undefined) return false

    let parent: NodeRecord | undefined
    if (parentId !== null) {
      parent = this.nodes.get(parentId)
      if (parent === undefined) throw new InvalidNodeParentError('parent node does not exist')
      if (parent.season !== node.season) {
        throw new InvalidNodeParentError('parent node belongs to a different season')
      }
      // A parent inside this subtree would make the moved branch unreachable: its new path would
      // depend on a descendant whose own path is being rewritten from the branch's old prefix.
      if (parent.id === node.id || parent.path.startsWith(`${node.path}/`)) {
        throw new InvalidNodeParentError(
          'parent node cannot be the node itself or one of its descendants',
        )
      }
    }

    // A parent-only move keeps the node's live path segment. The route's proposed path comes from
    // an earlier read and may carry the slug from a rename this store has already observed.
    const segment =
      patch.name === undefined
        ? node.path.slice(node.path.lastIndexOf('/') + 1)
        : proposedPath.slice(proposedPath.lastIndexOf('/') + 1)
    const path = `${parent?.path ?? ''}/${segment}`
    const oldPrefix = `${node.path}/`
    const foldedPrefix = foldPath(oldPrefix)
    const descendants = [...this.nodes.values()].filter(
      (candidate) =>
        candidate.season === node.season && foldPath(candidate.path).startsWith(foldedPrefix),
    )
    const movedIds = new Set([node.id, ...descendants.map(({ id }) => id)])
    const rewritten = descendants.map((descendant) => ({
      ...descendant,
      path: `${path}${descendant.path.slice(node.path.length)}`,
    }))
    const longest = rewritten.reduce(
      (worst, entry) => Math.max(worst, entry.path.length),
      path.length,
    )
    if (longest > MAX_NODE_PATH_LENGTH) {
      throw new NodePathTooLongError(`move would derive a path longer than ${MAX_NODE_PATH_LENGTH}`)
    }
    const rewrittenPaths = new Set([path, ...rewritten.map(({ path: next }) => next)].map(foldPath))
    const taken = [...this.nodes.values()].some(
      (candidate) =>
        candidate.season === node.season &&
        !movedIds.has(candidate.id) &&
        rewrittenPaths.has(foldPath(candidate.path)),
    )
    if (taken) {
      throw new NodePathConflictError(`node path is already taken in season ${node.season}`)
    }

    this.nodes.set(node.id, { ...node, parentId, path, name: patch.name ?? node.name })
    for (const descendant of rewritten) this.nodes.set(descendant.id, descendant)
    return true
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

  async countNodeSubtree(nodeId: string): Promise<{ nodes: number; templates: number }> {
    const node = this.nodes.get(nodeId)
    if (node === undefined) throw new NodeNotFoundError(`node does not exist: ${nodeId}`)
    const prefix = `${node.path}/`
    const nodeIds = new Set(
      [...this.nodes.values()]
        .filter(
          (candidate) =>
            candidate.season === node.season &&
            (candidate.id === nodeId || candidate.path.startsWith(prefix)),
        )
        .map((candidate) => candidate.id),
    )
    const templates = [...this.templates.values()].filter(
      (template) => template.nodeId !== null && nodeIds.has(template.nodeId),
    ).length
    return { nodes: nodeIds.size, templates }
  }

  async deleteNodeCascade(nodeId: string, expected: NodeDeletion): Promise<NodeDeletion> {
    const node = this.nodes.get(nodeId)
    if (node === undefined) throw new NodeNotFoundError(`node does not exist: ${nodeId}`)
    const prefix = `${node.path}/`
    const nodeIds = new Set(
      [...this.nodes.values()]
        .filter(
          (candidate) =>
            candidate.season === node.season &&
            (candidate.id === nodeId || candidate.path.startsWith(prefix)),
        )
        .map((candidate) => candidate.id),
    )
    const templateIds = new Set(
      [...this.templates.entries()]
        .filter(([, template]) => template.nodeId !== null && nodeIds.has(template.nodeId))
        .map(([templateId]) => templateId),
    )
    if (nodeIds.size !== expected.nodes || templateIds.size !== expected.templates) {
      throw new NodeSubtreeChangedError('node subtree changed after it was counted')
    }
    // The collections do not enforce foreign keys, but this deliberately follows D1's safe order:
    // remove versions, then their templates, and only then their nodes.
    for (const [versionId, version] of this.templateVersions) {
      if (!templateIds.has(version.templateId)) continue
      this.templateVersions.delete(versionId)
    }
    for (const templateId of templateIds) this.templates.delete(templateId)
    for (const descendantId of nodeIds) this.nodes.delete(descendantId)

    return { nodes: nodeIds.size, templates: templateIds.size }
  }

  async insertTemplateVersion(
    version: TemplateVersionRecord,
    options: { readonly requireExisting?: boolean } = {},
  ): Promise<void> {
    assertValidTemplateVersion(version)
    if (
      options.requireExisting !== true &&
      version.nodeId !== null &&
      !this.nodes.has(version.nodeId)
    ) {
      throw new NodeNotFoundError(`node does not exist: ${version.nodeId}`)
    }
    const destination = version.nodeId === null ? null : this.nodes.get(version.nodeId)
    if (
      options.requireExisting !== true &&
      destination !== null &&
      destination?.season !== version.season
    ) {
      throw new InvalidNodeParentError('destination node belongs to a different season')
    }
    if (this.templateVersions.has(version.versionId)) {
      throw new Error(`template version already exists: ${version.versionId}`)
    }
    const tileKeys = new Set(version.chunks.map((chunk) => `${chunk.tileX}/${chunk.tileY}`))
    if (tileKeys.size !== version.chunks.length) {
      throw new Error(`template version repeats a tile: ${version.versionId}`)
    }

    const previous = this.templates.get(version.templateId)
    if (options.requireExisting === true && previous === undefined) {
      throw new TemplateNotFoundError(`template does not exist: ${version.templateId}`)
    }
    if (previous !== undefined) {
      const current = this.templateVersions.get(previous.currentVersionId)
      const dimensions = (bbox: TemplateVersionRecord['bbox']) => ({
        width:
          bbox.maxX >= bbox.minX ? bbox.maxX - bbox.minX : WORLD_PIXELS - bbox.minX + bbox.maxX,
        height: bbox.maxY - bbox.minY,
      })
      const was = current === undefined ? null : dimensions(current.bbox)
      const now = dimensions(version.bbox)
      if (was !== null && (was.width !== now.width || was.height !== now.height)) {
        throw new TemplateIdentityError(
          `template ${version.templateId} is ${was.width}x${was.height}, not ${now.width}x${now.height}`,
        )
      }
    }

    const existingTemplate = previous
    const template = existingTemplate ?? {
      season: version.season,
      nodeId: version.nodeId,
      name: version.name,
      createdAt: version.createdAt,
      currentVersionId: version.versionId,
      publishedAt: null,
      updatedAt: version.createdAt,
    }
    this.templateVersions.set(version.versionId, {
      ...version,
      bbox: { ...version.bbox },
      chunks: version.chunks.map((chunk) => ({ ...chunk })),
    })
    // New pixels are a change like any other. An existing template keeps its name, parent, published
    // state and creation date — only what it points at, and when it last moved, are its own.
    this.templates.set(version.templateId, {
      ...template,
      currentVersionId: version.versionId,
      updatedAt: version.createdAt,
    })
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

  async readTemplate(templateId: string): Promise<TemplateRecord | null> {
    const template = this.templates.get(templateId)
    if (template === undefined) return null
    return {
      id: templateId,
      season: template.season,
      nodeId: template.nodeId,
      name: template.name,
      currentVersionId: template.currentVersionId,
      published: template.publishedAt !== null,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    }
  }

  async setTemplatePublishedAt(
    templateId: string,
    publishedAt: Millis | null,
    updatedAt: Millis,
  ): Promise<boolean> {
    return await this.updateTemplate(templateId, { publishedAt }, updatedAt)
  }

  async updateTemplate(
    templateId: string,
    patch: TemplatePatch,
    updatedAt: Millis,
  ): Promise<boolean> {
    const template = this.templates.get(templateId)
    if (template === undefined) return false
    if (patch.nodeId !== undefined && patch.nodeId !== null && !this.nodes.has(patch.nodeId)) {
      throw new NodeNotFoundError(`node does not exist: ${patch.nodeId}`)
    }
    if (patch.nodeId !== undefined && patch.nodeId !== null) {
      const destination = this.nodes.get(patch.nodeId)
      if (destination?.season !== template.season) {
        throw new InvalidNodeParentError('destination node belongs to a different season')
      }
    }
    this.templates.set(templateId, {
      ...template,
      name: patch.name ?? template.name,
      nodeId: patch.nodeId === undefined ? template.nodeId : patch.nodeId,
      publishedAt: patch.publishedAt === undefined ? template.publishedAt : patch.publishedAt,
      updatedAt,
    })
    return true
  }

  async deleteTemplate(templateId: string): Promise<boolean> {
    if (!this.templates.delete(templateId)) return false
    for (const [versionId, version] of this.templateVersions) {
      if (version.templateId === templateId) this.templateVersions.delete(versionId)
    }
    for (const [key, status] of this.templateTileStatuses) {
      if (status.templateId === templateId) this.templateTileStatuses.delete(key)
    }
    for (const [key, contribution] of this.contributions) {
      if (contribution.templateId === templateId) this.contributions.delete(key)
    }
    // Chunks are not touched: they are content-addressed and shared. See `deleteTemplate` on the port.
    return true
  }

  async listManifestTemplates(
    season: number,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTemplateRecord[]> {
    const records: ManifestTemplateRecord[] = []
    for (const [id, template] of this.templates) {
      const version = this.templateVersions.get(template.currentVersionId)
      if (
        template.season !== season ||
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
        updatedAt: template.updatedAt,
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
      const version = this.templateVersions.get(template.currentVersionId)
      if (
        template.season !== season ||
        version === undefined ||
        (!includeUnpublished && template.publishedAt === null)
      ) {
        continue
      }
      records.push(
        ...version.chunks.map((chunk) => ({
          templateId,
          versionId: version.versionId,
          ...chunk,
        })),
      )
    }
    return records
  }

  async listTelemetryTargets(
    season: number,
    tile: { readonly x: number; readonly y: number },
    includeUnpublished: boolean,
  ): Promise<readonly TelemetryTarget[]> {
    const targets: TelemetryTarget[] = []
    for (const [templateId, template] of this.templates) {
      const version = this.templateVersions.get(template.currentVersionId)
      if (
        template.season !== season ||
        version === undefined ||
        (!includeUnpublished && template.publishedAt === null)
      )
        continue
      const chunk = version.chunks.find((entry) => entry.tileX === tile.x && entry.tileY === tile.y)
      if (chunk === undefined) continue
      targets.push({
        templateId,
        versionId: version.versionId,
        tileX: tile.x,
        tileY: tile.y,
        hash: chunk.hash,
        bbox: { ...version.bbox },
      })
    }
    return targets.sort((left, right) => left.templateId.localeCompare(right.templateId))
  }

  async readLatestTile(
    season: number,
    tile: {
      readonly x: number
      readonly y: number
    },
  ): Promise<TileObservation | null> {
    const held = this.canvasTiles.get(`${season}\u0000${tileKey(tile)}`)
    return held === undefined ? null : { ...held, tile: { ...held.tile } }
  }

  async recordTileObservation(
    observation: TileObservation,
    statuses: readonly TemplateTileStatusRecord[],
  ): Promise<void> {
    const key = `${observation.season}\u0000${tileKey(observation.tile)}`
    const held = this.canvasTiles.get(key)
    if (held === undefined || held.observedAt <= observation.observedAt) {
      this.canvasTiles.set(key, { ...observation, tile: { ...observation.tile } })
    }
    for (const status of statuses) {
      const statusKey = `${status.templateId}\u0000${status.versionId}\u0000${tileKey(status.tile)}`
      const current = this.templateTileStatuses.get(statusKey)
      if (current === undefined || current.observedAt <= status.observedAt) {
        this.templateTileStatuses.set(statusKey, { ...status, tile: { ...status.tile } })
      }
    }
  }

  async readTemplateStatuses(
    season: number,
    includeUnpublished: boolean,
  ): Promise<readonly TemplateStatus[]> {
    const out: TemplateStatus[] = []
    for (const [templateId, template] of this.templates) {
      const version = this.templateVersions.get(template.currentVersionId)
      if (
        template.season !== season ||
        version === undefined ||
        (!includeUnpublished && template.publishedAt === null)
      )
        continue
      const statuses = [...this.templateTileStatuses.values()].filter(
        (status) => status.templateId === templateId && status.versionId === version.versionId,
      )
      if (statuses.length === 0) continue
      const classified = new Map<
        number,
        { correct: number; wrong: number; blank: number; total: number }
      >()
      for (const status of statuses) {
        for (const colour of status.colours ?? []) {
          const held = classified.get(colour.index)
          classified.set(colour.index, {
            correct: (held?.correct ?? 0) + colour.correct,
            wrong: (held?.wrong ?? 0) + colour.wrong,
            blank: (held?.blank ?? 0) + colour.blank,
            total: (held?.total ?? 0) + colour.total,
          })
        }
      }
      const classifiedTotals = [...classified].map(([index, colour]) => ({
        index,
        total: colour.total,
      }))
      const colourTotals =
        version.colourTotals ??
        (classifiedTotals.reduce((sum, colour) => sum + colour.total, 0) === version.totalPixels
          ? classifiedTotals.sort((left, right) => left.index - right.index)
          : undefined)
      out.push({
        templateId,
        correct: statuses.reduce((total, status) => total + status.correct, 0),
        wrong: statuses.reduce((total, status) => total + status.wrong, 0),
        blank: statuses.reduce((total, status) => total + status.blank, 0),
        total: version.totalPixels,
        ...(colourTotals === undefined
          ? {}
          : {
              colours: colourTotals.map(({ index, total }) => ({
                index,
                total,
                correct: classified.get(index)?.correct ?? 0,
                wrong: classified.get(index)?.wrong ?? 0,
                blank: classified.get(index)?.blank ?? 0,
              })),
            }),
        observedAt: statuses.reduce(
          (latest, status) => Math.max(latest, status.observedAt),
          statuses[0]?.observedAt ?? 0,
        ) as Millis,
      })
    }
    return out.sort((left, right) => left.templateId.localeCompare(right.templateId))
  }

  async claimPaintEvent(eventId: string, _wplaceUserId: number, _seenAt: Millis): Promise<boolean> {
    if (this.appliedEvents.has(eventId)) return false
    this.appliedEvents.add(eventId)
    return true
  }

  async rememberPainter(wplaceUserId: number, displayName: string, seenAt: Millis): Promise<void> {
    const held = this.painters.get(wplaceUserId)
    if (held === undefined || held.seenAt <= seenAt)
      this.painters.set(wplaceUserId, { displayName, seenAt })
  }

  async addContributions(deltas: readonly ContributionDelta[]): Promise<void> {
    for (const delta of deltas) {
      const key = `${delta.wplaceUserId}\u0000${delta.templateId}\u0000${delta.day}\u0000${delta.reportedByUserId}`
      const held = this.contributions.get(key)
      this.contributions.set(key, {
        ...delta,
        placed: (held?.placed ?? 0) + delta.placed,
        correct: (held?.correct ?? 0) + delta.correct,
        repairs: (held?.repairs ?? 0) + delta.repairs,
      })
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

  async listAccessTokens(query: AccessTokenQuery = {}): Promise<readonly AccessToken[]> {
    const ordered = [...this.tokens.values()].sort(compareAccessTokens)
    const after = query.after
    const remaining =
      after === undefined
        ? ordered
        : ordered.filter(
            (token) =>
              token.createdAt < after.createdAt ||
              (token.createdAt === after.createdAt && token.tokenHash > after.tokenHash),
          )
    const page = query.limit === undefined ? remaining : remaining.slice(0, query.limit)
    return page.map((token) => ({ ...token }))
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
