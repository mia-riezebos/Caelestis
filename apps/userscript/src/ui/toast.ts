/** The panel's own element id, shared so a message can find where to appear. */
export const PANEL_ID = 'caelestis-panel'

/**
 * A transient message anchored to the panel, so an action can report without a dialog.
 *
 * One at a time: a second message replaces the first rather than stacking, because a column of
 * alerts inside a narrow panel pushes the thing the user was looking at off the bottom.
 */
export const toast = (message: string, kind: 'info' | 'warning' | 'error' = 'info'): void => {
  const panel = document.getElementById(PANEL_ID)
  if (panel === null) return
  panel.querySelector('[data-caelestis-toast]')?.remove()
  const el = document.createElement('div')
  el.setAttribute('data-caelestis-toast', '')
  el.className =
    kind === 'error'
      ? 'alert alert-error text-xs'
      : kind === 'warning'
        ? 'alert alert-warning text-xs'
        : 'alert alert-info text-xs'
  Object.assign(el.style, { margin: '0 0.5rem 0.5rem', padding: '0.5rem 0.75rem' })
  el.textContent = message
  panel.appendChild(el)
  setTimeout(() => el.remove(), 6000)
}
