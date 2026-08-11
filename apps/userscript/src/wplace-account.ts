import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@wts/shared'
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

const premiumIndices = (): readonly number[] =>
  WPLACE_PALETTE.filter(
    (colour) => colour.kind === 'premium' && colour.index !== TRANSPARENT_INDEX,
  ).map((colour) => colour.index)

/** Palette indices this account can place, or null when we have not been able to ask. */
export const ownedColours = (): ReadonlySet<number> | null => owned

export const loadAccount = async (): Promise<void> => {
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
    owned = set
    log('install', 'owned colours read from /me', { premium: set.size, mask })
  } catch (error) {
    // Signed out, offline, or blocked. The preset simply stays unavailable.
    warn('install', 'could not read /me', String(error))
  }
}
