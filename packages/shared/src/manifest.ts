import type { TemplateSurface } from './template-surface.js'
import type { Millis } from './time.js'

/** Canonical chunk-grid coordinate. World keys are non-negative; centred surfaces may be signed. */
export type SurfaceChunkKey = `${number}/${number}`

/**
 * A server's manifest is the only thing a client needs before it can decide whether to touch a
 * given wplace tile at all. It is polled with `If-None-Match`, so it must stay small enough that a
 * 304 is the common case and a full body is cheap when it is not.
 */
export interface Manifest {
  /** Opaque, changes whenever anything below changes. Surfaced to the user as a "what changed" diff. */
  readonly version: string
  readonly season: number
  /** Absent means the world canvas, preserving the v1 manifest representation. */
  readonly surface?: TemplateSurface
  readonly server: ServerInfo
  readonly nodes: readonly Node[]
  readonly templates: readonly Template[]
  /**
   * Union of every tile any template touches, including templates the user has disabled.
   * Including disabled ones means toggling never forces a manifest refetch.
   */
  readonly tiles: readonly SurfaceChunkKey[]
}

export interface ServerInfo {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly auth: 'none' | 'access_token'
}

/**
 * Groups and subgroups form an arbitrary-depth tree addressed by materialized path, so a rollup at
 * any depth is one prefix query. Templates may also sit directly under the server root.
 */
export interface Node {
  readonly id: string
  readonly parentId: string | null
  /** e.g. `/canada/toronto/skyline` */
  readonly path: string
  readonly name: string
  readonly description?: string
  readonly createdAt: Millis
}

export interface Template {
  readonly id: string
  readonly nodeId: string | null
  readonly name: string
  readonly version: string
  readonly bbox: BoundingBox
  /** Non-transparent pixel count — the denominator for every progress figure. */
  readonly totalPixels: number
  readonly chunks: readonly Chunk[]
  readonly published: boolean
  /** Finished templates keep live status but stop accumulating history and contribution data. */
  readonly finished: boolean
  /** The instant the historical timeline stops, or null while the template is live. */
  readonly finishedAt: Millis | null
  /** Whether decay must preserve the archived portion of this timelapse. */
  readonly timelapseFrozen: boolean
  readonly createdAt: Millis
  /**
   * When anything about this template last changed — pixels, name, parent, or published state.
   *
   * `version` already answers "are my chunks current", because a new version is a new id and the
   * chunk list moves with it. It cannot answer "has anything changed", since renaming a template or
   * moving it to another node leaves every chunk exactly where it was. A client holding a local copy
   * needs both: one to decide whether to re-download pixels, and one to decide whether to touch the
   * copy at all.
   *
   * Equal to `createdAt` until the first edit.
   */
  readonly updatedAt: Millis
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
  readonly tile: SurfaceChunkKey
  /** sha256 of the stored indexed PNG; also its storage key. */
  readonly hash: string
}
