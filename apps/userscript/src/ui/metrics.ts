/**
 * The handful of numbers our chrome is built out of.
 *
 * They were spread across three files and had drifted apart: the rail sat 8px from the edge, the
 * panel 16px, and the per-overlay menu 16px with a comment claiming it matched the panel. So our own
 * surfaces started on three different lines, which is visible the moment two of them are open at
 * once — and they are usually open at once, because the menu configures what the panel lists.
 *
 * The rhythm is wplace's, not ours. Their rail is `top-2 right-2`, so 8px from the edge is where
 * chrome starts on this page; anything of ours using a different number reads as sitting slightly
 * wrong rather than as a deliberate choice.
 */

/** From the edge of the window. wplace's own inset, so our chrome starts where theirs does. */
export const EDGE = 8

/** Between two things of ours: rail button to rail button, rail to panel, menu to whatever it clears. */
export const GAP = 12

/** One rail button — wplace's `btn-circle` at the size they use, which ours are copies of. */
export const RAIL_BUTTON = 40

/** The right edge of anything that has to clear the rail, since the rail is always on top of it. */
export const CLEAR_OF_RAIL = EDGE + RAIL_BUTTON + GAP

/**
 * Every floating surface: the panel, a per-overlay menu, a dropdown, the colour picker.
 *
 * One radius rather than a scale. These are all the same kind of thing — a rounded rectangle over
 * the map — and the panel being 8px while everything opening out of it was 12px was the one place
 * the difference was legible, as a corner that did not match the corner beside it.
 */
export const SURFACE_RADIUS = '0.75rem'
