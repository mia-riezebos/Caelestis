import { icon } from './icons.js'
import { APP_NAME, PANEL_ID } from './panel-chrome.js'

/**
 * How to find the rail.
 *
 * Not by its classes. `.flex.flex-col.items-center.gap-3` is Tailwind utility soup that describes a
 * layout, not an identity — several elements on the page match it, `querySelector` returns whichever
 * comes first in the document, and ours landed in the wrong one. Anchor on the thing we actually
 * mean instead: wplace's own Overlays button, whose parent *is* the rail by definition. Ours then
 * lands directly beneath it, which is where it was asked to go.
 */
export const ANCHOR_LABEL = 'Overlays'

export const findRail = (): { rail: Element; after: Element } | null => {
  for (const button of document.querySelectorAll('button')) {
    const label = button.getAttribute('title') ?? button.getAttribute('aria-label') ?? ''
    if (label.trim() !== ANCHOR_LABEL) continue
    const rail = button.parentElement
    if (rail !== null) return { rail, after: button }
  }
  return null
}

export const BUTTON_ID = 'wts-rail-button'
const BUTTON_TOOLTIP = `${APP_NAME} — shared templates`

/**
 * wplace marks an open rail button by adding `btn-primary`, measured by opening theirs and diffing
 * the class list. Using the same class rather than a colour of our own means our button lights up
 * in whatever their theme calls primary, now and after any theme change.
 */
const RAIL_BUTTON_CLASS = 'btn btn-square shadow-md relative'

export const syncRailButtonState = (open: boolean): void => {
  const button = document.getElementById(BUTTON_ID)
  if (button === null) return
  button.className = open ? `${RAIL_BUTTON_CLASS} btn-primary` : RAIL_BUTTON_CLASS
  button.setAttribute('aria-expanded', String(open))
}

export const railButton = (toggle: () => void): HTMLButtonElement => {
  const existing = document.getElementById(BUTTON_ID)
  if (existing !== null) return existing as HTMLButtonElement
  const button = document.createElement('button')
  button.id = BUTTON_ID
  // Exactly the classes wplace's own rail buttons carry.
  button.className = RAIL_BUTTON_CLASS
  button.title = BUTTON_TOOLTIP
  button.setAttribute('aria-label', BUTTON_TOOLTIP)
  button.setAttribute('aria-expanded', 'false')
  button.setAttribute('aria-controls', PANEL_ID)
  button.appendChild(icon('extension'))
  button.addEventListener('click', toggle)
  return button
}
