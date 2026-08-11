import { millis, tileKey, WORLD_PIXELS, WORLD_TILES } from '@wts/shared'
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
const MILLIS = millis(SECONDS * 1_000)

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

/**
 * `count` distinct tile-local coordinates. Bulk fixtures used to repeat one coordinate, which the
 * uniqueness rule now rejects — and a fixture that repeats a coordinate cannot exercise a cap on
 * how many *distinct* pixels an event may carry, which is what those tests are for.
 */
const distinctPixels = (count: number) => ({
  x: Array.from({ length: count }, (_, index) => index % 1_000),
  y: Array.from({ length: count }, (_, index) => Math.floor(index / 1_000)),
  colors: Array.from({ length: count }, () => 0),
})
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
  published: true,
  createdAt: MILLIS,
}

const validNode = {
  id: NODE_ID,
  parentId: null,
  path: '/group',
  name: 'Group',
  createdAt: MILLIS,
}

const validManifest = {
  version: 'manifest-1',
  season: 1,
  server: { id: SERVER_ID, name: 'Server', auth: 'none' as const },
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

  it.each(['', '../../etc/passwd', 'A'.repeat(64), 'a', 'a'.repeat(63), 'a'.repeat(65)])(
    // The short cases matter: the pattern's {64} could become {1,64} with nothing failing, and this
    // value is both the R2 object key and the dedup identity, reachable via TileOffer.sha256.
    'rejects invalid SHA-256 digest %s',
    (hash) => {
      expectRejected(Chunk, { tile: '0/0', hash })
    },
  )

  it.each([
    // Nothing exercised the description cap at all, so it could move freely. It bounds both
    // ServerInfo.description and Node.path, and a network client controls both.
    ['a description at the cap', 4_096, true],
    ['a description one character past the cap', 4_097, false],
  ])('%s is accepted: %s', (_label, length, accepted) => {
    const server = {
      id: SERVER_ID,
      name: 'Server',
      auth: 'none',
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

  it('rejects an x/y length mismatch when y matches colours', () => {
    // The existing x/y case also breaks y === colors, so the first conjunct alone was deletable.
    expectRejected(PaintPixels, { x: [1, 2], y: [3], colors: [9] })
  })

  it.each([-1, 1.5, 1_000])('rejects invalid tile-local coordinate %s', (x) => {
    expectRejected(PaintPixels, { x: [x], y: [0], colors: [0] })
  })

  it.each([-1, 1.5, 999_999, Number.NaN])('rejects invalid palette index %s', (color) => {
    expectRejected(PaintPixels, { x: [0], y: [0], colors: [color] })
  })

  it('rejects a repeated pixel coordinate', () => {
    // `submitted` is derived by counting entries, and painted === submitted credits them all, so a
    // repeated coordinate is credited once per repeat for one physically painted pixel.
    expectRejected(PaintPixels, { x: [7, 7], y: [9, 9], colors: [1, 2] })
  })

  it('accepts coordinates that share only one axis', () => {
    // The uniqueness key must be the pair. Keying on either axis alone would reject an ordinary
    // horizontal or vertical stroke.
    const pixels = { x: [7, 7, 8], y: [9, 10, 9], colors: [1, 2, 3] }
    expect(Schema.decodeUnknownSync(PaintPixels)(pixels)).toEqual(pixels)
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
    const pixels = distinctPixels(1_001)
    expect(Schema.decodeUnknownSync(PaintPixels)(pixels)).toEqual(pixels)
  })

  it('caps one tile payload at the counter-store guardrail', () => {
    // Distinct coordinates, or the duplicate-coordinate rule does the rejecting and the cap this
    // test names can be raised a hundredfold with the suite green. `distinctPixels` exists for
    // exactly this and was applied to some fixtures and not this one.
    expectRejected(PaintPixels, distinctPixels(100_001))
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
    // can do the rejecting — provided the pixels are distinct. With repeated coordinates the
    // duplicate rule rejects first and this conjunct becomes deletable, which is what it was.
    expectRejected(PaintEvent, {
      ...validEvent,
      tiles: [
        { x: 0, y: 0, pixels: distinctPixels(100_000) },
        { x: 1, y: 0, pixels: { x: [0], y: [0], colors: [0] } },
      ],
      painted: 1,
    })
  })

  it('accepts a two-tile event summing to exactly the pixel total', () => {
    // The accept side of the same bound, so it fails whichever way the cap moves.
    const event = {
      ...validEvent,
      tiles: [
        { x: 0, y: 0, pixels: distinctPixels(50_000) },
        { x: 1, y: 0, pixels: distinctPixels(50_000) },
      ],
      painted: 100_000,
    }
    expect(Schema.decodeUnknownSync(PaintEvent)(event)).toEqual(event)
  })

  it('rejects a two-tile event one pixel over the total', () => {
    expectRejected(PaintEvent, {
      ...validEvent,
      tiles: [
        { x: 0, y: 0, pixels: distinctPixels(50_000) },
        { x: 1, y: 0, pixels: distinctPixels(50_001) },
      ],
      painted: 1,
    })
  })

  it('accepts an event submitting exactly the pixel total', () => {
    const event = {
      ...validEvent,
      tiles: [{ x: 0, y: 0, pixels: distinctPixels(100_000) }],
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

  it('rejects a repeated tile entry', () => {
    // Per-tile uniqueness does not cover this: repeating the whole entry reaches the same canvas
    // coordinates again, and submitted counts each entry.
    const tile = { x: 3, y: 4, pixels: { x: [1], y: [1], colors: [2] } }
    expectRejected(PaintEvent, { ...validEvent, tiles: [tile, tile], painted: 2 })
  })

  it('accepts tiles that only a correct packing keeps distinct', () => {
    // The duplicate-tile rule packs (x, y) as x * WORLD_TILES + y. Tiles (0, 1000) and (1, 0) are
    // distinct under that and collide under any smaller multiplier, so this is what pins the
    // constant — the existing multi-tile case uses tiles that stay distinct either way.
    const pixels = { x: [1], y: [1], colors: [2] }
    const event = {
      ...validEvent,
      tiles: [
        { x: 0, y: 1_000, pixels },
        { x: 1, y: 0, pixels },
      ],
      painted: 2,
    }
    expect(Schema.decodeUnknownSync(PaintEvent)(event)).toEqual(event)
  })

  it('accepts pixel coordinates that only a correct packing keeps distinct', () => {
    // Same argument one level down: the coordinate key is x * TILE_SIZE + y, so (0, 999) and (1, 0)
    // collide under any smaller multiplier and a legitimate two-pixel stroke would be rejected as a
    // repeat.
    const pixels = { x: [0, 1], y: [999, 0], colors: [1, 2] }
    expect(Schema.decodeUnknownSync(PaintPixels)(pixels)).toEqual(pixels)
  })

  it('accepts two distinct tiles carrying the same tile-local coordinate', () => {
    // The same offset in different tiles is a different canvas pixel, so it must stay legal.
    const pixels = { x: [1], y: [1], colors: [2] }
    const event = {
      ...validEvent,
      tiles: [
        { x: 3, y: 4, pixels },
        { x: 3, y: 5, pixels },
      ],
      painted: 2,
    }
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
  it('accepts a manifest for wplace season zero', () => {
    const manifest = { ...validManifest, season: 0 }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

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

  it('rejects duplicate node identifiers carrying different paths', () => {
    // Duplicating the whole node makes the path-uniqueness rule do the rejecting, which leaves the
    // id rule deletable. Distinct paths isolate it.
    const first = { id: uuid(100), parentId: null, path: '/one', name: 'One', createdAt: MILLIS }
    const second = { id: uuid(100), parentId: null, path: '/two', name: 'Two', createdAt: MILLIS }
    expectRejected(Manifest, {
      ...validManifest,
      nodes: [first, second],
      templates: [{ ...validTemplate, nodeId: first.id }],
    })
  })

  it('rejects duplicate node identifiers', () => {
    expectRejected(Manifest, { ...validManifest, nodes: [validNode, { ...validNode }] })
  })

  it('rejects duplicate template identifiers', () => {
    const duplicate = {
      ...validTemplate,
      version: uuid(4),
      bbox: { minX: 1_000, minY: 1_000, maxX: 2_000, maxY: 2_000 },
      chunks: [{ tile: tileKey({ x: 1, y: 1 }), hash: HASH }],
    }
    expectRejected(Manifest, {
      ...validManifest,
      templates: [validTemplate, duplicate],
      tiles: ['325/1781', tileKey({ x: 1, y: 1 })],
    })
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
        published: true,
        createdAt: MILLIS,
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

  it.each([
    // Each case is outside the box on ONE axis only. A corner-to-corner fixture is rejected by
    // either half alone, which leaves both halves individually deletable.
    ['x', { minX: 2_047_999, minY: 0, maxX: 2_048_000, maxY: 1_000 }],
    ['y', { minX: 0, minY: 2_047_999, maxX: 1_000, maxY: 2_048_000 }],
  ])('rejects a chunk tile outside its template bounding box in %s', (_axis, bbox) => {
    // Every reference still resolves, so this decoded clean: culling watches tile 0/0 while the
    // painted pixels are elsewhere on the canvas.
    expectRejected(Manifest, {
      ...validManifest,
      templates: [
        { ...validTemplate, bbox, chunks: [{ tile: tileKey({ x: 0, y: 0 }), hash: HASH }] },
      ],
      tiles: [tileKey({ x: 0, y: 0 })],
    })
  })

  it.each([
    // Each case is one tile away from the box on one axis, so it pins that boundary comparison and
    // no other. The existing cases sit ~2,000 tiles away and hold for any comparison at all.
    ['the tile row directly above', { minX: 0, minY: 1_000, maxX: 1_000, maxY: 2_000 }, 0, 0],
    ['the tile row directly below', { minX: 0, minY: 0, maxX: 1_000, maxY: 1_000 }, 0, 1],
    ['the tile column directly left', { minX: 1_000, minY: 0, maxX: 2_000, maxY: 1_000 }, 0, 0],
    ['the tile column directly right', { minX: 0, minY: 0, maxX: 1_000, maxY: 1_000 }, 1, 0],
  ])('rejects a chunk on %s of its bounding box', (_label, bbox, tileX, tileY) => {
    expectRejected(Manifest, {
      ...validManifest,
      templates: [
        {
          ...validTemplate,
          bbox,
          totalPixels: 1,
          chunks: [{ tile: tileKey({ x: tileX, y: tileY }), hash: HASH }],
        },
      ],
      tiles: [tileKey({ x: tileX, y: tileY })],
    })
  })

  it.each([
    // The accept side of the same four boundaries: one pixel of overlap is enough.
    ['above', { minX: 0, minY: 999, maxX: 1_000, maxY: 2_000 }, 0, 0],
    ['below', { minX: 0, minY: 0, maxX: 1_000, maxY: 1_001 }, 0, 1],
    ['left', { minX: 999, minY: 0, maxX: 2_000, maxY: 1_000 }, 0, 0],
    ['right', { minX: 0, minY: 0, maxX: 1_001, maxY: 1_000 }, 1, 0],
  ])(
    'accepts a chunk overlapping its bounding box by one pixel from %s',
    (_l, bbox, tileX, tileY) => {
      const template = {
        ...validTemplate,
        bbox,
        totalPixels: 1,
        chunks: [{ tile: tileKey({ x: tileX, y: tileY }), hash: HASH }],
      }
      const manifest = {
        ...validManifest,
        templates: [template],
        tiles: [tileKey({ x: tileX, y: tileY })],
      }
      expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
    },
  )

  it('accepts two horizontally adjacent templates in one group', () => {
    // The ordinary way an alliance tiles a large mural. The forward walk's expiry comparison decides
    // this, and only the vertical case was covered.
    const left = {
      ...validTemplate,
      id: uuid(130),
      version: uuid(131),
      bbox: { minX: 0, minY: 0, maxX: 1_000, maxY: 1_000 },
      chunks: [{ tile: tileKey({ x: 0, y: 0 }), hash: HASH }],
    }
    const right = {
      ...validTemplate,
      id: uuid(132),
      version: uuid(133),
      bbox: { minX: 1_000, minY: 0, maxX: 2_000, maxY: 1_000 },
      chunks: [{ tile: tileKey({ x: 1, y: 0 }), hash: HASH }],
    }
    const manifest = {
      ...validManifest,
      templates: [left, right],
      tiles: [tileKey({ x: 0, y: 0 }), tileKey({ x: 1, y: 0 })],
    }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

  it('accepts a chunk on each tile a wrapped bounding box touches', () => {
    // The chunk check has to respect the antimeridian split, or a legal wrapped template loses its
    // chunks on the low side of the seam.
    const template = {
      ...validTemplate,
      bbox: { minX: 2_047_000, minY: 0, maxX: 1_000, maxY: 1_000 },
      chunks: [
        { tile: tileKey({ x: 2047, y: 0 }), hash: HASH },
        { tile: tileKey({ x: 0, y: 0 }), hash: HASH },
      ],
    }
    const manifest = {
      ...validManifest,
      templates: [template],
      tiles: [tileKey({ x: 2047, y: 0 }), tileKey({ x: 0, y: 0 })],
    }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

  it.each([
    [
      'a node that is its own parent',
      [{ id: NODE_ID, parentId: NODE_ID, path: '/g', name: 'G', createdAt: MILLIS }],
    ],
    [
      'two nodes that name each other',
      [
        { id: uuid(20), parentId: uuid(21), path: '/a', name: 'A', createdAt: MILLIS },
        { id: uuid(21), parentId: uuid(20), path: '/b', name: 'B', createdAt: MILLIS },
      ],
    ],
  ])('rejects %s', (_label, nodes) => {
    // Every reference resolves, so the existence check accepts these and the result has no root.
    // They are rejected by the path rule rather than a cycle check — see the note on that filter.
    expectRejected(Manifest, {
      ...validManifest,
      nodes,
      // biome-ignore lint/style/noNonNullAssertion: the fixtures above are non-empty
      templates: [{ ...validTemplate, nodeId: nodes[0]!.id }],
    })
  })

  it('accepts a genuine two-level group tree', () => {
    const parent = {
      id: uuid(30),
      parentId: null,
      path: '/canada',
      name: 'Canada',
      createdAt: MILLIS,
    }
    const child = {
      id: uuid(31),
      parentId: parent.id,
      path: '/canada/toronto',
      name: 'Toronto',
      createdAt: MILLIS,
    }
    const manifest = {
      ...validManifest,
      nodes: [parent, child],
      templates: [{ ...validTemplate, nodeId: child.id }],
    }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

  it('rejects two nodes sharing one path', () => {
    // path is the prefix-rollup key, so duplicates make a rollup attribute one group's templates to
    // another.
    const first = { id: uuid(40), parentId: null, path: '/canada', name: 'A', createdAt: MILLIS }
    const second = { id: uuid(41), parentId: null, path: '/canada', name: 'B', createdAt: MILLIS }
    expectRejected(Manifest, {
      ...validManifest,
      nodes: [first, second],
      templates: [{ ...validTemplate, nodeId: first.id }],
    })
  })

  it('rejects a manifest whose chunks exceed the total cap', () => {
    // The per-template cap bounds no total: the same tiles may be covered repeatedly, which keeps
    // the declared union at 1,000 tiles while the chunk arrays sum past the cap.
    const tiles = Array.from({ length: 1_000 }, (_, index) => tileKey({ x: index, y: 0 }))
    const chunks = tiles.map((tile) => ({ tile, hash: HASH }))
    const nodes = Array.from({ length: 201 }, (_, index) => ({
      id: uuid(70_000 + index),
      parentId: null,
      path: `/bulk${index}`,
      name: 'Bulk',
      createdAt: MILLIS,
    }))
    const templates = nodes.map((node, index) => ({
      ...validTemplate,
      id: uuid(80_000 + index),
      nodeId: node.id,
      version: uuid(90_000 + index),
      bbox: { minX: 0, minY: 0, maxX: 1_000_000, maxY: 1_000 },
      totalPixels: 1_000,
      chunks,
    }))
    expectRejected(Manifest, { ...validManifest, nodes, templates, tiles })
  })

  it('accepts a manifest with exactly the total chunk cap', () => {
    // The reject case uses 201,000, comfortably over either way, so the boundary itself was free to
    // move and a manifest carrying exactly the documented cap would have been refused.
    const tiles = Array.from({ length: 1_000 }, (_, index) => tileKey({ x: index, y: 0 }))
    const chunks = tiles.map((tile) => ({ tile, hash: HASH }))
    const nodes = Array.from({ length: 200 }, (_, index) => ({
      id: uuid(60_000 + index),
      parentId: null,
      path: `/cap${index}`,
      name: 'Cap',
      createdAt: MILLIS,
    }))
    const templates = nodes.map((node, index) => ({
      ...validTemplate,
      id: uuid(61_000 + index),
      nodeId: node.id,
      version: uuid(62_000 + index),
      bbox: { minX: 0, minY: 0, maxX: 1_000_000, maxY: 1_000 },
      totalPixels: 1_000,
      chunks,
    }))
    const manifest = { ...validManifest, nodes, templates, tiles }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

  it('rejects an alarm that ends before it began', () => {
    // Both timestamps independently satisfy Millis, so a reversed interval decoded clean and any
    // consumer deriving a duration from it got a negative one.
    expectRejected(Alarm, {
      id: uuid(60),
      templateId: TEMPLATE_ID,
      kind: 'regression',
      pixelsLost: 1,
      firstSeen: MILLIS + 1,
      lastSeen: MILLIS,
    })
  })

  it('accepts an alarm observed within a single millisecond', () => {
    const alarm = {
      id: uuid(61),
      templateId: TEMPLATE_ID,
      kind: 'regression' as const,
      pixelsLost: 1,
      firstSeen: MILLIS,
      lastSeen: MILLIS,
    }
    expect(Schema.decodeUnknownSync(Alarm)(alarm)).toEqual(alarm)
  })

  it('rejects a template with a zero progress denominator', () => {
    // totalPixels divides every progress figure, so zero makes them NaN.
    expectRejected(Manifest, {
      ...validManifest,
      templates: [{ ...validTemplate, totalPixels: 0 }],
    })
  })

  it('rejects a published template carrying no chunk', () => {
    // It would contribute to progress while advertising no tile and no content to draw.
    expectRejected(Manifest, {
      ...validManifest,
      templates: [{ ...validTemplate, chunks: [] }],
      tiles: [],
    })
  })

  it('rejects a total pixel count larger than the bounding box', () => {
    // The non-transparent pixels of a template live inside its own box; a larger count pins every
    // progress figure near zero forever.
    // The chunk has to move with the box, or the chunk-in-bounds rule rejects this first and the
    // area bound stays deletable.
    expectRejected(Manifest, {
      ...validManifest,
      templates: [
        {
          ...validTemplate,
          bbox: { minX: 0, minY: 0, maxX: 2, maxY: 2 },
          totalPixels: 5,
          chunks: [{ tile: tileKey({ x: 0, y: 0 }), hash: HASH }],
        },
      ],
      tiles: [tileKey({ x: 0, y: 0 })],
    })
  })

  it('rejects a total pixel count larger than where its chunks meet its box', () => {
    // Both ceilings are loose where they disagree. This box is 1001x1001, so the area bound allows
    // just over a million; one chunk allows a million; and tile 1/1 covers pixels 1000..2000, so it
    // meets the box in exactly one pixel. 1_000_000 clears both while the template can hold 1 —
    // a denominator a million times the largest possible numerator, and progress pinned at 0.0001%
    // forever.
    expectRejected(Manifest, {
      ...validManifest,
      templates: [
        {
          ...validTemplate,
          bbox: { minX: 0, minY: 0, maxX: 1_001, maxY: 1_001 },
          totalPixels: 1_000_000,
          chunks: [{ tile: tileKey({ x: 1, y: 1 }), hash: HASH }],
        },
      ],
      tiles: [tileKey({ x: 1, y: 1 })],
    })
  })

  it('accepts a total pixel count filling the corner where a chunk meets its box', () => {
    const template = {
      ...validTemplate,
      bbox: { minX: 0, minY: 0, maxX: 1_001, maxY: 1_001 },
      totalPixels: 1,
      chunks: [{ tile: tileKey({ x: 1, y: 1 }), hash: HASH }],
    }
    const manifest = { ...validManifest, templates: [template], tiles: [tileKey({ x: 1, y: 1 })] }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

  it('counts both sides of the seam for a box that wraps', () => {
    // A wrapped box is two disjoint x ranges, one against each end of the canvas, and the chunks
    // that meet them are the first and last tiles of the row. One column each, one row tall, so 2
    // is the honest ceiling — sum only the span the box was written with and this decodes as 1.
    const chunks = [
      { tile: tileKey({ x: 0, y: 0 }), hash: HASH },
      { tile: tileKey({ x: WORLD_TILES - 1, y: 0 }), hash: HASH },
    ]
    const template = {
      ...validTemplate,
      bbox: { minX: WORLD_PIXELS - 1, minY: 0, maxX: 1, maxY: 1 },
      totalPixels: 2,
      chunks,
    }
    const manifest = {
      ...validManifest,
      templates: [template],
      tiles: chunks.map((chunk) => chunk.tile),
    }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
    expectRejected(Manifest, { ...manifest, templates: [{ ...template, totalPixels: 3 }] })
  })

  it('accepts a template painting every pixel of its bounding box', () => {
    const template = {
      ...validTemplate,
      bbox: { minX: 0, minY: 0, maxX: 2, maxY: 2 },
      totalPixels: 4,
      chunks: [{ tile: tileKey({ x: 0, y: 0 }), hash: HASH }],
    }
    const manifest = { ...validManifest, templates: [template], tiles: [tileKey({ x: 0, y: 0 })] }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

  it('rejects a root node carrying a nested path', () => {
    // A node with no parent sits at the top of the tree, so its path has exactly one segment.
    // Without this, a rootless-looking '/canada/toronto' rolls up under a '/canada' it never
    // declared a parent link to.
    expectRejected(Manifest, {
      ...validManifest,
      nodes: [{ ...validNode, parentId: null, path: '/canada/toronto' }],
    })
  })

  it.each([
    ['a path at the cap', 256, true],
    ['a path one character past the cap', 257, false],
  ])('%s is accepted: %s', (_label, length, accepted) => {
    // Paths had the description bound, so MAX_MANIFEST_NODES of them was ~442 MB on an array the
    // decoder refines only after building it.
    const node = { ...validNode, path: `/${'a'.repeat(length - 1)}` }
    const manifest = { ...validManifest, nodes: [node] }
    if (accepted) expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
    else expectRejected(Manifest, manifest)
  })

  it('rejects a node whose path skips a level below its parent', () => {
    // startsWith alone accepts /a/b/c under /a, which claims a level of hierarchy no node declares:
    // a rollup over /a/b finds nothing while /a/b/c's templates sit below it.
    const parent = {
      id: uuid(140),
      parentId: null,
      path: '/canada',
      name: 'Canada',
      createdAt: MILLIS,
    }
    const child = {
      id: uuid(141),
      parentId: parent.id,
      path: '/canada/on/toronto',
      name: 'T',
      createdAt: MILLIS,
    }
    expectRejected(Manifest, {
      ...validManifest,
      nodes: [parent, child],
      templates: [{ ...validTemplate, nodeId: child.id }],
    })
  })

  it('rejects a total pixel count larger than its chunks can carry', () => {
    // The box is the outer ceiling; the chunks are the real one. A box spanning many tiles while
    // declaring one chunk cannot hold more painted pixels than that tile does.
    expectRejected(Manifest, {
      ...validManifest,
      templates: [
        {
          ...validTemplate,
          bbox: { minX: 0, minY: 0, maxX: 3_000, maxY: 3_000 },
          totalPixels: 1_000_001,
          chunks: [{ tile: tileKey({ x: 0, y: 0 }), hash: HASH }],
        },
      ],
      tiles: [tileKey({ x: 0, y: 0 })],
    })
  })

  it('accepts a total pixel count filling exactly one chunk', () => {
    const template = {
      ...validTemplate,
      bbox: { minX: 0, minY: 0, maxX: 3_000, maxY: 3_000 },
      totalPixels: 1_000_000,
      chunks: [{ tile: tileKey({ x: 0, y: 0 }), hash: HASH }],
    }
    const manifest = { ...validManifest, templates: [template], tiles: [tileKey({ x: 0, y: 0 })] }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

  it('rejects a node whose path is not under its parent', () => {
    const parent = {
      id: uuid(50),
      parentId: null,
      path: '/canada',
      name: 'Canada',
      createdAt: MILLIS,
    }
    const child = {
      id: uuid(51),
      parentId: parent.id,
      path: '/usa/x',
      name: 'Stray',
      createdAt: MILLIS,
    }
    expectRejected(Manifest, {
      ...validManifest,
      nodes: [parent, child],
      templates: [{ ...validTemplate, nodeId: child.id }],
    })
  })

  it('rejects a stray path the length of its parent plus one segment', () => {
    // The test above is satisfied by the length alone: '/usa/x' is shorter than '/canada', so the
    // slice is empty and the leading-slash test rejects it without any prefix ever being compared.
    // Give the stray path the shape the slice expects and it decodes — '/norway/x'.slice(7) is
    // '/x', one clean segment — so parent_id says /canada and the prefix rollup says /norway.
    const parent = { id: uuid(52), parentId: null, path: '/canada', name: 'Canada' }
    const child = { id: uuid(53), parentId: parent.id, path: '/norway/x', name: 'Stray' }
    expectRejected(Manifest, {
      ...validManifest,
      nodes: [parent, child],
      templates: [{ ...validTemplate, nodeId: child.id }],
    })
  })

  it('rejects a child whose prefix matches its parent only in case', () => {
    // Paths are unique case-insensitively, so /Canada and /canada never coexist — but a child may
    // still spell its parent's prefix in the other case. SQLite's LIKE is ASCII-case-insensitive,
    // so /Canada/x does roll up under /canada; the case-sensitive comparison is the one that would
    // disagree with the database, so the prefix test folds case the way the uniqueness rule does.
    const parent = {
      id: uuid(54),
      parentId: null,
      path: '/canada',
      name: 'Canada',
      createdAt: MILLIS,
    }
    const child = {
      id: uuid(55),
      parentId: parent.id,
      path: '/Canada/x',
      name: 'Child',
      createdAt: MILLIS,
    }
    const manifest = {
      ...validManifest,
      nodes: [parent, child],
      templates: [{ ...validTemplate, nodeId: child.id }],
    }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

  it('rejects two paths differing only in case', () => {
    // SQLite's LIKE is ASCII-case-insensitive, so with both stored the documented
    // `LIKE '<old>/%'` subtree move rewrites the other one's descendants too.
    expectRejected(Manifest, {
      ...validManifest,
      nodes: [
        { id: uuid(110), parentId: null, path: '/Canada', name: 'Upper', createdAt: MILLIS },
        { id: uuid(111), parentId: null, path: '/canada', name: 'Lower', createdAt: MILLIS },
      ],
      templates: [{ ...validTemplate, nodeId: uuid(110) }],
    })
  })

  it('rejects more declared tiles than the templates carry chunks', () => {
    // tiles is the union of every chunk tile, so it cannot be longer than the chunk total. Checked
    // before the Sets are built, so an untrusted manifest cannot make the decoder materialise a
    // canvas-sized tile list on its way to being rejected for the same reason.
    expectRejected(Manifest, {
      ...validManifest,
      tiles: [...validManifest.tiles, tileKey({ x: 9, y: 9 })],
    })
  })

  it('rejects two paths differing in a later ASCII letter only', () => {
    // The case pair above differs in its first letter, so a fold that stops after one replacement
    // still collapses them. SQLite's lower() folds the whole string, so /cANada and /canada collide
    // on nodes_path_idx and each would rewrite the other's subtree on a move.
    expectRejected(Manifest, {
      ...validManifest,
      nodes: [
        { id: uuid(116), parentId: null, path: '/cANada', name: 'Mixed' },
        { id: uuid(117), parentId: null, path: '/canada', name: 'Lower' },
      ],
      templates: [{ ...validTemplate, nodeId: uuid(116) }],
    })
  })

  it('accepts two paths differing only in a non-ASCII case pair', () => {
    // The case rule exists because SQLite's LIKE is ASCII-case-insensitive, and so is the unique
    // index on lower(path). É and é are distinct to both, so D1 stores these two rows and a subtree
    // move over one cannot capture the other. Folding with JavaScript's Unicode-aware toLowerCase
    // collapsed them here instead, leaving the manifest endpoint unable to emit a decodable
    // manifest for state the database had accepted.
    const upper = {
      id: uuid(113),
      parentId: null,
      path: '/QUÉBEC',
      name: 'Upper',
      createdAt: MILLIS,
    }
    const lower = {
      id: uuid(114),
      parentId: null,
      path: '/québec',
      name: 'Lower',
      createdAt: MILLIS,
    }
    const manifest = {
      ...validManifest,
      nodes: [upper, lower],
      templates: [{ ...validTemplate, nodeId: upper.id }],
    }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

  it.each(['/हिंदी', `/café`])('accepts the path %o, which needs combining marks', (path) => {
    // Letters and digits alone are not enough to write a name in. Devanagari carries its vowels as
    // separate mark codepoints, and any name at all can arrive decomposed — 'café' as 'cafe' plus
    // U+0301 is the same string a macOS client sends. Both were rejected outright, which is the
    // ASCII-only restriction the pattern was widened to remove, just one category further out.
    // Marks are allowed only after a letter or digit, so a segment still cannot open with one, and
    // neither LIKE metacharacter is a mark.
    const node = { id: uuid(115), parentId: null, path, name: 'Group', createdAt: MILLIS }
    const manifest = {
      ...validManifest,
      nodes: [node],
      templates: [{ ...validTemplate, nodeId: node.id }],
    }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

  it.each([`/́cafe`, '/x/́y'])('rejects the path %o, which opens a segment with a mark', (path) => {
    expectRejected(Manifest, { ...validManifest, nodes: [{ ...validNode, path }] })
  })

  it('accepts a path with non-ASCII letters', () => {
    // Alliances are not all anglophone, and D1 stores these happily — an ASCII-only pattern made a
    // legitimate stored path impossible to emit in a manifest.
    const node = {
      id: uuid(112),
      parentId: null,
      path: '/québec',
      name: 'Québec',
      createdAt: MILLIS,
    }
    const manifest = {
      ...validManifest,
      nodes: [node],
      templates: [{ ...validTemplate, nodeId: node.id }],
    }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

  it.each(['/canada%', '/canada_x', 'canada', '/', '/canada/', '/canada//x'])(
    'rejects the unusable node path %o',
    (path) => {
      // % and _ are LIKE metacharacters, and path is the subtree-rewrite key: '/canada%' captures
      // sibling subtrees on a move and '/%' captures the whole tree.
      expectRejected(Manifest, {
        ...validManifest,
        nodes: [{ ...validNode, path }],
      })
    },
  )

  it('accepts many templates stacked in one x column', () => {
    // The sweep's structural worst case: every span shares an x interval, so all of them stay
    // active at once and only the y ordering separates them. It is also a shape the all-pairs scan
    // this replaced handled by brute force, so it has to keep working.
    const templates = Array.from({ length: 400 }, (_, index) => ({
      ...validTemplate,
      id: uuid(3_000 + index),
      version: uuid(4_000 + index),
      bbox: { minX: 1, minY: 2 * index, maxX: 2, maxY: 2 * index + 1 },
      chunks: [{ tile: tileKey({ x: 0, y: 0 }), hash: HASH }],
    }))
    const manifest = { ...validManifest, templates, tiles: [tileKey({ x: 0, y: 0 })] }
    expect(Schema.decodeUnknownSync(Manifest)(manifest)).toEqual(manifest)
  })

  it('accepts two wrapped templates in one group', () => {
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

  it('counts blank towards the status total', () => {
    // The case above is satisfied by correct + wrong alone, so the `blank` term was droppable —
    // leaving the one invariant that ties the three classification buckets to the progress
    // denominator enforced for two of its three terms.
    expectRejected(TemplateStatus, {
      templateId: TEMPLATE_ID,
      correct: 0,
      wrong: 0,
      blank: 5,
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
