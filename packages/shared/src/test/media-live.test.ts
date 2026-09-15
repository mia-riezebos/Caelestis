import { describe, expect, it } from 'vitest'
import {
  decodeLiveTileUpload,
  encodeLivePaintParts,
  encodeLiveTileUpload,
  LivePaintAssembler,
  LiveSnapshotAssembler,
  type LiveTileUpload,
  MAX_LIVE_MESSAGE_BYTES,
  seconds,
} from '../index.js'

const id = '018f4f2a-1234-7abc-8def-0123456789ab'

describe('media and live protocol contracts', () => {
  it('keeps binary tile metadata separate from payload bytes', () => {
    const metadata: LiveTileUpload = {
      type: 'tile-upload',
      requestId: id,
      deliveryId: id,
      wplaceUserId: 4,
      displayName: 'Mia',
      season: 0,
      tile: '1/2',
      sha256: 'a'.repeat(64),
      ts: seconds(1_700_000_000),
    }
    const framed = encodeLiveTileUpload(metadata, new Uint8Array([2, 4, 6]))
    expect(decodeLiveTileUpload(framed.buffer)).toEqual({
      metadata,
      payload: new Uint8Array([2, 4, 6]),
    })
    expect(decodeLiveTileUpload(framed.buffer.slice(0, 3))).toBeNull()
  })

  it('partitions, assembles, and rejects contradictory paint transfers', () => {
    const event = {
      eventId: id,
      wplaceUserId: 4,
      displayName: 'Mia',
      season: 0,
      ts: seconds(1_700_000_000),
      tiles: [
        {
          x: 1,
          y: 2,
          pixels: {
            x: Array.from({ length: 6000 }, (_, index) => index % 1000),
            y: Array.from({ length: 6000 }, (_, index) => Math.floor(index / 1000)),
            colors: Array.from({ length: 6000 }, () => 5),
          },
        },
      ],
      painted: 6000,
    }
    const parts = encodeLivePaintParts(event, id)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(
        new TextEncoder().encode(JSON.stringify({ type: 'paint-part', requestId: id, ...part }))
          .length,
      ).toBeLessThanOrEqual(MAX_LIVE_MESSAGE_BYTES)
    }
    const assembler = new LivePaintAssembler()
    const owner = {}
    let result: string | null = null
    for (const part of parts) result = assembler.push(owner, part, 100)
    expect(JSON.parse(result!)).toEqual(event)
    expect(() => assembler.push(owner, parts[0]!, 101)).toThrow('busy')
    assembler.finish(owner)
    expect(assembler.push(owner, parts[0]!, 102)).toBeNull()
    expect(assembler.push(owner, parts[0]!, 103)).toBeNull()
    expect(() => assembler.push(owner, { ...parts[0]!, chunk: 'different' }, 104)).toThrow(
      'conflicting',
    )
    expect(assembler.push(owner, parts[0]!, 105)).toBeNull()
    assembler.discard(owner)

    const broken = new LivePaintAssembler()
    expect(() => broken.push({}, { ...parts[0]!, index: 1 }, 100)).toThrow('restart')
  })

  it('expires an incomplete paint transfer and lets its owner restart', () => {
    const assembler = new LivePaintAssembler()
    const owner = {}
    const part = { transferId: id, eventId: id, season: 0, index: 0, total: 2, chunk: '{' }
    expect(assembler.push(owner, part, 0)).toBeNull()
    expect(
      assembler.push(
        owner,
        { ...part, transferId: '018f4f2a-1235-7abc-8def-0123456789ab', total: 1, chunk: '{}' },
        30_001,
      ),
    ).toBe('{}')
    expect(() => assembler.push(owner, { ...part, total: 1, chunk: 'x' }, 30_002)).toThrow('busy')
  })

  it('assembles out-of-order snapshot frames once the final missing frame arrives', () => {
    const snapshot = new LiveSnapshotAssembler()
    expect(
      snapshot.push({ type: 'snapshot-part', messageId: id, index: 1, total: 2, chunk: '1}' }),
    ).toBeNull()
    expect(
      snapshot.push({ type: 'snapshot-part', messageId: id, index: 0, total: 2, chunk: '{"a":' }),
    ).toEqual({ a: 1 })
    expect(() =>
      snapshot.push({ type: 'snapshot-part', messageId: id, index: 2, total: 2, chunk: '' }),
    ).toThrow()
  })

  it('passes ordinary server events through and clears incomplete snapshots', () => {
    const snapshot = new LiveSnapshotAssembler()
    expect(snapshot.push({ type: 'manifest', version: 'v1' })).toEqual({
      type: 'manifest',
      version: 'v1',
    })
    expect(
      snapshot.push({ type: 'snapshot-part', messageId: id, index: 0, total: 2, chunk: '{"a":' }),
    ).toBeNull()
    snapshot.clear()
    expect(
      snapshot.push({ type: 'snapshot-part', messageId: id, index: 1, total: 2, chunk: '1}' }),
    ).toBeNull()
  })
})
