import type { Millis, Seconds } from '@wts/shared'
import { WORLD_PIXELS, WORLD_TILES } from '@wts/shared'
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
  //
  // That asymmetry constrains how the move is written. LIKE selects case-insensitively, so it picks
  // up a `/CANADA/x` descendant of `/canada` — and SQLite's `replace()` is byte-exact, so rewriting
  // with it leaves that row pointing at a prefix that no longer exists. The move has to rebuild the
  // path from its length: `<new> || substr(path, length(<old>) + 1)`.
  (table) => [
    uniqueIndex('nodes_path_idx').on(sql`lower(${table.path})`),
    // The wire's NodePath states this shape, and that schema validates the manifest *response* —
    // nothing stood between a create-or-rename-group route and this column, and `nodes` was the one
    // table in this file carrying no CHECK at all.
    //
    // `%` and `_` are LIKE metacharacters and this is the subtree-rewrite key, so `/canada%`
    // expands the documented move to `LIKE '/canada%/%'` and captures every sibling subtree
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
    createdBy: text('created_by').notNull(),
    createdByUserId: integer('created_by_user_id').notNull(),
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
    unique('template_versions_id_template_idx').on(table.id, table.templateId),
    // Same shape rule the reporter columns carry, for the same reason: an author record outlives
    // the credential it names, so the digest is constrained and its existence is not.
    check(
      'template_versions_created_by_check',
      sql`typeof(${table.createdBy}) = 'text' AND length(${table.createdBy}) = 64
        AND ${table.createdBy} NOT GLOB '*[^0-9a-f]*'
        AND typeof(${table.createdByUserId}) = 'integer' AND ${table.createdByUserId} >= 0`,
    ),

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

export const templates = sqliteTable(
  'templates',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id),
    name: text('name').notNull(),
    season: integer('season').notNull(),
    currentVersionId: text('current_version_id'),
    /**
     * Who created this template, as the same pair a report is attributed to: the digest of the
     * access token used, and the wplace `/me` id of the account that used it. `template_versions`
     * records this per upload; without it here, the template itself — the thing that gets renamed,
     * moved and deleted — had a creation time and no author.
     */
    createdBy: text('created_by').notNull(),
    createdByUserId: integer('created_by_user_id').notNull(),
    createdAtMs: integer('created_at_ms').$type<Millis>().notNull(),
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
    // Same shape rule the reporter columns carry, for the same reason: an author record outlives
    // the credential it names, so the digest is constrained and its existence is not.
    check(
      'templates_created_by_check',
      sql`typeof(${table.createdBy}) = 'text' AND length(${table.createdBy}) = 64
        AND ${table.createdBy} NOT GLOB '*[^0-9a-f]*'
        AND typeof(${table.createdByUserId}) = 'integer' AND ${table.createdByUserId} >= 0`,
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
    reportedBy: text('reported_by').notNull(),
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
      'contributions_reported_by_check',
      sql`typeof(${table.reportedBy}) = 'text' AND length(${table.reportedBy}) = 64
        AND ${table.reportedBy} NOT GLOB '*[^0-9a-f]*'`,
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
 * Object and `CounterStore.record` takes no event id, so the check and the increment are two writes
 * to two systems and no constraint here can make them one. What the schema provides is a durable,
 * uniquely-keyed record of what has been applied; what the ingest route must provide is the order.
 *
 * Insert here *first*, then record the counters. That way a crash between the two loses one event's
 * counts, which is the recoverable direction — the row exists, so the retry is refused and the
 * counters stay truthful about every other event. Recording first and inserting second fails the
 * other way: the retry is admitted and the counts inflate permanently, which is the bug this table
 * was added to prevent. Making the two atomic needs the event id to reach the counter store, which
 * is a port change and belongs with the route that will need it.
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
     * Deleting a credential does not retract what it already reported: the rows survive by design,
     * and a quorum read counting raw rows keeps counting them. Revoking a token therefore means
     * deleting its reports too, which this column is what makes possible —
     * `DELETE FROM tile_history WHERE reported_by = ?`. A route obligation, and the reason the
     * digest earns storage even though no key uses it.
     *
     * The shape stays constrained, which is what the foreign key was really buying: the earlier
     * justification was "keeps this a token, not free text". A 64-character lowercase hex digest is
     * still not free text, and it holds for a hash whose token row is long gone. Existence is the
     * route's job — the server derives this from the authenticated credential rather than reading
     * it off a request, the same way it computes `sha256` itself.
     */
    reportedBy: text('reported_by').notNull(),
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
        table.tileX,
        table.tileY,
        table.resolutionS,
        table.bucketStartS,
        table.sha256,
        table.reportedByUserId,
      ],
    }),
    check('tile_history_resolution_s_check', sql`${table.resolutionS} IN (0, 3600, 21600, 86400)`),
    // The same rule `telemetry_buckets` states, on the ladder this table folds. A folded bucket
    // start is the floor of an observation to its tier, so {resolution: 3600, bucketStart: 3601}
    // keys a bucket overlapping the real 3600 one and the fold counts one hour as two.
    //
    // Raw observations carry resolution 0 and are exempt: their bucket start is the observation
    // time itself, aligned to nothing. Stating that as an explicit disjunct rather than leaning on
    // `x % 0` evaluating to NULL — a CHECK that is NULL does not fail, so the exemption would hold
    // by accident and read as an oversight.
    check(
      'tile_history_reported_by_check',
      sql`typeof(${table.reportedBy}) = 'text' AND length(${table.reportedBy}) = 64
        AND ${table.reportedBy} NOT GLOB '*[^0-9a-f]*'`,
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
