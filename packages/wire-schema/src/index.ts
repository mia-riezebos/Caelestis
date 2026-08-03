import type * as Shared from '@wts/shared'
import { Schema } from 'effect'

const Seconds = Schema.Number.pipe(
  Schema.refine((value): value is Shared.Seconds => Number.isFinite(value)),
)
const Millis = Schema.Number.pipe(
  Schema.refine((value): value is Shared.Millis => Number.isFinite(value)),
)

const TileKey = Schema.String.pipe(
  Schema.refine((value): value is Shared.TileKey => /^\d+\/\d+$/.test(value)),
)

const BoundingBox = Schema.Struct({
  minX: Schema.Number,
  minY: Schema.Number,
  maxX: Schema.Number,
  maxY: Schema.Number,
}) satisfies Schema.Schema<Shared.BoundingBox>

export const ServerInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  requiresAuth: Schema.Boolean,
}) satisfies Schema.Schema<Shared.ServerInfo>

export const Node = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  path: Schema.String,
  name: Schema.String,
}) satisfies Schema.Schema<Shared.Node>

export const Chunk = Schema.Struct({
  tile: TileKey,
  hash: Schema.String,
}) satisfies Schema.Schema<Shared.Chunk>

export const Template = Schema.Struct({
  id: Schema.String,
  nodeId: Schema.String,
  name: Schema.String,
  version: Schema.String,
  bbox: BoundingBox,
  totalPixels: Schema.Number,
  chunks: Schema.Array(Chunk),
}) satisfies Schema.Schema<Shared.Template>

export const Manifest = Schema.Struct({
  version: Schema.String,
  server: ServerInfo,
  nodes: Schema.Array(Node),
  templates: Schema.Array(Template),
  tiles: Schema.Array(TileKey),
}) satisfies Schema.Schema<Shared.Manifest>

export const PaintPixels = Schema.Struct({
  x: Schema.Array(Schema.Number),
  y: Schema.Array(Schema.Number),
  colors: Schema.Array(Schema.Number),
}).pipe(
  Schema.refine(
    (pixels): pixels is Shared.PaintPixels =>
      pixels.x.length === pixels.y.length && pixels.y.length === pixels.colors.length,
    { message: 'x, y and colors must have equal lengths' },
  ),
) satisfies Schema.Schema<Shared.PaintPixels>

export const PaintTile = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  pixels: PaintPixels,
}) satisfies Schema.Schema<Shared.PaintTile>

export const PaintEvent = Schema.Struct({
  eventId: Schema.String,
  wplaceUserId: Schema.Number,
  displayName: Schema.String,
  season: Schema.Number,
  ts: Seconds,
  tiles: Schema.Array(PaintTile),
  painted: Schema.Number,
}) satisfies Schema.Schema<Shared.PaintEvent>

export const TileOffer = Schema.Struct({
  tile: TileKey,
  sha256: Schema.String,
  ts: Seconds,
}) satisfies Schema.Schema<Shared.TileOffer>

export const TileOfferResponse = Schema.Struct({
  wanted: Schema.Array(TileKey),
}) satisfies Schema.Schema<Shared.TileOfferResponse>

export const TemplateStatus = Schema.Struct({
  templateId: Schema.String,
  correct: Schema.Number,
  wrong: Schema.Number,
  blank: Schema.Number,
  total: Schema.Number,
  observedAt: Millis,
}) satisfies Schema.Schema<Shared.TemplateStatus>

export const NodeStatus = Schema.Struct({
  nodeId: Schema.String,
  correct: Schema.Number,
  total: Schema.Number,
  templatesComplete: Schema.Number,
  templatesTotal: Schema.Number,
  observedAt: Millis,
}) satisfies Schema.Schema<Shared.NodeStatus>

export const Alarm = Schema.Struct({
  id: Schema.String,
  templateId: Schema.String,
  kind: Schema.Literals(['regression', 'sustained-griefing']),
  pixelsLost: Schema.Number,
  firstSeen: Millis,
  lastSeen: Millis,
}) satisfies Schema.Schema<Shared.Alarm>
