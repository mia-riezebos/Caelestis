import type { ObjectStorage } from '@caelestis/storage'
import type { BlobListPage, BlobNamespace, BlobStore } from '../ports/index.js'

/** Content-addressed backend namespaces over a portable object-storage adapter. */
export class ObjectBlobStore implements BlobStore {
  constructor(private readonly storage: ObjectStorage) {}
  async put(namespace: BlobNamespace, key: string, bytes: Uint8Array): Promise<void> {
    await this.storage.put(`${namespace}/${key}`, bytes)
  }
  async get(namespace: BlobNamespace, key: string): Promise<Uint8Array | null> {
    return (await this.storage.get(`${namespace}/${key}`))?.bytes ?? null
  }
  async delete(namespace: BlobNamespace, keys: readonly string[]): Promise<void> {
    await this.storage.delete(keys.map((key) => `${namespace}/${key}`))
  }
  async hasAll(namespace: BlobNamespace, keys: readonly string[]): Promise<ReadonlySet<string>> {
    const present = await Promise.all(
      [...new Set(keys)].map(async (key) =>
        (await this.storage.head(`${namespace}/${key}`)) === null ? [] : [key],
      ),
    )
    return new Set(present.flat())
  }
  async list(
    namespace: BlobNamespace,
    options: { cursor?: string; limit: number },
  ): Promise<BlobListPage> {
    const prefix = `${namespace}/`
    const page = await this.storage.list(prefix, options)
    return { ...page, keys: page.keys.map((key) => key.slice(prefix.length)) }
  }
}
