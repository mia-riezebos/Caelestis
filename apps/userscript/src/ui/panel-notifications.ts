import { PANEL_ID } from './panel-chrome.js'
import { BUTTON_ID } from './panel-rail.js'
import { PAGE_TOAST_STYLE, toastMount } from './panel-workflow.js'

/**
 * The unacknowledged-alarm count. Not "how many alarms are active" — that number stays lit for
 * hours on a griefed template and stops being read. This one means "something new since you last
 * looked", so it clears itself by being seen.
 */
export const setAlarmBadge = (count: number): void => {
  const button = document.getElementById(BUTTON_ID)
  if (button === null) return
  const existing = button.querySelector('[data-wts-badge]')
  if (count <= 0) {
    existing?.remove()
    return
  }
  const badge = existing ?? document.createElement('span')
  badge.setAttribute('data-wts-badge', '')
  badge.className = 'badge badge-sm badge-error absolute -top-1 -right-1'
  badge.textContent = String(count)
  if (existing === null) button.appendChild(badge)
}

export const announce = (element: HTMLElement, message: string, error = false): void => {
  element.setAttribute('role', error ? 'alert' : 'status')
  element.setAttribute('aria-live', error ? 'assertive' : 'polite')
  element.textContent = message
}

/** A transient message anchored to the panel, so an action can report without a dialog. */
export const toast = (message: string, kind: 'info' | 'warning' | 'error' = 'info'): void => {
  const panel = document.getElementById(PANEL_ID)
  const mount = toastMount(panel, document.body)
  mount.querySelector('[data-wts-toast]')?.remove()
  const el = document.createElement('div')
  el.setAttribute('data-wts-toast', '')
  el.className =
    kind === 'error'
      ? 'alert alert-error text-xs'
      : kind === 'warning'
        ? 'alert alert-warning text-xs'
        : 'alert alert-info text-xs'
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  el.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite')
  Object.assign(el.style, { margin: '0 0.5rem 0.5rem', padding: '0.5rem 0.75rem' })
  if (panel === null) {
    Object.assign(el.style, PAGE_TOAST_STYLE)
  }
  el.textContent = message
  mount.appendChild(el)
  setTimeout(() => el.remove(), 6000)
}
