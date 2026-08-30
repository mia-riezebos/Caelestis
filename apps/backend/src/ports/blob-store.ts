/**
 * Content-addressed blob storage. R2 today, S3-compatible later.
 *
 * Deliberately use-case shaped rather than a generic object-store wrapper — every method here
 * exists because something in this system needs exactly it. A thin `get/put/delete` facade would
 * be easier to write and would leak the underlying API's assumptions straight through.
 */

/** Blobs are segregated by kind: templates sliced to tile boundaries, and mirrored canvas tiles. */
export type BlobNamespace = 'chunks' | 'tiles'

export interface BlobListPage {
  /** Keys relative to the requested namespace, in the object store's stable listing order. */
  readonly keys: readonly string[]
  /** Opaque continuation token. Absent when the namespace scan is complete. */
  readonly cursor?: string
}

export interface BlobStore {
  /** Store one relative key. Tile keys may include an internal generation suffix. */
  put(namespace: BlobNamespace, key: string, bytes: Uint8Array): Promise<void>

  get(namespace: BlobNamespace, key: string): Promise<Uint8Array | null>

  /** Delete these content-addressed objects after the SQL store has proved they are unreferenced. */
  delete(namespace: BlobNamespace, keys: readonly string[]): Promise<void>

  /**
   * Which of these hashes the store already holds.
   *
   * This exists for the hash-first tile offer: a client names the tiles it has just fetched and the
   * server replies with the subset it actually wants uploaded. Asking one hash at a time would turn
   * a single cheap round trip into dozens.
   */
  hasAll(namespace: BlobNamespace, hashes: readonly string[]): Promise<ReadonlySet<string>>

  /** One bounded namespace page. The cursor is opaque and may only be passed back to this method. */
  list(namespace: BlobNamespace, options: { cursor?: string; limit: number }): Promise<BlobListPage>
}
