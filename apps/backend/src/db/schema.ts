import type { Millis, Seconds, TemplateSurfaceKind } from '@caelestis/shared'
import { WORLD_PIXELS, WORLD_TILES } from '@caelestis/shared'
import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/**
 * Operator-set overrides for what this server calls itself.
 *
 * One row, pinned by a check constraint, because there is exactly one server per deployment and a
 * table that permits two would eventually hold two with nothing to say which is current.
 *
 * Separate from `wrangler.toml`'s `[vars]` rather than replacing them: the vars stay the value a
 * fresh deployment starts with, and this is what an admin has since decided. A null column means
 * "not decided", which is different from an empty string and falls back to the var.
 */
export const serverSettings = sqliteTable(
  'server_settings',
  {
    id: integer('id').primaryKey(),
    name: text('name'),
    description: text('description'),
  },
  (table) => [check('server_settings_single_row_check', sql`${table.id} = 1`)],
)

/** D1-owned rebuild metadata keeps season revisions monotonic if a projection object is lost. */
export const statusReadModelRevisions = sqliteTable(
  'status_read_model_revisions',
  {
    season: integer('season').primaryKey(),
    revision: integer('revision').notNull(),
    publicFingerprint: text('public_fingerprint').notNull(),
    adminFingerprint: text('admin_fingerprint').notNull(),
    fingerprintsDirty: integer('fingerprints_dirty', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    check(
      'status_read_model_revisions_values_check',
      sql`typeof(${table.season}) = 'integer' AND ${table.season} >= 0
        AND typeof(${table.revision}) = 'integer' AND ${table.revision} > 0
        AND length(${table.publicFingerprint}) = 64
        AND ${table.publicFingerprint} NOT GLOB '*[^0-9a-f]*'
        AND length(${table.adminFingerprint}) = 64
        AND ${table.adminFingerprint} NOT GLOB '*[^0-9a-f]*'
        AND typeof(${table.fingerprintsDirty}) = 'integer'
        AND ${table.fingerprintsDirty} IN (0, 1)`,
    ),
  ],
)

export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    season: integer('season').notNull(),
    surfaceKind: text('surface_kind', {
      enum: ['world', 'alliance-headquarters', 'alliance-picture', 'alliance-banner'],
    })
      .$type<TemplateSurfaceKind>()
      .notNull()
      .default('world'),
    allianceId: integer('alliance_id'),
    parentId: text('parent_id').references((): AnySQLiteColumn => nodes.id),
    path: text('path').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Ephemeral claim tying a confirmed cascade snapshot to its atomic delete batch. */
    deleteToken: text('delete_token'),
    createdAtMs: integer('created_at_ms').$type<Millis>().notNull(),
  },
  // Within a season and drawing surface, path is the prefix-rollup key and subtree-rewrite key. Two
  // nodes sharing one path make a rollup attribute one group's templates to another, and make the
  // documented prefix-matched subtree move rewrite both subtrees when either one is renamed.
  // Lowercase, because SQLite's LIKE is ASCII-case-insensitive: with both /Canada and /canada stored,
  // a subtree move matched on `<old>/` rewrites the other one's descendants too.
  //
  // That asymmetry constrains how the move is written. LIKE selects case-insensitively, so it picks
  // up a `/CANADA/x` descendant of `/canada` — and SQLite's `replace()` is byte-exact, so rewriting
  // with it leaves that row pointing at a prefix that no longer exists. The move has to rebuild the
  // path from its length: `<new> || substr(path, length(<old>) + 1)`.
  (table) => [
    uniqueIndex('nodes_world_path_idx')
      .on(table.season, sql`lower(${table.path})`)
      .where(sql`${table.surfaceKind} = 'world'`),
    uniqueIndex('nodes_alliance_surface_path_idx')
      .on(table.season, table.surfaceKind, table.allianceId, sql`lower(${table.path})`)
      .where(sql`${table.surfaceKind} <> 'world'`),
    check(
      'nodes_surface_check',
      sql`(${table.surfaceKind} = 'world' AND ${table.allianceId} IS NULL)
        OR (${table.surfaceKind} IN ('alliance-headquarters', 'alliance-picture', 'alliance-banner')
          AND typeof(${table.allianceId}) = 'integer' AND ${table.allianceId} > 0)`,
    ),
    // The wire's NodePath states this shape, and that schema validates the manifest *response* —
    // nothing stood between a create-or-rename-group route and this column, and `nodes` was the one
    // table in this file carrying no CHECK at all.
    //
    // `%` and `_` are LIKE metacharacters and this is the subtree-rewrite key, so `/canada%`
    // expands the move's prefix to `/canada%/` and captures every sibling subtree
    // starting with "canada"; `/%` captures the whole tree. The structural rules come with them: a
    // path is absolute, has no empty segment, and does not end in a slash, or the prefix rollup and
    // the move disagree about where a subtree begins.
    //
    // GLOB rather than LIKE because GLOB is case-sensitive and takes character classes; the
    // charset itself stays on the wire, where a pattern can express it.
    check(
      'nodes_path_check',
      sql`${table.path} GLOB '/*' AND ${table.path} NOT GLOB '*[%_]*'
        AND ${table.path} NOT GLOB '*/' AND ${table.path} NOT GLOB '*//*'
        AND length(${table.path}) BETWEEN 2 AND 256`,
    ),
    // The wire derives acyclicity from the path rule, which is likewise response-only. A self-parent
    // satisfies the foreign key, hangs any recursive ancestor walk, and makes the manifest
    // undecodable for every client. Only the one-step case is expressible here; a longer cycle needs
    // the path rule above, which the wire enforces on the way out.
    check(
      'nodes_parent_not_self_check',
      sql`${table.parentId} IS NULL OR ${table.parentId} <> ${table.id}`,
    ),
  ],
)
export const templateVersions = sqliteTable(
  'template_versions',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id')
      .notNull()
      .references((): AnySQLiteColumn => templates.id),
    createdAtMs: integer('created_at_ms').$type<Millis>().notNull(),
    /** Who uploaded this version — token digest and wplace account, as everywhere else. */
    createdWithToken: text('created_with_token').notNull(),
    createdByUserId: integer('created_by_user_id'),
    minX: integer('min_x').notNull(),
    minY: integer('min_y').notNull(),
    maxX: integer('max_x').notNull(),
    maxY: integer('max_y').notNull(),
    totalPixels: integer('total_pixels').notNull(),
    colourTotalsJson: text('colour_totals_json'),
    boundsNorth: real('bounds_north'),
    boundsSouth: real('bounds_south'),
    boundsWest: real('bounds_west'),
    boundsEast: real('bounds_east'),
  },
  (table) => [
    unique('template_versions_id_template_idx').on(table.id, table.templateId),
    // Same shape rule the reporter columns carry, for the same reason: an author record outlives
    // the credential it names, so the digest is constrained and its existence is not.
    check(
      'template_versions_created_with_token_check',
      sql`typeof(${table.createdWithToken}) = 'text' AND length(${table.createdWithToken}) = 64
        AND ${table.createdWithToken} NOT GLOB '*[^0-9a-f]*'
        AND (${table.createdByUserId} IS NULL
          OR (typeof(${table.createdByUserId}) = 'integer' AND ${table.createdByUserId} >= 0))`,
    ),

    check(
      'template_versions_bounds_all_or_none_check',
      sql`(${table.boundsNorth} IS NULL AND ${table.boundsSouth} IS NULL AND ${table.boundsWest} IS NULL AND ${table.boundsEast} IS NULL) OR (${table.boundsNorth} IS NOT NULL AND ${table.boundsSouth} IS NOT NULL AND ${table.boundsWest} IS NOT NULL AND ${table.boundsEast} IS NOT NULL)`,
    ),
    check(
      'template_versions_pixel_bounds_check',
      // The table is shared by world coordinates and the centred alliance HQ. SQLite CHECKs cannot
      // consult the parent template's surface, so this is the safe outer envelope; the store
      // validates the exact surface-specific bounds before insertion. World x may wrap through zero,
      // hence min_x > max_x remains legal here, while y never wraps.
      sql`typeof(${table.minX}) = 'integer' AND typeof(${table.minY}) = 'integer'
        AND typeof(${table.maxX}) = 'integer' AND typeof(${table.maxY}) = 'integer'
        AND typeof(${table.totalPixels}) = 'integer'
        AND ${table.minX} BETWEEN -1000 AND ${sql.raw(String(WORLD_PIXELS - 1))}
        AND ${table.minY} BETWEEN -1000 AND ${sql.raw(String(WORLD_PIXELS - 1))}
        AND ${table.maxX} BETWEEN -999 AND ${sql.raw(String(WORLD_PIXELS))}
        AND ${table.maxY} BETWEEN -999 AND ${sql.raw(String(WORLD_PIXELS))}
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

export const templates = sqliteTable(
  'templates',
  {
    id: text('id').primaryKey(),
    season: integer('season').notNull(),
    surfaceKind: text('surface_kind', {
      enum: ['world', 'alliance-headquarters', 'alliance-picture', 'alliance-banner'],
    })
      .$type<TemplateSurfaceKind>()
      .notNull()
      .default('world'),
    allianceId: integer('alliance_id'),
    nodeId: text('node_id').references(() => nodes.id),
    name: text('name').notNull(),
    currentVersionId: text('current_version_id'),
    publishedAt: integer('published_at').$type<Millis>(),
    /**
     * When an administrator froze this template's timelapse, or null while it is live.
     *
     * A finished artwork's history is an archive, not a cache. The decay sweeper must exempt
     * `tile_history` rows on a frozen template's tiles and their one-tile ring at or before this
     * instant.
     */
    timelapseFrozenAt: integer('timelapse_frozen_at_ms').$type<Millis>(),
    /** When an administrator marked this artwork complete, or null while work is live. */
    finishedAt: integer('finished_at_ms').$type<Millis>(),
    /**
     * Who created this template.
     *
     * The digest is always recorded: the bootstrap operator has no `access_tokens` row, but it is
     * still a real credential set from the environment, so it is hashed like any other and stored
     * like any other. There is no creation without a credential behind it.
     *
     * The account is nullable where the reporter columns' is not, and
     * the asymmetry is the point: quorum counts distinct accounts, so a report without one is
     * meaningless, while authorship only has to name the credential that acted. An admin uploading
     * through a server-side route presents a token and no wplace session, and a dashboard will be in
     * the same position until it can require the userscript to have read `/me` at least once.
     *
     * **An upload that does come from the userscript must carry the account.** The schema cannot
     * enforce that — it cannot tell which client called — so it is an obligation on the userscript
     * upload route, which does not exist yet. Recorded as the same pair a report is attributed to: the digest of the
     * access token used, and the wplace `/me` id of the account that used it. `template_versions`
     * records this per upload; without it here, the template itself — the thing that gets renamed,
     * moved and deleted — had a creation time and no author.
     */
    createdWithToken: text('created_with_token').notNull(),
    createdByUserId: integer('created_by_user_id'),
    createdAtMs: integer('created_at_ms').$type<Millis>().notNull(),
    /** Changes on every metadata or version mutation so manifest clients can invalidate caches. */
    updatedAtMs: integer('updated_at_ms').$type<Millis>().notNull(),
  },
  // The version this template currently serves has to be one of *its own* versions. Referencing
  // template_versions(id) alone said only "some version exists": one template could point at
  // another's, and current_version_id is what the manifest reads bounds and chunks from, so it
  // would serve that template's geometry under its own identity — wrong pixels on the canvas and a
  // progress denominator belonging to a different template.
  //
  // Expressed as a composite key against (id, template_id), which is why template_versions carries
  // a unique index on that pair: SQLite requires a foreign key's parent columns to be unique.
  (table) => [
    check(
      'templates_surface_check',
      sql`(${table.surfaceKind} = 'world' AND ${table.allianceId} IS NULL)
        OR (${table.surfaceKind} IN ('alliance-headquarters', 'alliance-picture', 'alliance-banner')
          AND typeof(${table.allianceId}) = 'integer' AND ${table.allianceId} > 0)`,
    ),
    index('templates_surface_idx').on(table.season, table.surfaceKind, table.allianceId),
    // Same shape rule the reporter columns carry, for the same reason: an author record outlives
    // the credential it names, so the digest is constrained and its existence is not.
    check(
      'templates_created_with_token_check',
      sql`typeof(${table.createdWithToken}) = 'text' AND length(${table.createdWithToken}) = 64
        AND ${table.createdWithToken} NOT GLOB '*[^0-9a-f]*'
        AND (${table.createdByUserId} IS NULL
          OR (typeof(${table.createdByUserId}) = 'integer' AND ${table.createdByUserId} >= 0))`,
    ),
    foreignKey({
      columns: [table.currentVersionId, table.id],
      foreignColumns: [templateVersions.id, templateVersions.templateId],
      name: 'templates_current_version_fk',
    }),
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
      'version_tiles_hash_check',
      sql`typeof(${table.hash}) = 'text' AND length(${table.hash}) = 64
        AND ${table.hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      'version_tiles_coordinate_check',
      // Alliance HQ uses the same 1,000px chunk grid centred on zero, so its western/northern half
      // is chunk -1. The store still validates exact per-surface ranges before this outer envelope.
      sql`typeof(${table.tileX}) = 'integer' AND typeof(${table.tileY}) = 'integer'
        AND ${table.tileX} BETWEEN -1 AND ${sql.raw(String(WORLD_TILES - 1))}
        AND ${table.tileY} BETWEEN -1 AND ${sql.raw(String(WORLD_TILES - 1))}`,
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
    createdWithToken: text('created_with_token').notNull(),
    createdAtMs: integer('created_at_ms').$type<Millis>().notNull(),
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
    // A bucket start is the floor of an event time to its resolution, so it is always a
    // non-negative multiple of it. Without this, {resolution: 60, bucketStart: 61} persists as a row
    // no reader can align with any other tier of the ladder, and the decay fold silently produces
    // overlapping buckets.
    //
    // The typeof guard carries the rest of the clause. `%` casts to integer before dividing, so
    // 60.5 reads as 60 and clears the alignment test on its own — and INTEGER is an affinity, so
    // 60.5 stays REAL. `(t, 60, 60)` and `(t, 60, 60.5)` would then be two primary keys for one
    // minute, which every reader that sums the tier double-counts. The sign clause is separate
    // because a negative multiple aligns perfectly and is still not a time.
    check(
      'telemetry_buckets_alignment_check',
      sql`typeof(${table.bucketStartS}) = 'integer' AND ${table.bucketStartS} >= 0
        AND ${table.bucketStartS} % ${table.resolution} = 0`,
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
    /**
     * Which token reported this. `wplace_user_id` is attacker-supplied and nothing binds it to the
     * authenticated caller, so a report-scope holder could attribute fabricated work to any other
     * painter — and with no reporter column that was neither attributable nor reversible.
     *
     * **`reported_by_user_id` is the key component, not this column, so
     * `(wplace_user_id, template_id, day_s)` is not unique.** On a self-hosted alliance server every
     * member reports, so two members reporting the same painter's day is the normal case, not an
     * attack. A rollup written as `SUM(placed) ... GROUP BY wplace_user_id` therefore multiplies
     * that painter's credit by the number of reporters. Rollups must reduce to one row per
     * (user, template, day) first — take the maximum, since a reporter that saw less of the day
     * cannot disprove one that saw more. Reduce on the account, which is what the key separates.
     *
     * Being out of the key costs this column something worth stating: an upsert from the same
     * account rewrites it, so it names the last credential to report a day rather than every one
     * that did. Tracing a leaked token through what it wrote is best-effort here; an append-only
     * log is what that would need, and it belongs with the route that writes it.
     */
    reportedWithToken: text('reported_with_token').notNull(),
    /**
     * The wplace `/me` id of the account running the reporting client, for the same reason
     * `tile_history` carries one: a token is not a client. One token shared across an alliance's
     * members made them a single reporter, so the max-per-reporter rollup below silently discarded
     * every member's view but one.
     */
    reportedByUserId: integer('reported_by_user_id').notNull(),
    placed: integer('placed').notNull(),
    correct: integer('correct').notNull(),
    repairs: integer('repairs').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.wplaceUserId, table.templateId, table.dayS, table.reportedByUserId],
    }),
    check(
      'contributions_reported_with_token_check',
      sql`typeof(${table.reportedWithToken}) = 'text' AND length(${table.reportedWithToken}) = 64
        AND ${table.reportedWithToken} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      'contributions_counter_check',
      // day_s is a day bucket, so it is a UTC midnight — the floor of a report time to 86400.
      // Unaligned, 1 and 2 are two primary keys for one day, and a leaderboard rollup grouped by
      // day splits one painter's work across both.
      // wplace_user_id is attacker-supplied and was the one key column here with no type guard,
      // while day_s and all three counters beside it had one. INTEGER affinity converts '1' but
      // leaves 1.5 and 'abc' alone, so each persisted as its own primary key — one report token
      // minting unbounded "painters" at 1.5, 1.25, 1.125, every one of them a separate person to
      // `GROUP BY wplace_user_id`, which also defeats the reduce-then-max rollup documented above.
      sql`typeof(${table.wplaceUserId}) = 'integer' AND ${table.wplaceUserId} >= 0
        AND typeof(${table.reportedByUserId}) = 'integer' AND ${table.reportedByUserId} >= 0
        AND typeof(${table.dayS}) = 'integer' AND ${table.dayS} >= 0
        AND ${table.dayS} % 86400 = 0
        AND typeof(${table.placed}) = 'integer' AND typeof(${table.correct}) = 'integer'
        AND typeof(${table.repairs}) = 'integer'
        AND ${table.repairs} >= 0
        AND ${table.repairs} <= ${table.correct} AND ${table.correct} <= ${table.placed}`,
    ),
  ],
)

/**
 * Paint event ids already applied, so the ingest path has somewhere to detect a retry.
 *
 * `PaintEvent.eventId` is documented as "client-generated, so a retry can never double-count", and
 * nothing stored it — the pending path is purely additive (`placed = placed + excluded.placed`), so
 * replaying one captured event N times multiplied the counters by N. The guarantee was stated as a
 * property of the design with nowhere in the schema to hold it.
 *
 * This table is that place, and it is not the guarantee. The counters it protects live in a Durable
 * D1 stores the classification beside the claim and applies contribution increments in one batch.
 * A retry replays that exact classification into the independently idempotent counter store.
 *
 * D1 retains the claim with the aggregate it protects. Pruning it would let an old retry increment
 * lifetime contributions again; the shorter-lived counter copy can expire with its time bucket.
 */
export const appliedEvents = sqliteTable(
  'applied_events',
  {
    eventId: text('event_id').primaryKey(),
    wplaceUserId: integer('wplace_user_id').notNull(),
    seenAtMs: integer('seen_at_ms').$type<Millis>().notNull(),
    // Null only for claims created before classifications were persisted.
    accountingJson: text('accounting_json'),
  },
  (table) => [
    index('applied_events_seen_at_idx').on(table.seenAtMs),
    // The guard `contributions` carries, on the sibling that was missed. INTEGER affinity converts
    // '1' and leaves 1.5 and 'abc' alone, so a replay check reading `wplace_user_id = 1` never
    // matches a row stored as 1.5 — and this is the first write of every ingest request.
    check(
      'applied_events_user_check',
      sql`typeof(${table.wplaceUserId}) = 'integer' AND ${table.wplaceUserId} >= 0`,
    ),
  ],
)

export const painters = sqliteTable('painters', {
  wplaceUserId: integer('wplace_user_id').primaryKey(),
  displayName: text('display_name').notNull(),
  seenAtMs: integer('seen_at_ms').$type<Millis>().notNull(),
})

export const tileHistory = sqliteTable(
  'tile_history',
  {
    season: integer('season').notNull(),
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
    //
    // Repetition is all it is safe from. The key component that separates reporters is
    // `reported_by_user_id`, and what keeps two rows from being one hostile client is the route
    // verifying that account — see the note on that column. Nothing in this table can check it.
    //
    // It bounds the reporter dimension and only that one. `sha256` is also in the key, so a client
    // free to choose it could still mint a row per hash for one tile and bucket. Two decisions
    // outside this schema close that, and they are the reason the key keeps `sha256`: the server
    // computes the hash from the tile it fetched rather than accepting a client's, and the report
    // route rate-limits ingest. A writer that ever takes this value from a request body reopens it.
    /**
     * Deliberately not a foreign key to `access_tokens`.
     *
     * This column exists to answer "which credential reported this", so a leaked or misbehaving
     * token can be traced through what it wrote. Referential integrity to a credential table
     * inverts that: `ON DELETE NO ACTION` makes deleting a token that ever reported fail, so the
     * only way to remove one is to delete its history first — destroying the very record the column
     * was added to keep. An audit trail has to outlive the credential it names, which means orphans
     * are the point, not a defect.
     *
     * Deleting a credential does not retract what it already reported, and must not: reported state
     * records what was actually on the canvas, so it is canonical regardless of what later happens
     * to the credential that carried it. Revoking ends a holder's future access; it does not edit
     * the past, and a quorum read counting those rows is still counting real observations.
     *
     * An earlier version of this note said revocation should delete the reports too. That was
     * wrong — it would trade an accurate record of wplace for a tidy one.
     *
     * The shape stays constrained, which is what the foreign key was really buying: the earlier
     * justification was "keeps this a token, not free text". A 64-character lowercase hex digest is
     * still not free text, and it holds for a hash whose token row is long gone. Existence is the
     * route's job — the server derives this from the authenticated credential rather than reading
     * it off a request, the same way it computes `sha256` itself.
     */
    reportedWithToken: text('reported_with_token').notNull(),
    /**
     * The wplace `/me` id of the account running the reporting client, and the only key component
     * that separates reporters. A token is not a client in either direction: one token configured
     * on five members' userscripts made those five a single reporter and collapsed genuine quorum
     * to 1, and keying on (token, account) made a member holding two tokens count as two, forging
     * the two-distinct-client agreement the ladder prefers.
     *
     * **That makes the route the only thing between this table and forged quorum, and it is a real
     * obligation.** An earlier version keyed on a token digest with a foreign key to
     * `access_tokens`, so manufacturing N agreeing reporters cost N admin-issued credentials. It no
     * longer does: this is an integer whose only constraint is that it is a non-negative one, so a
     * route that reads it from a request body lets one caller invent as many reporters as it likes
     * for a hash of its choosing.
     *
     * The server cannot derive it the way it derives `sha256` — the value comes from wplace `/me`,
     * which answers for whoever's session asked. The route must verify the account against wplace
     * rather than trust a client's copy, and the honest ceiling is then "as many reporters as the
     * attacker holds real wplace accounts", not one.
     */
    reportedByUserId: integer('reported_by_user_id').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.season,
        table.tileX,
        table.tileY,
        table.resolutionS,
        table.bucketStartS,
        table.sha256,
        table.reportedByUserId,
      ],
    }),
    index('tile_history_sha256_idx').on(table.sha256),
    check('tile_history_resolution_s_check', sql`${table.resolutionS} IN (0, 3600, 21600, 86400)`),
    check(
      'tile_history_season_check',
      sql`typeof(${table.season}) = 'integer' AND ${table.season} >= 0`,
    ),
    // The same rule `telemetry_buckets` states, on the ladder this table folds. A folded bucket
    // start is the floor of an observation to its tier, so {resolution: 3600, bucketStart: 3601}
    // keys a bucket overlapping the real 3600 one and the fold counts one hour as two.
    //
    // Raw observations carry resolution 0 and are exempt: their bucket start is the observation
    // time itself, aligned to nothing. Stating that as an explicit disjunct rather than leaning on
    // `x % 0` evaluating to NULL — a CHECK that is NULL does not fail, so the exemption would hold
    // by accident and read as an oversight.
    // The content digest gets the rule its credential sibling already has. A BLOB stored here is
    // invisible to text lookups and cannot satisfy the wire's Chunk.hash or an R2 object key, and
    // two spellings of one hash split the quorum they should agree on.
    check(
      'tile_history_sha256_check',
      sql`typeof(${table.sha256}) = 'text' AND length(${table.sha256}) = 64
        AND ${table.sha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      'tile_history_reported_with_token_check',
      sql`typeof(${table.reportedWithToken}) = 'text' AND length(${table.reportedWithToken}) = 64
        AND ${table.reportedWithToken} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      'tile_history_reported_by_user_id_check',
      sql`typeof(${table.reportedByUserId}) = 'integer' AND ${table.reportedByUserId} >= 0`,
    ),
    check(
      'tile_history_bucket_start_s_check',
      sql`typeof(${table.bucketStartS}) = 'integer' AND ${table.bucketStartS} >= 0
        AND (${table.resolutionS} = 0 OR ${table.bucketStartS} % ${table.resolutionS} = 0)`,
    ),
    check(
      'tile_history_coordinate_check',
      sql`typeof(${table.tileX}) = 'integer' AND typeof(${table.tileY}) = 'integer'
        AND ${table.tileX} BETWEEN 0 AND ${sql.raw(String(WORLD_TILES - 1))}
        AND ${table.tileY} BETWEEN 0 AND ${sql.raw(String(WORLD_TILES - 1))}`,
    ),
  ],
)

/** Latest accepted canvas observation per tile, used to classify later paint repairs. */
export const canvasTiles = sqliteTable(
  'canvas_tiles',
  {
    season: integer('season').notNull(),
    tileX: integer('tile_x').notNull(),
    tileY: integer('tile_y').notNull(),
    sha256: text('sha256').notNull(),
    observedAtMs: integer('observed_at_ms').$type<Millis>().notNull(),
    /** Distinguishes the backend mirror from client reports when resolving clock skew. */
    serverOwned: integer('server_owned', { mode: 'boolean' }).notNull().default(false),
    /** Monotonic per-tile order for projecting concurrent accepted commits into derived caches. */
    commitOrder: integer('commit_order').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.season, table.tileX, table.tileY] }),
    index('canvas_tiles_sha256_idx').on(table.sha256),
    check(
      'canvas_tiles_season_check',
      sql`typeof(${table.season}) = 'integer' AND ${table.season} >= 0`,
    ),
    check(
      'canvas_tiles_coordinate_check',
      sql`typeof(${table.tileX}) = 'integer' AND typeof(${table.tileY}) = 'integer'
        AND ${table.tileX} BETWEEN 0 AND ${sql.raw(String(WORLD_TILES - 1))}
        AND ${table.tileY} BETWEEN 0 AND ${sql.raw(String(WORLD_TILES - 1))}`,
    ),
    check(
      'canvas_tiles_sha256_check',
      sql`typeof(${table.sha256}) = 'text' AND length(${table.sha256}) = 64
        AND ${table.sha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
  ],
)

export type TileBlobObjectState = 'uploading' | 'active' | 'candidate' | 'deleting' | 'deleted'

/**
 * Durable state for each physical tile object.
 *
 * `sha256` remains the public content identity. `blob_key` is the physical R2 key relative to the
 * `tiles/` namespace and changes after a deletion. A delete can therefore finish late without
 * removing bytes restored by a later ingest.
 */
export const tileBlobObjects = sqliteTable(
  'tile_blob_objects',
  {
    blobKey: text('blob_key').primaryKey(),
    sha256: text('sha256').notNull(),
    state: text('state').$type<TileBlobObjectState>().notNull(),
    discoveredAtMs: integer('discovered_at_ms').$type<Millis>().notNull(),
    deleteStartedAtMs: integer('delete_started_at_ms').$type<Millis>(),
    deleteAttempts: integer('delete_attempts').notNull().default(0),
    reclaimedAtMs: integer('reclaimed_at_ms').$type<Millis>(),
  },
  (table) => [
    index('tile_blob_objects_hash_state_idx').on(table.sha256, table.state),
    check(
      'tile_blob_objects_sha256_check',
      sql`typeof(${table.sha256}) = 'text' AND length(${table.sha256}) = 64
        AND ${table.sha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      'tile_blob_objects_key_check',
      sql`${table.blobKey} = ${table.sha256} OR substr(${table.blobKey}, 1, length(${table.sha256}) + 1) = ${table.sha256} || '/'`,
    ),
    check(
      'tile_blob_objects_state_check',
      sql`${table.state} IN ('uploading', 'active', 'candidate', 'deleting', 'deleted')`,
    ),
    check(
      'tile_blob_objects_attempts_check',
      sql`typeof(${table.deleteAttempts}) = 'integer' AND ${table.deleteAttempts} >= 0`,
    ),
  ],
)

/** In-flight ingest claims. A deletion fence and a live reservation are mutually exclusive. */
export const tileBlobReservations = sqliteTable(
  'tile_blob_reservations',
  {
    id: text('id').primaryKey(),
    sha256: text('sha256').notNull(),
    blobKey: text('blob_key')
      .notNull()
      .references(() => tileBlobObjects.blobKey, { onDelete: 'cascade' }),
    expiresAtMs: integer('expires_at_ms').$type<Millis>().notNull(),
  },
  (table) => [
    index('tile_blob_reservations_hash_expiry_idx').on(table.sha256, table.expiresAtMs),
    check(
      'tile_blob_reservations_sha256_check',
      sql`typeof(${table.sha256}) = 'text' AND length(${table.sha256}) = 64
        AND ${table.sha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
  ],
)

/** The opaque R2 cursor that makes each scheduled namespace scan continue where the last stopped. */
export const tileBlobGcState = sqliteTable(
  'tile_blob_gc_state',
  {
    id: integer('id').primaryKey(),
    cursor: text('cursor'),
    completedSweeps: integer('completed_sweeps').notNull().default(0),
  },
  (table) => [
    check('tile_blob_gc_state_single_row_check', sql`${table.id} = 1`),
    check(
      'tile_blob_gc_state_sweeps_check',
      sql`typeof(${table.completedSweeps}) = 'integer' AND ${table.completedSweeps} >= 0`,
    ),
  ],
)

/** Latest classified progress for one current template chunk. */
export const templateTileStatuses = sqliteTable(
  'template_tile_statuses',
  {
    templateId: text('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    versionId: text('version_id')
      .notNull()
      .references(() => templateVersions.id, { onDelete: 'cascade' }),
    tileX: integer('tile_x').notNull(),
    tileY: integer('tile_y').notNull(),
    correct: integer('correct').notNull(),
    wrong: integer('wrong').notNull(),
    blank: integer('blank').notNull(),
    coloursJson: text('colours_json').notNull(),
    observedAtMs: integer('observed_at_ms').$type<Millis>().notNull(),
    /** Distinguishes backend classification from client-reported classification. */
    serverOwned: integer('server_owned', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.templateId, table.versionId, table.tileX, table.tileY] }),
    index('template_tile_statuses_version_idx').on(table.versionId),
    check(
      'template_tile_statuses_coordinate_check',
      sql`typeof(${table.tileX}) = 'integer' AND typeof(${table.tileY}) = 'integer'
        AND ${table.tileX} BETWEEN 0 AND ${sql.raw(String(WORLD_TILES - 1))}
        AND ${table.tileY} BETWEEN 0 AND ${sql.raw(String(WORLD_TILES - 1))}`,
    ),
    check(
      'template_tile_statuses_counter_check',
      sql`typeof(${table.correct}) = 'integer' AND typeof(${table.wrong}) = 'integer'
        AND typeof(${table.blank}) = 'integer'
        AND ${table.correct} >= 0 AND ${table.wrong} >= 0 AND ${table.blank} >= 0`,
    ),
  ],
)

/** Last backend-owned classification per current template chunk, independent of client freshness. */
export const templateAlarmTileStatuses = sqliteTable(
  'template_alarm_tile_statuses',
  {
    templateId: text('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    versionId: text('version_id')
      .notNull()
      .references(() => templateVersions.id, { onDelete: 'cascade' }),
    tileX: integer('tile_x').notNull(),
    tileY: integer('tile_y').notNull(),
    correct: integer('correct').notNull(),
    wrong: integer('wrong').notNull(),
    blank: integer('blank').notNull(),
    coloursJson: text('colours_json').notNull(),
    observedAtMs: integer('observed_at_ms').$type<Millis>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.templateId, table.versionId, table.tileX, table.tileY] }),
    index('template_alarm_tile_statuses_version_idx').on(table.versionId),
    check(
      'template_alarm_tile_statuses_coordinate_check',
      sql`typeof(${table.tileX}) = 'integer' AND typeof(${table.tileY}) = 'integer'
        AND ${table.tileX} BETWEEN 0 AND ${sql.raw(String(WORLD_TILES - 1))}
        AND ${table.tileY} BETWEEN 0 AND ${sql.raw(String(WORLD_TILES - 1))}`,
    ),
    check(
      'template_alarm_tile_statuses_counter_check',
      sql`typeof(${table.correct}) = 'integer' AND typeof(${table.wrong}) = 'integer'
        AND typeof(${table.blank}) = 'integer'
        AND ${table.correct} >= 0 AND ${table.wrong} >= 0 AND ${table.blank} >= 0`,
    ),
  ],
)

/** Version-local high-water state and the one active alarm episode a template may own. */
export const templateAlarmStates = sqliteTable(
  'template_alarm_states',
  {
    templateId: text('template_id')
      .primaryKey()
      .references(() => templates.id, { onDelete: 'cascade' }),
    versionId: text('version_id').notNull(),
    total: integer('total').notNull(),
    peakCorrect: integer('peak_correct').notNull(),
    alarmId: text('alarm_id'),
    kind: text('kind', { enum: ['regression', 'sustained-griefing'] }),
    pixelsLost: integer('pixels_lost'),
    firstSeenMs: integer('first_seen_ms').$type<Millis>(),
    lastSeenMs: integer('last_seen_ms').$type<Millis>(),
    probeDueAtMs: integer('probe_due_at_ms').$type<Millis>(),
    probePixelsLost: integer('probe_pixels_lost'),
    /** Rejects a delayed evaluation whose evidence predates the state already persisted. */
    evaluatedAtMs: integer('evaluated_at_ms').$type<Millis>().notNull().default(sql`0`),
    /** Optimistic compare-and-swap guard for overlapping cron and follow-up evaluations. */
    revision: integer('revision').notNull().default(0),
  },
  (table) => [
    index('template_alarm_states_probe_due_idx').on(table.probeDueAtMs),
    check(
      'template_alarm_states_counter_check',
      sql`typeof(${table.total}) = 'integer' AND ${table.total} >= 0
        AND typeof(${table.peakCorrect}) = 'integer'
        AND ${table.peakCorrect} BETWEEN 0 AND ${table.total}`,
    ),
    check(
      'template_alarm_states_episode_check',
      sql`(${table.alarmId} IS NULL AND ${table.kind} IS NULL AND ${table.pixelsLost} IS NULL
          AND ${table.firstSeenMs} IS NULL AND ${table.lastSeenMs} IS NULL
          AND ${table.probeDueAtMs} IS NULL AND ${table.probePixelsLost} IS NULL)
        OR (${table.alarmId} IS NOT NULL
          AND ${table.kind} IN ('regression', 'sustained-griefing')
          AND typeof(${table.pixelsLost}) = 'integer' AND ${table.pixelsLost} > 0
          AND typeof(${table.firstSeenMs}) = 'integer'
          AND typeof(${table.lastSeenMs}) = 'integer'
          AND ${table.firstSeenMs} <= ${table.lastSeenMs}
          AND ((${table.probeDueAtMs} IS NULL AND ${table.probePixelsLost} IS NULL)
            OR (typeof(${table.probeDueAtMs}) = 'integer'
              AND typeof(${table.probePixelsLost}) = 'integer'
              AND ${table.probePixelsLost} > 0)))`,
    ),
  ],
)
