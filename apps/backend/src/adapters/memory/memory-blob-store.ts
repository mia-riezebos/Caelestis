import type { BlobListPage, BlobNamespace, BlobStore } from '../../ports/index.js'

const objectKey = (namespace: BlobNamespace, hash: string): string => `${namespace}/${hash}`

export class MemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, Uint8Array>()

  async put(namespace: BlobNamespace, hash: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(objectKey(namespace, hash), bytes.slice())
  }

  async get(namespace: BlobNamespace, hash: string): Promise<Uint8Array | null> {
    return this.objects.get(objectKey(namespace, hash))?.slice() ?? null
  }

  async delete(namespace: BlobNamespace, hashes: readonly string[]): Promise<void> {
    for (const hash of hashes) this.objects.delete(objectKey(namespace, hash))
  }

  async hasAll(namespace: BlobNamespace, hashes: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(hashes.filter((hash) => this.objects.has(objectKey(namespace, hash))))
  }

  async list(
    namespace: BlobNamespace,
    options: { cursor?: string; limit: number },
  ): Promise<BlobListPage> {
    const prefix = `${namespace}/`
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort()
    const { cursor } = options
    const start = cursor === undefined ? 0 : keys.findIndex((key) => key > cursor)
    const offset = start < 0 ? keys.length : start
    const page = keys.slice(offset, offset + options.limit)
    const last = page.at(-1)
    return {
      keys: page,
      ...(last !== undefined && offset + page.length < keys.length ? { cursor: last } : {}),
    }
  }
}
