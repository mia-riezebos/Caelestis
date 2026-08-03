import {
  type AnySQLiteColumn,
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
    createdAtMs: integer('created_at_ms').notNull(),
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
  createdAtMs: integer('created_at_ms').notNull(),
})

export const templateVersions = sqliteTable('template_versions', {
  id: text('id').primaryKey(),
  templateId: text('template_id')
    .notNull()
    .references(() => templates.id),
  createdAtMs: integer('created_at_ms').notNull(),
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
})

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
    primaryKey({ columns: [table.versionId, table.tileX, table.tileY] }),
    index('version_tiles_tile_idx').on(table.tileX, table.tileY),
  ],
)

export const accessTokens = sqliteTable('access_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  label: text('label').notNull(),
  scope: text('scope', { enum: ['read', 'report', 'admin'] }).notNull(),
  createdBy: text('created_by').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
  revokedAtMs: integer('revoked_at_ms'),
})

export const telemetryBuckets = sqliteTable(
  'telemetry_buckets',
  {
    templateId: text('template_id').notNull(),
    resolution: integer('resolution').notNull(),
    bucketStartS: integer('bucket_start_s').notNull(),
    placed: integer('placed').notNull(),
    correct: integer('correct').notNull(),
    repairs: integer('repairs').notNull(),
  },
  (table) => [primaryKey({ columns: [table.templateId, table.resolution, table.bucketStartS] })],
)

export const contributions = sqliteTable(
  'contributions',
  {
    wplaceUserId: integer('wplace_user_id').notNull(),
    templateId: text('template_id')
      .notNull()
      .references(() => templates.id),
    dayS: integer('day_s').notNull(),
    placed: integer('placed').notNull(),
    correct: integer('correct').notNull(),
    repairs: integer('repairs').notNull(),
  },
  (table) => [primaryKey({ columns: [table.wplaceUserId, table.templateId, table.dayS] })],
)

export const painters = sqliteTable('painters', {
  wplaceUserId: integer('wplace_user_id').primaryKey(),
  displayName: text('display_name').notNull(),
  seenAtMs: integer('seen_at_ms').notNull(),
})

export const tileHistory = sqliteTable(
  'tile_history',
  {
    tileX: integer('tile_x').notNull(),
    tileY: integer('tile_y').notNull(),
    resolutionS: integer('resolution_s').notNull(),
    bucketStartS: integer('bucket_start_s').notNull(),
    sha256: text('sha256').notNull(),
    reporters: integer('reporters').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tileX, table.tileY, table.resolutionS, table.bucketStartS],
    }),
  ],
)
