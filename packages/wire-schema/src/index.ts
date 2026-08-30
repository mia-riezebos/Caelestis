import type * as Shared from '@caelestis/shared'
import {
  MAX_TILE_OFFERS,
  PALETTE_SIZE,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  templateSurface,
  templateSurfaceBounds,
  WORLD_PIXELS,
  WORLD_TILES,
} from '@caelestis/shared'
import { Schema } from 'effect'

const MAX_IDENTIFIER_LENGTH = 64
const MAX_NAME_LENGTH = 256
const MAX_DESCRIPTION_LENGTH = 4_096
/**
 * A materialized path is a handful of group names joined by slashes, not prose. Reusing the
 * description bound made MAX_MANIFEST_NODES paths worth ~442 MB — 22x the ceiling MAX_MANIFEST_CHUNKS
 * is sized to, on an array the decoder refines only after building it. That is the same "one shared
 * round number" mistake the array caps above already had to unlearn.
 */
const MAX_PATH_LENGTH = 256
/**
 * Array caps sized from what each field actually bounds. A single shared round number was wrong
 * three separate ways: it made a >1,000-tile manifest impossible to encode, capped a paint payload
 * at a tenth of a real charge drain, and rejected an ordinary 40x30-tile template.
 */
const MAX_MANIFEST_TILES = WORLD_TILES * WORLD_TILES
const MAX_TEMPLATE_CHUNKS = MAX_MANIFEST_TILES
const MAX_MANIFEST_NODES = 100_000
/**
 * Chunks summed across every template, checked before anything flattens them.
 *
 * The per-template cap bounds no total: templates in different groups may cover the same tiles, so
 * the declared tile union stays small while the chunk arrays do not, and the manifest filters below
 * build a flatMap and several Sets over all of them.
 *
 * Sized to a payload that can actually be processed rather than to the canvas. Each chunk record is
 * a tile key and a 64-character hash, so 200,000 of them is already ~20 MB of JSON — past what a
 * manifest response should be, and far short of the 4,194,304 the per-template cap allowed.
 */
const MAX_MANIFEST_CHUNKS = 200_000
const MAX_MANIFEST_TEMPLATES = 100_000
// 09-recon-palette has not recovered Wplace's complete index order yet. Keep this permissive until
// that ticket establishes the real upper bound instead of deriving it from the incomplete palette.
const MAX_PALETTE_INDEX = 65_535

// Wide enough for every v1 timestamp while still making seconds and milliseconds disjoint.
const MIN_EPOCH_SECONDS = 1_577_836_800 // 2020-01-01
const MAX_EPOCH_SECONDS = 4_102_444_800 // 2100-01-01
const MIN_EPOCH_MILLISECONDS = MIN_EPOCH_SECONDS * 1_000
const MAX_EPOCH_MILLISECONDS = MAX_EPOCH_SECONDS * 1_000

const booleanFilter = <T>(predicate: (value: T) => boolean, message: string) =>
  Schema.makeFilter<T>(predicate, { message })

const boundedString = (maximum: number) =>
  Schema.String.pipe(Schema.check(Schema.isLengthBetween(1, maximum)))

const boundedArray = <S extends Schema.Constraint>(item: S, maximum: number) =>
  Schema.Array(item).pipe(Schema.check(Schema.isMaxLength(maximum)))

const integerBetween = (minimum: number, maximum: number) =>
  Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isBetween(
        { minimum, maximum },
        {
          message: `must be a safe integer between ${minimum} and ${maximum}`,
        },
      ),
    ),
  )

const NonNegativeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
)

/**
 * Seasons are zero-based: Wplace's first and current canvas is season 0.
 */
const Season = NonNegativeInteger

const Identifier = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, {
      message: 'must be a canonical lowercase UUIDv7',
    }),
  ),
)
const VersionToken = boundedString(MAX_IDENTIFIER_LENGTH)
const Name = boundedString(MAX_NAME_LENGTH)
const Description = boundedString(MAX_DESCRIPTION_LENGTH)
const Hash = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[0-9a-f]{64}$/, {
      message: 'must be a lowercase SHA-256 hex digest',
    }),
  ),
)

const Seconds = Schema.declare<Shared.Seconds>(
  (value): value is Shared.Seconds =>
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_EPOCH_SECONDS &&
    value < MAX_EPOCH_SECONDS,
  { description: 'a plausible Unix timestamp in seconds' },
)

const Millis = Schema.declare<Shared.Millis>(
  (value): value is Shared.Millis =>
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_EPOCH_MILLISECONDS &&
    value < MAX_EPOCH_MILLISECONDS,
  { description: 'a plausible Unix timestamp in milliseconds' },
)

const isWorldTileKey = (value: unknown): value is Shared.TileKey => {
  if (typeof value !== 'string') return false
  const match = /^(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(value)
  if (match === null) return false
  const x = Number(match[1])
  const y = Number(match[2])
  return x < WORLD_TILES && y < WORLD_TILES
}

const TileKey = Schema.declare<Shared.TileKey>(isWorldTileKey, {
  description: `a canonical tile key with coordinates from 0 to ${WORLD_TILES - 1}`,
})

const SurfaceChunkKey = Schema.declare<Shared.SurfaceChunkKey>(
  (value): value is Shared.SurfaceChunkKey => {
    if (typeof value !== 'string') return false
    const match = /^(0|-?[1-9]\d*)\/(0|-?[1-9]\d*)$/.exec(value)
    if (match === null) return false
    return Number.isSafeInteger(Number(match[1])) && Number.isSafeInteger(Number(match[2]))
  },
  { description: 'a canonical signed chunk-grid key' },
)

const TemplateSurface = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(['world']), allianceId: Schema.Null }),
  Schema.Struct({
    kind: Schema.Literals(['alliance-headquarters', 'alliance-picture', 'alliance-banner']),
    allianceId: NonNegativeInteger.pipe(Schema.check(Schema.isGreaterThan(0))),
  }),
])

const BoundingBoxStruct = Schema.Struct({
  minX: integerBetween(0, WORLD_PIXELS - 1),
  // Redundant, like maxY below: `minY < maxY <= WORLD_PIXELS` already implies it. Stated for
  // symmetry with min_y's SQL CHECK.
  minY: integerBetween(0, WORLD_PIXELS - 1),
  // The exclusive end runs 1..WORLD_PIXELS, not 0..WORLD_PIXELS. A span ending exactly on the seam
  // is WORLD_PIXELS; allowing 0 as well would give that one span two encodings that compare
  // unequal, and the SQL CHECK on template_versions.max_x only accepts one of them — so a bbox the
  // wire admitted would fail to persist. One representation, agreed on both sides.
  maxX: integerBetween(1, WORLD_PIXELS),
  // Stated for symmetry with the SQL CHECK; the `minY < maxY` filter below already implies it,
  // since minY cannot be negative.
  maxY: integerBetween(1, WORLD_PIXELS),
})

/**
 * The canvas wraps in x and does not in y. `minX > maxX` therefore means "spans the antimeridian",
 * which is legal and which consumers must read as two ranges. `minY > maxY` has no such meaning:
 * Mercator clamps at the poles, so there is nothing to wrap through.
 *
 * Zero-width and zero-height are rejected either way — a template covering no pixels is not a
 * placement, and `maxX == minX` cannot be distinguished from a full-canvas wrap.
 */
const BoundingBox = BoundingBoxStruct.pipe(
  Schema.check(
    booleanFilter(
      (bbox: Schema.Schema.Type<typeof BoundingBoxStruct>) =>
        bbox.minX !== bbox.maxX && bbox.minY < bbox.maxY,
      'y must run low to high; x may wrap through zero but must span at least one pixel',
    ),
  ),
)

export const ServerInfo = Schema.Struct({
  id: Identifier,
  name: Name,
  description: Schema.optionalKey(Description),
  auth: Schema.Literals(['none', 'access_token']),
  liveSync: Schema.optionalKey(Schema.Literal(1)),
})

/**
 * A materialized group path: a leading slash and at least one segment.
 *
 * `%` and `_` are excluded because this value is the subtree-rewrite key. The documented move is
 * a prefix match on `<old>/`, and were that written as a LIKE — as it was — `%` matches any run and `_` matches
 * any single character — so a node created as `/canada%` rewrites every sibling subtree when it
 * moves, and `/%` captures the whole tree. Callers should still pass ESCAPE; excluding the two
 * metacharacters means a missing ESCAPE cannot be exploited from the wire.
 *
 * Segments accept Unicode letters, digits and combining marks. An earlier ASCII-only pattern
 * rejected `/québec`, which D1 stores happily — alliances are not all anglophone, and the
 * restriction bought nothing that excluding the two metacharacters does not already buy.
 *
 * Marks are the same argument one category further out: Devanagari writes its vowels as separate
 * mark codepoints, so `/हिंदी` had no representation at all, and any name can arrive decomposed —
 * `café` as `cafe` plus U+0301 is what a macOS client sends. A segment cannot *open* with a mark,
 * which is the rule the pattern actually states: the class admits one anywhere after the first
 * character, including after a dot, space or hyphen. Neither LIKE metacharacter is a mark.
 */
/**
 * Fold a node path the way the database does, so the wire agrees with what D1 can actually store.
 *
 * SQLite's `lower()` and `LIKE` fold ASCII only, and `nodes_path_idx` is a unique index on
 * `lower(path)`. JavaScript's `toLowerCase` folds all of Unicode, which is stricter in exactly the
 * wrong direction: `/QUÉBEC` and `/québec` collide here while D1 stores both, and the manifest
 * endpoint could not emit a decodable manifest for its own stored state — a permanent failure on
 * legitimate rows, fixable only by editing the database.
 *
 * Nothing is lost by matching: É and é are distinct to `LIKE`, so a subtree move over one cannot
 * capture the other, which is the collision the case rule exists to prevent.
 */
const foldPath = (path: string): string => path.replace(/[A-Z]/g, (c) => c.toLowerCase())

const NodePath = Schema.String.pipe(
  Schema.check(
    Schema.isLengthBetween(1, MAX_PATH_LENGTH),
    Schema.isPattern(/^(\/[\p{L}\p{N}][\p{L}\p{N}\p{M}. -]*)+$/u, {
      description: 'a slash-separated group path without LIKE metacharacters',
    }),
  ),
)

export const Node = Schema.Struct({
  id: Identifier,
  parentId: Schema.NullOr(Identifier),
  path: NodePath,
  name: Name,
  description: Schema.optionalKey(Description),
  createdAt: Millis,
})

export const Chunk = Schema.Struct({
  tile: TileKey,
  hash: Hash,
})

export const Template = Schema.Struct({
  id: Identifier,
  nodeId: Schema.NullOr(Identifier),
  name: Name,
  version: Identifier,
  bbox: BoundingBox,
  totalPixels: NonNegativeInteger,
  chunks: boundedArray(Chunk, MAX_TEMPLATE_CHUNKS),
  published: Schema.Boolean,
  finished: Schema.Boolean,
  finishedAt: Schema.NullOr(Millis),
  timelapseFrozen: Schema.Boolean,
  createdAt: Millis,
  /**
   * When anything last changed, including things that leave the chunks alone.
   *
   * Not redundant with `version`: renaming a template or moving it to another node keeps every
   * chunk exactly where it was, so the version is unchanged and a client watching only that would
   * never re-read the name.
   */
  updatedAt: Millis,
})

const SurfaceBoundingBox = Schema.Struct({
  minX: integerBetween(-WORLD_PIXELS, WORLD_PIXELS),
  minY: integerBetween(-WORLD_PIXELS, WORLD_PIXELS),
  maxX: integerBetween(-WORLD_PIXELS, WORLD_PIXELS),
  maxY: integerBetween(-WORLD_PIXELS, WORLD_PIXELS),
})

const SurfaceChunk = Schema.Struct({
  tile: SurfaceChunkKey,
  hash: Hash,
})

const SurfaceTemplate = Schema.Struct({
  id: Identifier,
  nodeId: Schema.NullOr(Identifier),
  name: Name,
  version: Identifier,
  bbox: SurfaceBoundingBox,
  totalPixels: NonNegativeInteger,
  chunks: boundedArray(SurfaceChunk, MAX_TEMPLATE_CHUNKS),
  published: Schema.Boolean,
  finished: Schema.Boolean,
  finishedAt: Schema.NullOr(Millis),
  timelapseFrozen: Schema.Boolean,
  createdAt: Millis,
  updatedAt: Millis,
})

const ManifestStruct = Schema.Struct({
  version: VersionToken,
  season: Season,
  surface: Schema.optionalKey(TemplateSurface),
  server: ServerInfo,
  nodes: boundedArray(Node, MAX_MANIFEST_NODES),
  templates: boundedArray(SurfaceTemplate, MAX_MANIFEST_TEMPLATES),
  tiles: boundedArray(SurfaceChunkKey, MAX_MANIFEST_TILES),
})

/** Split a validated tile key back into its coordinates. */
const parseTile = (tile: string): { x: number; y: number } => {
  const separator = tile.indexOf('/')
  return { x: Number(tile.slice(0, separator)), y: Number(tile.slice(separator + 1)) }
}

/** One non-wrapping x span of a template's bounding box. */
type XSpan = {
  readonly start: number
  readonly end: number
}

/**
 * x wraps, so a bounding box with minX > maxX spans the antimeridian and covers TWO x ranges.
 * Splitting into non-wrapping spans first makes every later comparison ordinary.
 */
const xSpans = (template: Schema.Schema.Type<typeof SurfaceTemplate>, wraps: boolean): XSpan[] => {
  const { minX, maxX } = template.bbox
  return minX < maxX || !wraps
    ? [{ start: minX, end: maxX }]
    : [
        { start: minX, end: WORLD_PIXELS },
        { start: 0, end: maxX },
      ]
}

/**
 * Templates within a group may overlap, deliberately.
 *
 * An earlier version of this schema refused it, and carried a sort-and-sweep to detect it. That was
 * a rule the product does not have: overlapping templates are how a group layers, and the client's
 * own custom ordering decides what draws on top. Enforcing it here meant a server could assemble —
 * from two ordinary uploads into one group — a manifest that every client then refused to decode.
 *
 * Removed rather than relaxed. A constraint the domain does not want is not worth the sweep, its
 * property test, or the next reader wondering which of the two rules is the real one.
 */

export const Manifest = ManifestStruct.pipe(
  Schema.check(
    booleanFilter((manifest: Schema.Schema.Type<typeof ManifestStruct>) => {
      const surface = templateSurface(
        manifest.surface?.kind ?? 'world',
        manifest.surface?.allianceId ?? null,
      )
      if (surface === null) return false
      const bounds = templateSurfaceBounds(surface)
      return manifest.templates.every((template) => {
        const { minX, minY, maxX, maxY } = template.bbox
        if (surface.kind === 'world') {
          if (
            minX < 0 ||
            minX >= WORLD_PIXELS ||
            minY < 0 ||
            minY >= WORLD_PIXELS ||
            maxX < 1 ||
            maxX > WORLD_PIXELS ||
            maxY < 1 ||
            maxY > WORLD_PIXELS ||
            minX === maxX ||
            minY >= maxY
          ) {
            return false
          }
          return template.chunks.every(({ tile }) => isWorldTileKey(tile))
        }
        if (bounds === null) return false
        return (
          minX >= bounds.minX &&
          minY >= bounds.minY &&
          maxX <= bounds.maxX &&
          maxY <= bounds.maxY &&
          minX < maxX &&
          minY < maxY
        )
      })
    }, 'template bounds and chunk keys must belong to the selected drawing surface'),
    booleanFilter(
      (manifest: Schema.Schema.Type<typeof ManifestStruct>) =>
        // Ahead of every filter that flattens chunks, so an oversized manifest is refused before
        // anything materialises an array or a Set over them.
        manifest.templates.reduce((total, template) => total + template.chunks.length, 0) <=
        MAX_MANIFEST_CHUNKS,
      `a manifest may carry at most ${MAX_MANIFEST_CHUNKS} chunks in total`,
    ),
    booleanFilter((manifest: Schema.Schema.Type<typeof ManifestStruct>) => {
      // Declared tiles are the union of chunk tiles, so there can never be more of them than there
      // are chunks. Checking that first bounds this filter by MAX_MANIFEST_CHUNKS rather than by
      // MAX_MANIFEST_TILES, which is the whole canvas — 4,194,304 keys built into two Sets before
      // the equality below could reject them. Cheap, and it makes the same short-circuit the chunk
      // cap above documents true of tiles as well.
      const totalChunks = manifest.templates.reduce(
        (total, template) => total + template.chunks.length,
        0,
      )
      if (manifest.tiles.length > totalChunks) return false
      const declaredTiles = new Set(manifest.tiles)
      const referencedTiles = new Set(
        manifest.templates.flatMap((template) => template.chunks.map((chunk) => chunk.tile)),
      )
      return (
        declaredTiles.size === manifest.tiles.length &&
        declaredTiles.size === referencedTiles.size &&
        [...referencedTiles].every((tile) => declaredTiles.has(tile))
      )
    }, 'tiles must be the unique union of all template chunk tiles'),
    booleanFilter((manifest: Schema.Schema.Type<typeof ManifestStruct>) => {
      const nodeIds = new Set(manifest.nodes.map((node) => node.id))
      const templateIds = new Set(manifest.templates.map((template) => template.id))
      return (
        nodeIds.size === manifest.nodes.length &&
        templateIds.size === manifest.templates.length &&
        manifest.templates.every(
          (template) => template.nodeId === null || nodeIds.has(template.nodeId),
        )
      )
      // Parent references are not checked here. The path rule below resolves each parent to look up
      // its path, so a dangling parentId already fails there — a conjunct here would be unreachable
      // and no test could pin it.
    }, 'node and template ids must be unique and every non-root template must name a node that exists'),
    booleanFilter(
      (manifest: Schema.Schema.Type<typeof ManifestStruct>) =>
        manifest.templates.every(
          (template) =>
            new Set(template.chunks.map((chunk) => chunk.tile)).size === template.chunks.length,
        ),
      'a template may contain at most one chunk for each tile',
    ),
    booleanFilter((manifest: Schema.Schema.Type<typeof ManifestStruct>) => {
      // Paths are the prefix-rollup key, so two nodes sharing one path make a rollup attribute one
      // group's templates to another. parent_id and path must also describe the same hierarchy: a
      // child of /canada carrying /usa/x rolls up under a group it does not belong to.
      // Compare paths to paths. Deriving the set from an id-keyed Map instead would collapse
      // duplicate ids and reject them here, which silently subsumes the id rule above and leaves it
      // deletable — each filter should fail for its own reason.
      //
      // Case-insensitively, because SQLite's LIKE is ASCII-case-insensitive by default: with both
      // /Canada and /canada stored, moving either one rewrites the other's subtree as well. Two
      // paths differing only in case cannot coexist.
      const paths = manifest.nodes.map((node) => foldPath(node.path))
      if (new Set(paths).size !== paths.length) return false
      const pathById = new Map(manifest.nodes.map((node) => [node.id, foldPath(node.path)]))
      return manifest.nodes.every((node) => {
        if (node.parentId === null) return node.path.indexOf('/', 1) === -1
        const parentPath = pathById.get(node.parentId)
        if (parentPath === undefined) return false
        // Under the parent at all: slicing at the parent's length without comparing the prefix
        // reads /norway/x as a child of /canada, because the suffix it produces — '/x' — has
        // exactly the shape the segment test below expects.
        //
        // Immediate child, not merely a descendant: `startsWith` alone accepts /a/b/c under /a,
        // which claims a level of hierarchy the manifest never declares a node for, so a rollup
        // over /a/b finds nothing while /a/b/c's templates sit below it.
        const path = foldPath(node.path)
        if (!path.startsWith(parentPath)) return false
        const suffix = path.slice(parentPath.length)
        return suffix.startsWith('/') && suffix.indexOf('/', 1) === -1
      })
      // This also makes the hierarchy acyclic, so no separate cycle check is needed: a non-root
      // path strictly extends its parent's, so walking up strictly shortens the path and must
      // terminate at a root. A cycle check here would be unreachable and could not be tested.
    }, 'every node path must be unique and sit directly under its parent'),
    booleanFilter(
      (manifest: Schema.Schema.Type<typeof ManifestStruct>) =>
        manifest.templates.every((template) => {
          // totalPixels is the denominator of every progress figure for this template, so zero
          // makes them NaN or a division by zero. A template that covers a box and declares chunks
          // has painted something; one that has not is not a published template.
          if (template.totalPixels === 0 || template.chunks.length === 0) return false
          // A painted pixel is inside the bounding box and inside a declared chunk, so the ceiling
          // is where the two meet — the chunk tiles clipped to the box, summed. Bounding by the box
          // alone let one chunk of a 1001x1001 box carry a million pixels where it can hold one;
          // bounding by `chunks.length * TILE_SIZE^2` let the same manifest through from the other
          // side. Either way a denominator far above the largest possible numerator pins progress
          // near zero forever. This is tighter than both and replaces them: distinct tiles clipped
          // to the box can never sum past the box's own area.
          //
          // Summed over x spans because a wrapped box is two disjoint ranges and a row of chunks
          // can meet both, at opposite ends of the canvas.
          const spans = xSpans(template, (manifest.surface?.kind ?? 'world') === 'world')
          const capacity = template.chunks.reduce((total, chunk) => {
            const { x, y } = parseTile(chunk.tile)
            const tileMinX = x * TILE_SIZE
            const tileMinY = y * TILE_SIZE
            const height =
              Math.min(tileMinY + TILE_SIZE, template.bbox.maxY) -
              Math.max(tileMinY, template.bbox.minY)
            if (height <= 0) return total
            const width = spans.reduce(
              (spanned, span) =>
                spanned +
                Math.max(
                  0,
                  Math.min(tileMinX + TILE_SIZE, span.end) - Math.max(tileMinX, span.start),
                ),
              0,
            )
            return total + width * height
          }, 0)
          return template.totalPixels <= capacity
        }),
      'a template total pixel count must fit where its chunks meet its bounding box',
    ),
    booleanFilter(
      (manifest: Schema.Schema.Type<typeof ManifestStruct>) =>
        manifest.templates.every((template) => {
          // A chunk is a full tile of painted pixels, so a chunk outside the box that declares the
          // template's extent is a contradiction: culling watches the bbox tiles and would never
          // fetch it, or would render it in the wrong place.
          const spans = xSpans(template, (manifest.surface?.kind ?? 'world') === 'world')
          return template.chunks.every((chunk) => {
            const { x, y } = parseTile(chunk.tile)
            const tileMinX = x * TILE_SIZE
            const tileMinY = y * TILE_SIZE
            if (tileMinY + TILE_SIZE <= template.bbox.minY || tileMinY >= template.bbox.maxY) {
              return false
            }
            return spans.some((span) => tileMinX < span.end && span.start < tileMinX + TILE_SIZE)
          })
        }),
      'every chunk tile must intersect its template bounding box',
    ),
  ),
)

const TileLocalCoordinate = integerBetween(0, TILE_SIZE - 1)
const PaletteIndex = integerBetween(0, MAX_PALETTE_INDEX)

const PaintPixelsStruct = Schema.Struct({
  x: Schema.Array(TileLocalCoordinate),
  y: Schema.Array(TileLocalCoordinate),
  colors: Schema.Array(PaletteIndex),
})

export const PaintPixels = PaintPixelsStruct.pipe(
  Schema.check(
    booleanFilter(
      (pixels: Schema.Schema.Type<typeof PaintPixelsStruct>) =>
        pixels.x.length === pixels.y.length && pixels.y.length === pixels.colors.length,
      'x, y and colors must have equal lengths',
    ),
    /**
     * A coordinate may appear once. `submitted` is derived by counting these entries, and equal
     * `painted`/`submitted` means "classify and credit them all" — so without this a reporter
     * claims one on-template pixel many times and is credited for every repeat. The same
     * anti-double-count rule is already enforced on the server-authored side, for
     * chunks within a template and for overlapping templates within a group; this is the
     * client-authored side of it.
     *
     * Colour is deliberately not part of the key: two different colours claimed for one coordinate
     * are contradictory, not additive, and must not both be credited.
     */
    booleanFilter((pixels: Schema.Schema.Type<typeof PaintPixelsStruct>) => {
      const seen = new Set<number>()
      for (let index = 0; index < pixels.x.length; index += 1) {
        // Pack into one number rather than a string key. Both coordinates are bounded by TILE_SIZE,
        // so this stays exact and allocation-free.
        seen.add((pixels.x[index] ?? 0) * TILE_SIZE + (pixels.y[index] ?? 0))
      }
      return seen.size === pixels.x.length
    }, 'each pixel coordinate may be submitted once'),
  ),
)

export const PaintTile = Schema.Struct({
  x: integerBetween(0, WORLD_TILES - 1),
  y: integerBetween(0, WORLD_TILES - 1),
  pixels: PaintPixels,
})

const PaintEventStruct = Schema.Struct({
  eventId: Identifier,
  wplaceUserId: NonNegativeInteger,
  displayName: Name,
  season: Season,
  ts: Seconds,
  tiles: Schema.Array(PaintTile),
  painted: Schema.NullOr(NonNegativeInteger),
})

export const PaintEvent = PaintEventStruct.pipe(
  Schema.check(
    booleanFilter(
      (event: Schema.Schema.Type<typeof PaintEventStruct>) =>
        event.tiles.every((tile) => tile.pixels.x.length > 0),
      'every submitted tile must carry at least one pixel',
    ),
    // Per-tile uniqueness is not enough on its own: repeating the whole tile entry reaches the same
    // canvas coordinates again, and `submitted` counts each entry.
    booleanFilter(
      (event: Schema.Schema.Type<typeof PaintEventStruct>) =>
        new Set(event.tiles.map((tile) => tile.x * WORLD_TILES + tile.y)).size ===
        event.tiles.length,
      'each tile may appear once per event',
    ),
    booleanFilter((event: Schema.Schema.Type<typeof PaintEventStruct>) => {
      const submitted = event.tiles.reduce((total, tile) => total + tile.pixels.x.length, 0)
      return (
        Number.isSafeInteger(submitted) && (event.painted === null || event.painted <= submitted)
      )
    }, 'painted must not exceed the submitted pixels'),
  ),
)

export const TileOffer = Schema.Struct({
  tile: TileKey,
  sha256: Hash,
  ts: Seconds,
})

export const TileOfferBatch = Schema.Struct({
  wplaceUserId: NonNegativeInteger,
  displayName: Name,
  season: Season,
  offers: boundedArray(TileOffer, MAX_TILE_OFFERS),
})

const TemplateStatusStruct = Schema.Struct({
  templateId: Identifier,
  correct: NonNegativeInteger,
  wrong: NonNegativeInteger,
  blank: NonNegativeInteger,
  total: NonNegativeInteger,
  colours: Schema.optionalKey(
    boundedArray(
      Schema.Struct({
        index: integerBetween(0, TRANSPARENT_INDEX - 1),
        correct: NonNegativeInteger,
        wrong: NonNegativeInteger,
        blank: NonNegativeInteger,
        total: NonNegativeInteger,
      }),
      PALETTE_SIZE,
    ),
  ),
  observedAt: Millis,
})

export const TemplateStatus: Schema.Codec<Shared.TemplateStatus> = TemplateStatusStruct.pipe(
  Schema.check(
    booleanFilter((status: Schema.Schema.Type<typeof TemplateStatusStruct>) => {
      if (status.correct + status.wrong + status.blank > status.total) return false
      if (status.colours === undefined) return true
      const unique = new Set(status.colours.map((colour) => colour.index))
      return (
        unique.size === status.colours.length &&
        status.colours.every(
          (colour) =>
            colour.total > 0 && colour.correct + colour.wrong + colour.blank <= colour.total,
        ) &&
        status.colours.reduce((sum, colour) => sum + colour.correct, 0) === status.correct &&
        status.colours.reduce((sum, colour) => sum + colour.wrong, 0) === status.wrong &&
        status.colours.reduce((sum, colour) => sum + colour.blank, 0) === status.blank &&
        status.colours.reduce((sum, colour) => sum + colour.total, 0) === status.total
      )
    }, 'classification counts must fit the total; colour rows must be unique and partition it'),
  ),
)

export const StatusDelta: Schema.Codec<Shared.StatusDelta> = Schema.Struct({
  baseRevision: NonNegativeInteger,
  revision: NonNegativeInteger,
  templates: boundedArray(TemplateStatus, MAX_MANIFEST_TEMPLATES),
  removedTemplateIds: boundedArray(Identifier, MAX_MANIFEST_TEMPLATES),
}).pipe(
  Schema.check(
    booleanFilter(
      (delta) =>
        delta.revision >= delta.baseRevision &&
        new Set(delta.templates.map((status) => status.templateId)).size ===
          delta.templates.length &&
        new Set(delta.removedTemplateIds).size === delta.removedTemplateIds.length &&
        delta.templates.every((status) => !delta.removedTemplateIds.includes(status.templateId)),
      'status delta revisions must be ordered and template ids must be unique',
    ),
  ),
)

export const TileOfferResponse: Schema.Codec<Shared.TileOfferResponse> = Schema.Struct({
  wanted: boundedArray(TileKey, MAX_MANIFEST_TILES),
  acknowledged: Schema.optionalKey(boundedArray(TileKey, MAX_MANIFEST_TILES)),
  rejected: Schema.optionalKey(boundedArray(TileKey, MAX_MANIFEST_TILES)),
  status: Schema.optionalKey(StatusDelta),
})

export const TileUploadResponse: Schema.Codec<Shared.TileUploadResponse> = Schema.Struct({
  status: Schema.optionalKey(StatusDelta),
})

const NodeStatusStruct = Schema.Struct({
  nodeId: Identifier,
  correct: NonNegativeInteger,
  total: NonNegativeInteger,
  templatesComplete: NonNegativeInteger,
  templatesTotal: NonNegativeInteger,
  observedAt: Millis,
})

export const NodeStatus = NodeStatusStruct.pipe(
  Schema.check(
    booleanFilter(
      (status: Schema.Schema.Type<typeof NodeStatusStruct>) =>
        status.correct <= status.total && status.templatesComplete <= status.templatesTotal,
      'correct and complete counts must not exceed their totals',
    ),
  ),
)

export const StatusResponse = Schema.Struct({
  revision: Schema.optionalKey(NonNegativeInteger),
  templates: boundedArray(TemplateStatus, MAX_MANIFEST_TEMPLATES),
})

/**
 * Sized like MAX_MANIFEST_CHUNKS: to a payload that can be processed, not to what the tables could
 * hold. 90 templates at minute resolution is ~130,000 buckets per day, so this admits a full day of
 * the widest legal query with headroom while refusing the multi-week minute-resolution pull that
 * should have asked a coarser tier.
 */
const MAX_HISTORY_BUCKETS = 200_000
/** Painters × templates × days; an alliance-season at dashboard scale, not a canvas-sized bound. */
const MAX_CONTRIBUTION_DAYS = 100_000
/** The route clamps `limit` to 200, so anything larger is not a response this server produced. */
const MAX_LEADERBOARD_ENTRIES = 200
/** Only observed tiles have rows and reporters only observe template-covered tiles — thousands,
 * not the canvas's four million. */
const MAX_CANVAS_TILES = 100_000
/** One frame per bucket: a year of raw per-report frames at one a minute stays under this. */
const MAX_TILE_HISTORY_FRAMES = 600_000

/**
 * Stated as a filter over `number` rather than `Schema.Literals`, so the decoded type stays the
 * plain `number` the shared `HistoryBucket` declares while the value domain stays the ladder.
 */
const LadderResolution = Schema.Number.pipe(
  Schema.check(
    booleanFilter(
      (resolution: number) => [60, 300, 900, 3_600, 21_600].includes(resolution),
      'resolution must be a decay-ladder tier',
    ),
  ),
)

/** UTC midnight: a day bucket is the floor of a report time to 86400, like `contributions.day_s`. */
const DaySeconds = Seconds.pipe(
  Schema.check(
    booleanFilter((day: Shared.Seconds) => day % 86_400 === 0, 'a day must be a UTC midnight'),
  ),
)

const orderedCounters = <
  T extends { readonly placed: number; readonly correct: number; readonly repairs: number },
>(
  value: T,
): boolean => value.repairs <= value.correct && value.correct <= value.placed

const HistoryBucketStruct = Schema.Struct({
  templateId: Identifier,
  resolution: LadderResolution,
  bucketStart: Seconds,
  placed: NonNegativeInteger,
  correct: NonNegativeInteger,
  repairs: NonNegativeInteger,
})

export const HistoryBucket = HistoryBucketStruct.pipe(
  Schema.check(
    booleanFilter(
      (bucket: Schema.Schema.Type<typeof HistoryBucketStruct>) =>
        bucket.bucketStart % bucket.resolution === 0 && orderedCounters(bucket),
      'bucketStart must align to the resolution and counters must satisfy repairs <= correct <= placed',
    ),
  ),
)

const HistoryResponseStruct = Schema.Struct({
  resolution: Schema.optionalKey(LadderResolution),
  coverageStart: Schema.optionalKey(Seconds),
  buckets: boundedArray(HistoryBucket, MAX_HISTORY_BUCKETS),
})

export const HistoryResponse = HistoryResponseStruct.pipe(
  Schema.check(
    booleanFilter((response: Schema.Schema.Type<typeof HistoryResponseStruct>) => {
      if (response.resolution === undefined || response.coverageStart === undefined) {
        return response.resolution === undefined && response.coverageStart === undefined
      }
      return response.coverageStart % response.resolution === 0
    }, 'resolution and coverageStart must appear together and the boundary must align to the resolution'),
  ),
)

const ContributionDayStruct = Schema.Struct({
  templateId: Identifier,
  day: DaySeconds,
  wplaceUserId: NonNegativeInteger,
  /** Never empty: a painter with no `painters` row is served their id as a string. */
  displayName: Name,
  placed: NonNegativeInteger,
  correct: NonNegativeInteger,
  repairs: NonNegativeInteger,
})

export const ContributionDay = ContributionDayStruct.pipe(
  Schema.check(
    booleanFilter(orderedCounters, 'counters must satisfy repairs <= correct <= placed'),
  ),
)

const ContributionsResponseStruct = Schema.Struct({
  days: boundedArray(ContributionDay, MAX_CONTRIBUTION_DAYS),
})

export const ContributionsResponse = ContributionsResponseStruct.pipe(
  Schema.check(
    booleanFilter(
      (response: Schema.Schema.Type<typeof ContributionsResponseStruct>) =>
        new Set(
          response.days.map((entry) => `${entry.templateId}/${entry.day}/${entry.wplaceUserId}`),
        ).size === response.days.length,
      'one row per painter, template and day — reporter rows must be reduced before serving',
    ),
  ),
)

const LeaderboardEntryStruct = Schema.Struct({
  wplaceUserId: NonNegativeInteger,
  displayName: Name,
  placed: NonNegativeInteger,
  correct: NonNegativeInteger,
  repairs: NonNegativeInteger,
  activeDays: NonNegativeInteger,
  lastDay: DaySeconds,
})

export const LeaderboardEntry = LeaderboardEntryStruct.pipe(
  Schema.check(
    booleanFilter(
      (entry: Schema.Schema.Type<typeof LeaderboardEntryStruct>) =>
        orderedCounters(entry) && entry.activeDays >= 1,
      'counters must satisfy repairs <= correct <= placed and an entry needs at least one active day',
    ),
  ),
)

const LeaderboardResponseStruct = Schema.Struct({
  entries: boundedArray(LeaderboardEntry, MAX_LEADERBOARD_ENTRIES),
})

export const LeaderboardResponse = LeaderboardResponseStruct.pipe(
  Schema.check(
    booleanFilter((response: Schema.Schema.Type<typeof LeaderboardResponseStruct>) => {
      const users = new Set(response.entries.map((entry) => entry.wplaceUserId))
      if (users.size !== response.entries.length) return false
      return response.entries.every(
        (entry, index) =>
          index === 0 ||
          // biome-ignore lint/style/noNonNullAssertion: index > 0 keeps it inside the array
          response.entries[index - 1]!.correct > entry.correct ||
          // biome-ignore lint/style/noNonNullAssertion: index > 0 keeps it inside the array
          (response.entries[index - 1]!.correct === entry.correct &&
            // biome-ignore lint/style/noNonNullAssertion: index > 0 keeps it inside the array
            response.entries[index - 1]!.placed >= entry.placed),
      )
    }, 'entries must be unique per painter and sorted by correct then placed, descending'),
  ),
)

export const CanvasTileSummary = Schema.Struct({
  tile: TileKey,
  hash: Hash,
  observedAt: Millis,
})

const CanvasTilesResponseStruct = Schema.Struct({
  tiles: boundedArray(CanvasTileSummary, MAX_CANVAS_TILES),
})

export const CanvasTilesResponse = CanvasTilesResponseStruct.pipe(
  Schema.check(
    booleanFilter(
      (response: Schema.Schema.Type<typeof CanvasTilesResponseStruct>) =>
        new Set(response.tiles.map((entry) => entry.tile)).size === response.tiles.length,
      'a season holds one current observation per tile',
    ),
  ),
)

const TileHistoryFrameStruct = Schema.Struct({
  bucketStart: Seconds,
  hash: Hash,
  reporters: NonNegativeInteger,
})

export const TileHistoryFrame = TileHistoryFrameStruct.pipe(
  Schema.check(
    booleanFilter(
      (frame: Schema.Schema.Type<typeof TileHistoryFrameStruct>) => frame.reporters >= 1,
      'a frame nobody reported is not an observation',
    ),
  ),
)

const TileHistoryResponseStruct = Schema.Struct({
  frames: boundedArray(TileHistoryFrame, MAX_TILE_HISTORY_FRAMES),
})

export const TileHistoryResponse = TileHistoryResponseStruct.pipe(
  Schema.check(
    booleanFilter(
      (response: Schema.Schema.Type<typeof TileHistoryResponseStruct>) =>
        response.frames.every(
          (frame, index) =>
            // biome-ignore lint/style/noNonNullAssertion: index > 0 keeps it inside the array
            index === 0 || response.frames[index - 1]!.bucketStart < frame.bucketStart,
        ),
      'frames must be strictly ascending by bucket start — one winning hash per bucket',
    ),
  ),
)

const AlarmStruct = Schema.Struct({
  id: Identifier,
  templateId: Identifier,
  kind: Schema.Literals(['regression', 'sustained-griefing']),
  pixelsLost: NonNegativeInteger,
  firstSeen: Millis,
  lastSeen: Millis,
})

export const Alarm = AlarmStruct.pipe(
  Schema.check(
    booleanFilter(
      (alarm: Schema.Schema.Type<typeof AlarmStruct>) => alarm.firstSeen <= alarm.lastSeen,
      'an alarm may not end before it began',
    ),
  ),
)

export const AlarmsResponse = Schema.Struct({
  alarms: boundedArray(Alarm, MAX_MANIFEST_TEMPLATES),
})

type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false

const assertExact = <_T extends true>(): void => {}

assertExact<Exact<Schema.Schema.Type<typeof BoundingBox>, Shared.BoundingBox>>()
assertExact<Exact<Schema.Schema.Type<typeof ServerInfo>, Shared.ServerInfo>>()
assertExact<Exact<Schema.Schema.Type<typeof Node>, Shared.Node>>()
assertExact<Exact<Schema.Schema.Type<typeof Chunk>, Shared.Chunk>>()
assertExact<Exact<Schema.Schema.Type<typeof Template>, Shared.Template>>()
assertExact<Exact<Schema.Schema.Type<typeof Manifest>, Shared.Manifest>>()
assertExact<Exact<Schema.Schema.Type<typeof PaintPixels>, Shared.PaintPixels>>()
assertExact<Exact<Schema.Schema.Type<typeof PaintTile>, Shared.PaintTile>>()
assertExact<Exact<Schema.Schema.Type<typeof PaintEvent>, Shared.PaintEvent>>()
assertExact<Exact<Schema.Schema.Type<typeof TileOffer>, Shared.TileOffer>>()
assertExact<Exact<Schema.Schema.Type<typeof TileOfferResponse>, Shared.TileOfferResponse>>()
assertExact<Exact<Schema.Schema.Type<typeof TileUploadResponse>, Shared.TileUploadResponse>>()
assertExact<Exact<Schema.Schema.Type<typeof TileOfferBatch>, Shared.TileOfferBatch>>()
assertExact<Exact<Schema.Schema.Type<typeof TemplateStatus>, Shared.TemplateStatus>>()
assertExact<Exact<Schema.Schema.Type<typeof StatusDelta>, Shared.StatusDelta>>()
assertExact<Exact<Schema.Schema.Type<typeof NodeStatus>, Shared.NodeStatus>>()
assertExact<Exact<Schema.Schema.Type<typeof StatusResponse>, Shared.StatusResponse>>()
assertExact<Exact<Schema.Schema.Type<typeof HistoryBucket>, Shared.HistoryBucket>>()
assertExact<Exact<Schema.Schema.Type<typeof HistoryResponse>, Shared.HistoryResponse>>()
assertExact<Exact<Schema.Schema.Type<typeof ContributionDay>, Shared.ContributionDay>>()
assertExact<Exact<Schema.Schema.Type<typeof ContributionsResponse>, Shared.ContributionsResponse>>()
assertExact<Exact<Schema.Schema.Type<typeof LeaderboardEntry>, Shared.LeaderboardEntry>>()
assertExact<Exact<Schema.Schema.Type<typeof LeaderboardResponse>, Shared.LeaderboardResponse>>()
assertExact<Exact<Schema.Schema.Type<typeof CanvasTileSummary>, Shared.CanvasTileSummary>>()
assertExact<Exact<Schema.Schema.Type<typeof CanvasTilesResponse>, Shared.CanvasTilesResponse>>()
assertExact<Exact<Schema.Schema.Type<typeof TileHistoryFrame>, Shared.TileHistoryFrame>>()
assertExact<Exact<Schema.Schema.Type<typeof TileHistoryResponse>, Shared.TileHistoryResponse>>()
assertExact<Exact<Schema.Schema.Type<typeof Alarm>, Shared.Alarm>>()
assertExact<Exact<Schema.Schema.Type<typeof AlarmsResponse>, Shared.AlarmsResponse>>()

assertExact<Exact<Schema.Codec.Encoded<typeof ServerInfo>, Shared.ServerInfo>>()
assertExact<Exact<Schema.Codec.Encoded<typeof BoundingBox>, Shared.BoundingBox>>()
assertExact<Exact<Schema.Codec.Encoded<typeof Node>, Shared.Node>>()
assertExact<Exact<Schema.Codec.Encoded<typeof Chunk>, Shared.Chunk>>()
assertExact<Exact<Schema.Codec.Encoded<typeof Template>, Shared.Template>>()
assertExact<Exact<Schema.Codec.Encoded<typeof Manifest>, Shared.Manifest>>()
assertExact<Exact<Schema.Codec.Encoded<typeof PaintPixels>, Shared.PaintPixels>>()
assertExact<Exact<Schema.Codec.Encoded<typeof PaintTile>, Shared.PaintTile>>()
assertExact<Exact<Schema.Codec.Encoded<typeof PaintEvent>, Shared.PaintEvent>>()
assertExact<Exact<Schema.Codec.Encoded<typeof TileOffer>, Shared.TileOffer>>()
assertExact<Exact<Schema.Codec.Encoded<typeof TileOfferResponse>, Shared.TileOfferResponse>>()
assertExact<Exact<Schema.Codec.Encoded<typeof TileUploadResponse>, Shared.TileUploadResponse>>()
assertExact<Exact<Schema.Codec.Encoded<typeof TileOfferBatch>, Shared.TileOfferBatch>>()
assertExact<Exact<Schema.Codec.Encoded<typeof TemplateStatus>, Shared.TemplateStatus>>()
assertExact<Exact<Schema.Codec.Encoded<typeof StatusDelta>, Shared.StatusDelta>>()
assertExact<Exact<Schema.Codec.Encoded<typeof NodeStatus>, Shared.NodeStatus>>()
assertExact<Exact<Schema.Codec.Encoded<typeof StatusResponse>, Shared.StatusResponse>>()
assertExact<Exact<Schema.Codec.Encoded<typeof HistoryBucket>, Shared.HistoryBucket>>()
assertExact<Exact<Schema.Codec.Encoded<typeof HistoryResponse>, Shared.HistoryResponse>>()
assertExact<Exact<Schema.Codec.Encoded<typeof ContributionDay>, Shared.ContributionDay>>()
assertExact<
  Exact<Schema.Codec.Encoded<typeof ContributionsResponse>, Shared.ContributionsResponse>
>()
assertExact<Exact<Schema.Codec.Encoded<typeof LeaderboardEntry>, Shared.LeaderboardEntry>>()
assertExact<Exact<Schema.Codec.Encoded<typeof LeaderboardResponse>, Shared.LeaderboardResponse>>()
assertExact<Exact<Schema.Codec.Encoded<typeof CanvasTileSummary>, Shared.CanvasTileSummary>>()
assertExact<Exact<Schema.Codec.Encoded<typeof CanvasTilesResponse>, Shared.CanvasTilesResponse>>()
assertExact<Exact<Schema.Codec.Encoded<typeof TileHistoryFrame>, Shared.TileHistoryFrame>>()
assertExact<Exact<Schema.Codec.Encoded<typeof TileHistoryResponse>, Shared.TileHistoryResponse>>()
assertExact<Exact<Schema.Codec.Encoded<typeof Alarm>, Shared.Alarm>>()
assertExact<Exact<Schema.Codec.Encoded<typeof AlarmsResponse>, Shared.AlarmsResponse>>()
