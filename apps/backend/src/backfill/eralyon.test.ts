import { zstdCompressSync } from 'node:zlib'
import { TILE_SIZE, TRANSPARENT_INDEX } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { decodeArchiveTile, EralyonArchive, parseSnapshots } from './eralyon.js'

const block = (
  date: number,
  colour: number,
  edits: readonly [number, number][] = [],
): Uint8Array => {
  const raw = new Uint8Array(TILE_SIZE * TILE_SIZE + 8).fill(colour)
  const header = new DataView(raw.buffer)
  header.setUint32(0, TILE_SIZE, true)
  header.setUint32(4, TILE_SIZE, true)
  for (const [at, value] of edits) raw[8 + at] = value
  const compressed = zstdCompressSync(raw)
  const result = new Uint8Array(8 + compressed.length)
  const view = new DataView(result.buffer)
  view.setUint32(0, date, true)
  view.setUint32(4, compressed.length, true)
  result.set(compressed, 8)
  return result
}

describe('Eralyon archive decoder', () => {
  it('reconstructs a base and dated diffs, including erasure and all palette indices', () => {
    const bytes = new Uint8Array([
      ...block(0, 1, [[1, 63]]),
      ...block(24, 254, [
        [0, 0],
        [2, 7],
      ]),
    ])
    expect(decodeArchiveTile(bytes, 23)?.slice(0, 3)).toEqual(new Uint8Array([0, 62, 0]))
    expect(decodeArchiveTile(bytes, 24)?.slice(0, 3)).toEqual(
      new Uint8Array([TRANSPARENT_INDEX, 62, 6]),
    )
  })
  it('keeps absent history unknown and rejects incomplete bases and truncated blocks', () => {
    expect(decodeArchiveTile(block(24, 1), 23)).toBeNull()
    expect(decodeArchiveTile(new Uint8Array(), 24)).toBeNull()
    expect(() => decodeArchiveTile(block(0, 254), 24)).toThrow('incomplete base')
    expect(() => decodeArchiveTile(block(0, 1).subarray(0, 10), 24)).toThrow('Invalid archive')
  })
  it('derives dates in UTC and refuses changed catalogue formats', () => {
    expect(
      parseSnapshots("const WPLACE_VERSIONS = [{version: '24', date: 'ignored'}, {version: '0'}]"),
    ).toEqual([
      { id: 0, at: Date.parse('2025-01-01Z') / 1000 },
      { id: 24, at: Date.parse('2025-01-02Z') / 1000 },
    ])
    expect(() => parseSnapshots('unavailable')).toThrow('catalogue')
  })
  it('uses the original tile coordinates and weekly archive, without treating 404 as blank', async () => {
    const urls: string[] = []
    const archive = new EralyonArchive(async (input) => {
      urls.push(String(input))
      return new Response(null, { status: 404 })
    })
    expect(await archive.tile(169, { x: 123, y: 456 })).toBeNull()
    expect(urls).toEqual(['https://wplace.eralyon.net/tiles/1/11/123/456.zst'])
  })
})
