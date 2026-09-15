import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  Alarm,
  ContributionsResponse,
  HistoryResponse,
  LeaderboardResponse,
  LiveDashboardSubscription,
  LiveSyncClientEvent,
  Manifest,
  PaintEvent,
  PaintPixels,
  PresenceClientEvent,
  PresenceDraft,
  RegionDocument,
  StatusDelta,
  StatusResponse,
  TemplateStatus,
  TileHistoryResponse,
} from '../index.js'

const id = '018f4f2a-1234-7abc-8def-0123456789ab'
const hash = 'a'.repeat(64)
const manifest = {
  version: 'catalog-1',
  season: 0,
  server: { id, name: 'Example', auth: 'none' as const },
  nodes: [{ id, parentId: null, path: '/atlas', name: 'Atlas', createdAt: 1_700_000_000_000 }],
  templates: [
    {
      id,
      nodeId: null,
      name: 'Map',
      version: id,
      bbox: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
      totalPixels: 1,
      chunks: [{ tile: '0/0', hash }],
      published: true,
      finished: false,
      finishedAt: null,
      timelapseFrozen: false,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
  ],
  tiles: ['0/0'],
}
const decode = (schema: Schema.ConstraintDecoder<unknown>, value: unknown): unknown =>
  Schema.decodeUnknownSync(schema)(value)
const invalid = (schema: Schema.ConstraintDecoder<unknown>, value: unknown): void => {
  expect(() => decode(schema, value)).toThrow()
}

describe('wire schema public contracts', () => {
  it('keeps presence nullability and region shape limits explicit', () => {
    expect(
      decode(PresenceClientEvent, { type: 'presence-update', viewport: null, draft: null }),
    ).toEqual({
      type: 'presence-update',
      viewport: null,
      draft: null,
    })
    invalid(PresenceClientEvent, { type: 'presence-update', viewport: { x: 0, y: 0, w: 0, h: 1 } })
    expect(
      decode(RegionDocument, {
        items: [{ id: 'brush', op: 'add', shape: { kind: 'rectangle', x: 1, y: 2, w: 3, h: 4 } }],
      }),
    ).toBeDefined()
    invalid(RegionDocument, {
      items: [
        {
          id: 'bad',
          op: 'add',
          shape: { kind: 'star', cx: 0, cy: 0, r: 5, inner: 5, points: 3, rotation: 0 },
        },
      ],
    })
  })

  it('rejects paint credit ambiguity while accepting a bounded event', () => {
    const event = {
      eventId: id,
      wplaceUserId: 1,
      displayName: 'Mia',
      season: 0,
      ts: 1_700_000_000,
      tiles: [{ x: 1, y: 2, pixels: { x: [3], y: [4], colors: [5] } }],
      painted: 1,
    }
    expect(decode(PaintEvent, event)).toEqual(event)
    invalid(PaintPixels, { x: [1, 1], y: [2, 2], colors: [3, 4] })
    invalid(PaintEvent, { ...event, painted: 2 })
  })

  it('preserves legacy omissions and nullability while rejecting impossible manifest geometry', () => {
    expect(decode(Manifest, manifest)).toEqual(manifest)
    expect(
      decode(Manifest, {
        ...manifest,
        templates: [{ ...manifest.templates[0]!, nodeId: null, finishedAt: null }],
      }),
    ).toBeDefined()
    invalid(Manifest, {
      ...manifest,
      templates: [{ ...manifest.templates[0]!, totalPixels: 1_000_001 }],
    })
    invalid(Manifest, {
      ...manifest,
      templates: [{ ...manifest.templates[0]!, chunks: [{ tile: '1/0', hash }] }],
    })
    invalid(Manifest, {
      ...manifest,
      nodes: [
        manifest.nodes[0],
        { ...manifest.nodes[0]!, id: '018f4f2a-1235-7abc-8def-0123456789ab', path: '/ATLAS' },
      ],
    })
  })

  it('keeps v1 and v2 live variants compatible while bounding subscriptions', () => {
    expect(
      decode(LiveSyncClientEvent, {
        type: 'paint-report',
        requestId: id,
        event: {
          eventId: id,
          wplaceUserId: 1,
          displayName: 'Mia',
          season: 0,
          ts: 1_700_000_000,
          tiles: [{ x: 1, y: 2, pixels: { x: [3], y: [4], colors: [5] } }],
          painted: null,
        },
      }),
    ).toMatchObject({ type: 'paint-report' })
    invalid(LiveDashboardSubscription, {
      subscriptionId: id,
      templateIds: [id, id],
      contributionsFrom: 1_700_000_000,
      leaderboardLimit: 5,
    })
    invalid(LiveSyncClientEvent, {
      type: 'paint-part',
      requestId: id,
      transferId: id,
      eventId: id,
      season: 0,
      index: 1,
      total: 1,
      chunk: 'x',
    })
    invalid(LiveSyncClientEvent, {
      type: 'state-vector',
      requestId: id,
      revision: null,
      projections: [
        { resource: 'world-manifest', scope: 'all', version: null },
        { resource: 'world-manifest', scope: 'all', version: null },
      ],
    })
  })

  it('rejects malformed presence masks at the public boundary', () => {
    expect(
      decode(PresenceDraft, { rect: { x: 0, y: 0, w: 8, h: 1 }, pixels: 1, mask: 'gA==' }),
    ).toBeDefined()
    invalid(PresenceDraft, { rect: { x: 0, y: 0, w: 8, h: 1 }, pixels: 1, mask: 'not-base64' })
  })

  it('enforces response ordering counters rather than only field shapes', () => {
    const status = {
      templateId: id,
      correct: 2,
      wrong: 1,
      blank: 0,
      total: 3,
      observedAt: 1_700_000_000_000,
    }
    expect(decode(TemplateStatus, status)).toEqual(status)
    invalid(StatusResponse, { templates: [{ ...status, correct: 4 }] })
  })

  it('checks telemetry response ordering, alignment, uniqueness, and time direction', () => {
    expect(
      decode(HistoryResponse, {
        resolution: 60,
        coverageStart: 1_700_000_040,
        buckets: [
          {
            templateId: id,
            resolution: 60,
            bucketStart: 1_700_000_040,
            placed: 3,
            correct: 2,
            repairs: 1,
          },
        ],
      }),
    ).toBeDefined()
    invalid(HistoryResponse, { resolution: 60, buckets: [] })
    const day = {
      templateId: id,
      day: 1_699_920_000,
      wplaceUserId: 1,
      displayName: 'Mia',
      placed: 2,
      correct: 1,
      repairs: 0,
    }
    expect(decode(ContributionsResponse, { days: [day] })).toEqual({ days: [day] })
    invalid(ContributionsResponse, { days: [day, day] })
    invalid(ContributionsResponse, { days: [{ ...day, day: day.day + 1 }] })
    invalid(Alarm, {
      id,
      templateId: id,
      kind: 'regression',
      pixelsLost: 1,
      firstSeen: 1_700_000_000_001,
      lastSeen: 1_700_000_000_000,
    })
    const delta = {
      baseRevision: 4,
      revision: 5,
      templates: [],
      removedTemplateIds: [],
      invalidateAllTiles: true,
    }
    expect(decode(StatusDelta, delta)).toEqual(delta)
    invalid(StatusDelta, { ...delta, revision: 3 })
    invalid(StatusDelta, { ...delta, invalidatedTiles: ['0/0'] })
    const leader = {
      wplaceUserId: 1,
      displayName: 'A',
      placed: 3,
      correct: 2,
      repairs: 0,
      activeDays: 1,
      lastDay: day.day,
    }
    const runnerUp = { ...leader, wplaceUserId: 2, placed: 2 }
    expect(decode(LeaderboardResponse, { entries: [leader, runnerUp] })).toEqual({
      entries: [leader, runnerUp],
    })
    invalid(LeaderboardResponse, { entries: [leader, leader] })
    invalid(LeaderboardResponse, { entries: [runnerUp, leader] })
    const frame = { bucketStart: 1_700_000_000, hash, reporters: 1 }
    expect(decode(TileHistoryResponse, { frames: [frame] })).toEqual({ frames: [frame] })
    invalid(TileHistoryResponse, { frames: [frame, frame] })
  })
})
