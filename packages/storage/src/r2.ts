import {
  type ObjectInfo,
  type ObjectStorage,
  type PutOptions,
  validateObjectKey,
  validateObjectPage,
} from './index.js'

interface R2Info {
  key: string
  size: number
  etag: string
  uploaded: Date
  httpMetadata?: { contentType?: string }
  customMetadata?: Record<string, string>
}

/** Structural binding keeps Cloudflare runtime types outside the shared storage contract. */
export interface R2Binding {
  head(key: string): Promise<R2Info | null>
  get(key: string): Promise<(R2Info & { arrayBuffer(): Promise<ArrayBuffer> }) | null>
  put(
    key: string,
    bytes: Uint8Array,
    options?: {
      onlyIf?: { etagDoesNotMatch: string }
      httpMetadata?: { contentType: string }
      customMetadata?: Record<string, string>
    },
  ): Promise<R2Info | null>
  delete(keys: string[]): Promise<void>
  list(options: {
    prefix: string
    cursor?: string
    limit: number
  }): Promise<{ objects: R2Info[]; truncated: boolean; cursor?: string }>
}

const info = (object: R2Info): ObjectInfo => ({
  size: object.size,
  etag: object.etag,
  uploadedAt: object.uploaded.getTime(),
  metadata: object.customMetadata ?? {},
  ...(object.httpMetadata?.contentType === undefined
    ? {}
    : { contentType: object.httpMetadata.contentType }),
})

/** Cloudflare R2 implementation, including atomic conditional creation. */
export class R2ObjectStorage implements ObjectStorage {
  constructor(private readonly bucket: R2Binding) {}
  async head(key: string) {
    validateObjectKey(key)
    const object = await this.bucket.head(key)
    return object === null ? null : info(object)
  }
  async get(key: string) {
    validateObjectKey(key)
    const object = await this.bucket.get(key)
    return object === null
      ? null
      : { ...info(object), bytes: new Uint8Array(await object.arrayBuffer()) }
  }
  async put(key: string, bytes: Uint8Array, options: PutOptions = {}) {
    validateObjectKey(key)
    const object = await this.bucket.put(key, bytes, {
      ...(options.ifAbsent ? { onlyIf: { etagDoesNotMatch: '*' } } : {}),
      ...(options.contentType === undefined
        ? {}
        : { httpMetadata: { contentType: options.contentType } }),
      ...(options.metadata === undefined ? {} : { customMetadata: { ...options.metadata } }),
    })
    return object === null ? null : info(object)
  }
  async delete(keys: readonly string[]) {
    keys.forEach(validateObjectKey)
    const unique = [...new Set(keys)]
    for (let start = 0; start < unique.length; start += 1000)
      await this.bucket.delete(unique.slice(start, start + 1000))
  }
  async list(prefix: string, options: { cursor?: string; limit: number }) {
    validateObjectPage(prefix, options.limit)
    const page = await this.bucket.list({ prefix, ...options })
    return {
      keys: page.objects.map((object) => object.key),
      ...(page.truncated && page.cursor !== undefined ? { cursor: page.cursor } : {}),
    }
  }
}
