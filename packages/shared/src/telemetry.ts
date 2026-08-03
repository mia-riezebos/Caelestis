import type { TileKey } from './tiles.js'

/**
 * What the userscript sends after wplace accepts a paint.
 *
 * Payload discipline: event id, username, season, painted pixels, acceptance counts, and a timestamp
 * are the ceiling. Never a session cookie, session state, a captcha or `x-pawtect-token`, a wplace
 * user id, or a raw wplace request body.
 *
 * Raw coordinates are sent rather than counts because the **server** classifies them — it holds the
 * template chunks and the tile history, so on-template / wrong-colour / repair needs no trust in
 * the client at all.
 *
 * Crediting rule:
 *
 * - When `painted === submitted`, classify and credit the accepted pixels normally.
 * - When `painted < submitted`, `painted` is still an exact placed total, but do not credit
 *   template-level `correct` or `repairs`: the response does not reveal which submitted pixels
 *   landed. The next tile-diff anchor re-establishes template correctness from ground truth.
 */
export interface PaintEvent {
  /** Client-generated, so a retry can never double-count. */
  readonly eventId: string
  readonly username: string
  readonly season: number
  readonly ts: number
  readonly tiles: readonly PaintTile[]
  /** Total pixels submitted across every tile. */
  readonly submitted: number
  /** Number wplace reported accepting. */
  readonly painted: number
}

export interface PaintTile {
  /** Canvas tile coordinates. */
  readonly x: number
  readonly y: number
  readonly pixels: PaintPixels
}

/** Structure-of-arrays payload observed on wplace's paint request. Arrays are parallel. */
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
  readonly ts: number
}

export interface TileOfferResponse {
  /** Tiles the server does not already have and wants the bytes for. */
  readonly wanted: readonly TileKey[]
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
  readonly observedAt: number
}

export interface NodeStatus {
  readonly nodeId: string
  /** Pixel-weighted: sum(correct) / sum(total). */
  readonly correct: number
  readonly total: number
  /** Unweighted companion — "3 of 7 complete" answers a different question to "94% by pixels". */
  readonly templatesComplete: number
  readonly templatesTotal: number
  readonly observedAt: number
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
  readonly firstSeen: number
  readonly lastSeen: number
}
