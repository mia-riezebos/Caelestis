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
.wts-row[draggable='true'] {
  cursor: grab;
}
.wts-row.wts-dragging {
  opacity: 0.4;
  cursor: grabbing;
}
/* Where the row would land, drawn on the gap rather than on the row, so it never reads as
   selection. */
.wts-row.wts-drop-before {
  box-shadow: inset 0 2px 0 0 var(--color-primary, currentColor);
}
.wts-row.wts-drop-after {
  box-shadow: inset 0 -2px 0 0 var(--color-primary, currentColor);
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
