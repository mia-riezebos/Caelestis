import { warn } from './debug.js'
import { type TreeNode, validateTreeNodes } from './state.js'

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
// Shared with local template persistence. Opening an older version after v3 exists is a VersionError.
const VERSION = 3

export interface CachedServer {
  /** Server URL, which is the identity of the connection. */
  readonly url: string
  /** Verified identity and season prevent one deployment at this URL reusing another's tree. */
  readonly serverId: string
  readonly season: number
  readonly nodes: readonly TreeNode[]
  readonly fetchedAt: number
  /** ETag from the manifest, so a refetch can be a 304. */
  readonly etag?: string
}

const open = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION)
    let abandoned = false
    request.onupgradeneeded = () => {
      const db = request.result
      // The local-template store lives in the same database and must survive this upgrade.
      if (!db.objectStoreNames.contains('local-templates')) {
        db.createObjectStore('local-templates', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'url' })
    }
    request.onblocked = () => {
      abandoned = true
      reject(new Error('indexedDB.open blocked by another connection'))
    }
    request.onsuccess = () => {
      const db = request.result
      if (abandoned) {
        db.close()
        return
      }
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'))
  })

const run = async <T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> => {
  try {
    const db = await open()
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const request = body(transaction.objectStore(STORE))
        let result: T
        request.onsuccess = () => {
          result = request.result
        }
        request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
        transaction.oncomplete = () => resolve(result)
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('indexedDB transaction failed'))
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('indexedDB transaction aborted'))
      })
    } finally {
      db.close()
    }
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

const loadEntries = async (urls: readonly string[]): Promise<readonly unknown[]> => {
  const unique = [...new Set(urls)]
  if (unique.length === 0) return []
  try {
    const db = await open()
    try {
      return await new Promise<readonly unknown[]>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readonly')
        const store = transaction.objectStore(STORE)
        const entries: unknown[] = new Array(unique.length)
        for (const [index, url] of unique.entries()) {
          const request = store.get(url)
          request.onsuccess = () => {
            entries[index] = request.result
          }
          request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
        }
        transaction.oncomplete = () => resolve(entries)
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('indexedDB transaction failed'))
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('indexedDB transaction aborted'))
      })
    } finally {
      db.close()
    }
  } catch (error) {
    warn('install', 'server cache unavailable', String(error))
    return []
  }
}

export const loadServerCache = async (
  configuredUrls: readonly string[],
): Promise<readonly CachedServer[]> => {
  const raw = await loadEntries(configuredUrls)
  const valid: CachedServer[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as Partial<CachedServer>
    const nodes = validateTreeNodes(candidate.nodes)
    if (
      typeof candidate.url !== 'string' ||
      typeof candidate.serverId !== 'string' ||
      !Number.isSafeInteger(candidate.season) ||
      Number(candidate.season) < 0 ||
      !Number.isFinite(candidate.fetchedAt) ||
      nodes === null
    )
      continue
    valid.push({
      url: candidate.url,
      serverId: candidate.serverId,
      season: Number(candidate.season),
      nodes,
      fetchedAt: Number(candidate.fetchedAt),
      ...(typeof candidate.etag === 'string' ? { etag: candidate.etag } : {}),
    })
  }
  return valid
}
