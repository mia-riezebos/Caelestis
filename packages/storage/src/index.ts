export interface ObjectInfo {
  readonly size: number
  /** Opaque, unquoted identifier suitable for HTTP cache validation. */
  readonly etag: string
  readonly uploadedAt: number
  readonly contentType?: string
  readonly metadata: Readonly<Record<string, string>>
}

export interface StoredObject extends ObjectInfo {
  readonly bytes: Uint8Array
}

export interface PutOptions {
  readonly ifAbsent?: boolean
  readonly contentType?: string
  readonly metadata?: Readonly<Record<string, string>>
}

/** Shared storage for authoritative blobs and generated frontend images. */
export interface ObjectStorage {
  head(key: string): Promise<ObjectInfo | null>
  get(key: string): Promise<StoredObject | null>
  /** Return null only when an atomic create-if-absent loses to an existing object. */
  put(key: string, bytes: Uint8Array, options?: PutOptions): Promise<ObjectInfo | null>
  delete(keys: readonly string[]): Promise<void>
  /** Return a bounded page; only this adapter may interpret its continuation cursor. */
  list(
    prefix: string,
    options: { cursor?: string; limit: number },
  ): Promise<{ keys: readonly string[]; cursor?: string }>
}

/** Keys must stay inside their namespace on both object services and local filesystems. */
export const validateObjectKey = (key: string): void => {
  if (
    !key ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.includes('\0') ||
    key.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Invalid object key')
  }
}

export const validateObjectPage = (prefix: string, limit: number): void => {
  if (prefix) validateObjectKey(prefix.replace(/\/$/, ''))
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Object page limit must be between 1 and 1000')
}
