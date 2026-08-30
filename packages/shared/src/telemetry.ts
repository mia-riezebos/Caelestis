import type { TileKey } from './tiles.js'
import type { Millis, Seconds } from './time.js'

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
 *   `correct` or `repairs`: the response does not reveal which submitted pixels landed.
 * - `painted` is null when one Wplace request crossed server coverage boundaries and was only
 *   partially accepted. The client cannot derive a scoped accepted count without disclosing the
 *   out-of-scope pixels. The next tile-diff anchor re-establishes truth instead.
 */
export interface PaintEvent extends PainterIdentity {
  /** Client-generated, so a retry can never double-count. */
  readonly eventId: string
  readonly season: number
  readonly ts: Seconds
  readonly tiles: readonly PaintTile[]
  /** Number wplace reported accepting in this scope, or null when that count is unknowable. */
  readonly painted: number | null
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
  /** Authoritative progress replacements produced while accepting already-held tile bytes. */
  readonly status?: StatusDelta
}

/** Ordered replacements for the templates changed between two materialized status revisions. */
export interface StatusDelta {
  readonly baseRevision: number
  readonly revision: number
  readonly templates: readonly TemplateStatus[]
  readonly removedTemplateIds: readonly string[]
}

export type LiveSyncServerEvent =
  | { readonly type: 'ready'; readonly revision: number }
  | { readonly type: 'status-delta'; readonly delta: StatusDelta }
  | { readonly type: 'status-reconcile'; readonly revision: number }
  | { readonly type: 'manifest-reconcile' }

/** Successful tile uploads carry their authoritative progress change instead of requiring a read. */
export interface TileUploadResponse {
  readonly status?: StatusDelta
}

/** One reporter offering the template-covered tiles it has just fetched from wplace. */
export interface TileOfferBatch extends PainterIdentity {
  readonly season: number
  readonly offers: readonly TileOffer[]
}

/** Current server-derived progress for every template the caller may read. */
export interface StatusResponse {
  /** Monotonic season projection revision; absent on older servers. */
  readonly revision?: number
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
  /** Per-template-colour progress, omitted by older servers without a stored colour histogram. */
  readonly colours?: readonly TemplateColourStatus[]
  /** Newest tile observation feeding this figure. Stale coverage must be visible, not implied. */
  readonly observedAt: Millis
}

export interface TemplateColourStatus {
  readonly index: number
  readonly correct: number
  readonly wrong: number
  readonly blank: number
  readonly total: number
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

/**
 * The frontend's time-series read surface, which the userscript deliberately does not have — see
 * the note on `TemplateStatus`. Everything below is a response shape for the read-scope telemetry
 * endpoints a dashboard draws pace charts, contribution graphs, leaderboards and timelapses from.
 */

/** One folded bucket of the decay ladder, as `GET /telemetry/history` serves it. */
export interface HistoryBucket {
  readonly templateId: string
  /** Bucket width in seconds — 60, 300, 900, 3600, 21600. */
  readonly resolution: number
  /** Unix seconds, floored to `resolution`. */
  readonly bucketStart: Seconds
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

/** Folded pace history for a set of templates at one resolution over a half-open range. */
export interface HistoryResponse {
  /** Selected bucket width when the caller bounds granularity. */
  readonly resolution?: number
  /** First bucket start whose selected-resolution coverage the server still guarantees. */
  readonly coverageStart?: Seconds
  readonly buckets: readonly HistoryBucket[]
}

/**
 * One painter's day on one template.
 *
 * Already reduced across reporters: several clients report the same painter-day, and each carries
 * its own partial view, so the server takes the maximum per counter before serving anything — a
 * reporter that saw less of the day cannot disprove one that saw more. Summing these rows is
 * therefore safe; summing the underlying reporter rows never was.
 */
export interface ContributionDay extends PainterIdentity {
  readonly templateId: string
  /** UTC midnight, Unix seconds — the floor of the report time to 86400. */
  readonly day: Seconds
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

/** Per-painter-per-day contributions, for contribution graphs. */
export interface ContributionsResponse {
  readonly days: readonly ContributionDay[]
}

/** One painter's aggregate standing, sorted by correct then placed, both descending. */
export interface LeaderboardEntry extends PainterIdentity {
  readonly placed: number
  readonly correct: number
  readonly repairs: number
  /** Distinct days with any contribution in the queried window. */
  readonly activeDays: number
  /** The most recent contributing day, UTC midnight in Unix seconds. */
  readonly lastDay: Seconds
}

export interface LeaderboardResponse {
  readonly entries: readonly LeaderboardEntry[]
}

/** The newest accepted observation of one canvas tile. The bytes live at `GET /tiles/:hash`. */
export interface CanvasTileSummary {
  readonly tile: TileKey
  readonly hash: string
  readonly observedAt: Millis
}

/** Every observed tile's current hash for a season — only observed tiles, so bounded in practice. */
export interface CanvasTilesResponse {
  readonly tiles: readonly CanvasTileSummary[]
}

/**
 * One frame of a tile's timelapse: the hash the most reporters agreed on for one bucket.
 *
 * When a bucket holds competing hashes the server keeps the one with the most distinct reporters,
 * tie-broken toward the lexically smaller hash so two adapters — and two requests — agree.
 */
export interface TileHistoryFrame {
  readonly bucketStart: Seconds
  readonly hash: string
  /** Distinct reporting accounts behind this hash — quorum, not repetition. */
  readonly reporters: number
}

export interface TileHistoryResponse {
  readonly frames: readonly TileHistoryFrame[]
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

/** Active server-owned alarms for templates visible to the caller. */
export interface AlarmsResponse {
  readonly alarms: readonly Alarm[]
}
