import type { TileKey } from './tiles.js'
import type { Millis, Seconds } from './time.js'

/** Stable public identity assigned by wplace. */
/**
 * The most pixels one paint report may claim, per tile and in total.
 *
 * This lives in `@caelestis/shared` because both sides of the boundary have to agree on it and neither
 * may depend on the other: `@caelestis/wire-schema` decides what a request is allowed to contain, and
 * `apps/backend`'s CounterStore decides what a delta is allowed to contain. Restating it in both
 * was a comment claiming a test pinned them together — there was no such test, and there could not
 * be one, since nothing links the two packages. A shared constant needs no pinning.
 *
 * The value is a bound on absurdity, not on play: a full Wplace charge drain is around 10,000
 * pixels, so this is an order of magnitude of headroom.
 */
export const MAX_PAINT_COUNT = 100_000
/** Bound one hash-first offer request without turning ordinary panning into one request per tile. */
export const MAX_TILE_OFFERS = 64

export type WplaceUserId = number

/** Attribution uses the stable id; the display name is a refreshable label. */
export interface PainterIdentity {
  readonly wplaceUserId: WplaceUserId
  readonly displayName: string
}

/**
 * What the userscript sends after wplace accepts a paint.
 *
 * Payload discipline: event id, public wplace identity, season, painted pixels, acceptance counts,
 * and a timestamp are the ceiling. Never a session cookie, session state, a captcha or
 * `x-pawtect-token`, or a raw wplace request body.
 *
 * Raw coordinates are sent rather than counts because the **server** classifies them — it holds the
 * template chunks and the tile history, so on-template / wrong-colour / repair needs no trust in
 * the client at all.
 *
 * Crediting rule:
 *
 * - The server derives the submitted total from `tiles`.
 * - When `painted` equals that server-derived total, classify and credit the accepted pixels
 *   normally.
 * - When `painted` is lower, it is still an exact placed total, but do not credit template-level
 *   `correct` or `repairs`: the response does not reveal which submitted pixels landed. The next
 *   tile-diff anchor re-establishes template correctness from ground truth.
 */
export interface PaintEvent extends PainterIdentity {
  /** Client-generated, so a retry can never double-count. */
  readonly eventId: string
  readonly season: number
  readonly ts: Seconds
  readonly tiles: readonly PaintTile[]
  /** Number wplace reported accepting. */
  readonly painted: number
}

export interface PaintTile {
  /** Canvas tile coordinates. */
  readonly x: number
  readonly y: number
  readonly pixels: PaintPixels
}

/**
 * Structure-of-arrays payload observed on wplace's paint request. All three arrays must have the
 * same length; the server must reject a PaintTile when they do not.
 */
export interface PaintPixels {
  /** Tile-local x coordinates. */
  readonly x: readonly number[]
  /** Tile-local y coordinates. */
  readonly y: readonly number[]
  /** wplace palette indices. */
  readonly colors: readonly number[]
}

/**
 * Hash-first tile offer. The client sends this for tiles it has just fetched and that a template
 * covers; the server replies with the subset it actually wants uploaded. In a quiet area nothing is
 * uploaded for days.
 */
export interface TileOffer {
  readonly tile: TileKey
  readonly sha256: string
  readonly ts: Seconds
}

export interface TileOfferResponse {
  /** Tiles the server does not already have and wants the bytes for. */
  readonly wanted: readonly TileKey[]
}

/** One reporter offering the template-covered tiles it has just fetched from wplace. */
export interface TileOfferBatch extends PainterIdentity {
  readonly season: number
  readonly offers: readonly TileOffer[]
}

/** Current server-derived progress for every template the caller may read. */
export interface StatusResponse {
  readonly templates: readonly TemplateStatus[]
}

/**
 * The userscript's read surface is current state and alarms only — no charts, no history, no pace.
 * Everything time-series is frontend-only for now.
 */
export interface TemplateStatus {
  readonly templateId: string
  readonly correct: number
  readonly wrong: number
  readonly blank: number
  readonly total: number
  /** Newest tile observation feeding this figure. Stale coverage must be visible, not implied. */
  readonly observedAt: Millis
}

export interface NodeStatus {
  readonly nodeId: string
  /** Pixel-weighted: sum(correct) / sum(total). */
  readonly correct: number
  readonly total: number
  /** Unweighted companion — "3 of 7 complete" answers a different question to "94% by pixels". */
  readonly templatesComplete: number
  readonly templatesTotal: number
  readonly observedAt: Millis
}

export type AlarmKind = 'regression' | 'sustained-griefing'

/**
 * Derived from drift: the gap between what our own paint events imply and what the canvas actually
 * shows. `observed < derived` means our work is being overwritten.
 */
export interface Alarm {
  readonly id: string
  readonly templateId: string
  readonly kind: AlarmKind
  readonly pixelsLost: number
  readonly firstSeen: Millis
  readonly lastSeen: Millis
}
