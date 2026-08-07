import { getState } from '../state.js'
import { isPaintOpen, selectedColour } from '../wplace-paint.js'
import { type Appearance, drawableIndices } from './appearance.js'

/**
 * What the colour switches actually come to, once the global set, the "only selected" mode and one
 * overlay's own switches are all taken into account.
 *
 * There was a global colour grid in settings whose value **nothing read**. It wrote
 * `state.hiddenColours` and rendering consulted only the per-overlay set, so every switch in it was
 * decorative. This is the join that was missing.
 *
 * **An overlay's own set replaces the global one; it does not add to it.** The global grid is the
 * default for overlays that have never been given an appearance of their own, and nothing more. So
 * a global "free" preset beside an overlay set to "all" means that overlay draws all sixty-three
 * colours — the override says what to show, not what to show *as well*.
 *
 * The union this replaces made the per-overlay grid one-directional: it could hide more but never
 * show more, so switching a colour back on in an overlay that the global set had hidden did
 * nothing, and the control lied about what it did.
 */

/** Everything except `keep`. */
const allBut = (keep: number | null): readonly number[] =>
  keep === null ? [] : drawableIndices().filter((index) => index !== keep)

/**
 * The globally hidden set, with the "only selected" mode applied.
 *
 * The mode is kept as a flag rather than written into `hiddenColours`, so turning it off restores
 * whatever was switched off by hand instead of leaving the palette however the mode left it. It
 * also does nothing until wplace's paint drawer is actually open, which is the point: it is for
 * lining up the one colour you are placing, and there is no such colour before you start.
 */
export const globalHiddenColours = (): readonly number[] => {
  const state = getState()
  if (!state.onlySelectedColour) return state.hiddenColours
  if (!isPaintOpen()) return state.hiddenColours
  return allBut(selectedColour())
}

/**
 * The set to draw one overlay with, given the appearance it owns — or null when it uses the defaults.
 *
 * "Only selected" still wins over both. It is a mode rather than a filter: it exists to line up the
 * one colour being placed, lasts only while the paint drawer is open, and switches nothing off
 * permanently, so an overlay having opinions of its own is not a reason to ignore it.
 */
export const hiddenColoursFor = (own: Appearance | null): readonly number[] => {
  const state = getState()
  if (state.onlySelectedColour && isPaintOpen()) return allBut(selectedColour())
  return own === null ? state.hiddenColours : own.hiddenColours
}
