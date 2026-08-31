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

interface PendingTileGenerationCommits {
  readonly active: Set<string>
  candidate: CachedTileGeneration | null
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
  const pendingCommits = new Map<string, PendingTileGenerationCommits>()
  const now = options.now ?? Date.now
  const ttl = options.ttlMilliseconds ?? TILE_GENERATION_CACHE_TTL_MILLISECONDS
  const createCoverageToken = options.createCoverageToken ?? (() => crypto.randomUUID())
  let coverageToken = createCoverageToken()

  const prunePendingCommits = (checkedAt: number): void => {
    for (const [key, pending] of pendingCommits) {
      if (pending.expiresAt <= checkedAt) pendingCommits.delete(key)
    }
  }

  const settle = (
    key: string,
    commitToken: string,
    generation: CommittedTileGeneration | null,
  ): boolean => {
    const checkedAt = now()
    prunePendingCommits(checkedAt)
    const pending = pendingCommits.get(key)
    if (pending === undefined) return false
    const knownCommit = pending.active.delete(commitToken)
    if (
      generation !== null &&
      generation.coverageToken === coverageToken &&
      (pending.candidate === null || pending.candidate.commitOrder < generation.commitOrder)
    ) {
      pending.candidate = { ...generation, expiresAt: checkedAt + ttl }
    }
    if (!knownCommit) return true
    if (pending.active.size > 0) return true
    pendingCommits.delete(key)
    if (pending.candidate !== null && pending.candidate.coverageToken === coverageToken) {
      entries.set(key, pending.candidate)
    }
    return true
  }

  return {
    prepare(tile: TileCoord): PreparedTileGenerationCommit {
      const key = tileKey(tile)
      const checkedAt = now()
      prunePendingCommits(checkedAt)
      const commitToken = createCoverageToken()
      const held = entries.get(key)
      const pending = pendingCommits.get(key) ?? {
        active: new Set<string>(),
        candidate: held !== undefined && held.expiresAt > checkedAt ? held : null,
        expiresAt: checkedAt + ttl,
      }
      pending.active.add(commitToken)
      pending.expiresAt = checkedAt + ttl
      entries.delete(key)
      pendingCommits.set(key, pending)
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
      prunePendingCommits(checkedAt)
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
      if (generation.commitToken !== undefined && settle(key, generation.commitToken, generation))
        return
      const held = entries.get(key)
      if (held !== undefined && held.commitOrder >= generation.commitOrder) return
      entries.set(key, { ...generation, expiresAt: now() + ttl })
    },

    finish(tile: TileCoord, commit: PreparedTileGenerationCommit): void {
      if (commit.coverageToken !== coverageToken) return
      settle(tileKey(tile), commit.commitToken, null)
    },

    synchronizeCoverageToken(next: string): void {
      if (coverageToken === next) return
      coverageToken = next
      entries.clear()
      pendingCommits.clear()
    },

    invalidate(): void {
      coverageToken = createCoverageToken()
      entries.clear()
      pendingCommits.clear()
    },
  }
}

export type TileGenerationCache = ReturnType<typeof createTileGenerationCache>
