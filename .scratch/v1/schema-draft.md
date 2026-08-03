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

**Identifiers: `text` UUIDv7.** Close call against nanoid. The only place ordering earns anything is
`template_versions`, where "newest first" comes free from primary-key order rather than needing
`created_at` plus an index plus tie-breaking. Everything else is indifferent, and 36 chars against 21
is cosmetic when ids live in API paths rather than anything a person types. The usual objection —
v7 leaks creation time — is moot when `created_at_ms` sits in the same row. Mixing the two schemes
would be worse than either.

**Timestamps: split by kind, with the unit in the column name.**

- **Domain time** — `occurred_at_s`, `bucket_start_s`, `day_s` — is **seconds**. It gets floored to 60s on
  arrival, so millisecond precision is discarded immediately.
- **Bookkeeping time** — `created_at_ms`, `observed_at_ms`, `revoked_at_ms` — is **milliseconds**,
  because ordering, last-write-wins and tie-breaking all need it. Two versions created in the same
  second would otherwise tie.

The lesson from the bucket-attribution bug was not "one unit everywhere" — it was that the unit lived
in a comment. Naming the column `_s` or `_ms` makes it unmissable at the call site, which is where it
went wrong.

### `nodes` — the group tree

```
id             text pk
parent_id      text null → nodes.id
path           text not null          -- '/canada/toronto', materialized
name           text not null
sort_order      integer not null       -- sparse: 100, 200, 300
created_at_ms  integer not null
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
created_at_ms       integer not null
```

`season` lives here because a template is placed on a specific canvas, and the season is a runtime
value in both the tile URL and the paint body.

### `template_versions` — content

```
id            text pk
template_id   text not null → templates.id
created_at_ms integer not null
created_by    text not null
min_x, min_y, max_x, max_y   integer not null   -- global canvas pixels
total_pixels  integer not null                  -- non-transparent; progress denominator
```

`templates.current_version_id` is nullable so a version can be uploaded before being made current —
which is what a draft is, without needing a separate concept.

### `version_tiles` — the sliced template, one full tile per row

```
version_id    text not null → template_versions.id
tile_x        integer not null
tile_y        integer not null
hash          text not null         -- sha256; R2 key chunks/{hash}.png
primary key (version_id, tile_x, tile_y)
```

**Chunks are full tiles**, padded to `TILE_SIZE` with transparency — not cropped sub-rectangles. That
removes `offset_x`, `offset_y`, `width`, `height` entirely. Blitting becomes a direct copy and
classification becomes `bytes[y * TILE_SIZE + x]` with no rectangle arithmetic on either side.

Storage barely moves: DEFLATE crushes runs of transparent pixels, so a sparse tile compresses to
roughly what a cropped one did. The real cost is **decoded memory — 1 MB per tile, always** — so
classifying a paint spanning three tiles holds 3 MB. Acceptable, but it bounds how large the
decoded-tile cache can grow.

Chunks are not versioned independently. A new version owns a whole tile set; if a version changes,
the affected tiles are replaced wholesale.

Index on `(tile_x, tile_y)` — the hot query is "which current-version tiles cover this tile", asked on
every paint classification and to build the manifest tile index.

**Chunk GC** is `SELECT hash FROM version_tiles` minus the R2 listing — safe only because versions
are immutable.

### `invites`

```
code_hash    text pk               -- sha256 of a 128-bit base32 code
label        text not null         -- 'discord-regulars'
scope        text not null         -- 'read' | 'report' | 'admin'
created_by   text not null
created_at_ms integer not null
revoked_at_ms integer null
```

Codes are server-generated high entropy, so SHA-256 is sufficient; no slow KDF.

### `telemetry_buckets` — exists, unchanged

```
template_id, resolution, bucket_start_s, placed, correct, repairs
primary key (template_id, resolution, bucket_start_s)
```

### `contributions` — leaderboard rollups

```
wplace_user_id  integer not null
template_id     text not null → templates.id
day_s           integer not null      -- unix seconds, floored to a day
placed, correct, repairs   integer not null
primary key (wplace_user_id, template_id, day_s)
```

```
painters
  wplace_user_id  integer pk
  display_name    text not null      -- refreshed on every report
  seen_at_ms      integer not null
```

Identity is wplace's public display form, `Cyphex #3822673` — name plus the numeric user id. Stored
as two columns rather than the composite string, so a **rename updates a label instead of orphaning
that person's entire history** under a dead key.

**Amends the payload-discipline rule**, which said the userscript never transmits wplace user ids.
The justification is that wplace displays `name#id` publicly itself, so it is not sensitive — but it
is a real relaxation and is recorded here rather than happening quietly.

### `tile_history` — the mirror timeline

```
tile_x, tile_y   integer not null
observed_at_ms   integer not null
sha256           text not null     -- R2 key tiles/{sha256}.png
reporter         text not null
primary key (tile_x, tile_y, observed_at_ms)
```

## Wire schemas (`packages/wire-schema`)

One schema per wire type, each `satisfies Schema.Schema<SharedType>`:

- `Manifest`, `ServerInfo`, `Node`, `Template`, `Chunk`

**`Chunk` in `packages/shared` needs reshaping first.** It still carries `offsetX`, `offsetY`,
`width`, `height` from the cropped-sub-rectangle model. Full tiles reduce it to `{ tile, hash }`,
which also shrinks the manifest — the single largest thing the userscript downloads.
- `PaintEvent`, `PaintTile`, `PaintPixels`
- `TileOffer`, `TileOfferResponse`
- `TemplateStatus`, `NodeStatus`, `Alarm`

Decode at every request boundary in the backend; encode on the way out. The userscript adheres
optimistically and validates nothing.

**?** `PaintPixels` has three parallel arrays with no length invariant expressible in the type. The
schema should carry a refinement asserting `x.length === y.length === colors.length`, so the one
thing TypeScript cannot express is caught at the boundary where it matters.

## Deliberately absent

- No accounts of our own. `painters` is a label cache for wplace's identity, not a user table.
- No `templates.version` integer. The version *is* `current_version_id`.
- No soft deletes yet.
