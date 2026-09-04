import { describe, expect, it } from 'vitest'
import {
  decodeLiveTileUpload,
  encodeLiveServerEvent,
  encodeLiveTileUpload,
  LiveSnapshotAssembler,
  MAX_LIVE_MESSAGE_BYTES,
} from './live.js'
import type { LiveTileUpload } from './telemetry.js'

const metadata: LiveTileUpload = {
  type: 'tile-upload',
  requestId: '01890f3a-6b7c-7def-8123-456789abcde1',
  deliveryId: '01890f3a-6b7c-7def-8123-456789abcde2',
  wplaceUserId: 7,
  displayName: 'Mia',
  season: 0,
  tile: '1/2',
  sha256: 'a'.repeat(64),
  ts: 1_750_000_000 as never,
}

describe('live framing', () => {
  it('round-trips one binary tile upload', () => {
    const framed = encodeLiveTileUpload(metadata, new Uint8Array([1, 2, 3]))
    const decoded = decodeLiveTileUpload(framed.buffer)
    expect(decoded?.metadata).toEqual(metadata)
    expect(decoded?.payload).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('rejects truncated binary frames', () => {
    expect(decodeLiveTileUpload(new Uint8Array([0, 0, 0, 8, 1]).buffer)).toBeNull()
  })

  it('bounds and reassembles a multibyte snapshot', () => {
    const padding = '漢'.repeat(100_000)
    const messages = encodeLiveServerEvent({
      type: 'alarms-snapshot',
      alarms: { alarms: [], version: 'a'.repeat(64) },
      padding,
    } as never)
    const assembler = new LiveSnapshotAssembler()
    let decoded: unknown = null
    for (const message of messages) {
      expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(
        MAX_LIVE_MESSAGE_BYTES,
      )
      decoded = assembler.push(JSON.parse(message)) ?? decoded
    }
    expect(decoded).toMatchObject({ type: 'alarms-snapshot', padding })
  })
})
