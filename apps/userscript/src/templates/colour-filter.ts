import { getState } from '../state.js'
import { isPaintOpen, selectedColour } from '../wplace-paint.js'
import { drawableIndices } from './appearance.js'

/**
 * What the colour switches actually come to, once the global set, the "only selected" mode and one
 * overlay's own switches are all taken into account.
 *
 * There was a global colour grid in settings whose value **nothing read**. It wrote
 * `state.hiddenColours` and rendering consulted only the per-overlay set, so every switch in it was
 * decorative. This is the join that was missing.
 *
 * Hiding composes by union rather than override. A colour hidden globally stays hidden on an
 * overlay that has not mentioned it, and an overlay can hide more but never less — "hide this
 * everywhere" would be a strange thing to be able to undo per overlay without saying so.
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

/** The set to draw one overlay with: what is hidden globally, plus what that overlay hides itself. */
export const effectiveHiddenColours = (overlayHidden: readonly number[]): readonly number[] => {
  const global = globalHiddenColours()
  if (global.length === 0) return overlayHidden
  if (overlayHidden.length === 0) return global
  return [...new Set([...global, ...overlayHidden])]
}
