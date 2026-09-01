interface CacheEntry {
  readonly value: Promise<unknown>
  readonly expiresAt: number
  lastUsed: number
  bytes: number
}

export interface DecodedPixelCacheOptions {
  readonly ttlMs?: number
  readonly maxBytes?: number
  readonly maxEntries?: number
  readonly now?: () => number
}

const DEFAULT_TTL_MS = 3 * 60 * 1_000
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 96

/**
 * A small isolate-local cache for decoded, content-addressed pixel inputs.
 *
 * The cache owns no canonical state: expiry, eviction, or isolate loss only causes the caller to
 * decode the immutable R2 input again. Pending decodes are cached too so concurrent targets that
 * share a chunk do not duplicate work.
 */
export class DecodedPixelCache {
  private readonly entries = new Map<string, CacheEntry>()
  private generation = 0
  private readonly ttlMs: number
  private readonly maxBytes: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: DecodedPixelCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.now = options.now ?? Date.now
  }

  async get<Value>(
    key: string,
    load: () => Promise<Value>,
    sizeOf: (value: Value) => number,
  ): Promise<Value> {
    const now = this.now()
    this.removeExpired(now)
    const held = this.entries.get(key)
    if (held !== undefined) {
      held.lastUsed = ++this.generation
      return held.value as Promise<Value>
    }

    const value = load()
    const entry: CacheEntry = {
      value,
      expiresAt: now + this.ttlMs,
      lastUsed: ++this.generation,
      bytes: 0,
    }
    this.entries.set(key, entry)
    try {
      const resolved = await value
      if (this.entries.get(key) === entry) {
        entry.bytes = Math.max(0, sizeOf(resolved))
        // A missing/invalid decode is not stable state. Let the next request retry R2 immediately.
        if (entry.bytes === 0) this.entries.delete(key)
        else this.evict()
      }
      return resolved
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key)
      throw error
    }
  }

  /** Dropping an isolate-local optimization never drops authoritative or derived state. */
  clear(): void {
    this.entries.clear()
  }

  private removeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
  }

  private evict(): void {
    let bytes = [...this.entries.values()].reduce((total, entry) => total + entry.bytes, 0)
    const oldest = [...this.entries].sort((left, right) => left[1].lastUsed - right[1].lastUsed)
    for (const [key, entry] of oldest) {
      if (this.entries.size <= this.maxEntries && bytes <= this.maxBytes) break
      this.entries.delete(key)
      bytes -= entry.bytes
    }
  }
}

export const decodedPixelCache = new DecodedPixelCache()
