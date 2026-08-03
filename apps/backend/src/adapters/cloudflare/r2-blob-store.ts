import type { BlobNamespace, BlobStore } from '../../ports/index.js'

const objectKey = (namespace: BlobNamespace, hash: string): string => `${namespace}/${hash}`

export class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(namespace: BlobNamespace, hash: string, bytes: Uint8Array): Promise<void> {
    await this.bucket.put(objectKey(namespace, hash), bytes)
  }

  async get(namespace: BlobNamespace, hash: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(objectKey(namespace, hash))
    if (object === null) return null

    return new Uint8Array(await object.arrayBuffer())
  }

  async hasAll(
    namespace: BlobNamespace,
    hashes: readonly string[],
  ): Promise<ReadonlySet<string>> {
    // R2 has no bulk HEAD/existence operation for arbitrary keys. Listing would require scanning
    // and paginating the whole namespace, so parallel HEADs are the cheaper bounded operation here.
    const uniqueHashes = [...new Set(hashes)]
    const objects = await Promise.all(
      uniqueHashes.map(async (hash) => ({
        hash,
        object: await this.bucket.head(objectKey(namespace, hash)),
      })),
    )

    return new Set(objects.filter(({ object }) => object !== null).map(({ hash }) => hash))
  }
}
