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
  (table) => [index('nodes_path_idx').on(table.path)],
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
    placed: integer('placed').notNull(),
    correct: integer('correct').notNull(),
    repairs: integer('repairs').notNull(),
  },
  (table) => [primaryKey({ columns: [table.wplaceUserId, table.templateId, table.dayS] })],
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
    reporters: integer('reporters').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tileX, table.tileY, table.resolutionS, table.bucketStartS],
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
