import { type Millis, seconds, WORLD_PIXELS } from '@wts/shared'
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  like,
  lt,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import {
  accessTokens,
  contributions,
  nodes,
  serverSettings,
  telemetryBuckets,
  templates,
  templateVersions,
  versionTiles,
} from '../../db/schema.js'
import {
  type AccessToken,
  assertValidBuckets,
  assertValidTemplateVersion,
  type BucketQuery,
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
  READ_BUCKETS_CHUNK_SIZE,
  type ServerSettings,
  type SqlStore,
  type TelemetryBucket,
  type TemplatePatch,
  type TemplateRecord,
  TemplateIdentityError,
  type TemplateVersionRecord,
  tooManyTemplateIds,
} from '../../ports/index.js'

/** Leave room below D1's 100-bound-parameter ceiling when checking candidate chunk hashes. */
const UNREFERENCED_HASH_CHUNK_SIZE = 90
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

export class D1SqlStore implements SqlStore {
  private readonly database: DrizzleD1Database

  constructor(database: D1Database) {
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

    // Not LIKE: D1 caps a LIKE or GLOB pattern at 50 bytes, and a node path may be 256 characters,
    // so renaming anything but a shallow node answered "LIKE or GLOB pattern too complex" — every
    // ordinary rename of a nested group, in production only. `substr` compares the same prefix with
    // no pattern at all, and `lower` folds ASCII exactly as LIKE did. Lengths come from SQLite's own
    // `length()` so the comparison stays in characters throughout.
    const oldPrefix = `${node.path}/`
    const startsWithOldPrefix = (prefix: SQL | string): SQL =>
      sql`lower(substr(${nodes.path}, 1, length(${prefix}))) = lower(${prefix})`
    const descendants = and(eq(nodes.season, node.season), startsWithOldPrefix(oldPrefix))

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
    // The destination is composed from the parent's path for the same reason. `parentId` cannot
    // change here, so the parent row is a stable place to ask.
    //
    // Untested on purpose: `insertNode` composes the same way, so no tree holds a child whose prefix
    // differs from its parent's, and the only thing this guards is a concurrent ancestor rename —
    // which a single-threaded suite cannot stage. A test that seeded the mismatch through the store
    // would be testing a state the stores no longer allow.
    const parentPath =
      node.parentId === null
        ? sql`''`
        : sql`coalesce((select path from nodes where id = ${node.parentId}), '')`
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
        .where(and(eq(nodes.season, node.season), startsWithOldPrefix(sql`${oldPath} || '/'`))),
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
      and(eq(nodes.season, node.season), like(nodes.path, `${node.path}/%`)),
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

  async deleteNodeCascade(nodeId: string): Promise<NodeDeletion> {
    const node = await this.readNode(nodeId)
    if (node === null) throw new NodeNotFoundError(`node does not exist: ${nodeId}`)
    const subtree = or(
      eq(nodes.id, nodeId),
      and(eq(nodes.season, node.season), like(nodes.path, `${node.path}/%`)),
    )
    const [nodeRows, templateRows, hashRows] = await Promise.all([
      this.database.select({ count: sql<number>`count(*)` }).from(nodes).where(subtree),
      this.database
        .select({ count: sql<number>`count(*)` })
        .from(templates)
        .innerJoin(nodes, eq(nodes.id, templates.nodeId))
        .where(subtree),
      this.database
        .selectDistinct({ hash: versionTiles.hash })
        .from(versionTiles)
        .innerJoin(templateVersions, eq(templateVersions.id, versionTiles.versionId))
        .innerJoin(templates, eq(templates.id, templateVersions.templateId))
        .innerJoin(nodes, eq(nodes.id, templates.nodeId))
        .where(subtree),
    ])

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
    await this.database.batch(statements)

    return {
      nodes: nodeRows[0]?.count ?? 0,
      templates: templateRows[0]?.count ?? 0,
      hashes: hashRows.map(({ hash }) => hash),
    }
  }

  async unreferencedHashes(hashes: readonly string[]): Promise<readonly string[]> {
    const candidates = [...new Set(hashes)]
    const referenced = new Set<string>()
    for (let start = 0; start < candidates.length; start += UNREFERENCED_HASH_CHUNK_SIZE) {
      const chunk = candidates.slice(start, start + UNREFERENCED_HASH_CHUNK_SIZE)
      const rows = await this.database
        .selectDistinct({ hash: versionTiles.hash })
        .from(versionTiles)
        .where(inArray(versionTiles.hash, chunk))
      for (const { hash } of rows) referenced.add(hash)
    }
    return candidates.filter((hash) => !referenced.has(hash))
  }

  async insertTemplateVersion(version: TemplateVersionRecord): Promise<void> {
    assertValidTemplateVersion(version)
    if ((await this.readNode(version.nodeId)) === null) {
      throw new NodeNotFoundError(`node does not exist: ${version.nodeId}`)
    }
    // A version replaces content in place, so it has to be a version of the same thing: same name,
    // same dimensions. Position may move and the hash obviously differs. See TemplateIdentityError.
    const previous = await this.database
      .select({
        name: templates.name,
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
      if (existing.name !== version.name) {
        throw new TemplateIdentityError(
          `template ${version.templateId} is named ${existing.name}, not ${version.name}`,
        )
      }
      if (existing.minX !== null && existing.maxX !== null) {
        const span = (min: number, max: number) =>
          max >= min ? max - min : WORLD_PIXELS - min + max
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

    const statements = [
      this.database
        .insert(templates)
        .values({
          id: version.templateId,
          nodeId: version.nodeId,
          name: version.name,
          currentVersionId: null,
          publishedAt: null,
          createdWithToken: version.createdWithToken,
          createdByUserId: version.createdByUserId,
          createdAtMs: version.createdAt,
          updatedAtMs: version.createdAt,
        })
        .onConflictDoNothing({ target: templates.id }),
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
        throw new NodeNotFoundError(`node does not exist: ${version.nodeId}`)
      }
      throw error
    }
  }

  async readTemplateVersion(versionId: string): Promise<TemplateVersionRecord | null> {
    const rows = await this.database
      .select({
        templateId: templates.id,
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
      })
      .from(templateVersions)
      .innerJoin(templates, eq(templates.id, templateVersions.templateId))
      .where(eq(templateVersions.id, versionId))
      .limit(1)
    const row = rows[0]
    if (row === undefined) return null

    const chunks = await this.database
      .select({ tileX: versionTiles.tileX, tileY: versionTiles.tileY, hash: versionTiles.hash })
      .from(versionTiles)
      .where(eq(versionTiles.versionId, versionId))
      .orderBy(asc(versionTiles.tileY), asc(versionTiles.tileX))

    return {
      templateId: row.templateId,
      nodeId: row.nodeId,
      name: row.name,
      versionId: row.versionId,
      createdByUserId: row.createdByUserId,
      createdWithToken: row.createdWithToken,
      createdAt: row.createdAt,
      bbox: { minX: row.minX, minY: row.minY, maxX: row.maxX, maxY: row.maxY },
      totalPixels: row.totalPixels,
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
    // Read-then-write rather than an upsert of the patch alone: an upsert would insert nulls for
    // whichever field this call is not setting, so renaming a server would silently clear its
    // description.
    const current = await this.readServerSettings()
    const next = {
      name: patch.name ?? current.name,
      description: patch.description === undefined ? current.description : patch.description,
    }
    await this.database
      .insert(serverSettings)
      .values({ id: 1, ...next })
      .onConflictDoUpdate({ target: serverSettings.id, set: next })
  }

  async readTemplate(templateId: string): Promise<TemplateRecord | null> {
    const rows = await this.database
      .select({
        id: templates.id,
        nodeId: templates.nodeId,
        name: templates.name,
        currentVersionId: templates.currentVersionId,
        publishedAt: templates.publishedAt,
        createdAt: templates.createdAtMs,
        updatedAt: templates.updatedAtMs,
      })
      .from(templates)
      .where(eq(templates.id, templateId))
      .limit(1)
    const row = rows[0]
    if (row === undefined) return null
    return {
      id: row.id,
      nodeId: row.nodeId,
      name: row.name,
      currentVersionId: row.currentVersionId,
      published: row.publishedAt !== null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  async setTemplatePublishedAt(
    templateId: string,
    publishedAt: Millis | null,
    updatedAt: Millis,
  ): Promise<boolean> {
    const existing = await this.database
      .select({ id: templates.id })
      .from(templates)
      .where(eq(templates.id, templateId))
      .limit(1)
    if (existing.length === 0) return false
    await this.database
      .update(templates)
      .set({ publishedAt, updatedAtMs: updatedAt })
      .where(eq(templates.id, templateId))
    return true
  }

  async updateTemplate(
    templateId: string,
    patch: TemplatePatch,
    updatedAt: Millis,
  ): Promise<boolean> {
    const existing = await this.database
      .select({ id: templates.id })
      .from(templates)
      .where(eq(templates.id, templateId))
      .limit(1)
    if (existing.length === 0) return false

    if (patch.nodeId !== undefined) {
      // Checked rather than left to the foreign key, because D1 surfaces a constraint failure as an
      // opaque error string. "That node does not exist" is worth saying plainly to whoever typed it.
      const node = await this.database
        .select({ id: nodes.id })
        .from(nodes)
        .where(eq(nodes.id, patch.nodeId))
        .limit(1)
      if (node.length === 0) throw new NodeNotFoundError(`node does not exist: ${patch.nodeId}`)
    }

    await this.database
      .update(templates)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.nodeId === undefined ? {} : { nodeId: patch.nodeId }),
        updatedAtMs: updatedAt,
      })
      .where(eq(templates.id, templateId))
    return true
  }

  async deleteTemplate(templateId: string): Promise<boolean> {
    const versions = await this.database
      .select({ id: templateVersions.id })
      .from(templateVersions)
      .where(eq(templateVersions.templateId, templateId))
    const existing = await this.database
      .select({ id: templates.id })
      .from(templates)
      .where(eq(templates.id, templateId))
      .limit(1)
    if (existing.length === 0) return false

    // Order matters and the batch is what makes it safe. `templates.current_version_id` points at a
    // version and every version points back at the template, so the pointer has to be dropped before
    // the rows it refers to. Tiles go first because they reference a version.
    const statements = [
      ...versions.map(({ id }) =>
        this.database.delete(versionTiles).where(eq(versionTiles.versionId, id)),
      ),
      this.database
        .update(templates)
        .set({ currentVersionId: null })
        .where(eq(templates.id, templateId)),
      this.database.delete(templateVersions).where(eq(templateVersions.templateId, templateId)),
      this.database.delete(templates).where(eq(templates.id, templateId)),
    ]
    await this.database.batch(
      statements as [(typeof statements)[number], ...Array<(typeof statements)[number]>],
    )
    // Chunk blobs stay: they are content-addressed and shared. See `deleteTemplate` on the port.
    return true
  }

  async listManifestTemplates(
    season: number,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTemplateRecord[]> {
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
        createdAt: templates.createdAtMs,
        updatedAt: templates.updatedAtMs,
      })
      .from(templates)
      .innerJoin(nodes, eq(nodes.id, templates.nodeId))
      .innerJoin(templateVersions, eq(templateVersions.id, templates.currentVersionId))
      .where(
        includeUnpublished
          ? eq(nodes.season, season)
          : and(eq(nodes.season, season), isNotNull(templates.publishedAt)),
      )

    return rows.map((row) => ({
      id: row.id,
      nodeId: row.nodeId,
      name: row.name,
      versionId: row.versionId,
      bbox: { minX: row.minX, minY: row.minY, maxX: row.maxX, maxY: row.maxY },
      totalPixels: row.totalPixels,
      published: row.publishedAt !== null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
  }

  async listManifestTiles(
    season: number,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTileRecord[]> {
    return this.database
      .select({
        templateId: templates.id,
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
      .innerJoin(nodes, eq(nodes.id, templates.nodeId))
      .where(
        includeUnpublished
          ? eq(nodes.season, season)
          : and(eq(nodes.season, season), isNotNull(templates.publishedAt)),
      )
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

  async listAccessTokens(): Promise<readonly AccessToken[]> {
    const rows = await this.database
      .select()
      .from(accessTokens)
      .orderBy(desc(accessTokens.createdAtMs))
    // Re-sorted rather than trusted: SQL leaves equal created_at_ms unspecified, and the port
    // promises one order both adapters return. The JS sort is a total order, so it does all of the
    // work — reversing the ORDER BY above changes nothing observable. The clause stays because
    // asking SQLite for the order we want is cheaper than making it sort a shuffled result.
    return rows.map(toAccessToken).sort(compareAccessTokens)
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
              eq(telemetryBuckets.resolution, query.resolution),
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
}
