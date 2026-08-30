import {
  type Alarm,
  type ContributionDay,
  type Millis,
  type Seconds,
  sameTemplateSurface,
  seconds,
  type TileHistoryFrame,
  templateSurface,
  WORLD_PIXELS,
  WORLD_TILES,
} from '@caelestis/shared'
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import {
  accessTokens,
  appliedEvents,
  canvasTiles,
  contributions,
  nodes,
  painters,
  serverSettings,
  telemetryBuckets,
  templateAlarmStates,
  templates,
  templateTileStatuses,
  templateVersions,
  tileBlobGcState,
  tileBlobObjects,
  tileHistory,
  versionTiles,
} from '../../db/schema.js'
import {
  type AccessToken,
  type AccessTokenQuery,
  type AlarmEvaluationPhase,
  type AlarmPolicyResult,
  type AlarmProbe,
  type AlarmTileRecord,
  assertValidBuckets,
  assertValidContributionQuery,
  assertValidPublishedFilter,
  assertValidTemplateVersion,
  assertValidTileHistoryQuery,
  type BucketQuery,
  type ContributionDelta,
  type ContributionQuery,
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
  READ_BUCKETS_CHUNK_SIZE,
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
  tooManyTemplateIds,
} from '../../ports/index.js'
import {
  ALARM_FOLLOW_UP_DELAY_MILLISECONDS,
  evaluateAlarmSnapshot,
} from '../../telemetry/alarm-policy.js'

const storedAlarmState = (row: typeof templateAlarmStates.$inferSelect): TemplateAlarmState => {
  if (row.alarmId === null) {
    return {
      templateId: row.templateId,
      versionId: row.versionId,
      total: row.total,
      peakCorrect: row.peakCorrect,
      alarm: null,
    }
  }
  if (
    row.kind === null ||
    row.pixelsLost === null ||
    row.firstSeenMs === null ||
    row.lastSeenMs === null
  ) {
    throw new Error(`alarm state ${row.templateId} has a partial episode`)
  }
  return {
    templateId: row.templateId,
    versionId: row.versionId,
    total: row.total,
    peakCorrect: row.peakCorrect,
    alarm: {
      id: row.alarmId,
      templateId: row.templateId,
      kind: row.kind,
      pixelsLost: row.pixelsLost,
      firstSeen: row.firstSeenMs,
      lastSeen: row.lastSeenMs,
    },
  }
}

const toAccessToken = (row: typeof accessTokens.$inferSelect): AccessToken => ({
  tokenHash: row.tokenHash,
  label: row.label,
  scope: row.scope,
  createdWithToken: row.createdWithToken,
  createdAt: row.createdAtMs,
})

/**
 * `version_tiles` rows per INSERT. Four bound parameters each, so 24 rows is 96 — just under D1's
 * 100-parameter ceiling, and it turns the per-tile statement count into a per-24-tile one.
 */
const VERSION_TILE_ROWS_PER_INSERT = 24

interface ColourStatus {
  readonly index: number
  readonly correct: number
  readonly wrong: number
  readonly blank: number
  readonly total: number
}

const parseColourTotals = (
  value: string | null,
): readonly { readonly index: number; readonly total: number }[] | undefined => {
  if (value === null) return undefined
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed)
    ? (parsed as readonly { readonly index: number; readonly total: number }[])
    : undefined
}

const parseColourStatuses = (value: string): readonly ColourStatus[] => {
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed) ? (parsed as readonly ColourStatus[]) : []
}

/**
 * Case-insensitive path-prefix matching without a LIKE pattern.
 *
 * D1 caps a LIKE or GLOB pattern at 50 bytes, while a node path may be 256 characters. `substr`
 * compares the same prefix without constructing a pattern, and `lower` folds ASCII exactly as
 * SQLite LIKE did. SQLite supplies both lengths so the comparison stays in characters throughout.
 */
const pathStartsWith = (prefix: SQL | string): SQL =>
  sql`lower(substr(${nodes.path}, 1, length(${prefix}))) = lower(${prefix})`

const chunkRows = <T>(rows: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let offset = 0; offset < rows.length; offset += size) {
    out.push(rows.slice(offset, offset + size))
  }
  return out
}

/**
 * Whether `text` appears anywhere in an error's chain.
 *
 * Drizzle wraps every failure in a `DrizzleQueryError` whose own message is `Failed query: insert
 * into "nodes" ...` — the driver's text, including `UNIQUE constraint failed`, is on `cause`. So a
 * check against `error.message` never matched, a duplicate group name escaped as an unhandled error,
 * and an ordinary admin action answered 500 where the route means 400. The memory store threw the
 * right error, so every test agreed with the route and only production disagreed.
 *
 * Walks the chain rather than reading `cause` once: D1 adds its own `D1_ERROR:` wrapper on top of
 * drizzle's, and neither depth is something to hard-code. Bounded anyway, because `cause` is an
 * ordinary property and nothing stops a chain from pointing back at itself.
 *
 * The `UNIQUE` translation is covered by a test. The two `FOREIGN KEY` ones guard races between a
 * guard read and the write that follows it, which a single-threaded test cannot open — they are here
 * because the constraint, not the read, is the authority, and losing that race should give the same
 * answer as failing the check.
 */
const MAX_CAUSE_DEPTH = 5

const mentions = (error: unknown, text: string): boolean => {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current.message.includes(text)) return true
    current = current.cause
  }
  return false
}

const fromRow = (row: typeof telemetryBuckets.$inferSelect): TelemetryBucket => ({
  templateId: row.templateId,
  resolution: row.resolution,
  bucketStart: seconds(row.bucketStartS),
  placed: row.placed,
  correct: row.correct,
  repairs: row.repairs,
})

const toNode = (row: typeof nodes.$inferSelect): NodeRecord => ({
  id: row.id,
  season: row.season,
  parentId: row.parentId,
  path: row.path,
  name: row.name,
  description: row.description,
  createdAt: row.createdAtMs,
})

const toTileBlobObject = (row: typeof tileBlobObjects.$inferSelect): TileBlobObject => ({
  blobKey: row.blobKey,
  hash: row.sha256,
  state: row.state,
  discoveredAt: row.discoveredAtMs,
  deleteStartedAt: row.deleteStartedAtMs,
  deleteAttempts: row.deleteAttempts,
  reclaimedAt: row.reclaimedAtMs,
})

export class D1SqlStore implements SqlStore {
  private readonly database: DrizzleD1Database
  private readonly client: D1Database

  constructor(database: D1Database) {
    this.client = database
    this.database = drizzle(database)
  }

  async insertNode(node: NodeRecord): Promise<NodeRecord> {
    let parentPath = ''
    if (node.parentId !== null) {
      const parent = await this.readNode(node.parentId)
      if (parent === null) throw new InvalidNodeParentError('parent node does not exist')
      if (parent.season !== node.season) {
        throw new InvalidNodeParentError('parent node belongs to a different season')
      }
      parentPath = parent.path
    }
    // The prefix comes from the parent row, not from `node.path`. A caller derives that path from
    // its own read of the parent, and a rename committing in between leaves the child inserted under
    // a prefix its parent no longer has — a hierarchy the wire refuses, written by two requests that
    // both succeeded. Only the last segment is the caller's to choose. Same rule as `renameNode`.
    const segment = node.path.slice(node.path.lastIndexOf('/') + 1)
    // Bounded here as well as by the CHECK, because the memory store bounds it here and the two are
    // meant to answer alike. The CHECK stays the backstop for the window between this read and the
    // write, in which a rename can lengthen the prefix underneath us.
    if (`${parentPath}/${segment}`.length > MAX_NODE_PATH_LENGTH) {
      throw new NodePathTooLongError(`node path is longer than ${MAX_NODE_PATH_LENGTH}`)
    }
    // Roots get the same treatment as children: only the last segment is the caller's, so a stale
    // multi-segment proposal cannot create a root whose path claims to be nested.
    const path =
      node.parentId === null
        ? sql`${`/${segment}`}`
        : sql`coalesce((select path from nodes where id = ${node.parentId}), '') || '/' || ${segment}`
    try {
      await this.database.insert(nodes).values({
        id: node.id,
        season: node.season,
        parentId: node.parentId,
        path,
        name: node.name,
        description: node.description,
        createdAtMs: node.createdAt,
      })
    } catch (error) {
      // The named index, not the bare string: `nodes` has two unique constraints, and reporting a
      // primary-key collision as a path conflict sends the caller after the wrong recovery — and
      // gave a different answer than the memory store, which leaves an id collision untyped.
      if (mentions(error, "UNIQUE constraint failed: index 'nodes_season_path_idx'")) {
        throw new NodePathConflictError(`node path is already taken in season ${node.season}`)
      }
      // The parent check above is a separate read, so a concurrent delete can remove the parent
      // between the two and the foreign key rejects this insert. Same outcome as the check finding
      // it missing, so it gets the same error rather than escaping as a 500.
      if (mentions(error, 'FOREIGN KEY constraint failed')) {
        throw new InvalidNodeParentError('parent node does not exist')
      }
      // The route bounds the path it derived, but the prefix written here comes from the parent row,
      // which a rename may have lengthened since. The CHECK is the authority; losing to it answers
      // the same 400 as failing the route's own check rather than a 500.
      if (mentions(error, 'CHECK constraint failed: nodes_path_check')) {
        throw new NodePathTooLongError(`node path is longer than ${MAX_NODE_PATH_LENGTH}`)
      }
      throw error
    }
    // Re-read rather than assemble: the path the database composed is the one that is true.
    const inserted = await this.readNode(node.id)
    if (inserted === null) throw new NodeNotFoundError(`node does not exist: ${node.id}`)
    return inserted
  }

  async readNode(nodeId: string): Promise<NodeRecord | null> {
    const rows = await this.database.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1)
    const row = rows[0]
    return row === undefined ? null : toNode(row)
  }

  async listNodes(season: number): Promise<readonly NodeRecord[]> {
    const rows = await this.database
      .select()
      .from(nodes)
      .where(eq(nodes.season, season))
      .orderBy(asc(nodes.id))
    return rows.map(toNode)
  }

  async renameNode(nodeId: string, name: string, segment: string): Promise<NodeRecord | null> {
    const node = await this.readNode(nodeId)
    if (node === null) return null

    const oldPrefix = `${node.path}/`
    const descendants = and(eq(nodes.season, node.season), pathStartsWith(oldPrefix))

    // Every descendant keeps its suffix, so its new length is its old one shifted by the change in
    // the prefix — one aggregate, no rows. `slug` keeps paths inside the BMP, so SQLite's character
    // count and the UTF-16 count the wire uses are the same number; this used to read every
    // descendant path because they were not, which a season-sized subtree turns into a result set D1
    // refuses.
    //
    // That equality is an assumption, and the route is what holds it up: every stored path is one
    // `slug` derived. A path with an astral character would make this under-count, the CHECK agree
    // with it, and the resulting manifest stop decoding — so if a second writer ever appears, or rows
    // arrive from anywhere but this route, this aggregate has to go back to measuring the rows.
    // Nothing has been deployed from this schema, so there are no such rows to migrate today.
    const path = `${node.path.slice(0, node.path.lastIndexOf('/'))}/${segment}`
    const shift = path.length - node.path.length
    const [deepest] = await this.database
      .select({ length: sql<number>`coalesce(max(length(${nodes.path})), 0)` })
      .from(nodes)
      .where(descendants)
    const longest = Math.max(path.length, (deepest?.length ?? 0) + shift)
    if (longest > MAX_NODE_PATH_LENGTH) {
      throw new NodePathTooLongError(
        `rename would derive a path longer than ${MAX_NODE_PATH_LENGTH}`,
      )
    }

    // The old path is read inside the batch rather than carried in from the read above, so the two
    // statements agree about what they are moving. Carried in, two concurrent renames of the same
    // node both saw `/x`: the first moved the node to `/a` and its children with it, the second then
    // moved the node to `/b` and rewrote `/x/%`, which by then matched nothing — leaving the node at
    // `/b` and its children at `/a/c`. The batch was atomic the whole time; the value it was built
    // from was not.
    //
    // The destination is composed from the node's live parent for the same reason. A concurrent move
    // can change `parentId` after the guard read; carrying the old id into this batch leaves the new
    // parent pointer paired with a path under the old parent.
    //
    // The D1 test seam stages a move immediately before this batch, which pins the live-parent rule
    // without seeding a hierarchy the store itself would otherwise refuse to create.
    const liveParentId = sql`(select parent_id from nodes where id = ${nodeId})`
    const parentPath = sql`coalesce((select path from nodes where id = ${liveParentId}), '')`
    const destination = sql`${parentPath} || '/' || ${segment}`
    const oldPath = sql`(select path from nodes where id = ${nodeId})`

    // One batch: the node and every descendant move together or not at all. A half-applied rename
    // leaves children whose path no longer starts with their parent's, which silently breaks every
    // prefix rollup rather than failing loudly.
    //
    // Descendants first, while the node row still holds the old path they are matched against. The
    // suffix starts at the old path's length rather than the old prefix's, so it keeps the
    // separating slash — cutting past it concatenated `/renamed` with `child` and wrote
    // `/renamedchild`. `length()` is SQLite's, which counts characters like `substr` does, where
    // JavaScript's counts UTF-16 units and sliced every descendant short past an astral character.
    const statements = [
      this.database
        .update(nodes)
        .set({ path: sql`${destination} || substr(${nodes.path}, length(${oldPath}) + 1)` })
        .where(and(eq(nodes.season, node.season), pathStartsWith(sql`${oldPath} || '/'`))),
      this.database.update(nodes).set({ name, path: destination }).where(eq(nodes.id, nodeId)),
    ] as const
    try {
      await this.database.batch([statements[0], statements[1]])
    } catch (error) {
      if (mentions(error, "UNIQUE constraint failed: index 'nodes_season_path_idx'")) {
        throw new NodePathConflictError(`node path is already taken in season ${node.season}`)
      }
      // The guard above reads a snapshot, so a child inserted between it and this batch can be
      // lengthened past the bound by a rename that was measured without it. The CHECK is the
      // authority; losing to it answers the same 400 as failing the guard rather than a 500.
      if (mentions(error, 'CHECK constraint failed: nodes_path_check')) {
        throw new NodePathTooLongError(
          `rename would derive a path longer than ${MAX_NODE_PATH_LENGTH}`,
        )
      }
      throw error
    }
    // Re-read rather than assemble: the path the database composed is the one that is true.
    return this.readNode(nodeId)
  }

  async moveNode(
    nodeId: string,
    parentId: string | null,
    proposedPath: string,
    patch: { readonly name?: string } = {},
  ): Promise<boolean> {
    return await this.moveNodeAttempt(nodeId, parentId, proposedPath, patch, 0)
  }

  private async moveNodeAttempt(
    nodeId: string,
    parentId: string | null,
    proposedPath: string,
    patch: { readonly name?: string },
    attempt: number,
  ): Promise<boolean> {
    const node = await this.readNode(nodeId)
    if (node === null) return false

    let parent: NodeRecord | null = null
    if (parentId !== null) {
      parent = await this.readNode(parentId)
      if (parent === null) throw new InvalidNodeParentError('parent node does not exist')
      if (parent.season !== node.season) {
        throw new InvalidNodeParentError('parent node belongs to a different season')
      }
      if (parent.id === node.id || parent.path.startsWith(`${node.path}/`)) {
        throw new InvalidNodeParentError(
          'parent node cannot be the node itself or one of its descendants',
        )
      }
    }

    // For a parent-only move, the path segment belongs to the live row rather than to the route's
    // earlier read. An explicit simultaneous rename still supplies its own requested segment.
    const segment =
      patch.name === undefined
        ? node.path.slice(node.path.lastIndexOf('/') + 1)
        : proposedPath.slice(proposedPath.lastIndexOf('/') + 1)
    const path = `${parent?.path ?? ''}/${segment}`
    const oldPrefix = `${node.path}/`
    const descendants = and(eq(nodes.season, node.season), pathStartsWith(oldPrefix))
    const shift = path.length - node.path.length
    const [deepest] = await this.database
      .select({ length: sql<number>`coalesce(max(length(${nodes.path})), 0)` })
      .from(nodes)
      .where(descendants)
    if (Math.max(path.length, (deepest?.length ?? 0) + shift) > MAX_NODE_PATH_LENGTH) {
      throw new NodePathTooLongError(`move would derive a path longer than ${MAX_NODE_PATH_LENGTH}`)
    }

    const destination =
      parentId === null
        ? sql`'/' || ${segment}`
        : sql`(select path from nodes where id = ${parentId}) || '/' || ${segment}`
    const oldPath = sql`(select path from nodes where id = ${nodeId})`
    // A rename between the guard read and this batch changes both name and path. Do not combine its
    // live name with our stale segment: let the batch make no change and retry from the new row.
    const nodeIsStillCurrent =
      patch.name === undefined ? sql`${oldPath} = ${node.path}` : sql`1 = 1`
    // Re-evaluate the parent against the node's live path inside each batch statement. Two opposite
    // moves may both pass the reads above, but only the first can still satisfy this predicate once
    // its write makes the other destination a descendant.
    const parentIsStillValid =
      parentId === null
        ? sql`1 = 1`
        : sql`(
            select path from nodes where id = ${parentId} and season = ${node.season}
          ) is not null and lower(substr(
            (select path from nodes where id = ${parentId} and season = ${node.season}),
            1,
            length(${oldPath}) + 1
          )) <> lower(${oldPath} || '/') and lower(
            (select path from nodes where id = ${parentId} and season = ${node.season})
          ) <> lower(${oldPath})`
    const statements = [
      this.database
        .update(nodes)
        .set({ path: sql`${destination} || substr(${nodes.path}, length(${oldPath}) + 1)` })
        .where(
          and(
            eq(nodes.season, node.season),
            pathStartsWith(sql`${oldPath} || '/'`),
            parentIsStillValid,
            nodeIsStillCurrent,
          ),
        ),
      this.database
        .update(nodes)
        .set({
          parentId,
          path: destination,
          ...(patch.name === undefined ? {} : { name: patch.name }),
        })
        .where(and(eq(nodes.id, nodeId), parentIsStillValid, nodeIsStillCurrent)),
    ] as const
    try {
      await this.database.batch([statements[0], statements[1]])
    } catch (error) {
      if (mentions(error, "UNIQUE constraint failed: index 'nodes_season_path_idx'")) {
        throw new NodePathConflictError(`node path is already taken in season ${node.season}`)
      }
      if (mentions(error, 'CHECK constraint failed: nodes_path_check')) {
        throw new NodePathTooLongError(
          `move would derive a path longer than ${MAX_NODE_PATH_LENGTH}`,
        )
      }
      throw error
    }
    const moved = await this.readNode(nodeId)
    if (moved === null) return false
    if (moved.parentId !== parentId) {
      if (patch.name === undefined && attempt < 3) {
        return await this.moveNodeAttempt(nodeId, parentId, proposedPath, patch, attempt + 1)
      }
      throw new InvalidNodeParentError('parent node became invalid during the move')
    }
    return true
  }

  async deleteNode(nodeId: string): Promise<void> {
    const [children, attachedTemplates] = await Promise.all([
      this.database.select({ id: nodes.id }).from(nodes).where(eq(nodes.parentId, nodeId)).limit(1),
      this.database
        .select({ id: templates.id })
        .from(templates)
        .where(eq(templates.nodeId, nodeId))
        .limit(1),
    ])
    if (children.length > 0 || attachedTemplates.length > 0) {
      throw new NodeNotEmptyError('node has children or templates')
    }
    try {
      await this.database.delete(nodes).where(eq(nodes.id, nodeId))
    } catch (error) {
      // The guards are reads, so a child or template can be attached after they come back empty and
      // before this runs. The foreign key is the authority either way; translate it rather than
      // letting the race be the one path that answers 500 instead of 409.
      if (mentions(error, 'FOREIGN KEY constraint failed')) {
        throw new NodeNotEmptyError('node has children or templates')
      }
      throw error
    }
  }

  async countNodeSubtree(nodeId: string): Promise<{ nodes: number; templates: number }> {
    const node = await this.readNode(nodeId)
    if (node === null) throw new NodeNotFoundError(`node does not exist: ${nodeId}`)
    const subtree = or(
      eq(nodes.id, nodeId),
      and(eq(nodes.season, node.season), pathStartsWith(`${node.path}/`)),
    )
    const [nodeRows, templateRows] = await Promise.all([
      this.database.select({ count: sql<number>`count(*)` }).from(nodes).where(subtree),
      this.database
        .select({ count: sql<number>`count(*)` })
        .from(templates)
        .innerJoin(nodes, eq(nodes.id, templates.nodeId))
        .where(subtree),
    ])
    return { nodes: nodeRows[0]?.count ?? 0, templates: templateRows[0]?.count ?? 0 }
  }

  async deleteNodeCascade(nodeId: string, expected: NodeDeletion): Promise<NodeDeletion> {
    const node = await this.readNode(nodeId)
    if (node === null) throw new NodeNotFoundError(`node does not exist: ${nodeId}`)
    // Every statement reads the root path inside the same transaction. Carrying `node.path` from the
    // read above lets a concurrent rename/move make the batch select the root by id but miss its
    // descendants, and the final delete then loses to their foreign keys.
    const rootPath = sql`(select path from nodes where id = ${nodeId})`
    const liveSubtree = or(
      eq(nodes.id, nodeId),
      and(eq(nodes.season, node.season), pathStartsWith(sql`${rootPath} || '/'`)),
    )
    const liveNodeCount = sql`(select count(*) from ${nodes} where ${liveSubtree})`
    const liveTemplateCount = sql`(
      select count(*) from ${templates}
      inner join ${nodes} on ${nodes.id} = ${templates.nodeId}
      where ${liveSubtree}
    )`
    const token = crypto.randomUUID()
    const claimed = this.database
      .update(nodes)
      .set({ deleteToken: token })
      .where(
        and(
          eq(nodes.id, nodeId),
          sql`${liveNodeCount} = ${expected.nodes}`,
          sql`${liveTemplateCount} = ${expected.templates}`,
        ),
      )
    const hasClaim = sql`(select delete_token from nodes where id = ${nodeId}) = ${token}`
    const subtree = and(liveSubtree, hasClaim)

    const subtreeNodeIds = this.database.select({ id: nodes.id }).from(nodes).where(subtree)
    const subtreeTemplateIds = this.database
      .select({ id: templates.id })
      .from(templates)
      .where(inArray(templates.nodeId, subtreeNodeIds))
    const subtreeVersionIds = this.database
      .select({ id: templateVersions.id })
      .from(templateVersions)
      .where(inArray(templateVersions.templateId, subtreeTemplateIds))

    // Order matters and the batch is what makes it safe. `templates.current_version_id` points at a
    // version and every version points back at the template, so the pointer has to be dropped before
    // the rows it refers to. Tiles go before the versions they belong to, and nodes remain until the
    // templates no longer refer to them. One batch means no caller can observe a half-deleted tree.
    const statements = [
      claimed,
      this.database
        .update(templates)
        .set({ currentVersionId: null })
        .where(inArray(templates.id, subtreeTemplateIds)),
      this.database.delete(versionTiles).where(inArray(versionTiles.versionId, subtreeVersionIds)),
      this.database.delete(templateVersions).where(inArray(templateVersions.id, subtreeVersionIds)),
      // Contributions enforce their template reference too, so they must leave before templates.
      this.database
        .delete(contributions)
        .where(inArray(contributions.templateId, subtreeTemplateIds)),
      this.database.delete(templates).where(inArray(templates.id, subtreeTemplateIds)),
      this.database.delete(nodes).where(subtree),
    ] as const
    const results = await this.database.batch(statements)
    if (Number(results[0]?.meta.changes) === 0) {
      if ((await this.readNode(nodeId)) === null) {
        throw new NodeNotFoundError(`node does not exist: ${nodeId}`)
      }
      throw new NodeSubtreeChangedError('node subtree changed after it was counted')
    }

    return expected
  }

  async insertTemplateVersion(
    version: TemplateVersionRecord,
    options: { readonly requireExisting?: boolean } = {},
  ): Promise<void> {
    assertValidTemplateVersion(version)
    if (options.requireExisting !== true && version.nodeId !== null) {
      const destination = await this.readNode(version.nodeId)
      if (destination === null) {
        throw new NodeNotFoundError(`node does not exist: ${version.nodeId}`)
      }
      if (destination.season !== version.season) {
        throw new InvalidNodeParentError('destination node belongs to a different season')
      }
    }
    // A version replaces content in place, so it has to keep the same dimensions. Name and parent
    // are live template metadata and may legitimately change while the pixels are being encoded.
    const previous = await this.database
      .select({
        name: templates.name,
        surfaceKind: templates.surfaceKind,
        allianceId: templates.allianceId,
        minX: templateVersions.minX,
        minY: templateVersions.minY,
        maxX: templateVersions.maxX,
        maxY: templateVersions.maxY,
      })
      .from(templates)
      .leftJoin(templateVersions, eq(templateVersions.id, templates.currentVersionId))
      .where(eq(templates.id, version.templateId))
      .limit(1)
    const existing = previous[0]
    if (existing !== undefined) {
      const existingSurface = templateSurface(existing.surfaceKind, existing.allianceId)
      if (existingSurface === null || !sameTemplateSurface(existingSurface, version.surface)) {
        throw new TemplateIdentityError(
          `template ${version.templateId} belongs to ${existing.surfaceKind}, not ${version.surface.kind}`,
        )
      }
      if (existing.minX !== null && existing.maxX !== null) {
        const span = (min: number, max: number) =>
          version.surface.kind !== 'world' || max >= min ? max - min : WORLD_PIXELS - min + max
        const wasWidth = span(existing.minX, existing.maxX)
        const wasHeight = (existing.maxY ?? 0) - (existing.minY ?? 0)
        const nowWidth = span(version.bbox.minX, version.bbox.maxX)
        const nowHeight = version.bbox.maxY - version.bbox.minY
        if (wasWidth !== nowWidth || wasHeight !== nowHeight) {
          throw new TemplateIdentityError(
            `template ${version.templateId} is ${wasWidth}x${wasHeight}, not ${nowWidth}x${nowHeight}`,
          )
        }
      }
    }

    const createTemplate = this.database
      .insert(templates)
      .values({
        id: version.templateId,
        season: version.season,
        surfaceKind: version.surface.kind,
        allianceId: version.surface.allianceId,
        nodeId: version.nodeId,
        name: version.name,
        currentVersionId: null,
        publishedAt: null,
        createdWithToken: version.createdWithToken,
        createdByUserId: version.createdByUserId,
        createdAtMs: version.createdAt,
        updatedAtMs: version.createdAt,
      })
      .onConflictDoNothing({ target: templates.id })
    const statements = [
      ...(options.requireExisting === true ? [] : [createTemplate]),
      this.database.insert(templateVersions).values({
        id: version.versionId,
        templateId: version.templateId,
        createdAtMs: version.createdAt,
        createdWithToken: version.createdWithToken,
        createdByUserId: version.createdByUserId,
        minX: version.bbox.minX,
        minY: version.bbox.minY,
        maxX: version.bbox.maxX,
        maxY: version.bbox.maxY,
        totalPixels: version.totalPixels,
        colourTotalsJson:
          version.colourTotals === undefined ? null : JSON.stringify(version.colourTotals),
      }),
      // Tiles go in as multi-row inserts, not one statement each. D1 allows 50 queries per Worker
      // invocation on the free plan, so a 48-chunk template — a 48,000x1 upload reaches that without
      // stressing anything — produced 51 statements and failed the whole batch. Chunked by bound
      // parameters rather than by rows: four columns each, kept under the 100-parameter ceiling.
      ...chunkRows(
        version.chunks.map((chunk) => ({
          versionId: version.versionId,
          tileX: chunk.tileX,
          tileY: chunk.tileY,
          hash: chunk.hash,
        })),
        VERSION_TILE_ROWS_PER_INSERT,
      ).map((rows) => this.database.insert(versionTiles).values(rows)),
      // The referenced version exists before this statement runs. D1 executes batch statements in
      // order, so the circular template/version relationship never needs deferred foreign keys.
      // New pixels are a change like any other, so the template's own timestamp moves with them —
      // for a template that already existed, this is the only column besides the version that does.
      this.database
        .update(templates)
        .set({ currentVersionId: version.versionId, updatedAtMs: version.createdAt })
        .where(eq(templates.id, version.templateId)),
    ]

    try {
      await this.database.batch(
        statements as [(typeof statements)[number], ...Array<(typeof statements)[number]>],
      )
    } catch (error) {
      // The node check above is a separate read, so a concurrent delete can remove the node between
      // the two — allowed, since no template row referenced it yet — and the foreign key rejects
      // this insert. Same outcome as the check finding it missing, so it gets the same error rather
      // than escaping as a 500. Same rule as `insertNode` and `deleteNode`.
      if (mentions(error, 'FOREIGN KEY constraint failed')) {
        if (options.requireExisting === true) {
          throw new TemplateNotFoundError(`template does not exist: ${version.templateId}`)
        }
        throw new NodeNotFoundError(`node does not exist: ${version.nodeId}`)
      }
      throw error
    }
  }

  async readTemplateVersion(versionId: string): Promise<TemplateVersionRecord | null> {
    const rows = await this.database
      .select({
        templateId: templates.id,
        surfaceKind: templates.surfaceKind,
        allianceId: templates.allianceId,
        season: templates.season,
        nodeId: templates.nodeId,
        name: templates.name,
        versionId: templateVersions.id,
        createdWithToken: templateVersions.createdWithToken,
        createdByUserId: templateVersions.createdByUserId,
        createdAt: templateVersions.createdAtMs,
        minX: templateVersions.minX,
        minY: templateVersions.minY,
        maxX: templateVersions.maxX,
        maxY: templateVersions.maxY,
        totalPixels: templateVersions.totalPixels,
        colourTotalsJson: templateVersions.colourTotalsJson,
      })
      .from(templateVersions)
      .innerJoin(templates, eq(templates.id, templateVersions.templateId))
      .where(eq(templateVersions.id, versionId))
      .limit(1)
    const row = rows[0]
    if (row === undefined) return null
    const surface = templateSurface(row.surfaceKind, row.allianceId)
    if (surface === null) throw new Error(`template ${row.templateId} has an invalid surface`)
    const colourTotals = parseColourTotals(row.colourTotalsJson)

    const chunks = await this.database
      .select({ tileX: versionTiles.tileX, tileY: versionTiles.tileY, hash: versionTiles.hash })
      .from(versionTiles)
      .where(eq(versionTiles.versionId, versionId))
      .orderBy(asc(versionTiles.tileY), asc(versionTiles.tileX))

    return {
      templateId: row.templateId,
      surface,
      season: row.season,
      nodeId: row.nodeId,
      name: row.name,
      versionId: row.versionId,
      createdByUserId: row.createdByUserId,
      createdWithToken: row.createdWithToken,
      createdAt: row.createdAt,
      bbox: { minX: row.minX, minY: row.minY, maxX: row.maxX, maxY: row.maxY },
      totalPixels: row.totalPixels,
      ...(colourTotals === undefined ? {} : { colourTotals }),
      chunks,
    }
  }

  async readServerSettings(): Promise<ServerSettings> {
    const rows = await this.database
      .select({ name: serverSettings.name, description: serverSettings.description })
      .from(serverSettings)
      .where(eq(serverSettings.id, 1))
      .limit(1)
    const row = rows[0]
    return { name: row?.name ?? null, description: row?.description ?? null }
  }

  async writeServerSettings(patch: { name?: string; description?: string | null }): Promise<void> {
    if (patch.name === undefined && patch.description === undefined) return
    const next = {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
    }
    await this.database
      .insert(serverSettings)
      .values({
        id: 1,
        name: patch.name ?? null,
        description: patch.description ?? null,
      })
      .onConflictDoUpdate({ target: serverSettings.id, set: next })
  }

  async readTemplate(templateId: string): Promise<TemplateRecord | null> {
    const rows = await this.database
      .select({
        id: templates.id,
        season: templates.season,
        surfaceKind: templates.surfaceKind,
        allianceId: templates.allianceId,
        nodeId: templates.nodeId,
        name: templates.name,
        currentVersionId: templates.currentVersionId,
        publishedAt: templates.publishedAt,
        timelapseFrozenAt: templates.timelapseFrozenAt,
        finishedAt: templates.finishedAt,
        createdAt: templates.createdAtMs,
        updatedAt: templates.updatedAtMs,
      })
      .from(templates)
      .where(eq(templates.id, templateId))
      .limit(1)
    const row = rows[0]
    if (row === undefined) return null
    const surface = templateSurface(row.surfaceKind, row.allianceId)
    if (surface === null) throw new Error(`template ${row.id} has an invalid surface`)
    return {
      id: row.id,
      surface,
      season: row.season,
      nodeId: row.nodeId,
      name: row.name,
      currentVersionId: row.currentVersionId,
      published: row.publishedAt !== null,
      timelapseFrozen: row.timelapseFrozenAt !== null,
      finished: row.finishedAt !== null,
      finishedAt: row.finishedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
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
    let predicate = eq(templates.id, templateId)
    if (patch.nodeId !== undefined) {
      const [existing] = await this.database
        .select({ nodeId: templates.nodeId, season: templates.season })
        .from(templates)
        .where(eq(templates.id, templateId))
        .limit(1)
      if (existing === undefined) return false
      if (patch.nodeId !== null) {
        const target = await this.readNode(patch.nodeId)
        if (target === null) throw new NodeNotFoundError(`node does not exist: ${patch.nodeId}`)
        if (target.season !== existing.season) {
          throw new InvalidNodeParentError('destination node belongs to a different season')
        }
      }
      // If another administrator moves or deletes the template after the season check, this write
      // loses instead of applying a stale decision and reporting success.
      const parentUnchanged =
        existing.nodeId === null ? isNull(templates.nodeId) : eq(templates.nodeId, existing.nodeId)
      predicate = and(eq(templates.id, templateId), parentUnchanged) ?? predicate
    }
    if (patch.timelapseFrozenAt === null && patch.finishedAt !== null) {
      predicate = and(predicate, isNull(templates.finishedAt)) ?? predicate
    }

    try {
      const result = await this.database
        .update(templates)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.nodeId === undefined ? {} : { nodeId: patch.nodeId }),
          ...(patch.publishedAt === undefined ? {} : { publishedAt: patch.publishedAt }),
          ...(patch.timelapseFrozenAt === undefined
            ? {}
            : { timelapseFrozenAt: patch.timelapseFrozenAt }),
          ...(patch.finishedAt === undefined ? {} : { finishedAt: patch.finishedAt }),
          updatedAtMs: updatedAt,
        })
        .where(predicate)
      return Number(result.meta.changes) > 0
    } catch (error) {
      // The destination was read above, and another administrator can delete it between that read
      // and this write. Translated like the other two races in this file, so the one path that
      // could still answer 500 instead of a typed error no longer can.
      if (mentions(error, 'FOREIGN KEY constraint failed')) {
        throw new NodeNotFoundError(`node does not exist: ${patch.nodeId ?? ''}`)
      }
      throw error
    }
  }

  async deleteTemplate(templateId: string, expected: TemplateDeletePrecondition): Promise<boolean> {
    // Order matters and the batch is what makes it safe. `templates.current_version_id` points at a
    // version and every version points back at the template, so the pointer has to be dropped before
    // the rows it refers to. Tiles go first because they reference a version.
    const claimedTemplate = and(eq(templates.id, templateId), isNull(templates.currentVersionId))
    const claimedTemplateIds = this.database
      .select({ id: templates.id })
      .from(templates)
      .where(claimedTemplate)
    const claimedVersionIds = this.database
      .select({ id: templateVersions.id })
      .from(templateVersions)
      .where(
        and(
          eq(templateVersions.templateId, templateId),
          inArray(templateVersions.templateId, claimedTemplateIds),
        ),
      )
    const statements = [
      this.database
        .update(templates)
        .set({ currentVersionId: null })
        .where(
          and(
            eq(templates.id, templateId),
            eq(templates.currentVersionId, expected.versionId),
            eq(templates.updatedAtMs, expected.updatedAt),
          ),
        ),
      this.database.delete(versionTiles).where(inArray(versionTiles.versionId, claimedVersionIds)),
      this.database.delete(templateVersions).where(inArray(templateVersions.id, claimedVersionIds)),
      this.database
        .delete(contributions)
        .where(inArray(contributions.templateId, claimedTemplateIds)),
      this.database.delete(templates).where(claimedTemplate),
    ]
    const results = await this.database.batch(
      statements as [(typeof statements)[number], ...Array<(typeof statements)[number]>],
    )
    // Chunk blobs stay: they are content-addressed and shared. See `deleteTemplate` on the port.
    return Number(results.at(-1)?.meta.changes) > 0
  }

  async listManifestTemplates(
    scope: TemplateManifestScope,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTemplateRecord[]> {
    const scoped = and(
      eq(templates.season, scope.season),
      eq(templates.surfaceKind, scope.surface.kind),
      scope.surface.kind === 'world'
        ? isNull(templates.allianceId)
        : eq(templates.allianceId, scope.surface.allianceId),
    )
    const rows = await this.database
      .select({
        id: templates.id,
        nodeId: templates.nodeId,
        name: templates.name,
        versionId: templateVersions.id,
        minX: templateVersions.minX,
        minY: templateVersions.minY,
        maxX: templateVersions.maxX,
        maxY: templateVersions.maxY,
        totalPixels: templateVersions.totalPixels,
        publishedAt: templates.publishedAt,
        finishedAt: templates.finishedAt,
        timelapseFrozenAt: templates.timelapseFrozenAt,
        createdAt: templates.createdAtMs,
        updatedAt: templates.updatedAtMs,
      })
      .from(templates)
      .innerJoin(templateVersions, eq(templateVersions.id, templates.currentVersionId))
      .where(includeUnpublished ? scoped : and(scoped, isNotNull(templates.publishedAt)))

    return rows.map((row) => ({
      id: row.id,
      nodeId: row.nodeId,
      name: row.name,
      versionId: row.versionId,
      bbox: { minX: row.minX, minY: row.minY, maxX: row.maxX, maxY: row.maxY },
      totalPixels: row.totalPixels,
      published: row.publishedAt !== null,
      finished: row.finishedAt !== null,
      finishedAt: row.finishedAt,
      timelapseFrozen: row.timelapseFrozenAt !== null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
  }

  async listManifestTiles(
    scope: TemplateManifestScope,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTileRecord[]> {
    const scoped = and(
      eq(templates.season, scope.season),
      eq(templates.surfaceKind, scope.surface.kind),
      scope.surface.kind === 'world'
        ? isNull(templates.allianceId)
        : eq(templates.allianceId, scope.surface.allianceId),
    )
    return this.database
      .select({
        templateId: templates.id,
        versionId: templateVersions.id,
        tileX: versionTiles.tileX,
        tileY: versionTiles.tileY,
        hash: versionTiles.hash,
      })
      .from(versionTiles)
      .innerJoin(templateVersions, eq(templateVersions.id, versionTiles.versionId))
      .innerJoin(
        templates,
        and(
          eq(templates.id, templateVersions.templateId),
          eq(templates.currentVersionId, templateVersions.id),
        ),
      )
      .where(includeUnpublished ? scoped : and(scoped, isNotNull(templates.publishedAt)))
  }

  async listAlarmTiles(season: number): Promise<readonly AlarmTileRecord[]> {
    return this.database
      .select({
        templateId: templates.id,
        versionId: templateVersions.id,
        tileX: versionTiles.tileX,
        tileY: versionTiles.tileY,
        hash: versionTiles.hash,
        observedAt: templateTileStatuses.observedAtMs,
      })
      .from(versionTiles)
      .innerJoin(templateVersions, eq(templateVersions.id, versionTiles.versionId))
      .innerJoin(
        templates,
        and(
          eq(templates.id, templateVersions.templateId),
          eq(templates.currentVersionId, templateVersions.id),
        ),
      )
      .leftJoin(
        templateTileStatuses,
        and(
          eq(templateTileStatuses.templateId, templates.id),
          eq(templateTileStatuses.versionId, templateVersions.id),
          eq(templateTileStatuses.tileX, versionTiles.tileX),
          eq(templateTileStatuses.tileY, versionTiles.tileY),
        ),
      )
      .where(eq(templates.season, season))
  }

  async listTelemetryTargets(
    season: number,
    tile: { readonly x: number; readonly y: number },
    includeUnpublished: boolean,
  ): Promise<readonly TelemetryTarget[]> {
    return this.database
      .select({
        templateId: templates.id,
        versionId: templateVersions.id,
        tileX: versionTiles.tileX,
        tileY: versionTiles.tileY,
        hash: versionTiles.hash,
        minX: templateVersions.minX,
        minY: templateVersions.minY,
        maxX: templateVersions.maxX,
        maxY: templateVersions.maxY,
        finishedAt: templates.finishedAt,
      })
      .from(versionTiles)
      .innerJoin(templateVersions, eq(templateVersions.id, versionTiles.versionId))
      .innerJoin(
        templates,
        and(
          eq(templates.id, templateVersions.templateId),
          eq(templates.currentVersionId, templateVersions.id),
        ),
      )
      .where(
        and(
          eq(templates.season, season),
          eq(templates.surfaceKind, 'world'),
          isNull(templates.allianceId),
          eq(versionTiles.tileX, tile.x),
          eq(versionTiles.tileY, tile.y),
          includeUnpublished ? undefined : isNotNull(templates.publishedAt),
        ),
      )
      .then((rows) =>
        rows.map((row) => ({
          templateId: row.templateId,
          versionId: row.versionId,
          tileX: row.tileX,
          tileY: row.tileY,
          hash: row.hash,
          bbox: { minX: row.minX, minY: row.minY, maxX: row.maxX, maxY: row.maxY },
          finished: row.finishedAt !== null,
        })),
      )
  }

  async readLatestTile(season: number, tile: { readonly x: number; readonly y: number }) {
    const rows = await this.database
      .select()
      .from(canvasTiles)
      .where(
        and(
          eq(canvasTiles.season, season),
          eq(canvasTiles.tileX, tile.x),
          eq(canvasTiles.tileY, tile.y),
        ),
      )
      .limit(1)
    const row = rows[0]
    return row === undefined
      ? null
      : {
          season: row.season,
          tile: { x: row.tileX, y: row.tileY },
          hash: row.sha256,
          observedAt: row.observedAtMs,
        }
  }

  async recordTileObservation(
    observation: TileObservation,
    statuses: readonly TemplateTileStatusRecord[],
    recordHistory = true,
    forceCurrent = false,
  ): Promise<void> {
    const history = this.database
      .insert(tileHistory)
      .values({
        season: observation.season,
        tileX: observation.tile.x,
        tileY: observation.tile.y,
        resolutionS: seconds(0),
        bucketStartS: observation.reportedAt,
        sha256: observation.hash,
        reportedWithToken: observation.reportedWithToken,
        reportedByUserId: observation.reportedByUserId,
      })
      .onConflictDoNothing()
    const current = this.database
      .insert(canvasTiles)
      .values({
        season: observation.season,
        tileX: observation.tile.x,
        tileY: observation.tile.y,
        sha256: observation.hash,
        observedAtMs: observation.observedAt,
        serverOwned: forceCurrent,
      })
      .onConflictDoUpdate({
        target: [canvasTiles.season, canvasTiles.tileX, canvasTiles.tileY],
        set: {
          sha256: observation.hash,
          observedAtMs: observation.observedAt,
          serverOwned: forceCurrent,
        },
        ...(forceCurrent
          ? {
              setWhere: sql`${canvasTiles.serverOwned} = 0
                OR ${canvasTiles.observedAtMs} <= ${observation.observedAt}`,
            }
          : { setWhere: lte(canvasTiles.observedAtMs, observation.observedAt) }),
      })
    if (recordHistory) await this.database.batch([history, current])
    else await current
    await this.writeTileStatuses(statuses, forceCurrent)
  }

  private async writeTileStatuses(
    statuses: readonly TemplateTileStatusRecord[],
    forceCurrent = false,
  ): Promise<void> {
    for (const group of chunkRows(statuses, 50)) {
      const statements = group.map((status) =>
        this.database
          .insert(templateTileStatuses)
          .values({
            templateId: status.templateId,
            versionId: status.versionId,
            tileX: status.tile.x,
            tileY: status.tile.y,
            correct: status.correct,
            wrong: status.wrong,
            blank: status.blank,
            coloursJson: JSON.stringify(status.colours ?? []),
            observedAtMs: status.observedAt,
            serverOwned: forceCurrent,
          })
          .onConflictDoUpdate({
            target: [
              templateTileStatuses.templateId,
              templateTileStatuses.versionId,
              templateTileStatuses.tileX,
              templateTileStatuses.tileY,
            ],
            set: {
              correct: status.correct,
              wrong: status.wrong,
              blank: status.blank,
              coloursJson: JSON.stringify(status.colours ?? []),
              observedAtMs: status.observedAt,
              serverOwned: forceCurrent,
            },
            ...(forceCurrent
              ? {
                  setWhere: sql`${templateTileStatuses.serverOwned} = 0
                    OR ${templateTileStatuses.observedAtMs} <= ${status.observedAt}`,
                }
              : { setWhere: lte(templateTileStatuses.observedAtMs, status.observedAt) }),
          }),
      )
      if (statements.length > 0) {
        await this.database.batch(
          statements as [(typeof statements)[number], ...Array<(typeof statements)[number]>],
        )
      }
    }
  }

  async readTileBlob(hash: string): Promise<TileBlobObject | null> {
    const rows = await this.database
      .select()
      .from(tileBlobObjects)
      .where(and(eq(tileBlobObjects.sha256, hash), eq(tileBlobObjects.state, 'active')))
      .orderBy(asc(tileBlobObjects.blobKey))
      .limit(1)
    return rows[0] === undefined ? null : toTileBlobObject(rows[0])
  }

  async reserveTileBlob(
    hash: string,
    reservationId: string,
    now: Millis,
    expiresAt: Millis,
  ): Promise<TileBlobReservation | null> {
    const results = await this.client.batch([
      this.client.prepare('DELETE FROM tile_blob_reservations WHERE expires_at_ms <= ?').bind(now),
      this.client
        .prepare(
          `INSERT INTO tile_blob_reservations (id, sha256, blob_key, expires_at_ms)
           SELECT ?, object.sha256, object.blob_key, ?
           FROM tile_blob_objects AS object
           WHERE object.sha256 = ?
             AND object.state IN ('active', 'candidate', 'uploading')
             AND NOT EXISTS (
               SELECT 1 FROM tile_blob_objects AS deleting
               WHERE deleting.sha256 = object.sha256 AND deleting.state = 'deleting'
             )
           ORDER BY CASE object.state WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
             object.blob_key
           LIMIT 1
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(reservationId, expiresAt, hash),
      this.client
        .prepare(
          `UPDATE tile_blob_objects SET state = 'active', reclaimed_at_ms = NULL
           WHERE blob_key = (
             SELECT blob_key FROM tile_blob_reservations WHERE id = ?
           ) AND state IN ('candidate', 'uploading')`,
        )
        .bind(reservationId),
    ])
    if (Number(results[1]?.meta.changes) === 0) return null
    const row = await this.client
      .prepare(
        'SELECT id, sha256, blob_key, expires_at_ms FROM tile_blob_reservations WHERE id = ?',
      )
      .bind(reservationId)
      .first<{ id: string; sha256: string; blob_key: string; expires_at_ms: number }>()
    return row === null
      ? null
      : {
          id: row.id,
          hash: row.sha256,
          blobKey: row.blob_key,
          expiresAt: row.expires_at_ms as Millis,
        }
  }

  async reserveTileBlobUpload(
    hash: string,
    blobKey: string,
    reservationId: string,
    now: Millis,
    expiresAt: Millis,
  ): Promise<TileBlobReservation | null> {
    const results = await this.client.batch([
      this.client.prepare('DELETE FROM tile_blob_reservations WHERE expires_at_ms <= ?').bind(now),
      this.client
        .prepare(
          `INSERT INTO tile_blob_objects (
             blob_key, sha256, state, discovered_at_ms, delete_attempts
           )
           SELECT ?, ?, 'uploading', ?, 0
           WHERE NOT EXISTS (
             SELECT 1 FROM tile_blob_objects
             WHERE sha256 = ? AND state = 'deleting'
           ) AND NOT EXISTS (
             SELECT 1 FROM tile_blob_objects
             WHERE sha256 = ? AND state IN ('active', 'uploading')
           )
           ON CONFLICT(blob_key) DO NOTHING`,
        )
        .bind(blobKey, hash, now, hash, hash),
      this.client
        .prepare(
          `INSERT INTO tile_blob_reservations (id, sha256, blob_key, expires_at_ms)
           SELECT ?, object.sha256, object.blob_key, ?
           FROM tile_blob_objects AS object
           WHERE object.sha256 = ?
             AND object.state IN ('active', 'uploading')
             AND NOT EXISTS (
               SELECT 1 FROM tile_blob_objects AS deleting
               WHERE deleting.sha256 = object.sha256 AND deleting.state = 'deleting'
             )
           ORDER BY CASE object.state WHEN 'active' THEN 0 ELSE 1 END, object.blob_key
           LIMIT 1
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(reservationId, expiresAt, hash),
    ])
    if (Number(results[2]?.meta.changes) === 0) return null
    const row = await this.client
      .prepare(
        'SELECT id, sha256, blob_key, expires_at_ms FROM tile_blob_reservations WHERE id = ?',
      )
      .bind(reservationId)
      .first<{ id: string; sha256: string; blob_key: string; expires_at_ms: number }>()
    return row === null
      ? null
      : {
          id: row.id,
          hash: row.sha256,
          blobKey: row.blob_key,
          expiresAt: row.expires_at_ms as Millis,
        }
  }

  async commitTileBlobReservation(
    reservationId: string,
    now: Millis,
    observation: TileObservation,
    statuses: readonly TemplateTileStatusRecord[],
    recordHistory = true,
    forceCurrent = false,
  ): Promise<boolean> {
    const statements: D1PreparedStatement[] = [
      this.client.prepare('DELETE FROM tile_blob_reservations WHERE expires_at_ms <= ?').bind(now),
      this.client
        .prepare(
          `UPDATE tile_blob_objects SET state = 'active', reclaimed_at_ms = NULL
           WHERE blob_key = (
             SELECT blob_key FROM tile_blob_reservations
             WHERE id = ? AND sha256 = ?
           ) AND NOT EXISTS (
             SELECT 1 FROM tile_blob_objects AS deleting
             WHERE deleting.sha256 = ? AND deleting.state = 'deleting'
           )`,
        )
        .bind(reservationId, observation.hash, observation.hash),
    ]
    if (recordHistory) {
      statements.push(
        this.client
          .prepare(
            `INSERT INTO tile_history (
               season, tile_x, tile_y, resolution_s, bucket_start_s, sha256,
               reported_with_token, reported_by_user_id
             )
             SELECT ?, ?, ?, 0, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM tile_blob_reservations AS reservation
               INNER JOIN tile_blob_objects AS object ON object.blob_key = reservation.blob_key
               WHERE reservation.id = ? AND reservation.sha256 = ? AND object.state = 'active'
             )
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            observation.season,
            observation.tile.x,
            observation.tile.y,
            observation.reportedAt,
            observation.hash,
            observation.reportedWithToken,
            observation.reportedByUserId,
            reservationId,
            observation.hash,
          ),
      )
    }
    statements.push(
      this.client
        .prepare(
          `INSERT INTO canvas_tiles (
             season, tile_x, tile_y, sha256, observed_at_ms, server_owned
           )
           SELECT ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM tile_blob_reservations AS reservation
             INNER JOIN tile_blob_objects AS object ON object.blob_key = reservation.blob_key
             WHERE reservation.id = ? AND reservation.sha256 = ? AND object.state = 'active'
           )
           ON CONFLICT(season, tile_x, tile_y) DO UPDATE SET
             sha256 = excluded.sha256,
             observed_at_ms = excluded.observed_at_ms,
             server_owned = excluded.server_owned
           WHERE canvas_tiles.observed_at_ms <= excluded.observed_at_ms
             OR (excluded.server_owned = 1 AND canvas_tiles.server_owned = 0)`,
        )
        .bind(
          observation.season,
          observation.tile.x,
          observation.tile.y,
          observation.hash,
          observation.observedAt,
          forceCurrent ? 1 : 0,
          reservationId,
          observation.hash,
        ),
      this.client.prepare('DELETE FROM tile_blob_reservations WHERE id = ?').bind(reservationId),
    )
    const results = await this.client.batch(statements)
    if (Number(results[1]?.meta.changes) === 0) return false
    await this.writeTileStatuses(statuses, forceCurrent)
    return true
  }

  async releaseTileBlobReservation(reservationId: string): Promise<void> {
    await this.client
      .prepare('DELETE FROM tile_blob_reservations WHERE id = ?')
      .bind(reservationId)
      .run()
  }

  async noteTileBlobObject(
    hash: string,
    blobKey: string,
    now: Millis,
  ): Promise<TileBlobCandidateResult> {
    await this.client
      .prepare(
        `INSERT INTO tile_blob_objects (
           blob_key, sha256, state, discovered_at_ms, delete_attempts
         )
         SELECT ?, ?, CASE
           WHEN EXISTS (
             SELECT 1 FROM tile_blob_reservations
             WHERE sha256 = ? AND blob_key = ? AND expires_at_ms > ?
           ) OR (
             (
               EXISTS (SELECT 1 FROM tile_history WHERE sha256 = ?)
               OR EXISTS (SELECT 1 FROM canvas_tiles WHERE sha256 = ?)
             ) AND (
               EXISTS (
                 SELECT 1 FROM tile_blob_objects
                 WHERE blob_key = ? AND sha256 = ? AND state = 'active'
               ) OR NOT EXISTS (
                 SELECT 1 FROM tile_blob_objects
                 WHERE sha256 = ? AND blob_key <> ? AND state = 'active'
               )
             )
           ) THEN 'active' ELSE 'candidate' END, ?, 0
         ON CONFLICT(blob_key) DO UPDATE SET
           sha256 = excluded.sha256,
           state = CASE
             WHEN tile_blob_objects.state = 'deleting' THEN 'deleting'
             ELSE excluded.state
           END,
           reclaimed_at_ms = CASE
             WHEN tile_blob_objects.state = 'deleting' THEN tile_blob_objects.reclaimed_at_ms
             ELSE NULL
           END,
           delete_started_at_ms = CASE
             WHEN tile_blob_objects.state = 'deleting' THEN tile_blob_objects.delete_started_at_ms
             ELSE NULL
           END`,
      )
      .bind(blobKey, hash, hash, blobKey, now, hash, hash, blobKey, hash, hash, blobKey, now)
      .run()
    const row = await this.client
      .prepare('SELECT state FROM tile_blob_objects WHERE blob_key = ?')
      .bind(blobKey)
      .first<{ state: string }>()
    return row?.state === 'deleting'
      ? 'deleting'
      : row?.state === 'active'
        ? 'referenced'
        : 'candidate'
  }

  async listTileBlobDeletionWork(limit: number): Promise<readonly TileBlobObject[]> {
    const rows = await this.database
      .select()
      .from(tileBlobObjects)
      .where(inArray(tileBlobObjects.state, ['deleting', 'candidate']))
      .orderBy(
        sql`CASE ${tileBlobObjects.state} WHEN 'deleting' THEN 0 ELSE 1 END`,
        asc(tileBlobObjects.discoveredAtMs),
        asc(tileBlobObjects.blobKey),
      )
      .limit(limit)
    return rows.map(toTileBlobObject)
  }

  async claimTileBlobDeletion(blobKey: string, now: Millis): Promise<TileBlobClaimResult> {
    const results = await this.client.batch([
      this.client.prepare('DELETE FROM tile_blob_reservations WHERE expires_at_ms <= ?').bind(now),
      this.client
        .prepare(
          `UPDATE tile_blob_objects SET
             state = CASE
               WHEN EXISTS (
                   SELECT 1 FROM tile_blob_reservations
                   WHERE sha256 = tile_blob_objects.sha256
                     AND blob_key = tile_blob_objects.blob_key AND expires_at_ms > ?
                 ) OR (
                   (
                     EXISTS (SELECT 1 FROM tile_history WHERE sha256 = tile_blob_objects.sha256)
                     OR EXISTS (SELECT 1 FROM canvas_tiles WHERE sha256 = tile_blob_objects.sha256)
                   ) AND NOT EXISTS (
                     SELECT 1 FROM tile_blob_objects AS active
                     WHERE active.sha256 = tile_blob_objects.sha256
                       AND active.blob_key <> tile_blob_objects.blob_key
                       AND active.state = 'active'
                 )
                )
               THEN 'active' ELSE 'deleting' END,
             delete_started_at_ms = CASE
               WHEN EXISTS (
                   SELECT 1 FROM tile_blob_reservations
                   WHERE sha256 = tile_blob_objects.sha256
                     AND blob_key = tile_blob_objects.blob_key AND expires_at_ms > ?
                 ) OR (
                   (
                     EXISTS (SELECT 1 FROM tile_history WHERE sha256 = tile_blob_objects.sha256)
                     OR EXISTS (SELECT 1 FROM canvas_tiles WHERE sha256 = tile_blob_objects.sha256)
                   ) AND NOT EXISTS (
                     SELECT 1 FROM tile_blob_objects AS active
                     WHERE active.sha256 = tile_blob_objects.sha256
                       AND active.blob_key <> tile_blob_objects.blob_key
                       AND active.state = 'active'
                 )
                )
               THEN NULL ELSE coalesce(delete_started_at_ms, ?) END,
             delete_attempts = CASE
               WHEN EXISTS (
                   SELECT 1 FROM tile_blob_reservations
                   WHERE sha256 = tile_blob_objects.sha256
                     AND blob_key = tile_blob_objects.blob_key AND expires_at_ms > ?
                 ) OR (
                   (
                     EXISTS (SELECT 1 FROM tile_history WHERE sha256 = tile_blob_objects.sha256)
                     OR EXISTS (SELECT 1 FROM canvas_tiles WHERE sha256 = tile_blob_objects.sha256)
                   ) AND NOT EXISTS (
                     SELECT 1 FROM tile_blob_objects AS active
                     WHERE active.sha256 = tile_blob_objects.sha256
                       AND active.blob_key <> tile_blob_objects.blob_key
                       AND active.state = 'active'
                 )
                )
               THEN delete_attempts ELSE delete_attempts + 1 END
           WHERE blob_key = ? AND state IN ('candidate', 'deleting')`,
        )
        .bind(now, now, now, now, blobKey),
    ])
    if (Number(results[1]?.meta.changes) === 0) return 'missing'
    const row = await this.client
      .prepare('SELECT state FROM tile_blob_objects WHERE blob_key = ?')
      .bind(blobKey)
      .first<{ state: string }>()
    if (row?.state === 'deleting') return 'claimed'
    if (row?.state === 'active') return 'blocked'
    return 'missing'
  }

  async finishTileBlobDeletion(blobKey: string, reclaimedAt: Millis): Promise<void> {
    await this.client
      .prepare(
        `UPDATE tile_blob_objects
         SET state = 'deleted', reclaimed_at_ms = ?
         WHERE blob_key = ? AND state = 'deleting'`,
      )
      .bind(reclaimedAt, blobKey)
      .run()
  }

  async readTileBlobScanState(): Promise<TileBlobScanState> {
    const rows = await this.database.select().from(tileBlobGcState).where(eq(tileBlobGcState.id, 1))
    const row = rows[0]
    return row === undefined
      ? { completedSweeps: 0 }
      : {
          ...(row.cursor === null ? {} : { cursor: row.cursor }),
          completedSweeps: row.completedSweeps,
        }
  }

  async writeTileBlobScanState(cursor: string | undefined): Promise<void> {
    await this.database
      .insert(tileBlobGcState)
      .values({ id: 1, cursor: cursor ?? null, completedSweeps: cursor === undefined ? 1 : 0 })
      .onConflictDoUpdate({
        target: tileBlobGcState.id,
        set: {
          cursor: cursor ?? null,
          completedSweeps: sql`${tileBlobGcState.completedSweeps} + ${cursor === undefined ? 1 : 0}`,
        },
      })
  }

  async foldTileHistory(
    season: number,
    tile: { readonly x: number; readonly y: number },
    now: Seconds,
  ): Promise<void> {
    for (const edge of TILE_HISTORY_DECAY_EDGES) {
      const targetStart = `CAST(history.bucket_start_s / ${edge.target} AS INTEGER) * ${edge.target}`
      const ringX = `MIN(ABS(version_tiles.tile_x - history.tile_x), ${WORLD_TILES} - ABS(version_tiles.tile_x - history.tile_x))`
      const chosen = `
        SELECT ${targetStart} AS target_start
        FROM tile_history AS history
        WHERE history.season = ? AND history.tile_x = ? AND history.tile_y = ?
          AND history.resolution_s = ${edge.source}
          AND ${targetStart} + ${edge.target} <= ?
          AND NOT EXISTS (
            SELECT 1 FROM tile_history AS finer
            WHERE finer.season = history.season
              AND finer.tile_x = history.tile_x
              AND finer.tile_y = history.tile_y
              AND finer.resolution_s < ${edge.source}
              AND finer.bucket_start_s >= ${targetStart}
              AND finer.bucket_start_s < ${targetStart} + ${edge.target}
          )
          AND NOT EXISTS (
            SELECT 1
            FROM templates
            INNER JOIN template_versions
              ON template_versions.id = templates.current_version_id
            INNER JOIN version_tiles
              ON version_tiles.version_id = template_versions.id
            WHERE templates.season = history.season
              AND templates.timelapse_frozen_at_ms IS NOT NULL
              AND ${targetStart} * 1000 <= templates.timelapse_frozen_at_ms
              AND ${ringX} <= 1
              AND ABS(version_tiles.tile_y - history.tile_y) <= 1
          )
        GROUP BY target_start
        ORDER BY target_start
        LIMIT ?`
      const query = `
        WITH chosen AS (${chosen})
        SELECT history.season, history.tile_x, history.tile_y,
          history.resolution_s, history.bucket_start_s, history.sha256,
          history.reported_with_token, history.reported_by_user_id
        FROM tile_history AS history
        INNER JOIN chosen
          ON chosen.target_start = CAST(history.bucket_start_s / ${edge.target} AS INTEGER) * ${edge.target}
        WHERE history.season = ? AND history.tile_x = ? AND history.tile_y = ?
          AND history.resolution_s = ${edge.source}
        ORDER BY history.bucket_start_s, history.sha256, history.reported_by_user_id`
      const cutoff = now - edge.retainSeconds
      const selected = await this.client
        .prepare(query)
        .bind(season, tile.x, tile.y, cutoff, DECAY_FOLD_GROUP_LIMIT, season, tile.x, tile.y)
        .all<{
          season: number
          tile_x: number
          tile_y: number
          resolution_s: number
          bucket_start_s: number
          sha256: string
          reported_with_token: string
          reported_by_user_id: number
        }>()
      const rows: TileHistoryReporterRow[] = selected.results.map((row) => ({
        season: row.season,
        tile: { x: row.tile_x, y: row.tile_y },
        resolution: row.resolution_s,
        bucketStart: seconds(row.bucket_start_s),
        hash: row.sha256,
        reportedWithToken: row.reported_with_token,
        reportedByUserId: row.reported_by_user_id,
      }))
      if (rows.length === 0) continue
      const folded = foldTileReporterRows(rows, edge.target)
      const statements: D1PreparedStatement[] = []
      for (const group of chunkRows(folded.rows, 10)) {
        const values = group.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
        statements.push(
          this.client
            .prepare(
              `INSERT INTO tile_history (
                season, tile_x, tile_y, resolution_s, bucket_start_s, sha256,
                reported_with_token, reported_by_user_id
              ) VALUES ${values}
              ON CONFLICT(
                season, tile_x, tile_y, resolution_s, bucket_start_s, sha256,
                reported_by_user_id
              ) DO UPDATE SET reported_with_token = excluded.reported_with_token`,
            )
            .bind(
              ...group.flatMap((row) => [
                row.season,
                row.tile.x,
                row.tile.y,
                row.resolution,
                row.bucketStart,
                row.hash,
                row.reportedWithToken,
                row.reportedByUserId,
              ]),
            ),
        )
      }
      // Delete only the reporter rows that participated in this fold. A new observation can land
      // after the SELECT above; deleting by the whole target window would erase that unrepresented
      // row. Exact primary keys leave it for the next touch instead.
      for (const group of chunkRows(rows, 20)) {
        const keys = group.map(() => '(?, ?, ?)').join(', ')
        statements.push(
          this.client
            .prepare(
              `DELETE FROM tile_history
               WHERE season = ? AND tile_x = ? AND tile_y = ? AND resolution_s = ${edge.source}
                 AND (bucket_start_s, sha256, reported_by_user_id) IN (${keys})`,
            )
            .bind(
              season,
              tile.x,
              tile.y,
              ...group.flatMap((row) => [row.bucketStart, row.hash, row.reportedByUserId]),
            ),
        )
      }
      await this.client.batch(statements)
    }
  }

  async readTemplateStatuses(
    season: number,
    includeUnpublished: boolean,
  ): Promise<readonly import('@caelestis/shared').TemplateStatus[]> {
    const rows = await this.database
      .select({
        templateId: templates.id,
        correct: sql<number>`sum(${templateTileStatuses.correct})`,
        wrong: sql<number>`sum(${templateTileStatuses.wrong})`,
        blank: sql<number>`sum(${templateTileStatuses.blank})`,
        total: templateVersions.totalPixels,
        colourTotalsJson: templateVersions.colourTotalsJson,
        colourRowsJson: sql<string>`json_group_array(${templateTileStatuses.coloursJson})`,
        observedAt: sql<number>`max(${templateTileStatuses.observedAtMs})`,
      })
      .from(templates)
      .innerJoin(templateVersions, eq(templateVersions.id, templates.currentVersionId))
      .innerJoin(
        templateTileStatuses,
        and(
          eq(templateTileStatuses.templateId, templates.id),
          eq(templateTileStatuses.versionId, templateVersions.id),
        ),
      )
      .where(
        and(
          eq(templates.season, season),
          includeUnpublished ? undefined : isNotNull(templates.publishedAt),
        ),
      )
      .groupBy(templates.id, templateVersions.totalPixels, templateVersions.colourTotalsJson)
      .orderBy(asc(templates.id))
    return rows.map((row) => {
      const storedTotals = parseColourTotals(row.colourTotalsJson)
      const classified = new Map<number, Omit<ColourStatus, 'index'>>()
      const colourRows: unknown = JSON.parse(row.colourRowsJson)
      if (Array.isArray(colourRows)) {
        for (const encoded of colourRows) {
          if (typeof encoded !== 'string') continue
          for (const colour of parseColourStatuses(encoded)) {
            const held = classified.get(colour.index)
            classified.set(colour.index, {
              correct: (held?.correct ?? 0) + colour.correct,
              wrong: (held?.wrong ?? 0) + colour.wrong,
              blank: (held?.blank ?? 0) + colour.blank,
              total: (held?.total ?? 0) + colour.total,
            })
          }
        }
      }
      // Versions created before colour histograms were stored still have exact per-colour totals in
      // every classified tile row. Once those rows cover the whole template, their totals are the
      // missing histogram. Do not expose a partial partition: the wire schema deliberately requires
      // colour rows to add up to the template total.
      const classifiedTotals = [...classified].map(([index, colour]) => ({
        index,
        total: colour.total,
      }))
      const totals =
        storedTotals ??
        (classifiedTotals.reduce((sum, colour) => sum + colour.total, 0) === row.total
          ? classifiedTotals.sort((left, right) => left.index - right.index)
          : undefined)
      return {
        templateId: row.templateId,
        correct: Number(row.correct),
        wrong: Number(row.wrong),
        blank: Number(row.blank),
        total: row.total,
        ...(totals === undefined
          ? {}
          : {
              colours: totals.map(({ index, total }) => ({
                index,
                total,
                correct: classified.get(index)?.correct ?? 0,
                wrong: classified.get(index)?.wrong ?? 0,
                blank: classified.get(index)?.blank ?? 0,
              })),
            }),
        observedAt: Number(row.observedAt) as Millis,
      }
    })
  }

  async evaluateTemplateAlarm(
    snapshot: TemplateAlarmSnapshot,
    phase: AlarmEvaluationPhase,
    alarmId: string,
  ): Promise<AlarmPolicyResult> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const previousRow = await this.database
        .select()
        .from(templateAlarmStates)
        .where(eq(templateAlarmStates.templateId, snapshot.templateId))
        .limit(1)
        .then((rows) => rows[0])
      const previousState = previousRow === undefined ? null : storedAlarmState(previousRow)
      if (previousRow !== undefined && snapshot.observedAt < previousRow.evaluatedAtMs) {
        return { state: previousState as TemplateAlarmState, scheduleFollowUp: false }
      }
      const result = evaluateAlarmSnapshot(previousState, snapshot, phase, () => alarmId)
      const alarm = result.state.alarm
      const obsoleteFollowUp =
        phase.kind === 'follow-up' &&
        previousState !== null &&
        previousState.alarm !== null &&
        phase.alarmId !== previousState.alarm.id
      const probeDueAt = result.scheduleFollowUp
        ? ((snapshot.observedAt + ALARM_FOLLOW_UP_DELAY_MILLISECONDS) as Millis)
        : obsoleteFollowUp
          ? (previousRow?.probeDueAtMs ?? null)
          : null
      const values = {
        templateId: snapshot.templateId,
        versionId: result.state.versionId,
        total: result.state.total,
        peakCorrect: result.state.peakCorrect,
        alarmId: alarm?.id ?? null,
        kind: alarm?.kind ?? null,
        pixelsLost: alarm?.pixelsLost ?? null,
        firstSeenMs: alarm?.firstSeen ?? null,
        lastSeenMs: alarm?.lastSeen ?? null,
        probeDueAtMs: probeDueAt,
        probePixelsLost: result.scheduleFollowUp
          ? (alarm?.pixelsLost ?? null)
          : obsoleteFollowUp
            ? (previousRow?.probePixelsLost ?? null)
            : null,
        evaluatedAtMs: snapshot.observedAt,
        revision: (previousRow?.revision ?? -1) + 1,
      }
      const write =
        previousRow === undefined
          ? await this.database
              .insert(templateAlarmStates)
              .values(values)
              .onConflictDoNothing({ target: templateAlarmStates.templateId })
          : await this.database
              .update(templateAlarmStates)
              .set(values)
              .where(
                and(
                  eq(templateAlarmStates.templateId, snapshot.templateId),
                  eq(templateAlarmStates.revision, previousRow.revision),
                ),
              )
      if (Number(write.meta.changes) > 0) return result
    }
    throw new Error(`alarm state stayed contended for template ${snapshot.templateId}`)
  }

  async readActiveAlarms(season: number, includeUnpublished: boolean): Promise<readonly Alarm[]> {
    const rows = await this.database
      .select({ state: templateAlarmStates })
      .from(templateAlarmStates)
      .innerJoin(templates, eq(templates.id, templateAlarmStates.templateId))
      .where(
        and(
          eq(templates.season, season),
          eq(templates.currentVersionId, templateAlarmStates.versionId),
          isNotNull(templateAlarmStates.alarmId),
          includeUnpublished ? undefined : isNotNull(templates.publishedAt),
        ),
      )
      .orderBy(asc(templateAlarmStates.templateId))
    return rows.flatMap(({ state }) => {
      const alarm = storedAlarmState(state).alarm
      return alarm === null ? [] : [alarm]
    })
  }

  async listDueAlarmProbes(now: Millis): Promise<readonly AlarmProbe[]> {
    const rows = await this.database
      .select({
        templateId: templateAlarmStates.templateId,
        versionId: templateAlarmStates.versionId,
        season: templates.season,
        alarmId: templateAlarmStates.alarmId,
        pixelsLost: templateAlarmStates.probePixelsLost,
        dueAt: templateAlarmStates.probeDueAtMs,
      })
      .from(templateAlarmStates)
      .innerJoin(templates, eq(templates.id, templateAlarmStates.templateId))
      .where(
        and(
          eq(templates.currentVersionId, templateAlarmStates.versionId),
          isNotNull(templateAlarmStates.alarmId),
          isNotNull(templateAlarmStates.probePixelsLost),
          isNotNull(templateAlarmStates.probeDueAtMs),
          lte(templateAlarmStates.probeDueAtMs, now),
        ),
      )
      .orderBy(asc(templateAlarmStates.probeDueAtMs), asc(templateAlarmStates.templateId))
    return rows.flatMap((row) =>
      row.alarmId === null || row.pixelsLost === null || row.dueAt === null
        ? []
        : [
            {
              templateId: row.templateId,
              versionId: row.versionId,
              season: row.season,
              alarmId: row.alarmId,
              pixelsLost: row.pixelsLost,
              dueAt: row.dueAt,
            },
          ],
    )
  }

  async nextAlarmProbeAt(): Promise<Millis | null> {
    const rows = await this.database
      .select({ dueAt: sql<number | null>`min(${templateAlarmStates.probeDueAtMs})` })
      .from(templateAlarmStates)
      .innerJoin(templates, eq(templates.id, templateAlarmStates.templateId))
      .where(
        and(
          eq(templates.currentVersionId, templateAlarmStates.versionId),
          isNotNull(templateAlarmStates.alarmId),
          isNotNull(templateAlarmStates.probeDueAtMs),
        ),
      )
    const dueAt = rows[0]?.dueAt
    return dueAt === undefined || dueAt === null ? null : (dueAt as Millis)
  }

  async clearAlarmProbe(templateId: string, alarmId: string): Promise<void> {
    await this.database
      .update(templateAlarmStates)
      .set({
        probeDueAtMs: null,
        probePixelsLost: null,
        revision: sql`${templateAlarmStates.revision} + 1`,
      })
      .where(
        and(
          eq(templateAlarmStates.templateId, templateId),
          eq(templateAlarmStates.alarmId, alarmId),
        ),
      )
  }

  async claimPaintEvent(eventId: string, wplaceUserId: number, seenAt: Millis): Promise<boolean> {
    const result = await this.database
      .insert(appliedEvents)
      .values({ eventId, wplaceUserId, seenAtMs: seenAt })
      .onConflictDoNothing()
    return Number(result.meta.changes) > 0
  }

  async rememberPainter(wplaceUserId: number, displayName: string, seenAt: Millis): Promise<void> {
    await this.database
      .insert(painters)
      .values({ wplaceUserId, displayName, seenAtMs: seenAt })
      .onConflictDoUpdate({
        target: painters.wplaceUserId,
        set: { displayName, seenAtMs: seenAt },
        setWhere: lte(painters.seenAtMs, seenAt),
      })
  }

  async addContributions(deltas: readonly ContributionDelta[]): Promise<void> {
    for (const group of chunkRows(deltas, 40)) {
      const statements = group.map((delta) =>
        this.database
          .insert(contributions)
          .values({
            wplaceUserId: delta.wplaceUserId,
            templateId: delta.templateId,
            dayS: delta.day,
            reportedWithToken: delta.reportedWithToken,
            reportedByUserId: delta.reportedByUserId,
            placed: delta.placed,
            correct: delta.correct,
            repairs: delta.repairs,
          })
          .onConflictDoUpdate({
            target: [
              contributions.wplaceUserId,
              contributions.templateId,
              contributions.dayS,
              contributions.reportedByUserId,
            ],
            set: {
              reportedWithToken: delta.reportedWithToken,
              placed: sql`${contributions.placed} + excluded.placed`,
              correct: sql`${contributions.correct} + excluded.correct`,
              repairs: sql`${contributions.repairs} + excluded.repairs`,
            },
          }),
      )
      if (statements.length > 0) {
        await this.database.batch(
          statements as [(typeof statements)[number], ...Array<(typeof statements)[number]>],
        )
      }
    }
  }

  async appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void> {
    if (buckets.length === 0) return
    // Ahead of the batch, so a poison row is a synchronous error naming the column rather than a
    // CHECK failure the shard's alarm retries forever.
    assertValidBuckets(buckets)

    const statements = buckets.map((bucket) =>
      this.database
        .insert(telemetryBuckets)
        .values({
          templateId: bucket.templateId,
          resolution: bucket.resolution,
          bucketStartS: bucket.bucketStart,
          placed: bucket.placed,
          correct: bucket.correct,
          repairs: bucket.repairs,
        })
        .onConflictDoUpdate({
          target: [
            telemetryBuckets.templateId,
            telemetryBuckets.resolution,
            telemetryBuckets.bucketStartS,
          ],
          set: {
            placed: sql`excluded.placed`,
            correct: sql`excluded.correct`,
            repairs: sql`excluded.repairs`,
          },
        }),
    )

    await this.database.batch(
      statements as [(typeof statements)[number], ...Array<(typeof statements)[number]>],
    )
  }

  async foldTelemetryBuckets(templateIds: readonly string[], now: Seconds): Promise<void> {
    const ids = [...new Set(templateIds)].slice(0, READ_BUCKETS_CHUNK_SIZE)
    if (ids.length === 0) return
    const idBindings = ids.map(() => '?').join(', ')
    for (const edge of TELEMETRY_DECAY_EDGES) {
      const targetStart = `CAST(source.bucket_start_s / ${edge.target} AS INTEGER) * ${edge.target}`
      const chosen = `
        SELECT source.template_id, ${targetStart} AS target_start
        FROM telemetry_buckets AS source
        WHERE source.resolution = ${edge.source}
          AND source.template_id IN (${idBindings})
          AND ${targetStart} + ${edge.target} <= ?
          AND NOT EXISTS (
            SELECT 1 FROM telemetry_buckets AS finer
            WHERE finer.template_id = source.template_id
              AND finer.resolution < ${edge.source}
              AND finer.bucket_start_s >= ${targetStart}
              AND finer.bucket_start_s < ${targetStart} + ${edge.target}
          )
        GROUP BY source.template_id, target_start
        ORDER BY MIN(source.bucket_start_s), source.template_id
        LIMIT ?`
      const insert = `
        WITH chosen AS (${chosen})
        INSERT INTO telemetry_buckets (
          template_id, resolution, bucket_start_s, placed, correct, repairs
        )
        SELECT source.template_id, ${edge.target}, chosen.target_start,
          SUM(source.placed), SUM(source.correct), SUM(source.repairs)
        FROM telemetry_buckets AS source
        INNER JOIN chosen
          ON chosen.template_id = source.template_id
          AND chosen.target_start = CAST(source.bucket_start_s / ${edge.target} AS INTEGER) * ${edge.target}
        WHERE source.resolution = ${edge.source}
        GROUP BY source.template_id, chosen.target_start
        ON CONFLICT(template_id, resolution, bucket_start_s) DO UPDATE SET
          placed = excluded.placed,
          correct = excluded.correct,
          repairs = excluded.repairs`
      const remove = `
        WITH chosen AS (${chosen})
        DELETE FROM telemetry_buckets AS source
        WHERE source.resolution = ${edge.source}
          AND EXISTS (
            SELECT 1 FROM chosen
            WHERE chosen.template_id = source.template_id
              AND chosen.target_start = CAST(source.bucket_start_s / ${edge.target} AS INTEGER) * ${edge.target}
          )`
      const cutoff = now - edge.retainSeconds
      const bindings = [...ids, cutoff, DECAY_FOLD_GROUP_LIMIT]
      await this.client.batch([
        this.client.prepare(insert).bind(...bindings),
        this.client.prepare(remove).bind(...bindings),
      ])
    }
  }

  async insertAccessToken(token: AccessToken): Promise<void> {
    // No onConflict clause: the primary key must reject a duplicate hash rather than overwrite it,
    // which would silently transfer one holder's credential to another.
    await this.database.insert(accessTokens).values({
      tokenHash: token.tokenHash,
      label: token.label,
      scope: token.scope,
      createdWithToken: token.createdWithToken,
      createdAtMs: token.createdAt,
    })
  }

  async readAccessToken(tokenHash: string): Promise<AccessToken | null> {
    const rows = await this.database
      .select()
      .from(accessTokens)
      .where(eq(accessTokens.tokenHash, tokenHash))
      .limit(1)
    const row = rows[0]
    return row === undefined ? null : toAccessToken(row)
  }

  async listAccessTokens(query: AccessTokenQuery = {}): Promise<readonly AccessToken[]> {
    const after = query.after
    const ordered = this.database
      .select()
      .from(accessTokens)
      .where(
        after === undefined
          ? undefined
          : or(
              lt(accessTokens.createdAtMs, after.createdAt),
              and(
                eq(accessTokens.createdAtMs, after.createdAt),
                gt(accessTokens.tokenHash, after.tokenHash),
              ),
            ),
      )
      .orderBy(desc(accessTokens.createdAtMs), asc(accessTokens.tokenHash))
      .$dynamic()
    const rows = await (query.limit === undefined ? ordered : ordered.limit(query.limit))
    return rows.map(toAccessToken)
  }

  async revokeAccessToken(tokenHash: string): Promise<void> {
    // A delete, not a flag. Idempotent because deleting an absent row is a no-op, and nothing
    // references this table — the reporter and author digests are shape-checked, not foreign keys —
    // so the reports this credential wrote survive it. That is deliberate: reported state records
    // what was on wplace, and revoking a credential ends its future access rather than editing the
    // past.
    await this.database.delete(accessTokens).where(eq(accessTokens.tokenHash, tokenHash))
  }

  async readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]> {
    if (query.templateIds.length === 0) return []
    const resolutions = [
      ...new Set(typeof query.resolution === 'number' ? [query.resolution] : query.resolution),
    ]
    if (resolutions.length === 0) return []

    // Deduplicate before chunking. Each chunk returns its own rows and the merge does not join
    // them, so an id repeated across two chunks came back twice and any consumer summing the result
    // double-counted that template's history. It also keeps the query count honest.
    const templateIds = [...new Set(query.templateIds)]
    if (templateIds.length > MAX_READ_BUCKETS_TEMPLATE_IDS)
      throw tooManyTemplateIds(templateIds.length)
    // Concatenated rather than spread into `push`. A spread passes every row as a separate argument,
    // so a chunk returning more rows than V8's argument limit — around 125,000, which 90 templates
    // at minute resolution reach in under a day — throws RangeError instead of answering. The id
    // count is bounded; the row count is bounded only by the window the caller asks for.
    let rows: (typeof telemetryBuckets.$inferSelect)[] = []
    for (let offset = 0; offset < templateIds.length; offset += READ_BUCKETS_CHUNK_SIZE) {
      const chunk = templateIds.slice(offset, offset + READ_BUCKETS_CHUNK_SIZE)
      rows = rows.concat(
        await this.database
          .select()
          .from(telemetryBuckets)
          .where(
            and(
              inArray(telemetryBuckets.resolution, resolutions),
              gte(telemetryBuckets.bucketStartS, query.fromSeconds),
              lt(telemetryBuckets.bucketStartS, query.toSeconds),
              inArray(telemetryBuckets.templateId, chunk),
            ),
          )
          .orderBy(asc(telemetryBuckets.templateId), asc(telemetryBuckets.bucketStartS)),
      )
    }

    // Each chunk is ordered, but the concatenation of ordered chunks is not: template ids are
    // distributed across chunks in input order, not sort order. The contract is a single ordered
    // result, so the merge has to re-sort.
    //
    // The bucketStart tiebreak is redundant today and kept for explicitness: chunking is by template
    // id, so one template's buckets always land in a single chunk already ordered by SQL, and
    // Array.prototype.sort is stable. Dropping it changes no outcome, so no test can pin it — said
    // here rather than left looking load-bearing.
    return rows.map(fromRow).sort(compareBuckets)
  }

  async readContributions(query: ContributionQuery): Promise<readonly ContributionDay[]> {
    assertValidContributionQuery(query)
    // The season and publish filters are one IN-subquery rather than a join, so one builder shape
    // serves the season-only, ids-only and intersected forms — and the group key stays the three
    // columns the reduction is defined over, with nothing joined in to widen it. The publish gate
    // applies to explicit-id queries too: a read-scoped caller holding a stale id must get the
    // same nothing the manifest gives it.
    const templateGate =
      query.season === undefined && query.includeUnpublished
        ? undefined
        : inArray(
            contributions.templateId,
            this.database
              .select({ id: templates.id })
              .from(templates)
              .where(
                and(
                  query.season === undefined ? undefined : eq(templates.season, query.season),
                  query.includeUnpublished ? undefined : isNotNull(templates.publishedAt),
                ),
              ),
          )
    const readChunk = (chunk: readonly string[] | null) =>
      this.database
        .select({
          templateId: contributions.templateId,
          day: contributions.dayS,
          wplaceUserId: contributions.wplaceUserId,
          // MAX-then-SUM, and this is the MAX: one row per reporter describes the same painter-day,
          // so the largest view per counter is the day's truth and summing reporter rows multiplies
          // credit by reporter count. See the rollup note on the `contributions` schema.
          displayName: sql<string | null>`max(${painters.displayName})`,
          placed: sql<number>`max(${contributions.placed})`,
          correct: sql<number>`max(${contributions.correct})`,
          repairs: sql<number>`max(${contributions.repairs})`,
        })
        .from(contributions)
        .leftJoin(painters, eq(painters.wplaceUserId, contributions.wplaceUserId))
        .where(
          and(
            chunk === null ? undefined : inArray(contributions.templateId, chunk),
            templateGate,
            query.fromSeconds === undefined
              ? undefined
              : gte(contributions.dayS, query.fromSeconds),
            query.toSeconds === undefined ? undefined : lt(contributions.dayS, query.toSeconds),
          ),
        )
        .groupBy(contributions.templateId, contributions.dayS, contributions.wplaceUserId)

    // Chunked like `readBuckets`, and safe for the same structural reason: the group key contains
    // the template id, so every group lands wholly inside one chunk and concatenation loses nothing.
    let rows: Awaited<ReturnType<typeof readChunk>> = []
    if (query.templateIds === undefined) {
      rows = await readChunk(null)
    } else {
      const templateIds = [...new Set(query.templateIds)]
      for (let offset = 0; offset < templateIds.length; offset += READ_BUCKETS_CHUNK_SIZE) {
        rows = rows.concat(
          await readChunk(templateIds.slice(offset, offset + READ_BUCKETS_CHUNK_SIZE)),
        )
      }
    }
    return rows
      .map((row) => ({
        templateId: row.templateId,
        day: row.day,
        wplaceUserId: row.wplaceUserId,
        // A painter seen only through another member's reports has no `painters` row yet; the id as
        // a string keeps the label non-empty, which the wire schema requires of every display name.
        displayName: row.displayName ?? String(row.wplaceUserId),
        placed: row.placed,
        correct: row.correct,
        repairs: row.repairs,
      }))
      .sort(compareContributionDays)
  }

  async filterPublishedTemplateIds(ids: readonly string[]): Promise<readonly string[]> {
    assertValidPublishedFilter(ids)
    const distinct = [...new Set(ids)]
    // Chunked like `readBuckets` for the same bound-parameter budget; membership is per-id, so
    // concatenating chunk results loses nothing.
    const published = new Set<string>()
    for (let offset = 0; offset < distinct.length; offset += READ_BUCKETS_CHUNK_SIZE) {
      const chunk = distinct.slice(offset, offset + READ_BUCKETS_CHUNK_SIZE)
      const rows = await this.database
        .select({ id: templates.id })
        .from(templates)
        .where(and(inArray(templates.id, chunk), isNotNull(templates.publishedAt)))
      for (const row of rows) published.add(row.id)
    }
    return distinct.filter((id) => published.has(id))
  }

  async listLatestTiles(season: number): Promise<readonly LatestTileObservation[]> {
    const rows = await this.database
      .select()
      .from(canvasTiles)
      .where(eq(canvasTiles.season, season))
      .orderBy(asc(canvasTiles.tileX), asc(canvasTiles.tileY))
    return rows.map((row) => ({
      season: row.season,
      tile: { x: row.tileX, y: row.tileY },
      hash: row.sha256,
      observedAt: row.observedAtMs,
    }))
  }

  async readTileHistory(query: TileHistoryQuery): Promise<readonly TileHistoryFrame[]> {
    assertValidTileHistoryQuery(query)
    const rows = await this.database
      .select({
        bucketStart: tileHistory.bucketStartS,
        hash: tileHistory.sha256,
        // Distinct accounts, not rows — quorum a client cannot inflate by replaying its own hash.
        // Redundant against today's primary key, which already separates reporters, and kept so the
        // count stays honest if the key ever widens.
        reporters: sql<number>`count(distinct ${tileHistory.reportedByUserId})`,
      })
      .from(tileHistory)
      .where(
        and(
          eq(tileHistory.season, query.season),
          eq(tileHistory.tileX, query.tile.x),
          eq(tileHistory.tileY, query.tile.y),
          eq(tileHistory.resolutionS, seconds(query.resolution)),
          gte(tileHistory.bucketStartS, query.fromSeconds),
          lt(tileHistory.bucketStartS, query.toSeconds),
        ),
      )
      .groupBy(tileHistory.bucketStartS, tileHistory.sha256)
    return foldTileFrames(rows)
  }
}
