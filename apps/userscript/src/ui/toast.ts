import { icon } from './icons.js'

/** The panel's own element id, shared so a message can find where to appear. */
export const PANEL_ID = 'caelestis-panel'
const REGION_ID = 'caelestis-toast-region'

/**
 * A transient message anchored to the panel, so an action can report without a dialog.
 *
 * One at a time: a second message replaces the first rather than stacking, because a column of
 * alerts inside a narrow panel pushes the thing the user was looking at off the bottom.
 */
const toastRegion = (panel: HTMLElement): HTMLElement => {
  const existing = document.getElementById(REGION_ID)
  if (existing !== null) return existing
  const region = document.createElement('div')
  region.id = REGION_ID
  region.setAttribute('role', 'status')
  region.setAttribute('aria-live', 'polite')
  region.setAttribute('aria-atomic', 'false')
  Object.assign(region.style, {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    margin: '0 0.5rem 0.5rem',
  })
  panel.appendChild(region)
  return region
}

export const toast = (message: string, kind: 'info' | 'warning' | 'error' = 'info'): void => {
  const panel = document.getElementById(PANEL_ID)
  if (panel === null) return
  const selector =
    kind === 'error'
      ? '[data-caelestis-toast="error"]'
      : '[data-caelestis-toast]:not([data-caelestis-toast="error"])'
  panel.querySelector(selector)?.remove()
  const el = document.createElement('div')
  el.dataset.caelestisToast = kind
  el.className =
    kind === 'error'
      ? 'alert alert-error text-xs'
      : kind === 'warning'
        ? 'alert alert-warning text-xs'
        : 'alert alert-info text-xs'
  Object.assign(el.style, { padding: '0.5rem 0.75rem' })
  const text = document.createElement('span')
  text.textContent = message
  el.appendChild(text)
  if (kind === 'error') {
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'btn btn-ghost btn-sm btn-circle'
    dismiss.title = 'Dismiss error'
    dismiss.setAttribute('aria-label', dismiss.title)
    dismiss.appendChild(icon('close', 'size-4'))
    dismiss.addEventListener('click', () => el.remove())
    el.appendChild(dismiss)
  } else {
    setTimeout(() => el.remove(), 6000)
  }
  toastRegion(panel).appendChild(el)
}
