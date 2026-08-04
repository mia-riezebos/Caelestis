import type { Millis, Seconds } from '@wts/shared'
import { WORLD_PIXELS, WORLD_TILES } from '@wts/shared'
import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    parentId: text('parent_id').references((): AnySQLiteColumn => nodes.id),
    path: text('path').notNull(),
    name: text('name').notNull(),
    createdAtMs: integer('created_at_ms').$type<Millis>().notNull(),
  },
  // path is the prefix-rollup key and the subtree-rewrite key. Two nodes sharing one path make a
  // rollup attribute one group's templates to another, and make the documented
  // `UPDATE ... WHERE path LIKE '<old>/%'` move rewrite both subtrees when either is renamed.
  // NOCASE, because SQLite's LIKE is ASCII-case-insensitive: with both /Canada and /canada stored,
  // the documented `LIKE '<old>/%'` subtree move rewrites the other one's descendants too.
  (table) => [uniqueIndex('nodes_path_idx').on(sql`lower(${table.path})`)],
)

export const templates = sqliteTable('templates', {
  id: text('id').primaryKey(),
  nodeId: text('node_id')
    .notNull()
    .references(() => nodes.id),
  name: text('name').notNull(),
  season: integer('season').notNull(),
  currentVersionId: text('current_version_id').references(
    (): AnySQLiteColumn => templateVersions.id,
  ),
  createdAtMs: integer('created_at_ms').$type<Millis>().notNull(),
})

export const templateVersions = sqliteTable(
  'template_versions',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id')
      .notNull()
      .references(() => templates.id),
    createdAtMs: integer('created_at_ms').$type<Millis>().notNull(),
    createdBy: text('created_by').notNull(),
    minX: integer('min_x').notNull(),
    minY: integer('min_y').notNull(),
    maxX: integer('max_x').notNull(),
    maxY: integer('max_y').notNull(),
    totalPixels: integer('total_pixels').notNull(),
    boundsNorth: real('bounds_north'),
    boundsSouth: real('bounds_south'),
    boundsWest: real('bounds_west'),
    boundsEast: real('bounds_east'),
  },
  (table) => [
    check(
      'template_versions_bounds_all_or_none_check',
      sql`(${table.boundsNorth} IS NULL AND ${table.boundsSouth} IS NULL AND ${table.boundsWest} IS NULL AND ${table.boundsEast} IS NULL) OR (${table.boundsNorth} IS NOT NULL AND ${table.boundsSouth} IS NOT NULL AND ${table.boundsWest} IS NOT NULL AND ${table.boundsEast} IS NOT NULL)`,
    ),
    check(
      'template_versions_pixel_bounds_check',
      // x wraps through zero, so min_x > max_x is a legal antimeridian span; y does not wrap.
      // Zero width and zero height are rejected: a template covering no pixels is not a placement.
      sql`typeof(${table.minX}) = 'integer' AND typeof(${table.minY}) = 'integer'
        AND typeof(${table.maxX}) = 'integer' AND typeof(${table.maxY}) = 'integer'
        AND typeof(${table.totalPixels}) = 'integer'
        AND ${table.minX} BETWEEN 0 AND ${sql.raw(String(WORLD_PIXELS - 1))}
        AND ${table.minY} BETWEEN 0 AND ${sql.raw(String(WORLD_PIXELS - 1))}
        AND ${table.maxX} BETWEEN 1 AND ${sql.raw(String(WORLD_PIXELS))}
        AND ${table.maxY} BETWEEN 1 AND ${sql.raw(String(WORLD_PIXELS))}
        AND ${table.minX} <> ${table.maxX}
        AND ${table.minY} < ${table.maxY}
        AND ${table.totalPixels} >= 0`,
    ),
    check(
      'template_versions_bounds_range_check',
      sql`${table.boundsNorth} IS NULL OR (${table.boundsNorth} BETWEEN -90 AND 90 AND ${table.boundsSouth} BETWEEN -90 AND 90 AND ${table.boundsWest} BETWEEN -180 AND 180 AND ${table.boundsEast} BETWEEN -180 AND 180 AND ${table.boundsNorth} > ${table.boundsSouth})`,
    ),
  ],
)

export const versionTiles = sqliteTable(
  'version_tiles',
  {
    versionId: text('version_id')
      .notNull()
      .references(() => templateVersions.id),
    tileX: integer('tile_x').notNull(),
    tileY: integer('tile_y').notNull(),
    hash: text('hash').notNull(),
  },
  (table) => [
    check(
      'version_tiles_coordinate_check',
      sql`typeof(${table.tileX}) = 'integer' AND typeof(${table.tileY}) = 'integer'
        AND ${table.tileX} BETWEEN 0 AND ${sql.raw(String(WORLD_TILES - 1))}
        AND ${table.tileY} BETWEEN 0 AND ${sql.raw(String(WORLD_TILES - 1))}`,
    ),
    primaryKey({ columns: [table.versionId, table.tileX, table.tileY] }),
    index('version_tiles_tile_idx').on(table.tileX, table.tileY),
  ],
)

export const accessTokens = sqliteTable(
  'access_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    label: text('label').notNull(),
    scope: text('scope', { enum: ['read', 'report', 'admin'] }).notNull(),
    createdBy: text('created_by').notNull(),
    createdAtMs: integer('created_at_ms').$type<Millis>().notNull(),
    revokedAtMs: integer('revoked_at_ms').$type<Millis>(),
  },
  (table) => [
    check('access_tokens_scope_check', sql`${table.scope} IN ('read', 'report', 'admin')`),
  ],
)

export const telemetryBuckets = sqliteTable(
  'telemetry_buckets',
  {
    templateId: text('template_id').notNull(),
    resolution: integer('resolution').notNull(),
    bucketStartS: integer('bucket_start_s').$type<Seconds>().notNull(),
    placed: integer('placed').notNull(),
    correct: integer('correct').notNull(),
    repairs: integer('repairs').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.templateId, table.resolution, table.bucketStartS] }),
    check(
      'telemetry_buckets_resolution_check',
      sql`${table.resolution} IN (60, 300, 900, 3600, 21600)`,
    ),
    // The geometry columns get typeof + range; the counters got neither, so `placed = -5`,
    // `correct = 'oops'` and `repairs = 0.5` all persisted. SQLite INTEGER is an affinity, not a
    // type. isValidCounterDelta already refuses these, which is exactly why nothing here would ever
    // trip: this is the second half of the rule, for any writer that is not the shard.
    //
    // Only `repairs >= 0` is stated. `repairs <= correct <= placed` carries the sign to the other
    // two, so a bound on either would be unreachable and no test could pin it.
    check(
      'telemetry_buckets_counter_check',
      sql`typeof(${table.placed}) = 'integer' AND typeof(${table.correct}) = 'integer'
        AND typeof(${table.repairs}) = 'integer'
        AND ${table.repairs} >= 0
        AND ${table.repairs} <= ${table.correct} AND ${table.correct} <= ${table.placed}`,
    ),
  ],
)

export const contributions = sqliteTable(
  'contributions',
  {
    wplaceUserId: integer('wplace_user_id').notNull(),
    templateId: text('template_id')
      .notNull()
      .references(() => templates.id),
    dayS: integer('day_s').$type<Seconds>().notNull(),
    // Which token reported this. wplace_user_id is attacker-supplied and nothing bound it to the
    // authenticated caller, so a report-scope holder could attribute fabricated work to any other
    // painter — and with no reporter column, neither attributable nor reversible afterwards.
    reportedBy: text('reported_by').notNull(),
    placed: integer('placed').notNull(),
    correct: integer('correct').notNull(),
    repairs: integer('repairs').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.wplaceUserId, table.templateId, table.dayS, table.reportedBy] }),
    check(
      'contributions_counter_check',
      sql`typeof(${table.dayS}) = 'integer' AND ${table.dayS} >= 0
        AND typeof(${table.placed}) = 'integer' AND typeof(${table.correct}) = 'integer'
        AND typeof(${table.repairs}) = 'integer'
        AND ${table.repairs} >= 0
        AND ${table.repairs} <= ${table.correct} AND ${table.correct} <= ${table.placed}`,
    ),
  ],
)

/**
 * Paint events already applied, so a retry cannot double-count.
 *
 * `PaintEvent.eventId` is documented as "client-generated, so a retry can never double-count", and
 * nothing stored it — the pending path is purely additive (`placed = placed + excluded.placed`), so
 * replaying one captured event N times multiplied the counters by N. The guarantee was stated as a
 * property of the design with nowhere in the schema to hold it.
 *
 * `seen_at_ms` is what a sweeper prunes on. The row only has to outlive the window in which a retry
 * is plausible, not the event itself.
 */
export const appliedEvents = sqliteTable(
  'applied_events',
  {
    eventId: text('event_id').primaryKey(),
    wplaceUserId: integer('wplace_user_id').notNull(),
    seenAtMs: integer('seen_at_ms').$type<Millis>().notNull(),
  },
  (table) => [index('applied_events_seen_at_idx').on(table.seenAtMs)],
)

export const painters = sqliteTable('painters', {
  wplaceUserId: integer('wplace_user_id').primaryKey(),
  displayName: text('display_name').notNull(),
  seenAtMs: integer('seen_at_ms').$type<Millis>().notNull(),
})

export const tileHistory = sqliteTable(
  'tile_history',
  {
    tileX: integer('tile_x').notNull(),
    tileY: integer('tile_y').notNull(),
    resolutionS: integer('resolution_s').$type<Seconds>().notNull(),
    bucketStartS: integer('bucket_start_s').$type<Seconds>().notNull(),
    sha256: text('sha256').notNull(),
    // One row per reporter per observation. `reporters` used to be an aggregate integer on a row
    // keyed only by tile, tier and bucket: a single hostile client could increment it by replaying
    // its own hash until it looked like multi-client quorum, and an honest competing hash could not
    // be stored at all because the key admitted one hash per bucket. The count is now COUNT(*) over
    // distinct reporters, which cannot be forged by repetition.
    reportedBy: text('reported_by').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tileX,
        table.tileY,
        table.resolutionS,
        table.bucketStartS,
        table.sha256,
        table.reportedBy,
      ],
    }),
    check('tile_history_resolution_s_check', sql`${table.resolutionS} IN (0, 3600, 21600, 86400)`),
    check(
      'tile_history_coordinate_check',
      sql`typeof(${table.tileX}) = 'integer' AND typeof(${table.tileY}) = 'integer'
        AND ${table.tileX} BETWEEN 0 AND ${sql.raw(String(WORLD_TILES - 1))}
        AND ${table.tileY} BETWEEN 0 AND ${sql.raw(String(WORLD_TILES - 1))}`,
    ),
  ],
)
