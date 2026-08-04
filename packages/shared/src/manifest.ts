import type { TileKey } from './tiles.js'

/**
 * A server's manifest is the only thing a client needs before it can decide whether to touch a
 * given wplace tile at all. It is polled with `If-None-Match`, so it must stay small enough that a
 * 304 is the common case and a full body is cheap when it is not.
 */
export interface Manifest {
  /** Opaque, changes whenever anything below changes. Surfaced to the user as a "what changed" diff. */
  readonly version: string
  readonly server: ServerInfo
  readonly nodes: readonly Node[]
  readonly templates: readonly Template[]
  /**
   * Union of every tile any template touches, including templates the user has disabled.
   * Including disabled ones means toggling never forces a manifest refetch.
   */
  readonly tiles: readonly TileKey[]
}

export interface ServerInfo {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** Whether this server requires an invite code. Public servers run the same code path ungated. */
  readonly requiresAuth: boolean
}

/**
 * Groups and subgroups form an arbitrary-depth tree addressed by materialized path, so a rollup at
 * any depth is one prefix query. A template has exactly one parent.
 */
export interface Node {
  readonly id: string
  readonly parentId: string | null
  /** e.g. `/canada/toronto/skyline` */
  readonly path: string
  readonly name: string
}

export interface Template {
  readonly id: string
  readonly nodeId: string
  readonly name: string
  readonly version: string
  readonly bbox: BoundingBox
  /** Non-transparent pixel count — the denominator for every progress figure. */
  readonly totalPixels: number
  readonly chunks: readonly Chunk[]
}

/** Global canvas pixel coordinates, inclusive of `min`, exclusive of `max`. */
export interface BoundingBox {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/**
 * A template sliced on tile boundaries. Chunks are content-addressed and immutable, so editing a
 * template only invalidates the tiles that actually changed.
 */
export interface Chunk {
  readonly tile: TileKey
  /** sha256 of the stored indexed PNG; also its storage key. */
  readonly hash: string
}
