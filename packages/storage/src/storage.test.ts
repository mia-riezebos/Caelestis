import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateBucketCommand, DeleteBucketCommand } from '@aws-sdk/client-s3'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilesystemObjectStorage } from './filesystem.js'
import type { ObjectStorage } from './index.js'
import { R2ObjectStorage } from './r2.js'
import { S3ObjectStorage } from './s3.js'

type Harness = { storage: ObjectStorage; close(): Promise<void> }
const adapters: { name: string; make(): Promise<Harness> }[] = [
  {
    name: 'filesystem',
    async make() {
      const directory = await mkdtemp(join(tmpdir(), 'caelestis-objects-'))
      return {
        storage: new FilesystemObjectStorage(directory),
        close: () => rm(directory, { recursive: true, force: true }),
      }
    },
  },
  {
    name: 'R2',
    async make() {
      const runtime = new Miniflare(
        convertV4MiniflareOptions({
          modules: true,
          script: 'export default { fetch() { return new Response(null) } }',
          r2Buckets: ['OBJECTS'],
        }),
      )
      return {
        storage: new R2ObjectStorage(await runtime.getR2Bucket('OBJECTS')),
        close: () => runtime.dispose(),
      }
    },
  },
]
const testS3Endpoint = process.env.CAELESTIS_TEST_S3_ENDPOINT
if (testS3Endpoint)
  adapters.push({
    name: 'S3',
    async make() {
      const bucket = `caelestis-test-${crypto.randomUUID()}`
      const storage = new S3ObjectStorage(bucket, {
        endpoint: testS3Endpoint,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: { accessKeyId: 'caelestis-test', secretAccessKey: 'caelestis-test-password' },
      })
      await storage.client.send(new CreateBucketCommand({ Bucket: bucket }))
      return {
        storage,
        async close() {
          await storage.delete((await storage.list('', { limit: 1000 })).keys)
          await storage.client.send(new DeleteBucketCommand({ Bucket: bucket }))
          storage.close()
        },
      }
    },
  })

describe.each(adapters)('$name object storage', ({ make }) => {
  let harness: Harness
  beforeEach(async () => {
    harness = await make()
  })
  afterEach(() => harness?.close())

  it('round-trips binary bytes, metadata, and content type', async () => {
    const bytes = new Uint8Array([0, 255, 1, 128])
    const metadata = { version: 'v1', Name: 'Grüße' }
    const created = await harness.storage.put('chunks/hash', bytes, {
      contentType: 'image/png',
      metadata,
    })
    expect(created).toMatchObject({ size: 4, contentType: 'image/png', metadata })
    expect(created?.etag.length).toBeGreaterThan(0)
    expect(created?.uploadedAt).toBeGreaterThan(0)
    const read = await harness.storage.get('chunks/hash')
    expect(read).toMatchObject({ size: 4, contentType: 'image/png', metadata, etag: created?.etag })
    expect([...(read?.bytes ?? [])]).toEqual([...bytes])
    expect(await harness.storage.head('chunks/hash')).toEqual(created)
  })

  it('admits exactly one competing create-if-absent without replacing its data', async () => {
    const results = await Promise.all(
      [1, 2].map((number) =>
        harness.storage.put('social/poster', new Uint8Array([number]), {
          ifAbsent: true,
          metadata: { winner: String(number) },
        }),
      ),
    )
    expect(results.filter((result) => result !== null)).toHaveLength(1)
    const read = await harness.storage.get('social/poster')
    expect(String(read?.bytes[0])).toBe(read?.metadata.winner)
    expect(
      await harness.storage.put('social/poster', new Uint8Array([3]), { ifAbsent: true }),
    ).toBeNull()
  })

  it('returns complete overwritten objects and treats missing deletes as successful', async () => {
    await harness.storage.put('social/poster', new Uint8Array([1]), {
      metadata: { version: 'old' },
    })
    await harness.storage.put('social/poster', new Uint8Array([2, 3]), {
      metadata: { version: 'new' },
    })
    expect(await harness.storage.get('social/poster')).toMatchObject({
      bytes: new Uint8Array([2, 3]),
      metadata: { version: 'new' },
    })
    await harness.storage.delete(['social/poster', 'social/missing', 'social/poster'])
    expect(await harness.storage.get('social/poster')).toBeNull()
    expect(await harness.storage.head('social/poster')).toBeNull()
  })

  it('paginates namespace keys without duplicates or leaking another namespace', async () => {
    for (const key of ['chunks/c', 'chunks/a', 'tiles/a', 'chunks/nested/b', 'chunks/b'])
      await harness.storage.put(key, new Uint8Array([1]))
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await harness.storage.list('chunks/', {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      })
      expect(page.keys.length).toBeLessThanOrEqual(2)
      keys.push(...page.keys)
      cursor = page.cursor
    } while (cursor !== undefined)
    expect(keys).toEqual(['chunks/a', 'chunks/b', 'chunks/c', 'chunks/nested/b'])
  })

  it('rejects path traversal and unbounded page requests', async () => {
    await expect(harness.storage.put('chunks/../../outside', new Uint8Array())).rejects.toThrow(
      'Invalid object key',
    )
    await expect(harness.storage.list('', { limit: 1001 })).rejects.toThrow('Object page limit')
  })
})

it('reopens filesystem objects with their metadata intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caelestis-reopen-'))
  try {
    const first = new FilesystemObjectStorage(directory)
    const created = await first.put('archives/import', new Uint8Array([1, 2]), {
      metadata: { job: 'resume' },
    })
    const second = new FilesystemObjectStorage(directory)
    expect(await second.head('archives/import')).toEqual(created)
    expect((await second.get('archives/import'))?.bytes).toEqual(new Uint8Array([1, 2]))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
