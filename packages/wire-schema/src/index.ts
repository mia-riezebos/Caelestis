import type * as Shared from '@wts/shared'
import { TILE_SIZE, WORLD_PIXELS, WORLD_TILES, WPLACE_PALETTE } from '@wts/shared'
import { Schema } from 'effect'

const MAX_IDENTIFIER_LENGTH = 64
const MAX_NAME_LENGTH = 256
const MAX_DESCRIPTION_LENGTH = 4_096
const MAX_ARRAY_LENGTH = 1_000

// Wide enough for every v1 timestamp while still making seconds and milliseconds disjoint.
const MIN_EPOCH_SECONDS = 1_577_836_800 // 2020-01-01
const MAX_EPOCH_SECONDS = 4_102_444_800 // 2100-01-01
const MIN_EPOCH_MILLISECONDS = MIN_EPOCH_SECONDS * 1_000
const MAX_EPOCH_MILLISECONDS = MAX_EPOCH_SECONDS * 1_000

const booleanFilter = <T>(predicate: (value: T) => boolean, message: string) =>
  Schema.makeFilter<T>(predicate, { message })

const boundedString = (maximum: number) =>
  Schema.String.pipe(Schema.check(Schema.isLengthBetween(1, maximum)))

const boundedArray = <A>(item: Schema.Schema<A>) =>
  Schema.Array(item).pipe(Schema.check(Schema.isMaxLength(MAX_ARRAY_LENGTH)))

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

const Identifier = boundedString(MAX_IDENTIFIER_LENGTH)
const Name = boundedString(MAX_NAME_LENGTH)
const Description = boundedString(MAX_DESCRIPTION_LENGTH)
const Hash = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[0-9a-f]{64}$/, {
      message: 'must be a lowercase SHA-256 hex digest',
    }),
  ),
)

// Runtime checks establish the units. The casts only attach the compile-time brands after decoding.
const Seconds = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isBetween(
      { minimum: MIN_EPOCH_SECONDS, maximum: MAX_EPOCH_SECONDS, exclusiveMaximum: true },
      { message: 'must be a plausible Unix timestamp in seconds' },
    ),
  ),
) as unknown as Schema.Schema<Shared.Seconds>

const Millis = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isBetween(
      {
        minimum: MIN_EPOCH_MILLISECONDS,
        maximum: MAX_EPOCH_MILLISECONDS,
        exclusiveMaximum: true,
      },
      { message: 'must be a plausible Unix timestamp in milliseconds' },
    ),
  ),
) as unknown as Schema.Schema<Shared.Millis>

const TileKey = Schema.String.pipe(
  Schema.check(
    booleanFilter(
      (value: string) => {
        const match = /^(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(value)
        if (match === null) return false
        const x = Number(match[1])
        const y = Number(match[2])
        return x < WORLD_TILES && y < WORLD_TILES
      },
      `must be a canonical tile key with coordinates from 0 to ${WORLD_TILES - 1}`,
    ),
  ),
) as unknown as Schema.Schema<Shared.TileKey>

const BoundingBoxStruct = Schema.Struct({
  minX: integerBetween(0, WORLD_PIXELS),
  minY: integerBetween(0, WORLD_PIXELS),
  maxX: integerBetween(0, WORLD_PIXELS),
  maxY: integerBetween(0, WORLD_PIXELS),
})

const BoundingBox = BoundingBoxStruct.pipe(
  Schema.check(
    booleanFilter(
      (bbox: Schema.Schema.Type<typeof BoundingBoxStruct>) =>
        bbox.minX <= bbox.maxX && bbox.minY <= bbox.maxY,
      'minimum coordinates must not exceed maximum coordinates',
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
  chunks: boundedArray(Chunk),
})

const ManifestStruct = Schema.Struct({
  version: Identifier,
  server: ServerInfo,
  nodes: boundedArray(Node),
  templates: boundedArray(Template),
  tiles: boundedArray(TileKey),
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
  ),
)

const TileLocalCoordinate = integerBetween(0, TILE_SIZE - 1)
const PaletteIndex = integerBetween(0, WPLACE_PALETTE.length - 1)

const PaintPixelsStruct = Schema.Struct({
  x: boundedArray(TileLocalCoordinate),
  y: boundedArray(TileLocalCoordinate),
  colors: boundedArray(PaletteIndex),
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
  displayName: boundedString(MAX_IDENTIFIER_LENGTH),
  season: NonNegativeInteger,
  ts: Seconds,
  tiles: boundedArray(PaintTile),
  painted: NonNegativeInteger,
})

export const PaintEvent = PaintEventStruct.pipe(
  Schema.check(
    booleanFilter(
      (event: Schema.Schema.Type<typeof PaintEventStruct>) =>
        event.painted <= event.tiles.reduce((total, tile) => total + tile.pixels.x.length, 0),
      'painted must not exceed the number of submitted pixels',
    ),
  ),
)

export const TileOffer = Schema.Struct({
  tile: TileKey,
  sha256: Hash,
  ts: Seconds,
})

export const TileOfferResponse = Schema.Struct({
  wanted: boundedArray(TileKey),
})

export const TemplateStatus = Schema.Struct({
  templateId: Identifier,
  correct: NonNegativeInteger,
  wrong: NonNegativeInteger,
  blank: NonNegativeInteger,
  total: NonNegativeInteger,
  observedAt: Millis,
})

export const NodeStatus = Schema.Struct({
  nodeId: Identifier,
  correct: NonNegativeInteger,
  total: NonNegativeInteger,
  templatesComplete: NonNegativeInteger,
  templatesTotal: NonNegativeInteger,
  observedAt: Millis,
})

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
