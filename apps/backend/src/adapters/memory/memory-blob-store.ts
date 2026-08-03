import type { BlobNamespace, BlobStore } from '../../ports/index.js'

const objectKey = (namespace: BlobNamespace, hash: string): string => `${namespace}/${hash}`

export class MemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, Uint8Array>()

  async put(namespace: BlobNamespace, hash: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(objectKey(namespace, hash), bytes.slice())
  }

  async get(namespace: BlobNamespace, hash: string): Promise<Uint8Array | null> {
    return this.objects.get(objectKey(namespace, hash))?.slice() ?? null
  }

  async hasAll(
    namespace: BlobNamespace,
    hashes: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return new Set(hashes.filter((hash) => this.objects.has(objectKey(namespace, hash))))
  }
}
