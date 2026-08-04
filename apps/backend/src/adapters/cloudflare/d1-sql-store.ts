import { seconds } from '@wts/shared'
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import {
  accessTokens,
  telemetryBuckets,
  templates,
  templateVersions,
  versionTiles,
} from '../../db/schema.js'
import {
  type AccessToken,
  assertValidAccessToken,
  assertValidBuckets,
  type BucketQuery,
  compareAccessTokens,
  compareBuckets,
  MAX_READ_BUCKETS_TEMPLATE_IDS,
  READ_BUCKETS_CHUNK_SIZE,
  type SqlStore,
  type TelemetryBucket,
  type TemplateVersionRecord,
  tooManyTemplateIds,
} from '../../ports/index.js'

const toAccessToken = (row: typeof accessTokens.$inferSelect): AccessToken => ({
  tokenHash: row.tokenHash,
  label: row.label,
  scope: row.scope,
  createdBy: row.createdBy,
  createdAt: row.createdAtMs,
})

const fromRow = (row: typeof telemetryBuckets.$inferSelect): TelemetryBucket => ({
  templateId: row.templateId,
  resolution: row.resolution,
  bucketStart: seconds(row.bucketStartS),
  placed: row.placed,
  correct: row.correct,
  repairs: row.repairs,
})

export class D1SqlStore implements SqlStore {
  private readonly database: DrizzleD1Database

  constructor(database: D1Database) {
    this.database = drizzle(database)
  }

  async insertTemplateVersion(version: TemplateVersionRecord): Promise<void> {
    const statements = [
      this.database
        .insert(templates)
        .values({
          id: version.templateId,
          nodeId: version.nodeId,
          name: version.name,
          season: version.season,
          currentVersionId: null,
          createdBy: version.createdBy,
          createdByUserId: version.createdByUserId,
          createdAtMs: version.createdAt,
        })
        .onConflictDoNothing({ target: templates.id }),
      this.database.insert(templateVersions).values({
        id: version.versionId,
        templateId: version.templateId,
        createdAtMs: version.createdAt,
        createdBy: version.createdBy,
        createdByUserId: version.createdByUserId,
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
        season: templates.season,
        versionId: templateVersions.id,
        createdBy: templateVersions.createdBy,
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
      season: row.season,
      versionId: row.versionId,
      createdByUserId: row.createdByUserId,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      bbox: { minX: row.minX, minY: row.minY, maxX: row.maxX, maxY: row.maxY },
      totalPixels: row.totalPixels,
      chunks,
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

  async insertAccessToken(token: AccessToken): Promise<void> {
    // No onConflict clause: the primary key must reject a duplicate hash rather than overwrite it,
    // which would silently transfer one holder's credential to another.
    await this.database.insert(accessTokens).values({
      tokenHash: token.tokenHash,
      label: token.label,
      scope: token.scope,
      createdBy: token.createdBy,
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
