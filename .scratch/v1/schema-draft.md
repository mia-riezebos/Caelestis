# Schema draft — v1

Settled artifact for #24 and #25 as of 2026-08-03. Everything below has been reviewed and agreed.

## Package layout

```
packages/shared        TypeScript types only, zero runtime deps  → userscript, backend, frontend
packages/wire-schema   Effect Schemas, depends on shared         → backend, frontend
```

Schemas are declared to satisfy the shared types, so drift is a build error. The userscript cannot
pull Effect in because it never depends on the package that contains it.

## Canvas geometry (shared constants)

The canvas is **Web Mercator at zoom 11**: `2048 × 2048` tiles of `1000 px`, world = `2,048,000 px`.
Derived from a native `.wplace` file's lat/lng bounds — width ÷ longitude span and height ÷ latitude
span both give 2,048,000.0 exactly. Tile coordinates are therefore bounded `0..2047`, which is cheap
validation on both sides, and a 404 from the tile endpoint means an out-of-range coordinate rather
than an unpainted tile.

```
CANVAS_ZOOM  = 11
TILE_SIZE    = 1000
WORLD_TILES  = 2048          // 2 ** CANVAS_ZOOM
WORLD_PIXELS = 2_048_000     // WORLD_TILES * TILE_SIZE
```

`packages/shared` also carries the lat/lng ↔ canvas-pixel conversion, since the userscript needs it
to place templates and the backend needs it to import and export native files.

## The palette

Lives in `packages/shared` as a constant array, **ordered by wplace's own palette index** — the paint
request sends indices, not RGB, so a list without indices cannot classify a report. 59 colours are
recovered so far (`09-recon-palette`); the ordering and the free/premium split are still open.

Not a table. It is wplace's, it changes only when they change it, and a migration is the wrong tool
for a constant every layer needs at build time.

## Ingest pipeline

An upload runs: **decode → quantise → pad to tiles → encode → hash → store**.

**Quantise.** Every non-transparent pixel maps to its nearest palette colour in RGBA space. No
dithering, no threshold, no rejection — this reverses the original reject-on-nonconformance rule (see
the amendment on `01-template-storage-and-chunk-model`) because a real `.wplace` file carries ±2
per-channel deviation from a colour-management artefact upstream and would otherwise be refused
despite being correct in substance.

**Alpha.** wplace has no partial transparency. **?** Alpha ≥ 128 quantises to a palette colour; below
becomes fully transparent. Alpha is *not* folded into the distance metric — doing so would match
opaque palette entries against translucent pixels.

**Memoise by distinct colour.** Naively 4.16M pixels × 59 entries ≈ 245M comparisons for one upload,
far past any Worker CPU budget. Real images have few distinct colours (an observed file has 6,137), so
caching nearest-match per distinct colour cuts it to ~362k comparisons plus one `Map` lookup per
pixel. A fixed 5-bit LUT was the alternative and is worse: ±4 of its own error against a palette whose
closest pair is 8 apart.

**Pad to full tiles**, transparent outside the template's bounds — this is what removes offset and
size columns from `version_tiles`.

**Encode with PNG filter type 0 (None) on every scanline.** Costs a little compression ratio and buys
a trivial server-side decode path: `DecompressionStream('deflate')` is native in Workers, so reading
pixels back is inflate-then-strip-one-byte-per-row, with no WASM decoder.

**Hash** the encoded bytes with SHA-256; that is both the R2 key and the dedup identity.

### The upload response reports what it did

Since nothing is rejected any more, the response carries what the quantiser changed: share of pixels
moved, mean and max distance moved, resulting distinct-colour count. An uploader seeing "94% of pixels
moved, mean distance 31" knows they uploaded a photograph — the server just declines to decide that
for them.

## Ordering is client-side

**Draw order is not stored.** No `sort_order` on nodes or templates, and none in the manifest. The
userscript owns the whole ordering, across servers, groups and templates alike.

`sort_order` had been doing two jobs: a viewer's presentation preference, which is genuinely
client-side, and an author's layering intent — "the outline draws over the fill" — which is genuinely
the alliance's. Only the first survives.

The second is mostly moot because overlapping templates within a group are forbidden already (that
rule exists so rollups cannot double-count). What remains is cross-group overlap inside one server,
which is normally accidental rather than designed. Where it is designed, the alliance now has no way
to express it, and different members may see different results.

**?** The default order, since nothing is stored: sort by `created_at_ms`, oldest first — "the order
things were added", stable, and free from UUIDv7's ordering. Deliberately *not* manifest array order,
which would be server-side ordering smuggled back in through the ordering of a JSON array.

Consequence for `28-native-wplace-format`: a `.wplace` file's `order` field has nowhere to land on
import, and export has nothing to populate it from.

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
created_at_ms  integer not null
```

**No `sort_order`.** Draw order is a userscript setting, not server state — see *Ordering* below.

Index on `path` for prefix rollups. On rename or move, descendant paths are rewritten in one
`UPDATE ... WHERE path LIKE '<old>/%'`. Moves are rare and trees are small, so no closure table.

### `templates` — identity

```
id                  text pk
node_id             text not null → nodes.id
name                text not null
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
min_x, min_y, max_x, max_y   integer not null   -- global canvas pixels, 0..2_047_999
total_pixels  integer not null                  -- non-transparent; progress denominator
bounds_north, bounds_south, bounds_west, bounds_east   real null   -- original lat/lng, if imported
```

`bounds_*` preserve a native `.wplace` file's placement verbatim so a round trip is lossless.
Re-deriving them from canvas pixels on export would introduce floating-point drift. Null for
templates that did not come from a native file.

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

### `access_tokens`

```
token_hash    text pk               -- sha256 of a 128-bit base32 token
label         text not null         -- 'discord-regulars'
scope         text not null         -- 'read' | 'report' | 'admin'
created_by    text not null
created_at_ms integer not null
revoked_at_ms integer null
```

Tokens are server-generated high entropy, so SHA-256 is sufficient; no slow KDF.

Named `access_tokens` rather than `invites` because that is what they are: long-lived, named, scoped
and individually revocable. "Invite" implies one-time onboarding, which these never were — the whole
point of naming them is that one can be revoked without rotating everyone else's.

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

**Attribution is by `wplace_user_id`; display is by `display_name` alone.** The id is stable, so a
rename updates a label instead of orphaning that person's entire history under a dead key. wplace's
own public form is `Cyphex #3822673`, but we surface only the name.

Consequence for the frontend, not the schema: two painters sharing a display name are
indistinguishable in a leaderboard, which is exactly what wplace's `#id` suffix exists to prevent.
Attribution stays correct regardless; only the label is ambiguous.

**Amends the payload-discipline rule**, which said the userscript never transmits wplace user ids.
The justification is that wplace displays `name#id` publicly itself, so it is not sensitive — but it
is a real relaxation and is recorded here rather than happening quietly.

### `tile_history` — the mirror timeline, on a decay ladder

Same mechanism as `telemetry_buckets`, so one compaction job serves both.

```
tile_x, tile_y   integer not null
resolution_s     integer not null   -- 0 = raw observation, else the folded tier
bucket_start_s   integer not null
sha256           text not null      -- R2 key tiles/{sha256}.png
reporters        integer not null   -- distinct clients that reported this hash
primary key (tile_x, tile_y, resolution_s, bucket_start_s)
```

**Reconciled on write.** Several clients viewing the same area report the same hash; that is one row
with `reporters` incremented, not one row each. The count is what the quorum rule reads — prefer a
hash seen by two or more distinct clients — so it earns its place, unlike a per-reporter row.

**The fold is latest-wins, not sum.** A tile observation is *state*, so folding a window keeps the
last observation in it and discards the rest — the same distinction that governs `correct`/`wrong`/
`blank` versus `placed`/`repairs` in the telemetry ladder. Getting this backwards would be
meaningless here rather than merely wrong: you cannot add two hashes.

**?** Tier configuration, deliberately coarser than telemetry's. A tile observation only exists when
the tile actually changed, and each one pins a ~70–125 KB blob:

| resolution | retention |
|---|---|
| raw (`0`) | 24h |
| 1h | 7d |
| 6h | 30d |
| 1d | forever |

**Blob GC is the point.** Rows are trivial; the blobs are not. Content addressing means one hash is
referenced by many rows across time, so a blob is deletable only once **no surviving row references
it**. Thinning without that sweep saves nothing.

**What this costs:** timelapse resolution degrades with age. Yesterday plays back at every observed
change; three months ago plays back one frame per day. That is the trade being made, and it is the
right way round — recent detail is what anyone actually watches.

## Wire schemas (`packages/wire-schema`)

One schema per wire type, each `satisfies Schema.Schema<SharedType>`:

- `Manifest`, `ServerInfo`, `Node`, `Template`, `Chunk`
- `PaintEvent`, `PaintTile`, `PaintPixels`
- `TileOffer`, `TileOfferResponse`
- `TemplateStatus`, `NodeStatus`, `Alarm`

**`Chunk` in `packages/shared` needs reshaping first.** It still carries `offsetX`, `offsetY`,
`width`, `height` from the cropped-sub-rectangle model. Full tiles reduce it to `{ tile, hash }`,
which also shrinks the manifest — the single largest thing the userscript downloads.

Decode at every request boundary in the backend; encode on the way out. The userscript adheres
optimistically and validates nothing.

`PaintPixels` has three parallel arrays with no length invariant expressible in the type, so the
schema carries a refinement asserting `x.length === y.length === colors.length`. The one thing
TypeScript cannot express is caught at the boundary where the data arrives.

## Deliberately absent

- No accounts of our own. `painters` is a label cache for wplace's identity, not a user table.
- No `templates.version` integer. The version *is* `current_version_id`.
- No soft deletes yet.
