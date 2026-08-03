import type * as Shared from '@wts/shared'
import { TILE_SIZE, WORLD_PIXELS, WORLD_TILES } from '@wts/shared'
import { Schema } from 'effect'

const MAX_IDENTIFIER_LENGTH = 64
const MAX_NAME_LENGTH = 256
const MAX_DESCRIPTION_LENGTH = 4_096
/**
 * Array caps sized from what each field actually bounds. A single shared round number was wrong
 * three separate ways: it made a >1,000-tile manifest impossible to encode, capped a paint payload
 * at a tenth of a real charge drain, and rejected an ordinary 40x30-tile template.
 */
const MAX_MANIFEST_TILES = WORLD_TILES * WORLD_TILES
const MAX_TEMPLATE_CHUNKS = MAX_MANIFEST_TILES
const MAX_MANIFEST_NODES = 100_000
const MAX_MANIFEST_TEMPLATES = 100_000
/**
 * Deliberately redundant, and only meaningful as a cost bound. The PaintEvent filters below already
 * force every tile to carry a pixel and the event as a whole to stay within MAX_PAINTED_PIXELS, so
 * the tile count cannot exceed that on semantics alone — mutating this constant changes no
 * accept/reject outcome and no test pins it. What it does is stop the decoder validating four
 * million tile structs before the filters get a chance to reject the payload, which the previous
 * WORLD_TILES-squared value did not.
 */
const MAX_PAINT_TILES = 100_000
/**
 * Both mirror `MAX_COUNTER_DELTA_VALUE` in `apps/backend/src/ports/counter-store.ts`, which cannot be
 * imported here — the wire package must not depend on the backend. `counter-store.ts` says "derive,
 * never restate"; this is the one place that is impossible, so the restatement is named as such and
 * a test pins the two together.
 */
const MAX_PAINT_PIXELS_PER_TILE = 100_000
const MAX_PAINTED_PIXELS = 100_000
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

const TileKey = Schema.declare<Shared.TileKey>(
  (value): value is Shared.TileKey => {
    if (typeof value !== 'string') return false
    const match = /^(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(value)
    if (match === null) return false
    const x = Number(match[1])
    const y = Number(match[2])
    return x < WORLD_TILES && y < WORLD_TILES
  },
  { description: `a canonical tile key with coordinates from 0 to ${WORLD_TILES - 1}` },
)

const BoundingBoxStruct = Schema.Struct({
  minX: integerBetween(0, WORLD_PIXELS - 1),
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
  requiresAuth: Schema.Boolean,
})

export const Node = Schema.Struct({
  id: Identifier,
  parentId: Schema.NullOr(Identifier),
  path: boundedString(MAX_DESCRIPTION_LENGTH),
  name: Name,
})

export const Chunk = Schema.Struct({
  tile: TileKey,
  hash: Hash,
})

export const Template = Schema.Struct({
  id: Identifier,
  nodeId: Identifier,
  name: Name,
  version: Identifier,
  bbox: BoundingBox,
  totalPixels: NonNegativeInteger,
  chunks: boundedArray(Chunk, MAX_TEMPLATE_CHUNKS),
})

const ManifestStruct = Schema.Struct({
  version: VersionToken,
  server: ServerInfo,
  nodes: boundedArray(Node, MAX_MANIFEST_NODES),
  templates: boundedArray(Template, MAX_MANIFEST_TEMPLATES),
  tiles: boundedArray(TileKey, MAX_MANIFEST_TILES),
})

export const Manifest = ManifestStruct.pipe(
  Schema.check(
    booleanFilter((manifest: Schema.Schema.Type<typeof ManifestStruct>) => {
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
        manifest.nodes.every((node) => node.parentId === null || nodeIds.has(node.parentId)) &&
        manifest.templates.every((template) => nodeIds.has(template.nodeId))
      )
    }, 'node and template ids must be unique and every parent reference must resolve'),
    booleanFilter(
      (manifest: Schema.Schema.Type<typeof ManifestStruct>) =>
        manifest.templates.every(
          (template) =>
            new Set(template.chunks.map((chunk) => chunk.tile)).size === template.chunks.length,
        ),
      'a template may contain at most one chunk for each tile',
    ),
    booleanFilter((manifest: Schema.Schema.Type<typeof ManifestStruct>) => {
      // x wraps, so a bounding box with minX > maxX spans the antimeridian and covers TWO x ranges.
      // A sort-and-sweep over minX silently misses those: two fully-overlapping wrapped templates
      // both start high and end low, so the early break skips the comparison entirely. Splitting
      // into non-wrapping intervals first makes the comparison ordinary again.
      const xRanges = ({
        minX,
        maxX,
      }: {
        minX: number
        maxX: number
      }): ReadonlyArray<readonly [number, number]> =>
        minX < maxX ? [[minX, maxX] as const] : [[minX, WORLD_PIXELS] as const, [0, maxX] as const]

      const groups = new Map<string, Array<Schema.Schema.Type<typeof Template>>>()
      for (const template of manifest.templates) {
        const group = groups.get(template.nodeId)
        if (group === undefined) groups.set(template.nodeId, [template])
        else group.push(template)
      }
      for (const group of groups.values()) {
        for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
          const left = group[leftIndex]
          if (left === undefined) continue
          for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
            const right = group[rightIndex]
            if (right === undefined) continue
            if (!(right.bbox.minY < left.bbox.maxY && left.bbox.minY < right.bbox.maxY)) continue
            const overlapsX = xRanges(left.bbox).some(([leftStart, leftEnd]) =>
              xRanges(right.bbox).some(
                ([rightStart, rightEnd]) => rightStart < leftEnd && leftStart < rightEnd,
              ),
            )
            if (overlapsX) return false
          }
        }
      }
      return true
    }, 'templates within one group must not overlap'),
  ),
)

const TileLocalCoordinate = integerBetween(0, TILE_SIZE - 1)
const PaletteIndex = integerBetween(0, MAX_PALETTE_INDEX)

const PaintPixelsStruct = Schema.Struct({
  x: boundedArray(TileLocalCoordinate, MAX_PAINT_PIXELS_PER_TILE),
  y: boundedArray(TileLocalCoordinate, MAX_PAINT_PIXELS_PER_TILE),
  colors: boundedArray(PaletteIndex, MAX_PAINT_PIXELS_PER_TILE),
})

export const PaintPixels = PaintPixelsStruct.pipe(
  Schema.check(
    booleanFilter(
      (pixels: Schema.Schema.Type<typeof PaintPixelsStruct>) =>
        pixels.x.length === pixels.y.length && pixels.y.length === pixels.colors.length,
      'x, y and colors must have equal lengths',
    ),
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
  season: NonNegativeInteger,
  ts: Seconds,
  tiles: boundedArray(PaintTile, MAX_PAINT_TILES),
  painted: integerBetween(0, MAX_PAINTED_PIXELS),
})

export const PaintEvent = PaintEventStruct.pipe(
  Schema.check(
    booleanFilter(
      (event: Schema.Schema.Type<typeof PaintEventStruct>) =>
        event.tiles.every((tile) => tile.pixels.x.length > 0),
      'every submitted tile must carry at least one pixel',
    ),
    // Without a total, the per-tile cap bounds nothing: MAX_PAINT_TILES tiles each holding
    // MAX_PAINT_PIXELS_PER_TILE pixels is a ten-billion-pixel payload the schema would accept.
    booleanFilter((event: Schema.Schema.Type<typeof PaintEventStruct>) => {
      const submitted = event.tiles.reduce((total, tile) => total + tile.pixels.x.length, 0)
      return submitted <= MAX_PAINTED_PIXELS && event.painted <= submitted
    }, `painted must not exceed the submitted pixels, of which there may be at most ${MAX_PAINTED_PIXELS}`),
  ),
)

export const TileOffer = Schema.Struct({
  tile: TileKey,
  sha256: Hash,
  ts: Seconds,
})

export const TileOfferResponse = Schema.Struct({
  wanted: boundedArray(TileKey, MAX_MANIFEST_TILES),
})

const TemplateStatusStruct = Schema.Struct({
  templateId: Identifier,
  correct: NonNegativeInteger,
  wrong: NonNegativeInteger,
  blank: NonNegativeInteger,
  total: NonNegativeInteger,
  observedAt: Millis,
})

export const TemplateStatus = TemplateStatusStruct.pipe(
  Schema.check(
    booleanFilter(
      (status: Schema.Schema.Type<typeof TemplateStatusStruct>) =>
        status.correct + status.wrong + status.blank <= status.total,
      'correct, wrong and blank must not sum above total',
    ),
  ),
)

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

export const Alarm = Schema.Struct({
  id: Identifier,
  templateId: Identifier,
  kind: Schema.Literals(['regression', 'sustained-griefing']),
  pixelsLost: NonNegativeInteger,
  firstSeen: Millis,
  lastSeen: Millis,
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
assertExact<Exact<Schema.Schema.Type<typeof TemplateStatus>, Shared.TemplateStatus>>()
assertExact<Exact<Schema.Schema.Type<typeof NodeStatus>, Shared.NodeStatus>>()
assertExact<Exact<Schema.Schema.Type<typeof Alarm>, Shared.Alarm>>()

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
assertExact<Exact<Schema.Codec.Encoded<typeof TemplateStatus>, Shared.TemplateStatus>>()
assertExact<Exact<Schema.Codec.Encoded<typeof NodeStatus>, Shared.NodeStatus>>()
assertExact<Exact<Schema.Codec.Encoded<typeof Alarm>, Shared.Alarm>>()
