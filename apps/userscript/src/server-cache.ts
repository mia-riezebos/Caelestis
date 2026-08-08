import { warn } from './debug.js'
import type { TreeNode } from './state.js'

/**
 * What a server told us, kept between sessions.
 *
 * A manifest is fetched over the network and a page load throws it away, so without this the tree
 * is empty every time the tab opens and stays empty until every connected server has answered. That
 * is the wrong first impression, and it is worse the more servers are connected.
 *
 * Cached rather than authoritative: it is what the tree draws *first*, and a fresh fetch replaces
 * it as soon as one arrives. Nothing here is trusted for anything but rendering.
 */

const DB_NAME = 'caelestis'
const STORE = 'server-cache'
const VERSION = 2

export interface CachedServer {
  /** Server URL, which is the identity of the connection. */
  readonly url: string
  readonly nodes: readonly TreeNode[]
  readonly fetchedAt: number
  /** ETag from the manifest, so a refetch can be a 304. */
  readonly etag?: string
  /**
   * The templates the manifest listed, as the tree draws them.
   *
   * Kept beside the nodes because they answer the same question — what is on this server — and are
   * thrown away by the same page load. Optional so a cache written before templates were rendered
   * still loads: an absent list is "we have not asked yet", which is what it was.
   */
  readonly templates?: readonly ServerTemplate[]
}

/**
 * One template as the server describes it.
 *
 * A subset of the manifest's own shape rather than the whole thing: this is what a row needs to be
 * drawn and edited. `version` says whether the pixels have moved on and `updatedAt` says whether
 * anything at all has — the two answer different questions, and a rename only moves the second.
 */
export interface ServerTemplate {
  readonly id: string
  readonly nodeId: string
  readonly name: string
  readonly version: string
  readonly published: boolean
  readonly updatedAt: number
  /** Where it sits on the canvas, inclusive of min and exclusive of max. */
  readonly bbox: {
    readonly minX: number
    readonly minY: number
    readonly maxX: number
    readonly maxY: number
  }
  /**
   * The template sliced on tile boundaries, `tile` being `x/y`.
   *
   * Content-addressed, which is what makes a re-fetch cheap: a new version that changed one corner
   * shares every other hash with the old one, so only the tiles that actually moved are downloaded.
   */
  readonly chunks: readonly { readonly tile: string; readonly hash: string }[]
}

const open = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      // The local-template store lives in the same database and must survive this upgrade.
      if (!db.objectStoreNames.contains('local-templates')) {
        db.createObjectStore('local-templates', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'url' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'))
  })

const run = async <T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> => {
  try {
    const db = await open()
    return await new Promise<T>((resolve, reject) => {
      const request = body(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
    })
  } catch (error) {
    warn('install', 'server cache unavailable', String(error))
    return null
  }
}

export const cacheServer = async (entry: CachedServer): Promise<void> => {
  await run('readwrite', (store) => store.put(entry))
}

export const forgetServer = async (url: string): Promise<void> => {
  await run('readwrite', (store) => store.delete(url))
}

/**
 * How long a server's last answer is worth keeping after it stops answering.
 *
 * Long, deliberately. Nothing here is discarded because a server is unreachable — a restart, a
 * dropped tunnel, a laptop lid, a dev server hot-reloading between keystrokes all look identical to
 * "gone", and treating any of them as gone is how a tree empties itself and every switch you set
 * springs back to its default. Only genuine age retires an entry, and a month is long enough that
 * anything reaching it really has stopped existing.
 */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const loadServerCache = async (): Promise<readonly CachedServer[]> => {
  const entries = (await run<CachedServer[]>('readonly', (store) => store.getAll())) ?? []
  const cutoff = Date.now() - CACHE_TTL_MS
  const live = entries.filter((entry) => entry.fetchedAt >= cutoff)
  for (const stale of entries) {
    if (stale.fetchedAt < cutoff) void forgetServer(stale.url)
  }
  return live
}
