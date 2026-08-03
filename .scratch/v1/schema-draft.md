# Schema draft — v1

Working artifact for #24 and #25. **Not decided; react to it.** Anything marked **?** is an open
question I picked a default for rather than asking.

## Package layout

```
packages/shared        TypeScript types only, zero runtime deps  → userscript, backend, frontend
packages/wire-schema   Effect Schemas, depends on shared         → backend, frontend
```

Schemas are declared to satisfy the shared types, so drift is a build error. The userscript cannot
pull Effect in because it never depends on the package that contains it.

## D1 tables (Drizzle, `sqliteTable`)

**?** Identifiers are `text` UUIDv7 — sortable by creation, no coordination, safe to expose since a
server is single-tenant. Alternative is integer autoincrement plus opaque public ids, which is more
machinery than a self-hosted server needs.

**?** All timestamps are integer **unix seconds**, matching `CounterDelta.occurredAt`. Mixing seconds
and milliseconds is how the bucket-attribution bug happened; one unit everywhere.

### `nodes` — the group tree

```
id             text pk
parent_id      text null → nodes.id
path           text not null          -- '/canada/toronto', materialized
name           text not null
sort_order      integer not null       -- sparse: 100, 200, 300
created_at     integer not null
```

Index on `path` for prefix rollups. **?** On rename or move, descendant paths are rewritten in one
`UPDATE ... WHERE path LIKE '<old>/%'`. Moves are rare and trees are small, so no closure table.

### `templates` — identity

```
id                  text pk
node_id             text not null → nodes.id
name                text not null
sort_order          integer not null
season              integer not null      -- the canvas this is placed on
current_version_id  text null → template_versions.id
created_at          integer not null
```

`season` lives here because a template is placed on a specific canvas, and the season is a runtime
value in both the tile URL and the paint body.

### `template_versions` — content

```
id            text pk
template_id   text not null → templates.id
created_at    integer not null
created_by    text not null
min_x, min_y, max_x, max_y   integer not null   -- global canvas pixels
total_pixels  integer not null                  -- non-transparent; progress denominator
```

`templates.current_version_id` is nullable so a version can be uploaded before being made current —
which is what a draft is, without needing a separate concept.

### `version_chunks` — the sliced template

```
version_id    text not null → template_versions.id
tile_x        integer not null
tile_y        integer not null
offset_x      integer not null      -- tile-local
offset_y      integer not null
width         integer not null
height        integer not null
hash          text not null         -- sha256; R2 key chunks/{hash}.png
primary key (version_id, tile_x, tile_y)
```

Index on `(tile_x, tile_y)` — the hot query is "which current-version chunks cover this tile", asked
on every paint classification and to build the manifest tile index.

One row per tile per version, so an edit to one tile of a 1000-tile template writes 1000 rows.
**?** Accepted: rows are tiny, and normalising further still needs one row per (version, tile).

**Chunk GC** is `SELECT hash FROM version_chunks` minus the R2 listing — safe only because versions
are immutable.

### `invites`

```
code_hash    text pk               -- sha256 of a 128-bit base32 code
label        text not null         -- 'discord-regulars'
scope        text not null         -- 'read' | 'report' | 'admin'
created_by   text not null
created_at   integer not null
revoked_at   integer null
```

Codes are server-generated high entropy, so SHA-256 is sufficient; no slow KDF.

### `telemetry_buckets` — exists, unchanged

```
template_id, resolution, bucket_start, placed, correct, repairs
primary key (template_id, resolution, bucket_start)
```

### `contributions` — leaderboard rollups

```
username     text not null
template_id  text not null → templates.id
day          integer not null      -- unix seconds, floored to a day
placed, correct, repairs   integer not null
primary key (username, template_id, day)
```

**?** Keyed by `username` rather than a user id, because identity comes from wplace's `/me` and the
payload discipline forbids transmitting wplace user ids. A rename orphans history — accepted, or
needs an explicit rename story.

### `tile_history` — the mirror timeline

```
tile_x, tile_y   integer not null
observed_at      integer not null
sha256           text not null     -- R2 key tiles/{sha256}.png
reporter         text not null
primary key (tile_x, tile_y, observed_at)
```

## Wire schemas (`packages/wire-schema`)

One schema per wire type, each `satisfies Schema.Schema<SharedType>`:

- `Manifest`, `ServerInfo`, `Node`, `Template`, `Chunk`
- `PaintEvent`, `PaintTile`, `PaintPixels`
- `TileOffer`, `TileOfferResponse`
- `TemplateStatus`, `NodeStatus`, `Alarm`

Decode at every request boundary in the backend; encode on the way out. The userscript adheres
optimistically and validates nothing.

**?** `PaintPixels` has three parallel arrays with no length invariant expressible in the type. The
schema should carry a refinement asserting `x.length === y.length === colors.length`, so the one
thing TypeScript cannot express is caught at the boundary where it matters.

## Deliberately absent

- No `users` table. Identity is wplace's; we store a username string.
- No `templates.version` integer. The version *is* `current_version_id`.
- No soft deletes yet.
