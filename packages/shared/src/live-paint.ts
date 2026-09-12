import { MAX_LIVE_MESSAGE_BYTES } from './live.js'
import type { LivePaintPart, PaintEvent } from './telemetry.js'

// Includes headroom for 100k-pixel events (~1.1 MiB), while bounding assembled JSON and parsing.
export const MAX_LIVE_PAINT_BYTES = 8 * 1024 * 1024
export const MAX_LIVE_PAINT_PARTS = 2048
export const LIVE_PAINT_ASSEMBLY_TTL_MS = 30_000
const MAX_PENDING_PAINTS = 4
const INITIAL_CHUNK_CODE_UNITS = 20 * 1024
const REQUEST_ID = '00000000-0000-7000-8000-000000000000'
const encoder = new TextEncoder()

/** Split a logical event into fragments whose complete JSON envelopes fit the live byte limit. */
export const encodeLivePaintParts = (
  event: PaintEvent,
  transferId: string,
): readonly LivePaintPart[] => {
  const encoded = JSON.stringify(event)
  if (encoder.encode(encoded).byteLength > MAX_LIVE_PAINT_BYTES)
    throw new RangeError('paint report exceeds assembly byte limit')
  const chunks: string[] = []
  for (let offset = 0; offset < encoded.length; ) {
    let length = Math.min(INITIAL_CHUNK_CODE_UNITS, encoded.length - offset)
    while (true) {
      const envelope = {
        type: 'paint-part',
        requestId: REQUEST_ID,
        transferId,
        eventId: event.eventId,
        season: event.season,
        index: MAX_LIVE_PAINT_PARTS,
        total: MAX_LIVE_PAINT_PARTS,
        chunk: encoded.slice(offset, offset + length),
      }
      if (encoder.encode(JSON.stringify(envelope)).byteLength <= MAX_LIVE_MESSAGE_BYTES) break
      length = Math.floor(length / 2)
      if (length === 0) throw new RangeError('paint part envelope exceeds live byte limit')
    }
    chunks.push(encoded.slice(offset, offset + length))
    offset += length
  }
  if (chunks.length > MAX_LIVE_PAINT_PARTS) throw new RangeError('paint report has too many parts')
  return chunks.map((chunk, index) => ({
    transferId,
    eventId: event.eventId,
    season: event.season,
    index,
    total: chunks.length,
    chunk,
  }))
}

interface PendingPaint {
  readonly transferId: string
  readonly eventId: string
  readonly season: number
  readonly total: number
  readonly chunks: string[]
  bytes: number
  expiresAt: number
}

/** Invalid parts are terminal; unavailable assemblies can restart with the original event ID. */
export class LivePaintAssemblyError extends Error {
  constructor(
    readonly code: 'invalid' | 'unavailable',
    message: string,
  ) {
    super(message)
  }
}

/** Authenticated owners get one ordered transfer each within a shared byte budget. */
export class LivePaintAssembler {
  private readonly pending = new Map<object, PendingPaint>()
  private bytes = 0

  /** Release an owner's incomplete report when its socket closes or authorization is lost. */
  discard(owner: object): void {
    const held = this.pending.get(owner)
    if (held === undefined) return
    this.bytes -= held.bytes
    this.pending.delete(owner)
  }

  /** Accept a schema-validated part; return JSON only after all parts arrive in order. */
  push(owner: object, part: LivePaintPart, now = Date.now()): string | null {
    for (const [key, held] of this.pending) if (held.expiresAt <= now) this.discard(key)
    let held = this.pending.get(owner)
    if (held?.transferId !== part.transferId) {
      if (part.index !== 0)
        throw new LivePaintAssemblyError('unavailable', 'paint transfer must restart')
      this.discard(owner)
      if (this.pending.size >= MAX_PENDING_PAINTS)
        throw new LivePaintAssemblyError('unavailable', 'paint assembly is busy')
      held = {
        transferId: part.transferId,
        eventId: part.eventId,
        season: part.season,
        total: part.total,
        chunks: [],
        bytes: 0,
        expiresAt: now + LIVE_PAINT_ASSEMBLY_TTL_MS,
      }
      this.pending.set(owner, held)
    }
    const reject = (message: string): never => {
      this.discard(owner)
      throw new LivePaintAssemblyError('invalid', message)
    }
    if (held.eventId !== part.eventId || held.season !== part.season || held.total !== part.total)
      return reject('paint transfer identity changed')
    if (part.index < held.chunks.length) {
      if (held.chunks[part.index] !== part.chunk) return reject('conflicting paint part')
      return null
    }
    if (part.index !== held.chunks.length) return reject('paint part arrived out of order')
    const bytes = encoder.encode(part.chunk).byteLength
    if (held.bytes + bytes > MAX_LIVE_PAINT_BYTES)
      return reject('paint report exceeds assembly byte limit')
    if (this.bytes + bytes > MAX_LIVE_PAINT_BYTES) {
      this.discard(owner)
      throw new LivePaintAssemblyError('unavailable', 'paint assembly byte budget is busy')
    }
    held.chunks.push(part.chunk)
    held.bytes += bytes
    held.expiresAt = now + LIVE_PAINT_ASSEMBLY_TTL_MS
    this.bytes += bytes
    if (held.chunks.length !== held.total) return null
    const encoded = held.chunks.join('')
    this.discard(owner)
    return encoded
  }
}
