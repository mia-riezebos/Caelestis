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
.wts-swatch {
  aspect-ratio: 1;
  border-radius: 0.25rem;
  border: 1px solid rgba(0, 0, 0, 0.25);
  cursor: pointer;
  transition: opacity 100ms ease-out, outline-color 100ms ease-out;
  outline: 2px solid transparent;
  outline-offset: 1px;
}
/* Off reads as drained rather than hidden: the swatch has to stay identifiable as *which* colour
   it is even while it is not drawing. */
.wts-swatch[data-on='false'] {
  opacity: 0.25;
}
.wts-swatch[data-on='true'] {
  outline-color: var(--color-base-content, currentColor);
}
.wts-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`

/**
 * Ours, kept by reference.
 *
 * Looking the stylesheet up by id trusts the page not to have minted an element under it — and the
 * page owns the document. A planted `<div id="wts-styles">` turned the install into a no-op, which
 * costs `.wts-swatch` its `aspect-ratio` and collapses every colour toggle to zero height while the
 * rest of the UI looks perfect. Holding the node also makes this cheap enough to call every frame.
 */
let installed: HTMLStyleElement | null = null

export const installStyles = (): void => {
  // `isConnected` alone stays true for a node the host has adopted into an iframe or moved into a
  // shadow root, where its rules no longer reach our body-mounted controls.
  // Connected, ours, *and* still doing its job: a host can empty the text or disable the sheet
  // without moving the node, and the swatches lose their sizing exactly as if it were gone.
  if (
    installed?.isConnected === true &&
    installed.getRootNode() === document &&
    installed.textContent === CSS &&
    installed.sheet?.disabled !== true &&
    // A host can point `media` somewhere that never matches, or delete the rules through CSSOM,
    // and neither shows up in the text or the `disabled` flag.
    installed.media === '' &&
    // The declaration we actually depend on, not merely *a* rule mentioning the class: the text,
    // the media, the enabled flag, the rule count and even the selector all survive a host calling
    // `rule.style.removeProperty('aspect-ratio')`, while every colour toggle collapses to nothing.
    [...(installed.sheet?.cssRules ?? [])].some(
      (rule) =>
        rule instanceof CSSStyleRule &&
        rule.selectorText === '.wts-swatch' &&
        rule.style.getPropertyValue('aspect-ratio') !== '',
    )
  ) {
    return
  }
  installed?.remove()
  // The id is a convenience for anyone reading the DOM, never an identity check. An element the
  // page put there is not ours whatever it is called — an empty `<style id="wts-styles">` would
  // otherwise stand in for the real one and every swatch would collapse — and it is not ours to
  // delete either, so we simply add our own alongside it.
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.wtsStyles = ''
  style.textContent = CSS
  document.head.appendChild(style)
  installed = style
}
