import {
  decodePng,
  encodeIndexedPng,
  millis,
  PALETTE_RGB,
  type PixelBounds,
} from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import type { BlobListPage, BlobNamespace, BlobStore } from '../ports/index.js'
import { StoreTemplateError, storeTemplate } from './store.js'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

class CountingBlobStore implements BlobStore {
  readonly inner = new MemoryBlobStore()
  readonly puts: { namespace: BlobNamespace; hash: string }[] = []
  readonly hasAllCalls: { namespace: BlobNamespace; hashes: readonly string[] }[] = []

  async put(namespace: BlobNamespace, hash: string, bytes: Uint8Array): Promise<void> {
    this.puts.push({ namespace, hash })
    await this.inner.put(namespace, hash, bytes)
  }

  async get(namespace: BlobNamespace, hash: string): Promise<Uint8Array | null> {
    return this.inner.get(namespace, hash)
  }

  async delete(namespace: BlobNamespace, hashes: readonly string[]): Promise<void> {
    return this.inner.delete(namespace, hashes)
  }

  async hasAll(namespace: BlobNamespace, hashes: readonly string[]): Promise<ReadonlySet<string>> {
    this.hasAllCalls.push({ namespace, hashes: [...hashes] })
    return this.inner.hasAll(namespace, hashes)
  }

  async list(
    namespace: BlobNamespace,
    options: { cursor?: string; limit: number },
  ): Promise<BlobListPage> {
    return this.inner.list(namespace, options)
  }
}

const NODE_ID = '01890f3e-7b2c-7abc-8def-0123456789ab'

const harness = async () => {
  const sql = new MemorySqlStore()
  await sql.insertNode({
    id: NODE_ID,
    season: 1,
    parentId: null,
    path: '/test',
    name: 'Test',
    description: null,
    createdAt: millis(Date.now()),
  })
  return { blobs: new CountingBlobStore(), sql }
}

const input = (png: Uint8Array, overrides: { originX?: number; originY?: number } = {}) => ({
  season: 1,
  nodeId: '01890f3e-7b2c-7abc-8def-0123456789ab',
  name: 'Test template',
  createdWithToken: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  createdByUserId: null,
  originX: overrides.originX ?? 0,
  originY: overrides.originY ?? 0,
  png,
})

const rgba = (indices: readonly number[]): Uint8Array =>
  new Uint8Array(
    indices.flatMap((index) => {
      const colour = PALETTE_RGB[index]
      if (colour === undefined) throw new Error(`missing test palette colour ${index}`)
      return [...colour, 255]
    }),
  )

describe('storeTemplate', () => {
  it('round-trips exact palette colours through the stored chunk', async () => {
    const ports = await harness()
    const png = await encodeIndexedPng(2, 2, new Uint8Array([0, 1, 2, 3]))

    const stored = await storeTemplate(ports, input(png))

    expect(stored.templateId).toMatch(UUID_V7)
    expect(stored.versionId).toMatch(UUID_V7)
    expect(stored.chunks).toHaveLength(1)
    const chunk = stored.chunks[0]
    if (chunk === undefined) throw new Error('expected one stored chunk')
    const bytes = await ports.blobs.get('chunks', chunk.hash)
    if (bytes === null) throw new Error('stored chunk is missing')
    await expect(decodePng(bytes)).resolves.toEqual({
      width: 2,
      height: 2,
      pixels: rgba([0, 1, 2, 3]),
    })
    await expect(ports.sql.readTemplateVersion(stored.versionId)).resolves.toMatchObject({
      templateId: stored.templateId,
      bbox: stored.bbox,
      totalPixels: 4,
      colourTotals: [
        { index: 0, total: 1 },
        { index: 1, total: 1 },
        { index: 2, total: 1 },
        { index: 3, total: 1 },
      ],
      chunks: [{ tileX: 0, tileY: 0, hash: chunk.hash }],
    })
  })

  it('accepts a real indexed template larger than four million pixels', async () => {
    const ports = await harness()
    const width = 1_612
    const height = 2_584
    const png = await encodeIndexedPng(width, height, new Uint8Array(width * height))

    const stored = await storeTemplate(ports, input(png))

    expect(stored.totalPixels).toBe(width * height)
    expect(stored.chunks).toHaveLength(6)
  })

  it('stores separate hashes when painted pixels straddle a tile boundary', async () => {
    const ports = await harness()
    const png = await encodeIndexedPng(2, 1, new Uint8Array([0, 1]))

    const stored = await storeTemplate(ports, input(png, { originX: 999 }))

    expect(stored.bbox).toEqual<PixelBounds>({ minX: 999, minY: 0, maxX: 1001, maxY: 1 })
    expect(stored.chunks.map(({ tile }) => tile)).toEqual(['0/0', '1/0'])
    expect(new Set(stored.chunks.map(({ hash }) => hash)).size).toBe(2)
  })

  it('reuses identical chunk content without putting it again', async () => {
    const ports = await harness()
    const png = await encodeIndexedPng(2, 2, new Uint8Array([4, 4, 4, 4]))

    const first = await storeTemplate(ports, input(png))
    const second = await storeTemplate(ports, input(png))

    expect(second.chunks[0]?.hash).toBe(first.chunks[0]?.hash)
    expect(ports.blobs.puts).toHaveLength(1)
    expect(ports.blobs.hasAllCalls).toHaveLength(2)
    expect(ports.blobs.hasAllCalls.every(({ hashes }) => hashes.length === 1)).toBe(true)
  })

  it('replaces pixels after the template moves away from its former folder', async () => {
    const ports = await harness()
    const png = await encodeIndexedPng(1, 1, new Uint8Array([0]))
    const first = await storeTemplate(ports, input(png))
    const destination = '01890f3e-7b2c-7abc-8def-0123456789ac'
    await ports.sql.insertNode({
      id: destination,
      season: 1,
      parentId: null,
      path: '/destination',
      name: 'Destination',
      description: null,
      createdAt: millis(Date.now()),
    })
    await ports.sql.updateTemplate(first.templateId, { nodeId: destination }, millis(Date.now()))
    await ports.sql.deleteNode(NODE_ID)

    await expect(
      storeTemplate(ports, { ...input(png), templateId: first.templateId }),
    ).resolves.toMatchObject({ templateId: first.templateId })
    await expect(ports.sql.readTemplate(first.templateId)).resolves.toMatchObject({
      nodeId: destination,
    })
  })

  it('reports the live publication state after a concurrent replacement', async () => {
    const ports = await harness()
    const png = await encodeIndexedPng(1, 1, new Uint8Array([0]))
    const first = await storeTemplate(ports, input(png))
    const insert = ports.sql.insertTemplateVersion.bind(ports.sql)
    ports.sql.insertTemplateVersion = async (...args) => {
      await insert(...args)
      await ports.sql.setTemplatePublishedAt(first.templateId, millis(2_000), millis(2_000))
    }

    await expect(
      storeTemplate(ports, { ...input(png), templateId: first.templateId }),
    ).resolves.toMatchObject({ published: true })
  })

  it('refuses an upload spanning more than 400 tiles before encoding or storing chunks', async () => {
    const ports = await harness()
    const png = await encodeIndexedPng(401_000, 1, new Uint8Array(401_000))

    const error = await storeTemplate(ports, input(png)).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StoreTemplateError)
    expect(error).toHaveProperty('message', expect.stringMatching(/more than the 400/))
    expect(ports.blobs.hasAllCalls).toHaveLength(0)
    expect(ports.blobs.puts).toHaveLength(0)
  })
})
