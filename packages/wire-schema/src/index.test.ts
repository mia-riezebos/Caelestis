import { tileKey } from '@wts/shared'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  Alarm,
  Chunk,
  Manifest,
  Node,
  NodeStatus,
  PaintEvent,
  PaintPixels,
  PaintTile,
  ServerInfo,
  Template,
  TemplateStatus,
  TileOffer,
  TileOfferResponse,
} from './index.js'

const HASH = 'a'.repeat(64)
const SECONDS = 1_750_000_000
const MILLIS = SECONDS * 1_000

const SERVER_ID = '01890f3a-6b7c-7def-8123-456789abcdef'
const NODE_ID = '01890f3a-6b7c-7def-8123-456789abcde0'
const TEMPLATE_ID = '01890f3a-6b7c-7def-8123-456789abcde1'
const VERSION_ID = '01890f3a-6b7c-7def-8123-456789abcde2'
const EVENT_ID = '01890f3a-6b7c-7def-8123-456789abcde3'

const uuid = (index: number): string =>
  `01890f3a-6b7c-7def-8123-${index.toString(16).padStart(12, '0')}`

const expectRejected = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): void => {
  expect(() => Schema.decodeUnknownSync(schema)(value)).toThrow()
}

const validPixels = { x: [1], y: [2], colors: [3] }
const validEvent = {
  eventId: EVENT_ID,
  wplaceUserId: 123,
  displayName: 'Painter',
  season: 1,
  ts: SECONDS,
  tiles: [{ x: 325, y: 1781, pixels: validPixels }],
  painted: 1,
}

const validTemplate = {
  id: TEMPLATE_ID,
  nodeId: NODE_ID,
  name: 'Template',
  version: VERSION_ID,
  bbox: { minX: 325_000, minY: 1_781_000, maxX: 326_000, maxY: 1_782_000 },
  totalPixels: 1,
  chunks: [{ tile: '325/1781', hash: HASH }],
}

const validNode = { id: NODE_ID, parentId: null, path: '/group', name: 'Group' }

const validManifest = {
  version: 'manifest-1',
  server: { id: SERVER_ID, name: 'Server', requiresAuth: false },
  nodes: [validNode],
  templates: [validTemplate],
  tiles: ['325/1781'],
}

const encoders = [
  Schema.encodeSync(ServerInfo),
  Schema.encodeSync(Node),
  Schema.encodeSync(Chunk),
  Schema.encodeSync(Template),
  Schema.encodeSync(Manifest),
  Schema.encodeSync(PaintPixels),
  Schema.encodeSync(PaintTile),
  Schema.encodeSync(PaintEvent),
  Schema.encodeSync(TileOffer),
  Schema.encodeSync(TileOfferResponse),
  Schema.encodeSync(TemplateStatus),
  Schema.encodeSync(NodeStatus),
  Schema.encodeSync(Alarm),
]

it('exposes every exported wire schema as a bidirectional codec', () => {
  expect(encoders).toHaveLength(13)
})

describe('tile and template schemas', () => {
  it.each(['2048/0', '0/2048', '999999/12', '01/2', '2/01', '-1/2'])(
    'rejects non-canonical tile key %s',
    (tile) => {
      expectRejected(TileOffer, { tile, sha256: HASH, ts: SECONDS })
    },
  )

  it.each([2048, -1, 1.5])('rejects invalid paint-tile coordinate %s', (x) => {
    expectRejected(PaintTile, { x, y: 0, pixels: validPixels })
  })

  it.each([2048, -1, 1.5])('rejects invalid paint-tile y coordinate %s', (y) => {
    expectRejected(PaintTile, { x: 0, y, pixels: validPixels })
  })

  it('rejects an otherwise-valid vertically inverted bounding box', () => {
    // y does not wrap: Mercator clamps at the poles, so there is nothing to wrap through.
    expectRejected(Template, {
      ...validTemplate,
      bbox: { minX: 0, minY: 2, maxX: 1, maxY: 1 },
    })
  })

  it('rejects a bounding box with zero height', () => {
    expectRejected(Template, {
      ...validTemplate,
      bbox: { minX: 0, minY: 1, maxX: 1, maxY: 1 },
    })
  })

  it.each([
    { minX: -1, minY: 0, maxX: 1, maxY: 1 },
    { minX: 0, minY: -1, maxX: 1, maxY: 1 },
    { minX: 0, minY: 0, maxX: 2_048_001, maxY: 1 },
    { minX: 0, minY: 0, maxX: 1, maxY: 2_048_001 },
  ])('rejects a bounding box outside the canvas domain: %j', (bbox) => {
    expectRejected(Template, { ...validTemplate, bbox })
  })

  it('accepts a bounding box that wraps through zero in x', () => {
    // The canvas wraps in x, so minX > maxX means "spans the antimeridian" rather than "inverted".
    const template = {
      ...validTemplate,
      bbox: { minX: 2_047_000, minY: 0, maxX: 1_000, maxY: 1_000 },
    }
    expect(Schema.decodeUnknownSync(Template)(template)).toEqual(template)
  })

  it('rejects a bounding box with zero width', () => {
    expectRejected(Template, {
      ...validTemplate,
      bbox: { minX: 5, minY: 0, maxX: 5, maxY: 1 },
    })
  })

  it('rejects an out-of-world bounding-box minimum', () => {
    // maxX must differ from minX, or the zero-width filter rejects this regardless of the minX
    // bound and the test passes with that bound widened to WORLD_PIXELS — under which
    // template_versions_pixel_bounds_check would refuse an INSERT the wire had accepted.
    // Only x is asserted. `minY < maxY <= WORLD_PIXELS` already implies minY's upper bound, so a y
    // case would pass with that bound deleted and claim cover it does not have.
    expectRejected(Template, {
      ...validTemplate,
      bbox: { minX: 2_048_000, minY: 0, maxX: 1, maxY: 1 },
    })
  })

  it('accepts the world edge as an exclusive bounding-box maximum', () => {
    const template = {
      ...validTemplate,
      bbox: { minX: 2_047_999, minY: 2_047_999, maxX: 2_048_000, maxY: 2_048_000 },
    }
    expect(Schema.decodeUnknownSync(Template)(template)).toEqual(template)
  })

  it('rejects zero as a bounding-box maximum, so the seam has one encoding', () => {
    // A span ending on the seam is WORLD_PIXELS. Admitting 0 as well would let the wire accept a
    // bbox that template_versions_pixel_bounds_check then refuses to store.
    // Only x is asserted: `minY < maxY` already rejects maxY = 0, so a y case here would pass with
    // the bound deleted and claim cover it does not have.
    expectRejected(Template, {
      ...validTemplate,
      bbox: { minX: 2_047_000, minY: 0, maxX: 0, maxY: 1_000 },
    })
  })

  it('rejects a zero-area bounding box', () => {
    expectRejected(Template, {
      ...validTemplate,
      bbox: { minX: 1, minY: 1, maxX: 1, maxY: 2 },
    })
  })

  it('rejects identifiers that are not canonical UUIDv7 values', () => {
    expectRejected(Template, { ...validTemplate, id: 'template-1' })
  })

  it.each([
    TEMPLATE_ID.toUpperCase(),
    TEMPLATE_ID.replace('-7', '-4'),
    TEMPLATE_ID.replace('-8123-', '-7123-'),
  ])('rejects non-canonical UUIDv7 identifier %s', (id) => {
    expectRejected(Template, { ...validTemplate, id })
  })

  it('rejects a negative total pixel count', () => {
    expectRejected(Template, { ...validTemplate, totalPixels: -7 })
  })

  it.each(['', '../../etc/passwd', 'A'.repeat(64)])('rejects invalid SHA-256 digest %s', (hash) => {
    expectRejected(Chunk, { tile: '0/0', hash })
  })

  it.each([
    // Nothing exercised the description cap at all, so it could move freely. It bounds both
    // ServerInfo.description and Node.path, and a network client controls both.
    ['a description at the cap', 4_096, true],
    ['a description one character past the cap', 4_097, false],
  ])('%s is accepted: %s', (_label, length, accepted) => {
    const server = {
      id: SERVER_ID,
      name: 'Server',
      requiresAuth: false,
      description: 'x'.repeat(length),
    }
    if (accepted) expect(Schema.decodeUnknownSync(ServerInfo)(server)).toEqual(server)
    else expectRejected(ServerInfo, server)
  })
})

describe('PaintPixels', () => {
  it('accepts equal-length coordinate and colour arrays', () => {
    expect(Schema.decodeUnknownSync(PaintPixels)({ x: [1, 2], y: [3, 4], colors: [5, 6] })).toEqual(
      { x: [1, 2], y: [3, 4], colors: [5, 6] },
    )
  })

  it('rejects an x/y length mismatch when colours match x', () => {
    expectRejected(PaintPixels, { x: [1, 2], y: [3], colors: [5, 6] })
  })

  it('rejects a y/colour length mismatch when x matches y', () => {
    expectRejected(PaintPixels, { x: [1], y: [3], colors: [5, 6] })
  })

  it.each([-1, 1.5, 1_000])('rejects invalid tile-local coordinate %s', (x) => {
    expectRejected(PaintPixels, { x: [x], y: [0], colors: [0] })
  })

  it.each([-1, 1.5, 999_999, Number.NaN])('rejects invalid palette index %s', (color) => {
    expectRejected(PaintPixels, { x: [0], y: [0], colors: [color] })
  })

  it.each([
    // 999_999 above is far enough past the cap that the ceiling could move by one in either
    // direction and still reject it, so nothing pinned where the ceiling actually sits. The bound
    // is deliberately permissive until 09-recon-palette recovers the real index order, but
    // permissive is a decision about the value, not a licence for it to drift untested.
    ['the highest accepted palette index', 65_535, true],
    ['one past the palette ceiling', 65_536, false],
  ])('%s is accepted: %s', (_label, color, accepted) => {
    const pixels = { x: [0], y: [0], colors: [color] }
    if (accepted) expect(Schema.decodeUnknownSync(PaintPixels)(pixels)).toEqual(pixels)
    else expectRejected(PaintPixels, pixels)
  })

  it('accepts palette indices above the incomplete recovered palette', () => {
    expect(Schema.decodeUnknownSync(PaintPixels)({ x: [0], y: [0], colors: [255] })).toEqual({
      x: [0],
      y: [0],
      colors: [255],
    })
  })

  it('allows a paint payload above the old unevidenced 1,000-pixel cap', () => {
    const values = Array.from({ length: 1_001 }, () => 0)
    expect(Schema.decodeUnknownSync(PaintPixels)({ x: values, y: values, colors: values })).toEqual(
      {
        x: values,
        y: values,
        colors: values,
      },
    )
  })

  it('caps one tile payload at the counter-store guardrail', () => {
    const values = Array.from({ length: 100_001 }, () => 0)
    expectRejected(PaintPixels, { x: values, y: values, colors: values })
  })
})

describe('PaintEvent', () => {
  it.each([
    ['painted', -5],
    ['painted', 1.5],
    ['painted', Number.MAX_SAFE_INTEGER],
    ['painted', Number.POSITIVE_INFINITY],
    ['wplaceUserId', 1.5],
    ['wplaceUserId', 1e300],
    ['wplaceUserId', Number.NaN],
    ['season', -1.5],
    ['season', 1e21],
  ] as const)('rejects invalid %s value %s', (field, value) => {
    expectRejected(PaintEvent, { ...validEvent, [field]: value })
  })

  it('rejects painted counts above the total derived from tiles', () => {
    expectRejected(PaintEvent, { ...validEvent, painted: 2 })
  })

  it('caps the pixels submitted across the whole event, not merely per tile', () => {
    // The per-tile cap bounds nothing on its own: MAX_PAINT_TILES tiles at the per-tile cap is a
    // ten-billion-pixel payload. `painted` is well within its own bound here, so only the total
    // can do the rejecting.
    const values = Array.from({ length: 100_000 }, () => 0)
    expectRejected(PaintEvent, {
      ...validEvent,
      tiles: [
        { x: 0, y: 0, pixels: { x: values, y: values, colors: values } },
        { x: 1, y: 0, pixels: { x: [0], y: [0], colors: [0] } },
      ],
      painted: 1,
    })
  })

  it('accepts an event submitting exactly the pixel total', () => {
    const values = Array.from({ length: 100_000 }, () => 0)
    const event = {
      ...validEvent,
      tiles: [{ x: 0, y: 0, pixels: { x: values, y: values, colors: values } }],
      painted: 100_000,
    }
    expect(Schema.decodeUnknownSync(PaintEvent)(event)).toEqual(event)
  })

  it('accepts an ordinary paint event spanning two tiles', () => {
    const event = {
      ...validEvent,
      tiles: [
        { x: 0, y: 0, pixels: validPixels },
        { x: 1, y: 0, pixels: validPixels },
      ],
      painted: 2,
    }
    expect(Schema.decodeUnknownSync(PaintEvent)(event)).toEqual(event)
  })

  it('rejects a tile carrying no pixels', () => {
    // Without this, MAX_PAINT_TILES empty entries are a legal payload that reports nothing.
    expectRejected(PaintEvent, {
      ...validEvent,
      tiles: [...validEvent.tiles, { x: 5, y: 5, pixels: { x: [], y: [], colors: [] } }],
    })
  })

  it('accepts a display name longer than an identifier', () => {
    // wplace display names are names, not identifiers; a 65-character one is ordinary.
    const event = { ...validEvent, displayName: 'x'.repeat(65) }
    expect(Schema.decodeUnknownSync(PaintEvent)(event)).toEqual(event)
  })

  it('caps display-name length at the name bound', () => {
    expectRejected(PaintEvent, { ...validEvent, displayName: 'x'.repeat(257) })
  })

  it('rejects an empty display name', () => {
    // Every bounded string runs 1..max, not 0..max. Only the upper half was pinned, so lowering the
    // minimum to zero admitted empty names, paths, versions and descriptions across the whole wire.
    expectRejected(PaintEvent, { ...validEvent, displayName: '' })
  })
})

describe('cross-field and time-unit schemas', () => {
  it('requires manifest tiles to exactly match the unique tiles referenced by chunks', () => {
    expectRejected(Manifest, { ...validManifest, tiles: [] })
  })

  it('rejects manifest tiles that contain an unreferenced extra tile', () => {
    expectRejected(Manifest, { ...validManifest, tiles: ['325/1781', '0/0'] })
  })

  it('rejects a duplicate declared tile', () => {
    expectRejected(Manifest, { ...validManifest, tiles: ['325/1781', '325/1781'] })
  })

  it('rejects a declared tile set that omits a referenced tile', () => {
    expectRejected(Manifest, { ...validManifest, tiles: ['0/0'] })
  })

  it('rejects duplicate node identifiers', () => {
    expectRejected(Manifest, { ...validManifest, nodes: [validNode, { ...validNode }] })
  })

  it('rejects duplicate template identifiers', () => {
    const duplicate = { ...validTemplate, version: uuid(4) }
    expectRejected(Manifest, { ...validManifest, templates: [validTemplate, duplicate] })
  })

  it('rejects a dangling parent-node reference', () => {
    expectRejected(Manifest, {
      ...validManifest,
      nodes: [{ ...validNode, parentId: uuid(5) }],
    })
  })

  it('accepts a manifest covering more than 1,000 distinct canvas tiles', () => {
    const templates = Array.from({ length: 120 }, (_, templateIndex) => {
      const baseX = (templateIndex % 40) * 3
      const baseY = Math.floor(templateIndex / 40) * 3
      return {
        id: uuid(100 + templateIndex),
        nodeId: NODE_ID,
        name: `Template ${templateIndex}`,
        version: uuid(1_000 + templateIndex),
        bbox: {
          minX: baseX * 1_000,
          minY: baseY * 1_000,
          maxX: (baseX + 3) * 1_000,
          maxY: (baseY + 3) * 1_000,
        },
        totalPixels: 1,
        chunks: Array.from({ length: 9 }, (_, chunkIndex) => ({
          tile: tileKey({
            x: baseX + (chunkIndex % 3),
            y: baseY + Math.floor(chunkIndex / 3),
          }),
          hash: HASH,
        })),
      }
    })
    const manifest = {
      ...validManifest,
      templates,
      tiles: templates.flatMap((template) => template.chunks.map((chunk) => chunk.tile)),
    }

    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
    expect(Schema.encodeSync(Manifest)(manifest)).toEqual(manifest)
  })

  it('rejects a template whose node reference is absent from the manifest', () => {
    expectRejected(Manifest, { ...validManifest, nodes: [] })
  })

  it('rejects duplicate chunk tiles within a template', () => {
    const duplicate = {
      ...validTemplate,
      chunks: [
        ...validTemplate.chunks,
        { tile: validTemplate.chunks[0]?.tile, hash: 'b'.repeat(64) },
      ],
    }
    expectRejected(Manifest, { ...validManifest, templates: [duplicate] })
  })

  it('rejects two wrapped templates that overlap across the antimeridian seam', () => {
    // A sort-and-sweep over minX misses this: both wrapped boxes start high and end low, so the
    // early break skips the comparison and the forbidden same-group overlap decodes clean.
    const wrapped = (id: number) => ({
      ...validTemplate,
      id: uuid(500 + id),
      version: uuid(600 + id),
      bbox: { minX: 2_047_000, minY: 0, maxX: 1_000, maxY: 1_000 },
      chunks: [{ tile: tileKey({ x: 2047, y: 0 }), hash: HASH }],
    })
    expectRejected(Manifest, {
      ...validManifest,
      templates: [wrapped(1), wrapped(2)],
      tiles: [tileKey({ x: 2047, y: 0 })],
    })
  })

  it.each([
    // Both halves of the wrapped span must be compared against the unwrapped one. Pairing two
    // wrapped boxes — as the seam test above does — leaves either half deletable, because whichever
    // half survives still reports the overlap. Only a wrapped-against-unwrapped pair separates them.
    ['the low half, past the seam', { minX: 0, maxX: 500 }],
    ['the high half, before the seam', { minX: 2_047_500, maxX: 2_048_000 }],
  ])('rejects a wrapped template overlapping an unwrapped one on %s', (_, xs) => {
    const wrapped = {
      ...validTemplate,
      id: uuid(900),
      version: uuid(901),
      bbox: { minX: 2_047_000, minY: 0, maxX: 1_000, maxY: 1_000 },
      chunks: [{ tile: tileKey({ x: 2047, y: 0 }), hash: HASH }],
    }
    const unwrapped = {
      ...validTemplate,
      id: uuid(902),
      version: uuid(903),
      bbox: { ...xs, minY: 0, maxY: 1_000 },
      chunks: [{ tile: tileKey({ x: 0, y: 0 }), hash: HASH }],
    }
    expectRejected(Manifest, {
      ...validManifest,
      templates: [wrapped, unwrapped],
      tiles: [tileKey({ x: 2047, y: 0 }), tileKey({ x: 0, y: 0 })],
    })
  })

  it.each([
    // The tests above pin which halves the wrap splits into, but not where those halves end: both
    // spans overlap by hundreds of pixels, so moving an endpoint one pixel changes no outcome.
    // These two overlap on exactly one column each — the first on WORLD_PIXELS - 1, the last column
    // before the seam, and the second on column 0, the first one after it. Shrinking the high half
    // to WORLD_PIXELS - 1 or lifting the low half to 1 empties that interval and the overlap
    // disappears, so each endpoint now fails on its own.
    [
      'the last column before the seam',
      { minX: 2_047_999, maxX: 1_000 },
      { minX: 2_047_999, maxX: 2_048_000 },
      2047,
    ],
    ['the first column after the seam', { minX: 2_047_000, maxX: 1 }, { minX: 0, maxX: 1 }, 0],
  ])(
    'rejects a wrapped template overlapping an unwrapped one on %s',
    (_, wrappedX, unwrappedX, tile) => {
      const wrapped = {
        ...validTemplate,
        id: uuid(920),
        version: uuid(921),
        bbox: { ...wrappedX, minY: 0, maxY: 1_000 },
        chunks: [{ tile: tileKey({ x: 2047, y: 0 }), hash: HASH }],
      }
      const unwrapped = {
        ...validTemplate,
        id: uuid(922),
        version: uuid(923),
        bbox: { ...unwrappedX, minY: 0, maxY: 1_000 },
        chunks: [{ tile: tileKey({ x: tile, y: 0 }), hash: HASH }],
      }
      expectRejected(Manifest, {
        ...validManifest,
        templates: [wrapped, unwrapped],
        tiles: [...new Set([tileKey({ x: 2047, y: 0 }), tileKey({ x: tile, y: 0 })])],
      })
    },
  )

  it('accepts a wrapped template beside an unwrapped one that clears both of its halves', () => {
    const wrapped = {
      ...validTemplate,
      id: uuid(910),
      version: uuid(911),
      bbox: { minX: 2_047_000, minY: 0, maxX: 1_000, maxY: 1_000 },
      chunks: [{ tile: tileKey({ x: 2047, y: 0 }), hash: HASH }],
    }
    const unwrapped = {
      ...validTemplate,
      id: uuid(912),
      version: uuid(913),
      bbox: { minX: 1_000, minY: 0, maxX: 2_047_000, maxY: 1_000 },
      chunks: [{ tile: tileKey({ x: 1, y: 0 }), hash: HASH }],
    }
    const manifest = {
      ...validManifest,
      templates: [wrapped, unwrapped],
      tiles: [tileKey({ x: 2047, y: 0 }), tileKey({ x: 1, y: 0 })],
    }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

  it('accepts two wrapped templates that do not overlap in y', () => {
    const wrapped = (id: number, minY: number, maxY: number) => ({
      ...validTemplate,
      id: uuid(700 + id),
      version: uuid(800 + id),
      bbox: { minX: 2_047_000, minY, maxX: 1_000, maxY },
      chunks: [{ tile: tileKey({ x: 2047, y: minY / 1_000 }), hash: HASH }],
    })
    const manifest = {
      ...validManifest,
      templates: [wrapped(1, 0, 1_000), wrapped(2, 1_000, 2_000)],
      tiles: [tileKey({ x: 2047, y: 0 }), tileKey({ x: 2047, y: 1 })],
    }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

  it('accepts vertically adjacent templates in either manifest order', () => {
    const adjacent = (id: number, minY: number, maxY: number) => ({
      ...validTemplate,
      id: uuid(920 + id),
      version: uuid(930 + id),
      bbox: { minX: 0, minY, maxX: 1_000, maxY },
      chunks: [{ tile: tileKey({ x: 0, y: minY / 1_000 }), hash: HASH }],
    })
    const low = adjacent(1, 0, 1_000)
    const high = adjacent(2, 1_000, 2_000)
    for (const templates of [
      [low, high],
      [high, low],
    ]) {
      const manifest = { ...validManifest, templates, tiles: ['0/0', '0/1'] }
      expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
    }
  })

  it.each([
    [
      { minX: 2_047_999, maxX: 2_048_000 },
      { minX: 2_047_999, maxX: 2_048_000 },
    ],
    [
      { minX: 0, maxX: 1 },
      { minX: 0, maxX: 1 },
    ],
  ])('rejects overlap confined to a seam endpoint', (leftX, rightX) => {
    const makeTemplate = (id: number, x: { minX: number; maxX: number }) => ({
      ...validTemplate,
      id: uuid(940 + id),
      version: uuid(950 + id),
      bbox: { ...x, minY: 0, maxY: 1 },
    })
    expectRejected(Manifest, {
      ...validManifest,
      templates: [makeTemplate(1, leftX), makeTemplate(2, rightX)],
    })
  })

  it('rejects overlapping templates within one group', () => {
    const overlapping = {
      ...validTemplate,
      id: uuid(2),
      version: uuid(3),
      bbox: { ...validTemplate.bbox, minX: validTemplate.bbox.minX + 1 },
    }
    expectRejected(Manifest, { ...validManifest, templates: [validTemplate, overlapping] })
  })

  it('rejects milliseconds where seconds are required', () => {
    expectRejected(TileOffer, { tile: '0/0', sha256: HASH, ts: MILLIS })
  })

  it.each([
    // The disjointness tests above pin that seconds and milliseconds cannot be confused, and the
    // invalid-timestamp cases use 0, -1 and a fraction — all rejected by the sign or integer guard
    // whatever the epoch floor is. So the floor itself was free to move: raising it to 2021-01-01
    // survived the suite while silently rejecting every legitimate 2020 timestamp.
    ['the first instant of 2020, the epoch floor', 1_577_836_800, true],
    ['one second before the epoch floor', 1_577_836_799, false],
  ])('%s is accepted: %s', (_label, ts, accepted) => {
    const offer = { tile: '0/0', sha256: HASH, ts }
    if (accepted) expect(Schema.decodeUnknownSync(TileOffer)(offer)).toEqual(offer)
    else expectRejected(TileOffer, offer)
  })

  it('rejects seconds where milliseconds are required', () => {
    expectRejected(TemplateStatus, {
      templateId: TEMPLATE_ID,
      correct: 0,
      wrong: 0,
      blank: 0,
      total: 0,
      observedAt: SECONDS,
    })
  })

  it('rejects template status components whose sum exceeds total by one', () => {
    expectRejected(TemplateStatus, {
      templateId: TEMPLATE_ID,
      correct: 1,
      wrong: 1,
      blank: 0,
      total: 1,
      observedAt: MILLIS,
    })
  })

  it('rejects a node correct count above its total', () => {
    expectRejected(NodeStatus, {
      nodeId: NODE_ID,
      correct: 2,
      total: 1,
      templatesComplete: 1,
      templatesTotal: 1,
      observedAt: MILLIS,
    })
  })

  it('rejects a node complete count above its template total', () => {
    expectRejected(NodeStatus, {
      nodeId: NODE_ID,
      correct: 1,
      total: 1,
      templatesComplete: 2,
      templatesTotal: 1,
      observedAt: MILLIS,
    })
  })

  it.each([0, -1, 1_750_000_000.5])('rejects invalid seconds timestamp %s', (ts) => {
    expectRejected(TileOffer, { tile: '0/0', sha256: HASH, ts })
  })

  it.each([1e15, 1_750_000_000_000.5])(
    'rejects invalid milliseconds timestamp %s',
    (observedAt) => {
      expectRejected(TemplateStatus, {
        templateId: TEMPLATE_ID,
        correct: 0,
        wrong: 0,
        blank: 0,
        total: 0,
        observedAt,
      })
    },
  )
})
