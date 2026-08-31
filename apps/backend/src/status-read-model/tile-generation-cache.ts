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
  /** Opaque authority token captured before any coverage query derived from this read. */
  readonly coverageToken: string | null
}

export interface CommittedTileGeneration {
  readonly tile: TileCoord
  readonly hash: string
  readonly observedAt: Millis
  readonly commitOrder: number
  /** Token returned before the coverage query that produced the visibility flags. */
  readonly coverageToken: string
  /** Per-tile token that rejects repairs superseded by a newer commit attempt. */
  readonly commitToken?: string
  readonly visibleToPublic: boolean
  readonly visibleToAdmin: boolean
}

export interface PreparedTileGenerationCommit {
  readonly coverageToken: string
  readonly commitToken: string
}

interface CachedTileGeneration extends CommittedTileGeneration {
  expiresAt: number
}

const tileKey = (tile: TileCoord): string => `${tile.x}/${tile.y}`

/** Shared season cache. D1 remains authoritative whenever this module answers unresolved. */
export const createTileGenerationCache = (
  options: {
    readonly now?: () => number
    readonly ttlMilliseconds?: number
    readonly createCoverageToken?: () => string
  } = {},
) => {
  const entries = new Map<string, CachedTileGeneration>()
  const commitTokens = new Map<string, string>()
  const now = options.now ?? Date.now
  const ttl = options.ttlMilliseconds ?? TILE_GENERATION_CACHE_TTL_MILLISECONDS
  const createCoverageToken = options.createCoverageToken ?? (() => crypto.randomUUID())
  let coverageToken = createCoverageToken()

  return {
    prepare(tile: TileCoord): PreparedTileGenerationCommit {
      const key = tileKey(tile)
      const commitToken = createCoverageToken()
      entries.delete(key)
      commitTokens.set(key, commitToken)
      return { coverageToken, commitToken }
    },

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
        coverageToken,
      }
    },

    apply(generation: CommittedTileGeneration): void {
      if (generation.coverageToken !== coverageToken) return
      const key = tileKey(generation.tile)
      const commitToken = commitTokens.get(key)
      if (commitToken !== undefined && generation.commitToken !== commitToken) return
      const held = entries.get(key)
      if (held !== undefined && held.commitOrder >= generation.commitOrder) return
      entries.set(key, { ...generation, expiresAt: now() + ttl })
    },

    invalidate(): void {
      coverageToken = createCoverageToken()
      entries.clear()
      commitTokens.clear()
    },
  }
}

export type TileGenerationCache = ReturnType<typeof createTileGenerationCache>
