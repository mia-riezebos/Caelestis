import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateBucketCommand, DeleteBucketCommand } from '@aws-sdk/client-s3'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { FilesystemObjectStorage } from '../filesystem.js'
import { type ObjectStorage, validateObjectKey, validateObjectPage } from '../index.js'
import { R2ObjectStorage } from '../r2.js'
import { S3ObjectStorage } from '../s3.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

const verifyContract = (name: string, make: () => Promise<ObjectStorage>) => {
  describe(name, () => {
    it('preserves objects, enforces create-if-absent, and pages ordered keys', async () => {
      const storage = await make()
      expect(await storage.get('items/missing')).toBeNull()
      expect(await storage.head('items/missing')).toBeNull()
      const first = await storage.put('items/b', new Uint8Array([1, 2]), {
        ifAbsent: true,
        contentType: 'application/octet-stream',
        metadata: { source: 'test' },
      })
      expect(first).toMatchObject({ size: 2, metadata: { source: 'test' } })
      expect(await storage.put('items/b', new Uint8Array([9]), { ifAbsent: true })).toBeNull()
      expect(await storage.get('items/b')).toMatchObject({ bytes: new Uint8Array([1, 2]) })
      expect(await storage.head('items/b')).toMatchObject({
        size: 2,
        contentType: 'application/octet-stream',
        metadata: { source: 'test' },
      })
      await storage.put('items/a', new Uint8Array([3]))
      await storage.put('items/c', new Uint8Array([4]))
      const page = await storage.list('items/', { limit: 2 })
      expect(page.keys).toEqual(['items/a', 'items/b'])
      expect(page.cursor).toBeDefined()
      expect(
        await storage.list('items/', {
          limit: 2,
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        }),
      ).toMatchObject({
        keys: ['items/c'],
      })
      await storage.delete(['items/a', 'items/a', 'items/missing'])
      expect(await storage.head('items/a')).toBeNull()
    })

    it('allows exactly one concurrent creator and replaces bytes with metadata on overwrite', async () => {
      const storage = await make()
      const attempts = await Promise.all(
        [1, 2, 3].map((value) =>
          storage.put('race/winner', new Uint8Array([value]), {
            ifAbsent: true,
            metadata: { value: String(value) },
          }),
        ),
      )
      expect(attempts.filter((result) => result !== null)).toHaveLength(1)
      const winner = await storage.get('race/winner')
      expect(winner?.metadata.value).toBe(String(winner?.bytes[0]))
      await storage.put('race/winner', new Uint8Array([4, 5]), {
        contentType: 'image/png',
        metadata: { next: 'yes' },
      })
      expect(await storage.get('race/winner')).toMatchObject({
        bytes: new Uint8Array([4, 5]),
        size: 2,
        contentType: 'image/png',
        metadata: { next: 'yes' },
      })
      expect((await storage.head('race/winner'))?.metadata.value).toBeUndefined()
    })
  })
}

verifyContract('filesystem object storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caelestis-storage-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return new FilesystemObjectStorage(directory)
})

verifyContract('R2 object storage', async () => {
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response(null) } }',
      r2Buckets: ['objects'],
    }),
  )
  cleanups.push(() => miniflare.dispose())
  return new R2ObjectStorage(await miniflare.getR2Bucket('objects'))
})

const s3Endpoint = process.env.CAELESTIS_TEST_S3_ENDPOINT
if (s3Endpoint)
  verifyContract('S3 object storage', async () => {
    const bucket = `caelestis-test-${crypto.randomUUID()}`
    const storage = new S3ObjectStorage(bucket, {
      endpoint: s3Endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'caelestis-test', secretAccessKey: 'caelestis-test-password' },
    })
    await storage.client.send(new CreateBucketCommand({ Bucket: bucket }))
    cleanups.push(async () => {
      await storage.delete((await storage.list('', { limit: 1000 })).keys)
      await storage.client.send(new DeleteBucketCommand({ Bucket: bucket }))
      storage.close()
    })
    return storage
  })

describe('storage input boundary', () => {
  it('rejects keys that could escape their namespace and invalid pages', () => {
    for (const key of ['', '/root', '../up', 'one//two', 'one\\two', 'one/./two']) {
      expect(() => validateObjectKey(key)).toThrow('Invalid object key')
    }
    expect(() => validateObjectPage('items/', 0)).toThrow()
    expect(() => validateObjectPage('items/', 1001)).toThrow()
  })
})
