import {
  decodeLiveTileUpload,
  encodeLiveServerEvent,
  encodeLiveTileUpload,
  isWorkItem,
  LiveSnapshotAssembler,
  type LiveSyncServerEvent,
  MAX_LIVE_PROJECTIONS,
  seconds as timestamp,
} from '@caelestis/shared'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  LiveSyncClientEvent,
  LiveTileUpload,
  PresenceServerEvent,
  RegionClaimRequest,
  StatusDelta,
  TileOfferResponse,
  TileUploadResponse,
} from '../index.js'

const id = '018f4f2a-1234-7abc-8def-0123456789ab'
const otherId = '018f4f2a-1235-7abc-8def-0123456789ab'
const hash = 'a'.repeat(64)
const seconds = 1_700_000_000
const millis = seconds * 1_000
const painter = { wplaceUserId: 4, displayName: 'Mia' }

const decode = (schema: Schema.ConstraintDecoder<unknown>, value: unknown): unknown =>
  Schema.decodeUnknownSync(schema)(value)
const rejected = (schema: Schema.ConstraintDecoder<unknown>, value: unknown): void => {
  expect(() => decode(schema, value)).toThrow()
}
const decodeServerFrame = (event: LiveSyncServerEvent): unknown => {
  const [frame] = encodeLiveServerEvent(event)
  if (frame === undefined) throw new Error('live event did not produce a frame')
  return new LiveSnapshotAssembler().push(JSON.parse(frame))
}

const projection = { resource: 'world-manifest' as const, scope: 'world', version: null }
const stateVector = {
  type: 'state-vector' as const,
  requestId: id,
  revision: null,
  projections: [projection],
}
const document = {
  items: [
    {
      id: 'claim',
      op: 'add' as const,
      shape: { kind: 'rectangle' as const, x: 0, y: 0, w: 1, h: 1 },
    },
  ],
}

describe('live protocol decoder contracts', () => {
  it('preserves v1 and v2 server events through a live frame', () => {
    const correction = {
      type: 'state-correction' as const,
      requestId: id,
      mode: 'correction' as const,
      revision: 6,
      projections: [projection],
    }

    expect(decodeServerFrame({ type: 'ready', revision: 6 })).toEqual({
      type: 'ready',
      revision: 6,
    })
    expect(decodeServerFrame(correction)).toEqual(correction)
    expect(
      decodeServerFrame({
        type: 'manifest-reconcile',
        revision: 6,
        surface: { kind: 'world', allianceId: null },
      } satisfies LiveSyncServerEvent),
    ).toEqual({
      type: 'manifest-reconcile',
      revision: 6,
      surface: { kind: 'world', allianceId: null },
    })
    expect(
      decodeServerFrame({
        type: 'paint-result',
        requestId: id,
        eventId: otherId,
        result: 'recorded',
      } satisfies LiveSyncServerEvent),
    ).toMatchObject({ type: 'paint-result', result: 'recorded' })
  })

  it('rejects duplicate and oversized projections from otherwise valid state messages', () => {
    expect(decode(LiveSyncClientEvent, stateVector)).toEqual(stateVector)
    rejected(LiveSyncClientEvent, {
      ...stateVector,
      projections: [projection, projection],
    })

    rejected(LiveSyncClientEvent, {
      ...stateVector,
      projections: Array.from({ length: MAX_LIVE_PROJECTIONS + 1 }, (_, index) => ({
        ...projection,
        scope: `world-${index}`,
      })),
    })
  })

  it('decodes hash-first offers, binary uploads, and their optional HTTP replies', () => {
    const batch = {
      ...painter,
      season: 0,
      offers: [{ deliveryId: otherId, tile: '1/2', sha256: hash, ts: timestamp(seconds) }],
    }
    const upload = {
      type: 'tile-upload' as const,
      requestId: id,
      deliveryId: otherId,
      ...painter,
      season: 0,
      tile: '1/2' as const,
      sha256: hash,
      ts: timestamp(seconds),
    }
    const framed = encodeLiveTileUpload(upload, new Uint8Array([1, 2, 3]))

    expect(decode(LiveSyncClientEvent, { type: 'tile-offer', requestId: id, batch })).toEqual({
      type: 'tile-offer',
      requestId: id,
      batch,
    })
    expect(decode(LiveTileUpload, upload)).toEqual(upload)
    expect(decodeLiveTileUpload(framed.buffer)).toEqual({
      metadata: upload,
      payload: new Uint8Array([1, 2, 3]),
    })
    const brokenFrame = framed.slice()
    new DataView(brokenFrame.buffer).setUint32(0, 0)
    expect(decodeLiveTileUpload(brokenFrame.buffer)).toBeNull()

    expect(decode(TileOfferResponse, { wanted: ['1/2'] })).toEqual({ wanted: ['1/2'] })
    expect(decode(TileUploadResponse, {})).toEqual({})
    expect(
      decodeServerFrame({
        type: 'tile-offer-result',
        requestId: id,
        response: {
          acknowledgedDeliveryIds: [id],
          wanted: [{ deliveryId: otherId, coverageToken: 'covered' }],
          rejectedDeliveryIds: [],
        },
      } satisfies LiveSyncServerEvent),
    ).toMatchObject({ type: 'tile-offer-result' })
  })

  it('keeps null and omitted legacy values distinct where the protocol allows both', () => {
    expect(decode(LiveSyncClientEvent, stateVector)).toEqual(stateVector)
    expect(
      decode(RegionClaimRequest, {
        document,
        label: '',
        actor: painter,
      }),
    ).toBeDefined()
    expect(
      decode(RegionClaimRequest, {
        templateId: null,
        document,
        label: '',
        actor: painter,
      }),
    ).toBeDefined()
  })

  it('enforces ordered deltas and public coordination collection bounds', () => {
    const delta = {
      baseRevision: 5,
      revision: 6,
      templates: [
        {
          templateId: id,
          correct: 1,
          wrong: 0,
          blank: 0,
          total: 1,
          observedAt: millis,
        },
      ],
      removedTemplateIds: [],
      invalidatedTiles: ['1/2'],
    }
    expect(decode(StatusDelta, delta)).toEqual(delta)
    rejected(StatusDelta, { ...delta, revision: 4 })

    const claimsRenewed = { type: 'claims-renewed' as const, expiresAt: millis, ids: [id] }
    expect(decode(PresenceServerEvent, claimsRenewed)).toEqual(claimsRenewed)
    rejected(PresenceServerEvent, {
      ...claimsRenewed,
      ids: Array.from({ length: 501 }, () => id),
    })

    const work = {
      id,
      season: 0,
      surface: { kind: 'world' as const, allianceId: null },
      claimant: painter,
      claimants: [painter],
      revision: 1,
      createdAt: millis,
      updatedAt: millis,
      title: 'Trace tiles',
      description: '',
      status: 'open' as const,
      priority: 'normal' as const,
      tags: [],
      blockerIds: [],
      nodeId: null,
      templateIds: [id],
    }
    expect(isWorkItem(work)).toBe(true)
    expect(
      isWorkItem({
        ...work,
        claimants: Array.from({ length: 1_001 }, (_, wplaceUserId) => ({
          wplaceUserId,
          displayName: 'Mia',
        })),
      }),
    ).toBe(false)
  })
})
