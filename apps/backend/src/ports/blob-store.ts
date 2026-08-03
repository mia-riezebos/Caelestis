/**
 * Content-addressed blob storage. R2 today, S3-compatible later.
 *
 * Deliberately use-case shaped rather than a generic object-store wrapper — every method here
 * exists because something in this system needs exactly it. A thin `get/put/delete` facade would
 * be easier to write and would leak the underlying API's assumptions straight through.
 */

/** Blobs are segregated by kind: templates sliced to tile boundaries, and mirrored canvas tiles. */
export type BlobNamespace = 'chunks' | 'tiles'

export interface BlobStore {
  put(namespace: BlobNamespace, hash: string, bytes: Uint8Array): Promise<void>

  get(namespace: BlobNamespace, hash: string): Promise<Uint8Array | null>

  /**
   * Which of these hashes the store already holds.
   *
   * This exists for the hash-first tile offer: a client names the tiles it has just fetched and the
   * server replies with the subset it actually wants uploaded. Asking one hash at a time would turn
   * a single cheap round trip into dozens.
   */
  hasAll(namespace: BlobNamespace, hashes: readonly string[]): Promise<ReadonlySet<string>>
}
