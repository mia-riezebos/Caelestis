import { bytesToBase64, unpackBits } from './bitmask.js'
import type { RegionDocument } from './region-shape.js'
import type { PainterIdentity } from './telemetry.js'
import type { TemplateSurface } from './template-surface.js'

/**
 * Live painter presence: where each online painter is looking, what they have drafted, and which
 * regions they have claimed. Viewports and drafts are ephemeral and never stored; region claims are
 * the only persisted record.
 *
 * Traffic budget, because this has to hold with hundreds of painters on one artwork:
 *
 * - The client is the throttle. It publishes at most one viewport per `PRESENCE_VIEWPORT_MIN_MS`,
 *   one draft per `PRESENCE_DRAFT_MIN_MS`, and one heartbeat per `PRESENCE_HEARTBEAT_MS`, and only
 *   when something changed (the heartbeat always goes).
 * - The server batches every change into one tick per `PRESENCE_TICK_MS` and sends each subscriber
 *   only the peers whose rect intersects that subscriber's viewport padded by one tile, capped at
 *   `MAX_PRESENCE_PEERS` nearest by centre distance.
 * - Rects are quantised to `PRESENCE_RECT_GRID` pixels so a slow pan does not produce a message per
 *   frame, and draft masks are bounded by `MAX_PRESENCE_MASK_BITS`.
 */

export const PRESENCE_PROTOCOL_V1 = 'caelestis.presence.v1'

export const PRESENCE_VIEWPORT_MIN_MS = 2_000
export const PRESENCE_DRAFT_MIN_MS = 1_000
export const PRESENCE_HEARTBEAT_MS = 30_000
export const PRESENCE_TICK_MS = 1_000
/** A peer whose heartbeat is older than this is dropped even if its socket has not closed yet. */
export const PRESENCE_STALE_MS = 90_000
export const PRESENCE_RECT_GRID = 8
export const MAX_PRESENCE_PEERS = 64
/** Padding around a subscriber's viewport, in canvas pixels, that still counts as nearby. */
export const PRESENCE_INTEREST_PADDING = 1_000
export const MAX_PRESENCE_MASK_BITS = 32_768
export const MAX_PRESENCE_MESSAGE_CODE_UNITS = 16 * 1024
export const MAX_PRESENCE_SUBSCRIBERS = 2_048
export const MAX_PRESENCE_SUBSCRIBERS_PER_CLIENT = 4
/** Incoming messages per socket per second before the server closes it. */
export const MAX_PRESENCE_MESSAGES_PER_SECOND = 4
export const MAX_PRESENCE_REGIONS = 500
export const MAX_PRESENCE_REGION_PIXELS = 4_000_000
export const MAX_PRESENCE_REGION_LABEL = 64

/** Axis-aligned rect in canvas pixels. `x`/`y` are the top-left corner, sizes are exclusive. */
export interface PresenceRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Pixels drafted but not yet placed. `mask` is a row-major bitmask over `rect`, base64, MSB first. */
export interface PresenceDraft {
  readonly rect: PresenceRect
  readonly mask?: string
  readonly pixels: number
}

/** What one connected painter session publishes. Absent fields mean unchanged. */
export interface PresenceUpdate {
  readonly type: 'presence-update'
  readonly viewport?: PresenceRect | null
  readonly draft?: PresenceDraft | null
}

export type PresenceClientEvent = PresenceUpdate | { readonly type: 'presence-heartbeat' }

/** One online painter session as every peer sees it. */
export interface PresencePeer {
  readonly sessionId: string
  readonly painter: PainterIdentity
  readonly viewport: PresenceRect | null
  readonly draft: PresenceDraft | null
}

/**
 * A persisted region claim. Coordinates are canvas pixels, like templates. `rect` is the shape's
 * bounding box, derived by the server, so interest checks and older readers need only rects.
 *
 * A claim stands on its own anywhere on the canvas. `templateId` is a hint that the claim was drawn
 * over that template, nothing more: it is never required and never enforced.
 */
export interface RegionClaim {
  readonly id: string
  readonly season: number
  readonly surface: TemplateSurface
  readonly templateId: string | null
  readonly claimant: PainterIdentity
  /** The editable vector document; `rect` is its rasterised bounding box. */
  readonly document: RegionDocument
  readonly rect: PresenceRect
  readonly label: string
  readonly createdAt: number
}

export type PresenceServerEvent =
  | {
      readonly type: 'presence-ready'
      readonly sessionId: string
      readonly online: number
      readonly peers: readonly PresencePeer[]
      readonly regions: readonly RegionClaim[]
    }
  | {
      readonly type: 'presence-delta'
      readonly online: number
      readonly upsert: readonly PresencePeer[]
      readonly remove: readonly string[]
    }
  | { readonly type: 'regions'; readonly regions: readonly RegionClaim[] }

export interface RegionClaimRequest {
  /** The template the shape was drawn over, if any. Optional and unenforced. */
  readonly templateId?: string | null
  readonly document: RegionDocument
  readonly label: string
  readonly actor: PainterIdentity
}

const finiteInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)

export const isPresenceRect = (value: unknown): value is PresenceRect =>
  typeof value === 'object' &&
  value !== null &&
  finiteInt((value as PresenceRect).x) &&
  finiteInt((value as PresenceRect).y) &&
  finiteInt((value as PresenceRect).w) &&
  finiteInt((value as PresenceRect).h) &&
  (value as PresenceRect).x >= 0 &&
  (value as PresenceRect).y >= 0 &&
  (value as PresenceRect).w > 0 &&
  (value as PresenceRect).h > 0

export const rectsIntersect = (a: PresenceRect, b: PresenceRect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

export const rectIntersection = (a: PresenceRect, b: PresenceRect): PresenceRect | null => {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.w, b.x + b.w)
  const bottom = Math.min(a.y + a.h, b.y + b.h)
  return right <= x || bottom <= y ? null : { x, y, w: right - x, h: bottom - y }
}

export const padRect = (rect: PresenceRect, padding: number): PresenceRect => ({
  x: Math.max(0, rect.x - padding),
  y: Math.max(0, rect.y - padding),
  w: rect.w + padding * 2,
  h: rect.h + padding * 2,
})

export const sameRect = (a: PresenceRect | null, b: PresenceRect | null): boolean =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)

/** Snap outward to the presence grid so a slow pan does not change the rect every frame. */
export const quantiseRect = (rect: PresenceRect, grid = PRESENCE_RECT_GRID): PresenceRect => {
  const x = Math.floor(rect.x / grid) * grid
  const y = Math.floor(rect.y / grid) * grid
  const right = Math.ceil((rect.x + rect.w) / grid) * grid
  const bottom = Math.ceil((rect.y + rect.h) / grid) * grid
  return { x, y, w: Math.max(grid, right - x), h: Math.max(grid, bottom - y) }
}

export const rectCentreDistance = (a: PresenceRect, b: PresenceRect): number => {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2)
  const dy = a.y + a.h / 2 - (b.y + b.h / 2)
  return Math.hypot(dx, dy)
}

/** Which of `peer`'s rects matter to someone looking at `viewport`. */
export const peerRect = (peer: PresencePeer): PresenceRect | null =>
  peer.draft?.rect ?? peer.viewport

/**
 * Pack drafted canvas pixels into a bounded draft. Beyond `MAX_PRESENCE_MASK_BITS` the mask is
 * omitted and peers only see the rect; the count still tells them how much is drafted.
 */
export const encodePresenceDraft = (
  pixels: readonly { readonly x: number; readonly y: number }[],
): PresenceDraft | null => {
  if (pixels.length === 0) return null
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const { x, y } of pixels) {
    if (x < left) left = x
    if (y < top) top = y
    if (x > right) right = x
    if (y > bottom) bottom = y
  }
  const rect: PresenceRect = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }
  const bits = rect.w * rect.h
  if (bits > MAX_PRESENCE_MASK_BITS) return { rect, pixels: pixels.length }
  const bytes = new Uint8Array(Math.ceil(bits / 8))
  for (const { x, y } of pixels) {
    const bit = (y - rect.y) * rect.w + (x - rect.x)
    const index = bit >> 3
    bytes[index] = (bytes[index] ?? 0) | (128 >> (bit & 7))
  }
  return { rect, mask: bytesToBase64(bytes), pixels: pixels.length }
}

/** Every drafted pixel in canvas coordinates, or null when the draft carries only a rect. */
export const decodePresenceDraftMask = (draft: PresenceDraft): Uint8Array | null => {
  if (draft.mask === undefined) return null
  const bits = draft.rect.w * draft.rect.h
  if (bits > MAX_PRESENCE_MASK_BITS) return null
  return unpackBits(draft.mask, bits)
}

export const isPresenceDraft = (value: unknown): value is PresenceDraft => {
  if (typeof value !== 'object' || value === null) return false
  const draft = value as PresenceDraft
  if (!isPresenceRect(draft.rect) || !finiteInt(draft.pixels) || draft.pixels < 0) return false
  if (draft.mask === undefined) return true
  const bits = draft.rect.w * draft.rect.h
  return (
    typeof draft.mask === 'string' &&
    bits <= MAX_PRESENCE_MASK_BITS &&
    draft.mask.length === Math.ceil(Math.ceil(bits / 8) / 3) * 4 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(draft.mask)
  )
}

export interface PresenceColour {
  readonly name: string
  /** 0..255 channels. */
  readonly rgb: readonly [number, number, number]
}

/** Fourteen named colours, far enough apart to tell neighbours on a map apart. */
export const PRESENCE_COLOURS: readonly PresenceColour[] = [
  { name: 'red', rgb: [220, 38, 38] },
  { name: 'orange', rgb: [245, 124, 0] },
  { name: 'amber', rgb: [217, 166, 0] },
  { name: 'lime', rgb: [101, 163, 13] },
  { name: 'green', rgb: [22, 163, 74] },
  { name: 'teal', rgb: [13, 148, 136] },
  { name: 'cyan', rgb: [6, 182, 212] },
  { name: 'sky', rgb: [14, 165, 233] },
  { name: 'blue', rgb: [37, 99, 235] },
  { name: 'indigo', rgb: [79, 70, 229] },
  { name: 'violet', rgb: [139, 92, 246] },
  { name: 'fuchsia', rgb: [192, 38, 211] },
  { name: 'pink', rgb: [219, 39, 119] },
  { name: 'rose', rgb: [225, 29, 72] },
]

/** A painter's colour, the same in every tab and to every peer: their id modulo the list. */
export const presenceColour = (wplaceUserId: number): PresenceColour =>
  PRESENCE_COLOURS[Math.abs(wplaceUserId) % PRESENCE_COLOURS.length] as PresenceColour
