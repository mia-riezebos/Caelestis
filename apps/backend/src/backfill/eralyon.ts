import {
  type ArchiveSnapshot,
  TILE_SIZE,
  type TileCoord,
  TRANSPARENT_INDEX,
} from '@caelestis/shared'
import { Decompress } from 'fzstd'

const ORIGIN = 'https://wplace.eralyon.net'
const EPOCH = Date.parse('2025-01-01T00:00:00Z') / 1_000
const IMAGE_BYTES = 8 + TILE_SIZE * TILE_SIZE
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const DIFF_UNCHANGED = 254

/** Read a bounded archive response, including responses without Content-Length. */
const readBytes = async (response: Response): Promise<Uint8Array> => {
  if (response.body === null) throw new Error('Eralyon returned an empty response.')
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.length
      if (length > MAX_RESPONSE_BYTES) throw new Error('Eralyon response exceeds the import limit.')
      parts.push(value)
    }
  } finally {
    await reader.cancel()
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

/** Parse only the site's version catalogue; display dates are derived from its numeric UTC IDs. */
export const parseSnapshots = (html: string): readonly ArchiveSnapshot[] => {
  const catalogue = /const WPLACE_VERSIONS\s*=\s*\[([^\]]+)\]/.exec(html)?.[1]
  if (catalogue === undefined) throw new Error('Eralyon snapshot catalogue could not be read.')
  const ids = new Set<number>()
  for (const match of catalogue.matchAll(/version:\s*'(\d+)'/g)) {
    const id = Number(match[1])
    if (!Number.isSafeInteger(id) || id > 1_000_000)
      throw new Error('Invalid Eralyon snapshot date.')
    ids.add(id)
  }
  if (ids.size === 0 || ids.size > 2_000)
    throw new Error('Unsupported Eralyon snapshot catalogue size.')
  return [...ids].sort((a, b) => a - b).map((id) => ({ id, at: EPOCH + id * 3_600 }))
}

const inflateImage = (bytes: Uint8Array): Uint8Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 6 || view.getUint32(0, true) !== 0xfd2fb528)
    throw new Error('Invalid archive compression.')
  const descriptor = bytes[4] ?? 0
  const single = (descriptor & 32) !== 0
  if ((descriptor & 3) !== 0 || (descriptor & 24) !== 0)
    throw new Error('Unsupported archive compression header.')
  let offset = single ? 5 : 6
  const sizeBytes = descriptor >> 6 ? 1 << (descriptor >> 6) : single ? 1 : 0
  if (sizeBytes === 8 || offset + sizeBytes > bytes.length)
    throw new Error('Unsupported archive image size.')
  let size = 0
  for (let i = 0; i < sizeBytes; i++) size += (bytes[offset + i] ?? 0) * 256 ** i
  if (sizeBytes === 2) size += 256
  const windowByte = bytes[5] ?? 0
  const baseWindow = 2 ** (10 + (windowByte >> 3))
  const windowSize = single ? size : baseWindow + (baseWindow / 8) * (windowByte & 7)
  if (windowSize > 2 * 1024 * 1024 || (sizeBytes > 0 && size !== IMAGE_BYTES))
    throw new Error('Archive image exceeds the tile dimensions.')
  offset += sizeBytes
  // Accept one Zstandard frame, so concatenated frames cannot bypass the window bound.
  for (;;) {
    if (offset + 3 > bytes.length) throw new Error('Truncated archive compression block.')
    const block =
      (bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) * 256 + (bytes[offset + 2] ?? 0) * 65_536
    const kind = (block >> 1) & 3
    if (kind === 3) throw new Error('Invalid archive compression block.')
    offset += 3 + (kind === 1 ? 1 : block >> 3)
    if (block & 1) break
  }
  if (descriptor & 4) offset += 4
  if (offset !== bytes.length) throw new Error('Invalid archive compression length.')
  const image = new Uint8Array(IMAGE_BYTES)
  let written = 0
  const decoder = new Decompress((part) => {
    if (written + part.length > image.length)
      throw new Error('Archive image exceeds the tile dimensions.')
    image.set(part, written)
    written += part.length
  })
  decoder.push(bytes, true)
  const header = new DataView(image.buffer)
  if (
    written !== IMAGE_BYTES ||
    header.getUint32(0, true) !== TILE_SIZE ||
    header.getUint32(4, true) !== TILE_SIZE
  )
    throw new Error('Archive tile must be 1000×1000 pixels.')
  return image.subarray(8)
}

/** Decode wimage's dated base/diff blocks at original zoom 11; absent history stays unknown. */
export const decodeArchiveTile = (bytes: Uint8Array, snapshotId: number): Uint8Array | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const blocks = new Map<number, Uint8Array>()
  let offset = 0
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('Truncated archive tile history.')
    const date = view.getUint32(offset, true)
    const length = view.getUint32(offset + 4, true)
    offset += 8
    if (length === 0 || offset + length > bytes.length || blocks.has(date))
      throw new Error('Invalid archive tile history block.')
    blocks.set(date, bytes.subarray(offset, offset + length))
    offset += length
    if (blocks.size > 256) throw new Error('Archive week contains too many tile revisions.')
  }
  let result: Uint8Array | null = null
  for (const [date, compressed] of [...blocks].sort(([a], [b]) => a - b)) {
    if (date > snapshotId) break
    const pixels = inflateImage(compressed)
    const base = result === null
    result ??= new Uint8Array(TILE_SIZE * TILE_SIZE)
    for (let i = 0; i < pixels.length; i++) {
      const colour = pixels[i] ?? 0
      if (colour === DIFF_UNCHANGED && !base) continue
      if (colour > 63)
        throw new Error('Archive contains unknown colours or an incomplete base image.')
      result[i] = colour === 0 ? TRANSPARENT_INDEX : colour - 1
    }
  }
  return result
}

/** One bounded upstream client; keep the last week of a few tiles warm across alarm batches. */
export class EralyonArchive {
  private readonly cache = new Map<string, Uint8Array | null>()
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async snapshots(): Promise<readonly ArchiveSnapshot[]> {
    const response = await this.fetchImpl(`${ORIGIN}/en/`, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok)
      throw new Error(`Eralyon catalogue returned HTTP ${response.status}. Try again.`)
    return parseSnapshots(new TextDecoder().decode(await readBytes(response)))
  }

  async tile(snapshotId: number, tile: TileCoord): Promise<Uint8Array | null> {
    const key = `${Math.floor(snapshotId / 168)}/11/${tile.x}/${tile.y}`
    let bytes = this.cache.get(key)
    if (bytes === undefined) {
      const response = await this.fetchImpl(`${ORIGIN}/tiles/${key}.zst`, {
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status !== 404 && !response.ok)
        throw new Error(`Eralyon tile returned HTTP ${response.status}.`)
      bytes = response.status === 404 ? null : await readBytes(response)
      if (this.cache.size >= 2) this.cache.clear()
      this.cache.set(key, bytes)
    }
    return bytes === null || bytes.length === 0 ? null : decodeArchiveTile(bytes, snapshotId)
  }
}
