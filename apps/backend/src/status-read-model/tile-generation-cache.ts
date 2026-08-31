import type { Millis, TileCoord } from '@caelestis/shared'
import type { StatusVisibilityScope } from './model.js'

export const TILE_GENERATION_CACHE_TTL_MILLISECONDS = 5 * 60_000

export interface TileGenerationOffer {
  readonly deliveryId: string
  readonly tile: TileCoord
  readonly hash: string
}

export interface TileGenerationCacheRead {
  readonly acknowledgedDeliveryIds: readonly string[]
  readonly unresolvedDeliveryIds: readonly string[]
  readonly cacheOutcome: 'hit' | 'miss' | 'stale'
}

export interface CommittedTileGeneration {
  readonly tile: TileCoord
  readonly hash: string
  readonly observedAt: Millis
  readonly commitOrder: number
  /** Wall-clock instant after the coverage query that produced the visibility flags. */
  readonly coverageReadAt: Millis
  readonly visibleToPublic: boolean
  readonly visibleToAdmin: boolean
}

interface CachedTileGeneration extends CommittedTileGeneration {
  expiresAt: number
}

const tileKey = (tile: TileCoord): string => `${tile.x}/${tile.y}`

/** Shared season cache. D1 remains authoritative whenever this module answers unresolved. */
export const createTileGenerationCache = (
  options: { readonly now?: () => number; readonly ttlMilliseconds?: number } = {},
) => {
  const entries = new Map<string, CachedTileGeneration>()
  const now = options.now ?? Date.now
  const ttl = options.ttlMilliseconds ?? TILE_GENERATION_CACHE_TTL_MILLISECONDS
  let coverageInvalidatedAt = Number.NEGATIVE_INFINITY

  return {
    resolve(
      scope: StatusVisibilityScope,
      offers: readonly TileGenerationOffer[],
    ): TileGenerationCacheRead {
      const acknowledgedDeliveryIds: string[] = []
      const unresolvedDeliveryIds: string[] = []
      let sawMiss = false
      let sawStale = false
      const checkedAt = now()
      for (const offer of offers) {
        const key = tileKey(offer.tile)
        const held = entries.get(key)
        if (held === undefined) {
          sawMiss = true
          unresolvedDeliveryIds.push(offer.deliveryId)
          continue
        }
        if (held.expiresAt <= checkedAt) {
          entries.delete(key)
          sawStale = true
          unresolvedDeliveryIds.push(offer.deliveryId)
          continue
        }
        const visible = scope === 'admin' ? held.visibleToAdmin : held.visibleToPublic
        if (!visible || held.hash !== offer.hash) {
          sawStale = true
          unresolvedDeliveryIds.push(offer.deliveryId)
          continue
        }
        held.expiresAt = checkedAt + ttl
        acknowledgedDeliveryIds.push(offer.deliveryId)
      }
      return {
        acknowledgedDeliveryIds,
        unresolvedDeliveryIds,
        cacheOutcome: sawStale ? 'stale' : sawMiss ? 'miss' : 'hit',
      }
    },

    apply(generation: CommittedTileGeneration): void {
      if (generation.coverageReadAt <= coverageInvalidatedAt) return
      const key = tileKey(generation.tile)
      const held = entries.get(key)
      if (held !== undefined && held.commitOrder >= generation.commitOrder) return
      entries.set(key, { ...generation, expiresAt: now() + ttl })
    },

    invalidate(invalidatedAt = now()): void {
      coverageInvalidatedAt = Math.max(coverageInvalidatedAt, invalidatedAt)
      entries.clear()
    },
  }
}

export type TileGenerationCache = ReturnType<typeof createTileGenerationCache>
