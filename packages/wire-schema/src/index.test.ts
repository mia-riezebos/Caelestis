import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  Chunk,
  Manifest,
  PaintEvent,
  PaintPixels,
  PaintTile,
  Template,
  TemplateStatus,
  TileOffer,
} from './index.js'

const HASH = 'a'.repeat(64)
const SECONDS = 1_750_000_000
const MILLIS = SECONDS * 1_000

const expectRejected = (schema: Schema.Schema.Any, value: unknown): void => {
  expect(() => Schema.decodeUnknownSync(schema)(value)).toThrow()
}

const validPixels = { x: [1], y: [2], colors: [3] }
const validEvent = {
  eventId: 'event-1',
  wplaceUserId: 123,
  displayName: 'Painter',
  season: 1,
  ts: SECONDS,
  tiles: [{ x: 325, y: 1781, pixels: validPixels }],
  painted: 1,
}

const validTemplate = {
  id: 'template-1',
  nodeId: 'node-1',
  name: 'Template',
  version: 'version-1',
  bbox: { minX: 325_000, minY: 1_781_000, maxX: 326_000, maxY: 1_782_000 },
  totalPixels: 1,
  chunks: [{ tile: '325/1781', hash: HASH }],
}

describe('tile and template schemas', () => {
  it.each(['2048/0', '999999/12', '01/2', '-1/2'])('rejects non-canonical tile key %s', (tile) => {
    expectRejected(TileOffer, { tile, sha256: HASH, ts: SECONDS })
  })

  it.each([2048, -1, 1.5])('rejects invalid paint-tile coordinate %s', (x) => {
    expectRejected(PaintTile, { x, y: 0, pixels: validPixels })
  })

  it('rejects out-of-world and inverted bounding boxes', () => {
    expectRejected(Template, {
      ...validTemplate,
      bbox: { minX: 5_000_000, minY: 0, maxX: -3, maxY: 0.5 },
    })
  })

  it('rejects a negative total pixel count', () => {
    expectRejected(Template, { ...validTemplate, totalPixels: -7 })
  })

  it.each(['', '../../etc/passwd', 'A'.repeat(64)])('rejects invalid SHA-256 digest %s', (hash) => {
    expectRejected(Chunk, { tile: '0/0', hash })
  })
})

describe('PaintPixels', () => {
  it('accepts equal-length coordinate and colour arrays', () => {
    expect(Schema.decodeUnknownSync(PaintPixels)({ x: [1, 2], y: [3, 4], colors: [5, 6] })).toEqual(
      { x: [1, 2], y: [3, 4], colors: [5, 6] },
    )
  })

  it('rejects unequal-length coordinate and colour arrays', () => {
    expectRejected(PaintPixels, { x: [1, 2], y: [3], colors: [5, 6] })
  })

  it.each([-1, 1.5, 1_000])('rejects invalid tile-local coordinate %s', (x) => {
    expectRejected(PaintPixels, { x: [x], y: [0], colors: [0] })
  })

  it.each([-1, 1.5, 999_999, Number.NaN])('rejects invalid palette index %s', (color) => {
    expectRejected(PaintPixels, { x: [0], y: [0], colors: [color] })
  })

  it('caps the number of submitted pixels', () => {
    const values = Array.from({ length: 1_001 }, () => 0)
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

  it('caps display-name length', () => {
    expectRejected(PaintEvent, { ...validEvent, displayName: 'x'.repeat(65) })
  })
})

describe('cross-field and time-unit schemas', () => {
  it('requires manifest tiles to exactly match the unique tiles referenced by chunks', () => {
    expectRejected(Manifest, {
      version: 'version-1',
      server: { id: 'server-1', name: 'Server', requiresAuth: false },
      nodes: [],
      templates: [validTemplate],
      tiles: [],
    })
  })

  it('rejects milliseconds where seconds are required', () => {
    expectRejected(TileOffer, { tile: '0/0', sha256: HASH, ts: MILLIS })
  })

  it('rejects seconds where milliseconds are required', () => {
    expectRejected(TemplateStatus, {
      templateId: 'template-1',
      correct: 0,
      wrong: 0,
      blank: 0,
      total: 0,
      observedAt: SECONDS,
    })
  })
})
