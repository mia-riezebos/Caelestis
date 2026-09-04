import type { LiveSyncServerEvent, LiveTileUpload } from './telemetry.js'
import { uuidV7 } from './uuid.js'

export const MAX_LIVE_BINARY_HEADER_BYTES = 64 * 1024
export const MAX_LIVE_BINARY_PAYLOAD_BYTES = 8 * 1024 * 1024
export const MAX_LIVE_MESSAGE_BYTES = 64 * 1024
export const MAX_LIVE_SNAPSHOT_BYTES = 24 * 1024 * 1024
// JSON text costs at most three UTF-8 bytes per code unit. Keep 4 KiB for the part envelope.
const SNAPSHOT_CHUNK_CODE_UNITS = 20 * 1024
const MAX_SNAPSHOT_PARTS = Math.ceil(MAX_LIVE_SNAPSHOT_BYTES / SNAPSHOT_CHUNK_CODE_UNITS)

/** Frame upload metadata and PNG bytes as one retryable WebSocket message. */
export const encodeLiveTileUpload = (metadata: LiveTileUpload, payload: Uint8Array): Uint8Array => {
  const header = new TextEncoder().encode(JSON.stringify(metadata))
  if (header.byteLength > MAX_LIVE_BINARY_HEADER_BYTES)
    throw new RangeError('live header too large')
  if (payload.byteLength === 0 || payload.byteLength > MAX_LIVE_BINARY_PAYLOAD_BYTES) {
    throw new RangeError('live payload size is invalid')
  }
  const framed = new Uint8Array(4 + header.byteLength + payload.byteLength)
  new DataView(framed.buffer).setUint32(0, header.byteLength)
  framed.set(header, 4)
  framed.set(payload, 4 + header.byteLength)
  return framed
}

export const decodeLiveTileUpload = (
  value: ArrayBufferLike,
): { readonly metadata: unknown; readonly payload: Uint8Array } | null => {
  if (
    value.byteLength < 5 ||
    value.byteLength > 4 + MAX_LIVE_BINARY_HEADER_BYTES + MAX_LIVE_BINARY_PAYLOAD_BYTES
  ) {
    return null
  }
  const headerBytes = new DataView(value).getUint32(0)
  const payloadAt = 4 + headerBytes
  if (
    headerBytes === 0 ||
    headerBytes > MAX_LIVE_BINARY_HEADER_BYTES ||
    payloadAt >= value.byteLength
  ) {
    return null
  }
  try {
    const metadata = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(value, 4, headerBytes)),
    )
    return { metadata, payload: new Uint8Array(value, payloadAt) }
  } catch {
    return null
  }
}

/** Split only oversized snapshots. Small live events stay one message. */
export const encodeLiveServerEvent = (event: LiveSyncServerEvent): readonly string[] => {
  const encoded = JSON.stringify(event)
  const bytes = new TextEncoder().encode(encoded).byteLength
  if (bytes > MAX_LIVE_SNAPSHOT_BYTES) throw new RangeError('live snapshot too large')
  if (encoded.length <= SNAPSHOT_CHUNK_CODE_UNITS) return [encoded]
  const messageId = uuidV7()
  const total = Math.ceil(encoded.length / SNAPSHOT_CHUNK_CODE_UNITS)
  return Array.from({ length: total }, (_, index) =>
    JSON.stringify({
      type: 'snapshot-part',
      messageId,
      index,
      total,
      chunk: encoded.slice(
        index * SNAPSHOT_CHUNK_CODE_UNITS,
        (index + 1) * SNAPSHOT_CHUNK_CODE_UNITS,
      ),
    } satisfies LiveSyncServerEvent),
  )
}

interface PendingSnapshot {
  readonly chunks: string[]
  readonly total: number
  received: number
}

/** Reassemble bounded snapshot parts. Invalid or superseded streams are discarded. */
export class LiveSnapshotAssembler {
  private readonly pending = new Map<string, PendingSnapshot>()

  push(value: unknown): unknown | null {
    if (typeof value !== 'object' || value === null || !('type' in value)) return value
    const part = value as Record<string, unknown>
    if (part.type !== 'snapshot-part') return value
    if (
      typeof part.messageId !== 'string' ||
      !Number.isSafeInteger(part.index) ||
      !Number.isSafeInteger(part.total) ||
      Number(part.index) < 0 ||
      Number(part.total) < 1 ||
      Number(part.total) > MAX_SNAPSHOT_PARTS ||
      Number(part.index) >= Number(part.total) ||
      typeof part.chunk !== 'string' ||
      part.chunk.length > SNAPSHOT_CHUNK_CODE_UNITS
    ) {
      throw new TypeError('invalid live snapshot part')
    }
    const total = Number(part.total)
    const index = Number(part.index)
    let snapshot = this.pending.get(part.messageId)
    if (snapshot === undefined || snapshot.total !== total) {
      snapshot = { chunks: Array.from({ length: total }), total, received: 0 }
      this.pending.set(part.messageId, snapshot)
    }
    if (snapshot.chunks[index] === undefined) {
      snapshot.chunks[index] = part.chunk
      snapshot.received++
    }
    if (snapshot.received !== total) return null
    this.pending.delete(part.messageId)
    return JSON.parse(snapshot.chunks.join(''))
  }

  clear(): void {
    this.pending.clear()
  }
}
