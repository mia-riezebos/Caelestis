import {
  type Alarm,
  type ContributionDay,
  type Millis,
  type Seconds,
  sameTemplateSurface,
  seconds,
  type TemplateStatus,
  type TemplateSurface,
  type TileCoord,
  type TileHistoryFrame,
  tileKey,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
  WORLD_TILES,
} from '@caelestis/shared'
import {
  type AccessToken,
  type AccessTokenQuery,
  type AlarmEvaluationPhase,
  type AlarmPolicyResult,
  type AlarmProbe,
  type AlarmTileRecord,
  assertValidAccessToken,
  assertValidBuckets,
  assertValidContributionQuery,
  assertValidPublishedFilter,
  assertValidTemplateVersion,
  assertValidTileHistoryQuery,
  type BucketQuery,
  type ContributionDelta,
  type ContributionQuery,
  compareAccessTokens,
  compareBuckets,
  compareContributionDays,
  DECAY_FOLD_GROUP_LIMIT,
  foldTileFrames,
  foldTileReporterRows,
  InvalidNodeParentError,
  type LatestTileObservation,
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
  TELEMETRY_DECAY_EDGES,
  type TelemetryBucket,
  type TelemetryTarget,
  type TemplateAlarmSnapshot,
  type TemplateAlarmState,
  type TemplateDeletePrecondition,
  TemplateIdentityError,
  type TemplateManifestScope,
  TemplateNotFoundError,
  type TemplatePatch,
  type TemplateRecord,
  type TemplateTileStatusRecord,
  type TemplateVersionRecord,
  TILE_HISTORY_DECAY_EDGES,
  type TileBlobCandidateResult,
  type TileBlobClaimResult,
  type TileBlobObject,
  type TileBlobReservation,
  type TileBlobScanState,
  type TileHistoryQuery,
  type TileHistoryReporterRow,
  type TileObservation,
  type TileObservationCommit,
  tooManyTemplateIds,
} from '../../ports/index.js'
import {
  ALARM_FOLLOW_UP_DELAY_MILLISECONDS,
  evaluateAlarmSnapshot,
} from '../../telemetry/alarm-policy.js'

/**
 * Fold a path the way SQLite's `lower()` does, which is ASCII only.
 *
 * The node path indexes use `lower(path)`, so D1 treats `/QUÉBEC` and `/québec`
 * as different paths and stores both. JavaScript's `toLowerCase` folds all of Unicode and made the
 * oracle refuse a pair production accepts — the same asymmetry the wire schema already documents at
 * `foldPath`, reintroduced here. Stricter than production is the safer direction, but it is still a
 * divergence, and this store is what the route tests measure against.
 */
const foldPath = (path: string): string => path.replace(/[A-Z]/g, (c) => c.toLowerCase())

const bucketKey = (bucket: TelemetryBucket): string =>
  `${bucket.templateId}\u0000${bucket.resolution}\u0000${bucket.bucketStart}`

/** One `tile_history` row: an observation as one account reported it, keyed like D1's primary key. */
type TileHistoryRow = TileHistoryReporterRow

interface StoredTemplateAlarmState extends TemplateAlarmState {
  readonly probeDueAt: Millis | null
  readonly probePixelsLost: number | null
  readonly evaluatedAt: Millis
}

const tileHistoryRowKey = (row: TileHistoryRow): string =>
  [
    row.season,
    row.tile.x,
    row.tile.y,
    row.resolution,
    row.bucketStart,
    row.hash,
    row.reportedByUserId,
  ].join('/')

export class MemorySqlStore implements SqlStore {
  private readonly buckets = new Map<string, TelemetryBucket>()
  private readonly nodes = new Map<string, NodeRecord>()
  private readonly templates = new Map<
    string,
    Pick<TemplateVersionRecord, 'surface' | 'season' | 'nodeId' | 'name' | 'createdAt'> & {
      currentVersionId: string
      publishedAt: Millis | null
      timelapseFrozenAt: Millis | null
      finishedAt: Millis | null
      updatedAt: Millis
    }
  >()
  private readonly templateVersions = new Map<string, TemplateVersionRecord>()
  private readonly tokens = new Map<string, AccessToken>()
  private readonly statusRevisions = new Map<
    number,
    {
      revision: number
      publicFingerprint: string
      adminFingerprint: string
      fingerprintsDirty: boolean
    }
  >()
  private readonly canvasTiles = new Map<string, TileObservation>()
  private readonly serverOwnedCanvasTiles = new Set<string>()
  private readonly templateTileStatuses = new Map<string, TemplateTileStatusRecord>()
  private readonly serverOwnedTemplateStatuses = new Set<string>()
  private readonly templateAlarmTileStatuses = new Map<string, TemplateTileStatusRecord>()
  private readonly appliedEvents = new Set<string>()
  private readonly painters = new Map<number, { displayName: string; seenAt: Millis }>()
  private readonly contributions = new Map<string, ContributionDelta>()
  private readonly tileHistory = new Map<string, TileHistoryRow>()
  private readonly tileBlobObjects = new Map<string, TileBlobObject>()
  private readonly tileBlobReservations = new Map<string, TileBlobReservation>()
  private tileBlobScanState: TileBlobScanState = { completedSweeps: 0 }
  private readonly alarmStates = new Map<string, StoredTemplateAlarmState>()

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
      if (!sameTemplateSurface(parent.surface, node.surface)) {
        throw new InvalidNodeParentError('parent node belongs to a different surface')
      }
      path = `${parent.path}/${segment}`
    }

    if (path.length > MAX_NODE_PATH_LENGTH) {
      throw new NodePathTooLongError(`node path is longer than ${MAX_NODE_PATH_LENGTH}`)
    }
    if (
      [...this.nodes.values()].some(
        (candidate) =>
          candidate.season === node.season &&
          sameTemplateSurface(candidate.surface, node.surface) &&
          foldPath(candidate.path) === foldPath(path),
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

  async listNodes(
    season: number,
    surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
  ): Promise<readonly NodeRecord[]> {
    return [...this.nodes.values()]
      .filter((node) => node.season === season && sameTemplateSurface(node.surface, surface))
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
        candidate.season === node.season &&
        sameTemplateSurface(candidate.surface, node.surface) &&
        foldPath(candidate.path).startsWith(foldedPrefix),
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
        sameTemplateSurface(candidate.surface, node.surface) &&
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
      if (!sameTemplateSurface(parent.surface, node.surface)) {
        throw new InvalidNodeParentError('parent node belongs to a different surface')
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
        candidate.season === node.season &&
        sameTemplateSurface(candidate.surface, node.surface) &&
        foldPath(candidate.path).startsWith(foldedPrefix),
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
        sameTemplateSurface(candidate.surface, node.surface) &&
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
            sameTemplateSurface(candidate.surface, node.surface) &&
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
            sameTemplateSurface(candidate.surface, node.surface) &&
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
    if (
      options.requireExisting !== true &&
      destination !== null &&
      destination !== undefined &&
      !sameTemplateSurface(destination.surface, version.surface)
    ) {
      throw new InvalidNodeParentError('destination node belongs to a different surface')
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
      if (!sameTemplateSurface(previous.surface, version.surface)) {
        throw new TemplateIdentityError(
          `template ${version.templateId} belongs to ${previous.surface.kind}, not ${version.surface.kind}`,
        )
      }
      const current = this.templateVersions.get(previous.currentVersionId)
      const dimensions = (bbox: TemplateVersionRecord['bbox']) => ({
        width:
          version.surface.kind !== 'world' || bbox.maxX >= bbox.minX
            ? bbox.maxX - bbox.minX
            : WORLD_PIXELS - bbox.minX + bbox.maxX,
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
      surface: version.surface,
      season: version.season,
      nodeId: version.nodeId,
      name: version.name,
      createdAt: version.createdAt,
      currentVersionId: version.versionId,
      publishedAt: null,
      timelapseFrozenAt: null,
      finishedAt: null,
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
      surface: template.surface,
      season: template.season,
      nodeId: template.nodeId,
      name: template.name,
      currentVersionId: template.currentVersionId,
      published: template.publishedAt !== null,
      timelapseFrozen: template.timelapseFrozenAt !== null,
      finished: template.finishedAt !== null,
      finishedAt: template.finishedAt,
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
    if (
      patch.timelapseFrozenAt === null &&
      patch.finishedAt !== null &&
      template.finishedAt !== null
    ) {
      return false
    }
    if (patch.nodeId !== undefined && patch.nodeId !== null && !this.nodes.has(patch.nodeId)) {
      throw new NodeNotFoundError(`node does not exist: ${patch.nodeId}`)
    }
    if (patch.nodeId !== undefined && patch.nodeId !== null) {
      const destination = this.nodes.get(patch.nodeId)
      if (destination?.season !== template.season) {
        throw new InvalidNodeParentError('destination node belongs to a different season')
      }
      if (
        destination !== undefined &&
        !sameTemplateSurface(destination.surface, template.surface)
      ) {
        throw new InvalidNodeParentError('destination node belongs to a different surface')
      }
    }
    this.templates.set(templateId, {
      ...template,
      name: patch.name ?? template.name,
      nodeId: patch.nodeId === undefined ? template.nodeId : patch.nodeId,
      publishedAt: patch.publishedAt === undefined ? template.publishedAt : patch.publishedAt,
      timelapseFrozenAt:
        patch.timelapseFrozenAt === undefined
          ? template.timelapseFrozenAt
          : patch.timelapseFrozenAt,
      finishedAt: patch.finishedAt === undefined ? template.finishedAt : patch.finishedAt,
      updatedAt,
    })
    return true
  }

  async deleteTemplate(templateId: string, expected: TemplateDeletePrecondition): Promise<boolean> {
    const template = this.templates.get(templateId)
    if (
      template === undefined ||
      template.currentVersionId !== expected.versionId ||
      template.updatedAt !== expected.updatedAt
    ) {
      return false
    }
    this.templates.delete(templateId)
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
    scope: TemplateManifestScope,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTemplateRecord[]> {
    const records: ManifestTemplateRecord[] = []
    for (const [id, template] of this.templates) {
      const version = this.templateVersions.get(template.currentVersionId)
      if (
        template.season !== scope.season ||
        !sameTemplateSurface(template.surface, scope.surface) ||
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
        finished: template.finishedAt !== null,
        finishedAt: template.finishedAt,
        timelapseFrozen: template.timelapseFrozenAt !== null,
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
      })
    }
    return records.sort((left, right) => left.id.localeCompare(right.id))
  }

  async listManifestTiles(
    scope: TemplateManifestScope,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTileRecord[]> {
    const records: ManifestTileRecord[] = []
    for (const [templateId, template] of this.templates) {
      const version = this.templateVersions.get(template.currentVersionId)
      if (
        template.season !== scope.season ||
        !sameTemplateSurface(template.surface, scope.surface) ||
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

  async listAlarmTiles(season: number): Promise<readonly AlarmTileRecord[]> {
    const tiles = await this.listManifestTiles({ season, surface: WORLD_TEMPLATE_SURFACE }, true)
    return tiles.map((tile) => {
      const key = `${tile.templateId}\u0000${tile.versionId}\u0000${tileKey({ x: tile.tileX, y: tile.tileY })}`
      return {
        ...tile,
        observedAt: this.templateAlarmTileStatuses.get(key)?.observedAt ?? null,
      }
    })
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
        template.surface.kind !== 'world' ||
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
        finished: template.finishedAt !== null,
        published: template.publishedAt !== null,
        totalPixels: version.totalPixels,
        ...(version.colourTotals === undefined ? {} : { colourTotals: version.colourTotals }),
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
    recordHistory = true,
    forceCurrent = false,
  ): Promise<void> {
    // The raw tile-history tier, mirroring D1's insert-or-ignore: resolution 0, bucketed at the
    // report time itself. Without this row the memory oracle had no timelapse at all, so a
    // `readTileHistory` route test could only ever pin the empty answer.
    const row: TileHistoryRow = {
      season: observation.season,
      tile: { ...observation.tile },
      resolution: 0,
      bucketStart: observation.reportedAt,
      hash: observation.hash,
      reportedWithToken: observation.reportedWithToken,
      reportedByUserId: observation.reportedByUserId,
    }
    if (recordHistory) {
      const historyKey = tileHistoryRowKey(row)
      if (!this.tileHistory.has(historyKey)) this.tileHistory.set(historyKey, row)
    }
    const key = `${observation.season}\u0000${tileKey(observation.tile)}`
    const held = this.canvasTiles.get(key)
    if (
      held === undefined ||
      held.observedAt <= observation.observedAt ||
      (forceCurrent && !this.serverOwnedCanvasTiles.has(key))
    ) {
      this.canvasTiles.set(key, { ...observation, tile: { ...observation.tile } })
      if (forceCurrent) this.serverOwnedCanvasTiles.add(key)
      else this.serverOwnedCanvasTiles.delete(key)
    }
    for (const status of statuses) {
      const statusKey = `${status.templateId}\u0000${status.versionId}\u0000${tileKey(status.tile)}`
      const current = this.templateTileStatuses.get(statusKey)
      if (
        current === undefined ||
        current.observedAt <= status.observedAt ||
        (forceCurrent && !this.serverOwnedTemplateStatuses.has(statusKey))
      ) {
        this.templateTileStatuses.set(statusKey, { ...status, tile: { ...status.tile } })
        if (forceCurrent) this.serverOwnedTemplateStatuses.add(statusKey)
        else this.serverOwnedTemplateStatuses.delete(statusKey)
      }
      if (forceCurrent) {
        const authoritative = this.templateAlarmTileStatuses.get(statusKey)
        if (authoritative === undefined || authoritative.observedAt <= status.observedAt) {
          this.templateAlarmTileStatuses.set(statusKey, { ...status, tile: { ...status.tile } })
        }
      }
    }
  }

  private expireTileBlobReservations(now: number): void {
    for (const [id, reservation] of this.tileBlobReservations) {
      if (reservation.expiresAt <= now) this.tileBlobReservations.delete(id)
    }
  }

  private tileBlobIsReferenced(hash: string): boolean {
    return (
      [...this.canvasTiles.values()].some((row) => row.hash === hash) ||
      [...this.tileHistory.values()].some((row) => row.hash === hash)
    )
  }

  private copyTileBlob(object: TileBlobObject): TileBlobObject {
    return { ...object }
  }

  async readTileBlob(hash: string): Promise<TileBlobObject | null> {
    const object = [...this.tileBlobObjects.values()]
      .filter((candidate) => candidate.hash === hash && candidate.state === 'active')
      .sort((left, right) => left.blobKey.localeCompare(right.blobKey))[0]
    return object === undefined ? null : this.copyTileBlob(object)
  }

  async reserveTileBlob(
    hash: string,
    reservationId: string,
    now: Millis,
    expiresAt: Millis,
  ): Promise<TileBlobReservation | null> {
    this.expireTileBlobReservations(now)
    if (
      [...this.tileBlobObjects.values()].some(
        (object) => object.hash === hash && object.state === 'deleting',
      )
    ) {
      return null
    }
    const object = [...this.tileBlobObjects.values()]
      .filter(
        (candidate) =>
          candidate.hash === hash &&
          (candidate.state === 'active' ||
            candidate.state === 'candidate' ||
            candidate.state === 'uploading'),
      )
      .sort((left, right) => left.blobKey.localeCompare(right.blobKey))[0]
    if (object === undefined) return null
    const active = { ...object, state: 'active' as const }
    this.tileBlobObjects.set(active.blobKey, active)
    const reservation = { id: reservationId, hash, blobKey: active.blobKey, expiresAt }
    this.tileBlobReservations.set(reservationId, reservation)
    return { ...reservation }
  }

  async reserveTileBlobUpload(
    hash: string,
    blobKey: string,
    reservationId: string,
    now: Millis,
    expiresAt: Millis,
  ): Promise<TileBlobReservation | null> {
    this.expireTileBlobReservations(now)
    if (
      [...this.tileBlobObjects.values()].some(
        (object) => object.hash === hash && object.state === 'deleting',
      )
    ) {
      return null
    }
    const existing = [...this.tileBlobObjects.values()]
      .filter(
        (object) =>
          object.hash === hash && (object.state === 'active' || object.state === 'uploading'),
      )
      .sort(
        (left, right) =>
          ['active', 'uploading'].indexOf(left.state) -
            ['active', 'uploading'].indexOf(right.state) ||
          left.blobKey.localeCompare(right.blobKey),
      )[0]
    const selectedBlobKey = existing?.blobKey ?? blobKey
    if (existing === undefined) {
      const held = this.tileBlobObjects.get(blobKey)
      if (held !== undefined) return null
      this.tileBlobObjects.set(blobKey, {
        blobKey,
        hash,
        state: 'uploading',
        discoveredAt: now,
        deleteStartedAt: null,
        deleteAttempts: 0,
        reclaimedAt: null,
      })
    }
    const reservation = { id: reservationId, hash, blobKey: selectedBlobKey, expiresAt }
    this.tileBlobReservations.set(reservationId, reservation)
    return { ...reservation }
  }

  async commitTileBlobReservation(
    reservationId: string,
    now: Millis,
    observation: TileObservation,
    statuses: readonly TemplateTileStatusRecord[],
    recordHistory = true,
    forceCurrent = false,
    includeUnpublished = false,
  ): Promise<TileObservationCommit | null> {
    this.expireTileBlobReservations(now)
    const reservation = this.tileBlobReservations.get(reservationId)
    if (reservation === undefined || reservation.hash !== observation.hash) return null
    if (
      [...this.tileBlobObjects.values()].some(
        (object) => object.hash === reservation.hash && object.state === 'deleting',
      )
    ) {
      return null
    }
    const object = this.tileBlobObjects.get(reservation.blobKey)
    if (object === undefined || object.hash !== reservation.hash) return null
    this.tileBlobObjects.set(object.blobKey, {
      ...object,
      state: 'active',
      reclaimedAt: null,
    })
    const acceptedStatuses = statuses.flatMap((status) => {
      const template = this.templates.get(status.templateId)
      const version = this.templateVersions.get(status.versionId)
      return template !== undefined &&
        version !== undefined &&
        template.currentVersionId === status.versionId &&
        (includeUnpublished || template.publishedAt !== null)
        ? [{ status, template, version }]
        : []
    })
    const previous = new Map(
      acceptedStatuses.map(({ status }) => {
        const key = `${status.templateId}\u0000${status.versionId}\u0000${tileKey(status.tile)}`
        return [key, this.templateTileStatuses.get(key) ?? null] as const
      }),
    )
    await this.recordTileObservation(
      observation,
      acceptedStatuses.map(({ status }) => status),
      recordHistory,
      forceCurrent,
    )
    this.tileBlobReservations.delete(reservationId)
    const statusChanges = acceptedStatuses.flatMap(({ status, template, version }) => {
      const key = `${status.templateId}\u0000${status.versionId}\u0000${tileKey(status.tile)}`
      const current = this.templateTileStatuses.get(key)
      const before = previous.get(key) ?? null
      return current !== undefined && JSON.stringify(current) !== JSON.stringify(before)
        ? [
            {
              published: template.publishedAt !== null,
              totalPixels: version.totalPixels,
              ...(version.colourTotals === undefined ? {} : { colourTotals: version.colourTotals }),
              previous: before,
              current,
            },
          ]
        : []
    })
    let revision: number | null = null
    if (acceptedStatuses.length > 0) {
      const held = this.statusRevisions.get(observation.season)
      revision = (held?.revision ?? 0) + 1
      this.statusRevisions.set(observation.season, {
        revision,
        publicFingerprint: held?.publicFingerprint ?? '0'.repeat(64),
        adminFingerprint: held?.adminFingerprint ?? '0'.repeat(64),
        fingerprintsDirty: true,
      })
    }
    return { revision, statusChanges }
  }

  async releaseTileBlobReservation(reservationId: string): Promise<void> {
    this.tileBlobReservations.delete(reservationId)
  }

  async noteTileBlobObject(
    hash: string,
    blobKey: string,
    now: Millis,
  ): Promise<TileBlobCandidateResult> {
    this.expireTileBlobReservations(now)
    const held = this.tileBlobObjects.get(blobKey)
    if (held?.state === 'deleting') return 'deleting'
    const hasExactReservation = [...this.tileBlobReservations.values()].some(
      (reservation) => reservation.hash === hash && reservation.blobKey === blobKey,
    )
    const hasOtherActiveGeneration = [...this.tileBlobObjects.values()].some(
      (object) => object.hash === hash && object.blobKey !== blobKey && object.state === 'active',
    )
    const referenced =
      hasExactReservation ||
      (this.tileBlobIsReferenced(hash) && (held?.state === 'active' || !hasOtherActiveGeneration))
    const state = referenced ? 'active' : 'candidate'
    this.tileBlobObjects.set(blobKey, {
      blobKey,
      hash,
      state,
      discoveredAt: held?.discoveredAt ?? now,
      deleteStartedAt: null,
      deleteAttempts: held?.deleteAttempts ?? 0,
      reclaimedAt: null,
    })
    return referenced ? 'referenced' : 'candidate'
  }

  async listTileBlobDeletionWork(limit: number): Promise<readonly TileBlobObject[]> {
    return [...this.tileBlobObjects.values()]
      .filter((object) => object.state === 'deleting' || object.state === 'candidate')
      .sort(
        (left, right) =>
          (left.state === 'deleting' ? 0 : 1) - (right.state === 'deleting' ? 0 : 1) ||
          left.discoveredAt - right.discoveredAt ||
          left.blobKey.localeCompare(right.blobKey),
      )
      .slice(0, limit)
      .map((object) => this.copyTileBlob(object))
  }

  async claimTileBlobDeletion(blobKey: string, now: Millis): Promise<TileBlobClaimResult> {
    this.expireTileBlobReservations(now)
    const object = this.tileBlobObjects.get(blobKey)
    if (object === undefined || (object.state !== 'candidate' && object.state !== 'deleting')) {
      return 'missing'
    }
    const hasExactReservation = [...this.tileBlobReservations.values()].some(
      (reservation) => reservation.hash === object.hash && reservation.blobKey === object.blobKey,
    )
    const hasOtherActiveGeneration = [...this.tileBlobObjects.values()].some(
      (candidate) =>
        candidate.hash === object.hash &&
        candidate.blobKey !== object.blobKey &&
        candidate.state === 'active',
    )
    if (
      hasExactReservation ||
      (this.tileBlobIsReferenced(object.hash) && !hasOtherActiveGeneration)
    ) {
      this.tileBlobObjects.set(blobKey, {
        ...object,
        state: 'active',
        deleteStartedAt: null,
      })
      return 'blocked'
    }
    this.tileBlobObjects.set(blobKey, {
      ...object,
      state: 'deleting',
      deleteStartedAt: object.deleteStartedAt ?? now,
      deleteAttempts: object.deleteAttempts + 1,
    })
    return 'claimed'
  }

  async finishTileBlobDeletion(blobKey: string, reclaimedAt: Millis): Promise<void> {
    const object = this.tileBlobObjects.get(blobKey)
    if (object?.state !== 'deleting') return
    this.tileBlobObjects.set(blobKey, { ...object, state: 'deleted', reclaimedAt })
  }

  async readTileBlobScanState(): Promise<TileBlobScanState> {
    return { ...this.tileBlobScanState }
  }

  async writeTileBlobScanState(cursor: string | undefined): Promise<void> {
    this.tileBlobScanState = {
      ...(cursor === undefined ? {} : { cursor }),
      completedSweeps: this.tileBlobScanState.completedSweeps + (cursor === undefined ? 1 : 0),
    }
  }

  private tileIsFrozenAt(season: number, tile: TileCoord, targetStart: number): boolean {
    for (const template of this.templates.values()) {
      if (
        template.season !== season ||
        template.surface.kind !== 'world' ||
        template.timelapseFrozenAt === null ||
        targetStart * 1_000 > template.timelapseFrozenAt
      ) {
        continue
      }
      const version = this.templateVersions.get(template.currentVersionId)
      if (version === undefined) continue
      if (
        version.chunks.some((chunk) => {
          const directX = Math.abs(chunk.tileX - tile.x)
          const wrappedX = Math.min(directX, WORLD_TILES - directX)
          return wrappedX <= 1 && Math.abs(chunk.tileY - tile.y) <= 1
        })
      ) {
        return true
      }
    }
    return false
  }

  async foldTileHistory(season: number, tile: TileCoord, now: Seconds): Promise<void> {
    for (const edge of TILE_HISTORY_DECAY_EDGES) {
      const cutoff = now - edge.retainSeconds
      const targetStarts = [
        ...new Set(
          [...this.tileHistory.values()]
            .filter(
              (row) =>
                row.season === season &&
                row.tile.x === tile.x &&
                row.tile.y === tile.y &&
                row.resolution === edge.source,
            )
            .map((row) => Math.floor(row.bucketStart / edge.target) * edge.target)
            .filter(
              (targetStart) =>
                targetStart + edge.target <= cutoff &&
                !this.tileIsFrozenAt(season, tile, targetStart) &&
                ![...this.tileHistory.values()].some(
                  (row) =>
                    row.season === season &&
                    row.tile.x === tile.x &&
                    row.tile.y === tile.y &&
                    row.resolution < edge.source &&
                    row.bucketStart >= targetStart &&
                    row.bucketStart < targetStart + edge.target,
                ),
            ),
        ),
      ]
        .sort((left, right) => left - right)
        .slice(0, DECAY_FOLD_GROUP_LIMIT)
      if (targetStarts.length === 0) continue
      const selected = [...this.tileHistory.values()].filter(
        (row) =>
          row.season === season &&
          row.tile.x === tile.x &&
          row.tile.y === tile.y &&
          row.resolution === edge.source &&
          targetStarts.includes(Math.floor(row.bucketStart / edge.target) * edge.target),
      )
      const folded = foldTileReporterRows(selected, edge.target)
      for (const row of selected) this.tileHistory.delete(tileHistoryRowKey(row))
      for (const row of folded.rows) this.tileHistory.set(tileHistoryRowKey(row), row)
    }
  }

  async readTemplateStatuses(
    season: number,
    includeUnpublished: boolean,
    options: { readonly serverOwnedOnly?: boolean } = {},
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
      const source =
        options.serverOwnedOnly === true
          ? this.templateAlarmTileStatuses
          : this.templateTileStatuses
      const statuses = [...source.entries()]
        .filter(
          ([, status]) =>
            status.templateId === templateId && status.versionId === version.versionId,
        )
        .map(([, status]) => status)
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

  async readStatusProjectionRevision(season: number): Promise<number> {
    if (!Number.isSafeInteger(season) || season < 0) throw new RangeError('invalid season')
    return this.statusRevisions.get(season)?.revision ?? 0
  }

  async commitStatusProjectionRevision(
    season: number,
    expectedRevision: number,
    retainRevision: boolean,
    publicFingerprint: string,
    adminFingerprint: string,
  ): Promise<number | null> {
    if (
      !Number.isSafeInteger(season) ||
      season < 0 ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      !/^[0-9a-f]{64}$/.test(publicFingerprint) ||
      !/^[0-9a-f]{64}$/.test(adminFingerprint)
    ) {
      throw new RangeError('invalid status projection revision metadata')
    }
    const held = this.statusRevisions.get(season)
    if ((held?.revision ?? 0) !== expectedRevision) return null
    const changed =
      held === undefined ||
      held.publicFingerprint !== publicFingerprint ||
      held.adminFingerprint !== adminFingerprint
    const revision =
      held?.fingerprintsDirty && retainRevision
        ? held.revision
        : changed || held?.fingerprintsDirty
          ? (held?.revision ?? 0) + 1
          : held.revision
    this.statusRevisions.set(season, {
      revision,
      publicFingerprint,
      adminFingerprint,
      fingerprintsDirty: false,
    })
    return revision
  }

  async evaluateTemplateAlarm(
    snapshot: TemplateAlarmSnapshot,
    phase: AlarmEvaluationPhase,
    alarmId: string,
  ): Promise<AlarmPolicyResult> {
    const previous = this.alarmStates.get(snapshot.templateId) ?? null
    if (
      phase.kind === 'follow-up' &&
      (previous === null ||
        previous.versionId !== snapshot.versionId ||
        previous.alarm?.id !== phase.alarmId ||
        previous.probeDueAt !== phase.dueAt ||
        previous.probePixelsLost !== phase.pixelsLost)
    ) {
      return evaluateAlarmSnapshot(previous, snapshot, phase, () => alarmId)
    }
    if (previous !== null && snapshot.observedAt < previous.evaluatedAt) {
      return { state: previous, scheduleFollowUp: false }
    }
    const result = evaluateAlarmSnapshot(previous, snapshot, phase, () => alarmId)
    const probe = result.scheduleFollowUp
      ? {
          probeDueAt: (snapshot.observedAt + ALARM_FOLLOW_UP_DELAY_MILLISECONDS) as Millis,
          probePixelsLost: result.state.alarm?.pixelsLost ?? null,
        }
      : { probeDueAt: null, probePixelsLost: null }
    this.alarmStates.set(snapshot.templateId, {
      ...result.state,
      ...probe,
      evaluatedAt: snapshot.observedAt,
    })
    return result
  }

  async readActiveAlarms(season: number, includeUnpublished: boolean): Promise<readonly Alarm[]> {
    const alarms: Alarm[] = []
    for (const [templateId, state] of this.alarmStates) {
      const template = this.templates.get(templateId)
      if (
        state.alarm === null ||
        template === undefined ||
        template.season !== season ||
        template.currentVersionId !== state.versionId ||
        (!includeUnpublished && template.publishedAt === null)
      )
        continue
      alarms.push({ ...state.alarm })
    }
    return alarms.sort((left, right) => left.templateId.localeCompare(right.templateId))
  }

  async listDueAlarmProbes(now: Millis): Promise<readonly AlarmProbe[]> {
    const probes: AlarmProbe[] = []
    for (const [templateId, state] of this.alarmStates) {
      const template = this.templates.get(templateId)
      if (
        template === undefined ||
        template.currentVersionId !== state.versionId ||
        state.alarm === null ||
        state.probeDueAt === null ||
        state.probeDueAt > now ||
        state.probePixelsLost === null
      )
        continue
      probes.push({
        templateId,
        versionId: state.versionId,
        season: template.season,
        alarmId: state.alarm.id,
        pixelsLost: state.probePixelsLost,
        dueAt: state.probeDueAt,
      })
    }
    return probes.sort((left, right) => left.dueAt - right.dueAt)
  }

  async nextAlarmProbeAt(): Promise<Millis | null> {
    let next: Millis | null = null
    for (const [templateId, state] of this.alarmStates) {
      const template = this.templates.get(templateId)
      if (
        state.alarm !== null &&
        template?.currentVersionId === state.versionId &&
        state.probeDueAt !== null &&
        (next === null || state.probeDueAt < next)
      ) {
        next = state.probeDueAt
      }
    }
    return next
  }

  async clearAlarmProbe(templateId: string, alarmId: string, dueAt: Millis): Promise<void> {
    const state = this.alarmStates.get(templateId)
    if (state?.alarm?.id !== alarmId || state.probeDueAt !== dueAt) return
    this.alarmStates.set(templateId, {
      ...state,
      probeDueAt: null,
      probePixelsLost: null,
    })
  }

  async deferAlarmProbe(
    templateId: string,
    alarmId: string,
    dueAt: Millis,
    retryAt: Millis,
  ): Promise<void> {
    const state = this.alarmStates.get(templateId)
    if (state?.alarm?.id !== alarmId || state.probeDueAt !== dueAt) return
    this.alarmStates.set(templateId, { ...state, probeDueAt: retryAt })
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

  async foldTelemetryBuckets(templateIds: readonly string[], now: Seconds): Promise<void> {
    const ids = new Set(templateIds)
    if (ids.size === 0) return
    for (const edge of TELEMETRY_DECAY_EDGES) {
      const cutoff = now - edge.retainSeconds
      const groups = [
        ...new Set(
          [...this.buckets.values()]
            .filter((bucket) => ids.has(bucket.templateId) && bucket.resolution === edge.source)
            .map((bucket) => {
              const targetStart = Math.floor(bucket.bucketStart / edge.target) * edge.target
              return `${bucket.templateId}\u0000${targetStart}`
            })
            .filter((key) => {
              const separator = key.indexOf('\u0000')
              const templateId = key.slice(0, separator)
              const targetStart = Number(key.slice(separator + 1))
              return (
                targetStart + edge.target <= cutoff &&
                ![...this.buckets.values()].some(
                  (finer) =>
                    finer.templateId === templateId &&
                    finer.resolution < edge.source &&
                    finer.bucketStart >= targetStart &&
                    finer.bucketStart < targetStart + edge.target,
                )
              )
            }),
        ),
      ]
        .sort()
        .slice(0, DECAY_FOLD_GROUP_LIMIT)
      for (const key of groups) {
        const separator = key.indexOf('\u0000')
        const templateId = key.slice(0, separator)
        const targetStart = Number(key.slice(separator + 1))
        const source = [...this.buckets.values()].filter(
          (bucket) =>
            bucket.templateId === templateId &&
            bucket.resolution === edge.source &&
            Math.floor(bucket.bucketStart / edge.target) * edge.target === targetStart,
        )
        const folded: TelemetryBucket = {
          templateId,
          resolution: edge.target,
          bucketStart: seconds(targetStart),
          placed: source.reduce((sum, bucket) => sum + bucket.placed, 0),
          correct: source.reduce((sum, bucket) => sum + bucket.correct, 0),
          repairs: source.reduce((sum, bucket) => sum + bucket.repairs, 0),
        }
        this.buckets.set(bucketKey(folded), folded)
        for (const bucket of source) this.buckets.delete(bucketKey(bucket))
      }
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
    const resolutions = new Set(
      typeof query.resolution === 'number' ? [query.resolution] : query.resolution,
    )
    if (templateIds.size > MAX_READ_BUCKETS_TEMPLATE_IDS) throw tooManyTemplateIds(templateIds.size)

    return [...this.buckets.values()]
      .filter(
        (bucket) =>
          templateIds.has(bucket.templateId) &&
          resolutions.has(bucket.resolution) &&
          bucket.bucketStart >= query.fromSeconds &&
          bucket.bucketStart < query.toSeconds,
      )
      .sort(compareBuckets)
      .map((bucket) => ({ ...bucket }))
  }

  async readContributions(query: ContributionQuery): Promise<readonly ContributionDay[]> {
    assertValidContributionQuery(query)
    const wanted = query.templateIds === undefined ? null : new Set(query.templateIds)
    // Reduce, then let the caller sum. One painter-day exists once per *reporter*, so the maximum
    // of each counter across those rows is the day's truth — see `readContributions` on the port.
    const reduced = new Map<string, ContributionDay>()
    for (const row of this.contributions.values()) {
      if (wanted !== null && !wanted.has(row.templateId)) continue
      if (query.season !== undefined && this.templates.get(row.templateId)?.season !== query.season)
        continue
      // The publish gate applies to explicit-id queries too — see `includeUnpublished` on the port.
      if (!query.includeUnpublished && this.templates.get(row.templateId)?.publishedAt == null)
        continue
      if (query.fromSeconds !== undefined && row.day < query.fromSeconds) continue
      if (query.toSeconds !== undefined && row.day >= query.toSeconds) continue
      const key = `${row.wplaceUserId}/${row.templateId}/${row.day}`
      const held = reduced.get(key)
      reduced.set(key, {
        templateId: row.templateId,
        day: row.day,
        wplaceUserId: row.wplaceUserId,
        displayName: this.painters.get(row.wplaceUserId)?.displayName ?? String(row.wplaceUserId),
        placed: Math.max(held?.placed ?? 0, row.placed),
        correct: Math.max(held?.correct ?? 0, row.correct),
        repairs: Math.max(held?.repairs ?? 0, row.repairs),
      })
    }
    return [...reduced.values()].sort(compareContributionDays)
  }

  async filterPublishedTemplateIds(ids: readonly string[]): Promise<readonly string[]> {
    assertValidPublishedFilter(ids)
    const seen = new Set<string>()
    const published: string[] = []
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      if (this.templates.get(id)?.publishedAt != null) published.push(id)
    }
    return published
  }

  async listLatestTiles(season: number): Promise<readonly LatestTileObservation[]> {
    return [...this.canvasTiles.values()]
      .filter((held) => held.season === season)
      .sort((left, right) => left.tile.x - right.tile.x || left.tile.y - right.tile.y)
      .map((held) => ({
        season: held.season,
        tile: { ...held.tile },
        hash: held.hash,
        observedAt: held.observedAt,
      }))
  }

  async readTileHistory(query: TileHistoryQuery): Promise<readonly TileHistoryFrame[]> {
    assertValidTileHistoryQuery(query)
    // Reporters are counted as distinct accounts, though the Set is belt-and-braces here: the row
    // key already includes the account, so one account cannot appear twice for one (bucket, hash).
    const groups = new Map<string, { bucketStart: Seconds; hash: string; accounts: Set<number> }>()
    for (const row of this.tileHistory.values()) {
      if (
        row.season !== query.season ||
        row.tile.x !== query.tile.x ||
        row.tile.y !== query.tile.y ||
        row.resolution !== query.resolution ||
        row.bucketStart < query.fromSeconds ||
        row.bucketStart >= query.toSeconds
      ) {
        continue
      }
      const key = `${row.bucketStart}/${row.hash}`
      const held = groups.get(key) ?? {
        bucketStart: row.bucketStart,
        hash: row.hash,
        accounts: new Set<number>(),
      }
      held.accounts.add(row.reportedByUserId)
      groups.set(key, held)
    }
    return foldTileFrames(
      [...groups.values()].map((group) => ({
        bucketStart: group.bucketStart,
        hash: group.hash,
        reporters: group.accounts.size,
      })),
    )
  }
}
