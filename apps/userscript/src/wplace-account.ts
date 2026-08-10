import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import { log, warn } from './debug.js'

/**
 * What wplace knows about the signed-in user.
 *
 * `/me` returns `extraColorsBitmap`, a mask over the *premium* colours in palette order — bit 0 is
 * the first premium entry, not palette index 0. Free colours are not in the mask because everyone
 * has them.
 *
 * This is what makes the "Owned" colour preset mean anything. Without it the preset can only guess,
 * which is worse than not offering it.
 */

let owned: ReadonlySet<number> | null = null
let lastRead = 0
const listeners: Array<() => void> = []

/** Re-read `/me` at most this often, so opening settings repeatedly does not hammer wplace. */
const REFRESH_AFTER_MS = 30_000

export const onAccountChange = (listener: () => void): void => {
  listeners.push(listener)
}

/**
 * Ask again if the answer is stale.
 *
 * People buy colours mid-session, and the "Owned" preset is wrong the moment they do — it was read
 * once at start-up and never again. Called when the colour settings are shown, which is exactly when
 * being out of date is visible.
 */
export const refreshAccount = (): void => {
  if (Date.now() - lastRead < REFRESH_AFTER_MS) return
  void loadAccount()
}

const premiumIndices = (): readonly number[] =>
  WPLACE_PALETTE.filter(
    (colour) => colour.kind === 'premium' && colour.index !== TRANSPARENT_INDEX,
  ).map((colour) => colour.index)

/** Palette indices this account can place, or null when we have not been able to ask. */
export const ownedColours = (): ReadonlySet<number> | null => owned

export const loadAccount = async (): Promise<void> => {
  lastRead = Date.now()
  try {
    const response = await fetch('https://backend.wplace.live/me', { credentials: 'include' })
    if (!response.ok) {
      log('install', `/me said ${response.status}; owned colours unavailable`)
      return
    }
    const body = (await response.json()) as { extraColorsBitmap?: number }
    const mask = body.extraColorsBitmap
    if (typeof mask !== 'number') return

    const set = new Set<number>()
    // -1 is all bits set, which is how wplace says "everything".
    premiumIndices().forEach((paletteIndex, bit) => {
      if (mask === -1 || (mask & (1 << bit)) !== 0) set.add(paletteIndex)
    })
    const changed =
      owned === null || owned.size !== set.size || [...set].some((i) => !owned?.has(i))
    owned = set
    log('install', 'owned colours read from /me', { premium: set.size, mask, changed })
    // Only when it actually moved, so a periodic re-read does not rebuild the settings pane under
    // someone's cursor for nothing.
    if (changed) for (const listener of listeners) listener()
  } catch (error) {
    // Signed out, offline, or blocked. The preset simply stays unavailable.
    warn('install', 'could not read /me', String(error))
  }
}
