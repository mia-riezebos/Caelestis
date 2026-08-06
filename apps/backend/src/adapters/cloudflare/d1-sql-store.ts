import { type Millis, millis, seconds } from '@wts/shared'
import { and, asc, desc, eq, gte, inArray, isNotNull, like, lt, sql } from 'drizzle-orm'
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import {
  accessTokens,
  nodes,
  telemetryBuckets,
  templates,
  templateVersions,
  versionTiles,
} from '../../db/schema.js'
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
  NodePathConflictError,
} from '../../ports/index.js'

/**
 * D1 accepts at most 100 bound parameters per query, which is ten times tighter than the SQLite
 * default `TelemetryShard.readPending` chunks against. Reading history for a group of 98 templates
 * — well inside a single node, let alone MAX_MANIFEST_TEMPLATES — otherwise builds one statement
 * D1 rejects outright.
 *
 * 90 leaves room for the three non-id bindings in the WHERE clause and a little slack, so the
 * bound is not sitting exactly on the platform limit.
 *
 * The test fake is `node:sqlite`, whose limit is 32_766, so no test can observe the real ceiling —
 * `readBuckets issues one statement per parameter chunk` counts statements instead.
 */
const READ_BUCKETS_CHUNK_SIZE = 90

/**
 * Template ids one `readBuckets` call may ask for.
 *
 * Chunking fixed the 100-bound-parameter limit and walked into the next one: D1 allows 50 queries
 * per Worker invocation on the free plan and 1,000 on paid, so at 90 ids per query a group of 4,501
 * templates exceeded the free budget and failed the whole read with a D1_ERROR. The wire permits far
 * more than that in one group.
 *
 * 40 chunks leaves headroom under the free budget for whatever else an invocation does. Reading a
 * group larger than this needs paging, which belongs to the route layer that does not exist yet —
 * so this fails immediately, naming the limit, rather than reaching D1 and failing there.
 */
const MAX_READ_BUCKETS_TEMPLATE_IDS = READ_BUCKETS_CHUNK_SIZE * 40

const toAccessToken = (row: typeof accessTokens.$inferSelect): AccessToken => ({
  tokenHash: row.tokenHash,
  label: row.label,
  scope: row.scope,
  createdBy: row.createdBy,
  createdAt: row.createdAtMs,
  revokedAt: row.revokedAtMs === null ? null : millis(row.revokedAtMs),
})

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

/**
 * Does this error, or anything it wraps, mention `needle`?
 *
 * Drizzle raises a `DrizzleQueryError` whose own message is only "Failed query: insert into …" and
 * hangs the real database error off `cause` — D1 then adds a layer of its own. Testing
 * `error.message` alone therefore misses every constraint violation, which turned a duplicate
 * folder name into a 500 while the in-memory store correctly reported a conflict. Exactly the sort
 * of divergence that only shows up against real D1.
 */
const mentions = (error: unknown, needle: string): boolean => {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current.message.includes(needle)) return true
    current = current.cause
  }
  return false
}

export class D1SqlStore implements SqlStore {
  private readonly database: DrizzleD1Database

  constructor(database: D1Database) {
    this.database = drizzle(database)
  }

  async insertNode(node: NodeRecord): Promise<void> {
    if (node.parentId !== null) {
      const parent = await this.readNode(node.parentId)
      if (parent === null) throw new InvalidNodeParentError('parent node does not exist')
      if (parent.season !== node.season) {
        throw new InvalidNodeParentError('parent node belongs to a different season')
      }
    }
    try {
      await this.database.insert(nodes).values({
        id: node.id,
        season: node.season,
        parentId: node.parentId,
        path: node.path,
        name: node.name,
        description: node.description,
        createdAtMs: node.createdAt,
      })
    } catch (error) {
      if (mentions(error, 'UNIQUE constraint failed')) {
        throw new NodePathConflictError(`node path is already taken in season ${node.season}`)
      }
      throw error
    }
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

  async renameNode(nodeId: string, name: string, path: string): Promise<boolean> {
    const node = await this.readNode(nodeId)
    if (node === null) return false

    // One batch: the node and every descendant move together or not at all. A half-applied rename
    // leaves children whose path no longer starts with their parent's, which silently breaks every
    // prefix rollup rather than failing loudly.
    const oldPrefix = `${node.path}/`
    const statements = [
      this.database.update(nodes).set({ name, path }).where(eq(nodes.id, nodeId)),
      this.database
        .update(nodes)
        .set({ path: sql`${path} || substr(${nodes.path}, ${oldPrefix.length + 1})` })
        .where(and(eq(nodes.season, node.season), like(nodes.path, `${oldPrefix}%`))),
    ] as const
    try {
      await this.database.batch([statements[0], statements[1]])
    } catch (error) {
      if (mentions(error, 'UNIQUE constraint failed')) {
        throw new NodePathConflictError(`node path is already taken in season ${node.season}`)
      }
      throw error
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
    await this.database.delete(nodes).where(eq(nodes.id, nodeId))
  }

  async insertTemplateVersion(version: TemplateVersionRecord): Promise<void> {
    const statements = [
      this.database
        .insert(templates)
        .values({
          id: version.templateId,
          nodeId: version.nodeId,
          name: version.name,
          currentVersionId: null,
          publishedAt: null,
          createdAtMs: version.createdAt,
        })
        .onConflictDoNothing({ target: templates.id }),
      this.database.insert(templateVersions).values({
        id: version.versionId,
        templateId: version.templateId,
        createdAtMs: version.createdAt,
        createdBy: version.createdBy,
        minX: version.bbox.minX,
        minY: version.bbox.minY,
        maxX: version.bbox.maxX,
        maxY: version.bbox.maxY,
        totalPixels: version.totalPixels,
      }),
      ...version.chunks.map((chunk) =>
        this.database.insert(versionTiles).values({
          versionId: version.versionId,
          tileX: chunk.tileX,
          tileY: chunk.tileY,
          hash: chunk.hash,
        }),
      ),
      // The referenced version exists before this statement runs. D1 executes batch statements in
      // order, so the circular template/version relationship never needs deferred foreign keys.
      this.database
        .update(templates)
        .set({ currentVersionId: version.versionId })
        .where(eq(templates.id, version.templateId)),
    ]

    await this.database.batch(
      statements as [(typeof statements)[number], ...Array<(typeof statements)[number]>],
    )
  }

  async readTemplateVersion(versionId: string): Promise<TemplateVersionRecord | null> {
    const rows = await this.database
      .select({
        templateId: templates.id,
        nodeId: templates.nodeId,
        name: templates.name,
        versionId: templateVersions.id,
        createdBy: templateVersions.createdBy,
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
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      bbox: { minX: row.minX, minY: row.minY, maxX: row.maxX, maxY: row.maxY },
      totalPixels: row.totalPixels,
      chunks,
    }
  }

  async setTemplatePublishedAt(templateId: string, publishedAt: Millis | null): Promise<boolean> {
    const existing = await this.database
      .select({ id: templates.id })
      .from(templates)
      .where(eq(templates.id, templateId))
      .limit(1)
    if (existing.length === 0) return false
    await this.database.update(templates).set({ publishedAt }).where(eq(templates.id, templateId))
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
      createdBy: token.createdBy,
      createdAtMs: token.createdAt,
      revokedAtMs: token.revokedAt,
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
    return rows.map(toAccessToken)
  }

  async revokeAccessToken(tokenHash: string, revokedAt: Millis): Promise<void> {
    // `IS NULL` makes this idempotent in one statement and keeps the first instant: re-revoking must
    // not move the moment the credential stopped being usable.
    await this.database
      .update(accessTokens)
      .set({ revokedAtMs: revokedAt })
      .where(and(eq(accessTokens.tokenHash, tokenHash), sql`${accessTokens.revokedAtMs} IS NULL`))
  }

  async readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]> {
    if (query.templateIds.length === 0) return []

    // Deduplicate before chunking. Each chunk returns its own rows and the merge does not join
    // them, so an id repeated across two chunks came back twice and any consumer summing the result
    // double-counted that template's history. It also keeps the query count honest.
    const templateIds = [...new Set(query.templateIds)]
    if (templateIds.length > MAX_READ_BUCKETS_TEMPLATE_IDS) {
      throw new Error(
        `readBuckets accepts at most ${MAX_READ_BUCKETS_TEMPLATE_IDS} template ids per call; received ${templateIds.length}`,
      )
    }
    const rows = []
    for (let offset = 0; offset < templateIds.length; offset += READ_BUCKETS_CHUNK_SIZE) {
      const chunk = templateIds.slice(offset, offset + READ_BUCKETS_CHUNK_SIZE)
      rows.push(
        ...(await this.database
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
          .orderBy(asc(telemetryBuckets.templateId), asc(telemetryBuckets.bucketStartS))),
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
    return rows
      .map(fromRow)
      .sort(
        (left, right) =>
          left.templateId.localeCompare(right.templateId) || left.bucketStart - right.bucketStart,
      )
  }
}
