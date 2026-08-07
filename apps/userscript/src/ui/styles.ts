/**
 * Our own stylesheet, kept deliberately tiny.
 *
 * Everything that can be borrowed from wplace's DaisyUI is borrowed, because that inherits their
 * theme. What cannot be borrowed is anything they do not themselves use: Tailwind ships only the
 * classes a site actually needs, so `hover:` variants and arbitrary values we invent are simply
 * absent from their CSS. Interaction states are exactly that category.
 *
 * Colours here reference DaisyUI's own custom properties, so these rules still follow their theme
 * rather than hard-coding a palette beside it.
 */

const STYLE_ID = 'wts-styles'

const CSS = `
.wts-row {
  border-radius: 0.375rem;
  transition: background-color 100ms ease-out;
}
/* A card only while pointed at: the tree is a list to scan, and a permanent card per row turns
   scanning into reading. */
.wts-row:hover {
  background-color: var(--color-base-200, rgba(0, 0, 0, 0.06));
}
/* A plain pointer, not grab. The rows are clickable as well as draggable, and a grab cursor
   promises dragging is the primary action when it is the secondary one. */
.wts-row[draggable='true'] {
  cursor: pointer;
}
/* Gone, not faded: the placeholder is where it is going, and the drag image is where it is now.
   A third, half-visible copy in the original slot is one too many. */
.wts-row.wts-dragging {
  display: none;
}
/* The gap the row would occupy, held open while dragging, rather than a line drawn on a
   neighbour. A line says "near here"; a hole says "here", and the list stops shifting under the
   cursor as the target changes. */
.wts-placeholder {
  border: 1px dashed var(--color-primary, currentColor);
  border-radius: 0.375rem;
  opacity: 0.7;
  margin: 0.125rem 0.5rem 0.125rem 0.25rem;
  min-height: 2rem;
}
/* Dropping *into* a node, as opposed to between two — a different operation with a different
   consequence, so it gets a different signal. */
.wts-row.wts-drop-into {
  outline: 2px solid var(--color-primary, currentColor);
  outline-offset: -2px;
  background-color: var(--color-base-200, rgba(0, 0, 0, 0.06));
}
/* Inside the panel, not overhanging it: the panel clips its overflow to keep the rounded corner,
   so a handle at a negative offset is invisible and unclickable — which is exactly how it
   behaved. */
.wts-resize {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
  /* Above the header and body, which are appended after it and would otherwise paint over the
     whole strip — the handle was present, positioned, and completely unclickable. */
  z-index: 1;
}
.wts-resize:hover::after,
.wts-resize.wts-resizing::after {
  content: '';
  position: absolute;
  inset: 0 2px 0 1px;
  background-color: var(--color-primary, currentColor);
  border-radius: 999px;
  opacity: 0.5;
}
.wts-actions {
  opacity: 0;
  transition: opacity 100ms ease-out;
}
.wts-row:hover .wts-actions,
.wts-row:focus-within .wts-actions {
  opacity: 1;
}
/* The swatch grid steps between powers of two rather than flowing with auto-fill.
   auto-fill with minmax gives whatever column count happens to fit, so the palette reflowed into
   ragged counts like 13 or 17 and the rows stopped lining up into anything readable. Powers of two
   keep every row a clean subdivision of the one above at any panel width, and the panel is
   user-resizable, so this has to hold continuously. */
.wts-swatches {
  container-type: inline-size;
}
.wts-swatch-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.25rem;
}
/* Each step is the width at which that many columns still leaves a swatch of ~1.75rem (28px),
   allowing for the gaps: N * 1.75 + (N - 1) * 0.25.
   Stepping on available width alone let 32 columns pack into 30rem, which is a 0.69rem swatch — a
   colour you cannot identify and a target you cannot reliably hit. A grid of powers of two is only
   worth having while each cell is still a swatch, so the count waits for the room. */
@container (min-width: 16rem) {
  .wts-swatch-grid { grid-template-columns: repeat(8, 1fr); }
}
@container (min-width: 32rem) {
  .wts-swatch-grid { grid-template-columns: repeat(16, 1fr); }
}
@container (min-width: 64rem) {
  .wts-swatch-grid { grid-template-columns: repeat(32, 1fr); }
}
.wts-swatch {
  aspect-ratio: 1;
  position: relative;
  /* A floor as well as a step, so a container narrower than the smallest step overflows rather than
     grinding the swatches down to nothing. */
  min-width: 1.5rem;
  border-radius: 0.25rem;
  border: 1px solid rgba(0, 0, 0, 0.25);
  cursor: pointer;
  transition: opacity 100ms ease-out, outline-color 100ms ease-out;
  outline: 2px solid transparent;
  outline-offset: 1px;
}
/* Off keeps most of its colour rather than draining away: the swatch has to stay identifiable as
   *which* colour it is while it is not drawing, and 63 near-invisible squares are unreadable as a
   palette. The ring carries "on"; opacity is only the supporting signal. */
.wts-swatch[data-on='false'] {
  opacity: 0.7;
}
.wts-swatch[data-on='true'] {
  outline-color: var(--color-base-content, currentColor);
}
/* Hovering says what the swatch *is*, not what a click would do — a filled box with the eye knocked
   out for on, an empty box with a struck eye for off. Nothing decorates the grid at rest, because
   sixty-three badges saying "normal" is what made the old treatment noise. */
.wts-swatch-badge {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 80ms ease-out;
  pointer-events: none;
}
.wts-swatch:hover .wts-swatch-badge,
.wts-swatch:focus-visible .wts-swatch-badge {
  opacity: 1;
}
.wts-swatch-badge > span {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72%;
  height: 72%;
  border-radius: 0.25rem;
  box-sizing: border-box;
}
.wts-swatch-badge svg {
  width: 78%;
  height: 78%;
}
.wts-swatch[data-on='true'] .wts-swatch-badge > span {
  background-color: var(--color-base-content, #111);
  color: var(--color-base-100, #fff);
}
.wts-swatch[data-on='false'] .wts-swatch-badge > span {
  border: 1.5px solid var(--color-base-content, #111);
  background-color: var(--color-base-100, #fff);
  color: var(--color-base-content, #111);
}
.wts-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`

export const installStyles = (): void => {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}
