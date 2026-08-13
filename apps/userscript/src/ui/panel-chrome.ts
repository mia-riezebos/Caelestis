import { getState, setState } from '../state.js'
import { icon } from './icons.js'
import { createResizeCommitter } from './panel-workflow.js'

export const PANEL_ID = 'wts-panel'

/**
 * Named for the alliance it was built for. From Latin `caelum` — sky, heavens — so it carries
 * "shared" and "above everything" without having to say either.
 *
 * A proper noun rather than a functional label like the buttons around it, which is right for a
 * third-party addition: it should not read as another wplace feature. The tooltip carries the
 * explanation, since "Caelestis" alone teaches a first-time user nothing.
 */
export const APP_NAME = 'Caelestis'
export const PANEL_TITLE = APP_NAME

let activeResizeCleanup: (() => void) | null = null
let activeKeyboardResizeCommit: (() => void) | null = null

export const maximumPanelWidth = (): number => Math.min(720, Math.max(0, window.innerWidth - 96))
export const minimumPanelWidth = (): number => Math.min(260, maximumPanelWidth())
export const panelWidthForViewport = (wanted: number): number =>
  Math.min(maximumPanelWidth(), Math.max(minimumPanelWidth(), wanted))

export const updateResizeValue = (handle: HTMLElement, width: number): void => {
  handle.setAttribute('aria-valuemin', String(minimumPanelWidth()))
  handle.setAttribute('aria-valuemax', String(maximumPanelWidth()))
  handle.setAttribute('aria-valuenow', String(Math.round(width)))
}

export const cancelPointerResize = (): void => activeResizeCleanup?.()

export const commitKeyboardResize = (): void => {
  activeKeyboardResizeCommit?.()
  activeKeyboardResizeCommit = null
}

export const resizePanelForViewport = (): void => {
  activeResizeCleanup?.()
  const panel = document.getElementById(PANEL_ID)
  if (panel !== null) {
    const width = panelWidthForViewport(getState().panelWidth)
    panel.style.width = `${width}px`
    const handle = panel.querySelector<HTMLElement>('[role="separator"]')
    if (handle !== null) updateResizeValue(handle, width)
  }
}

export const buildPanel = (
  showTree: () => void,
  toggleSettings: () => void,
  closePanel: () => void,
): HTMLElement => {
  const panel = document.createElement('aside')
  panel.id = PANEL_ID
  panel.setAttribute('aria-label', PANEL_TITLE)
  // Fixed to the right edge, clear of the rail. Not a modal: no backdrop and nothing to dismiss, so
  // the map stays live and you can watch a setting take effect while you change it.
  panel.className = 'bg-base-100 shadow-2xl'
  // Layout inline: these must not depend on whether wplace happens to use the same utility.
  Object.assign(panel.style, {
    position: 'fixed',
    // The rail is `absolute top-2 right-2` with 40px buttons: 8 + 40 = 48px occupied. Clear it with
    // the same 12px rhythm the rail itself uses between buttons.
    right: '3.75rem',
    top: '1rem',
    bottom: '1rem',
    // wplace's own chrome sits at z-40 (the rail) and z-50 (its overlay layer), and the map canvas
    // is unpositioned. Sitting at 30 puts us above the canvas and beneath everything of theirs, so
    // their rail and menus open over our panel rather than being trapped behind it.
    zIndex: '30',
    width: `${panelWidthForViewport(getState().panelWidth)}px`,
    display: 'flex',
    flexDirection: 'column',
    minHeight: '0',
    color: 'var(--color-base-content, inherit)',
    borderRadius: '0.5rem',
    overflow: 'hidden',
  } satisfies Partial<CSSStyleDeclaration>)

  const handle = document.createElement('div')
  handle.className = 'wts-resize'
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-label', 'Resize panel')
  handle.setAttribute('aria-orientation', 'vertical')
  handle.tabIndex = 0
  updateResizeValue(handle, panelWidthForViewport(getState().panelWidth))
  const keyboardResize = createResizeCommitter((width) => setState({ panelWidth: width }))
  activeKeyboardResizeCommit = keyboardResize.commit
  const resizeKeys = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End'])
  handle.addEventListener('keydown', (event) => {
    const current = panel.getBoundingClientRect().width
    const step = event.shiftKey ? 50 : 10
    const wanted =
      event.key === 'ArrowLeft'
        ? current + step
        : event.key === 'ArrowRight'
          ? current - step
          : event.key === 'Home'
            ? minimumPanelWidth()
            : event.key === 'End'
              ? maximumPanelWidth()
              : null
    if (wanted === null) return
    event.preventDefault()
    const next = panelWidthForViewport(wanted)
    panel.style.width = `${next}px`
    updateResizeValue(handle, next)
    keyboardResize.stage(Math.round(next))
  })
  handle.addEventListener('keyup', (event) => {
    if (resizeKeys.has(event.key)) keyboardResize.commit()
  })
  handle.addEventListener('blur', keyboardResize.commit)
  handle.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || activeResizeCleanup !== null) return
    event.preventDefault()
    const pointerId = event.pointerId
    handle.classList.add('wts-resizing')
    // Capture is an optimisation, not a requirement — synthetic pointers can lack a capturable id,
    // and throwing here would abort the whole drag before it started.
    try {
      handle.setPointerCapture(event.pointerId)
    } catch {
      /* proceed without capture */
    }
    const startX = event.clientX
    const startWidth = panel.getBoundingClientRect().width
    const move = (moved: PointerEvent): void => {
      if (moved.pointerId !== pointerId) return
      // Dragging the left edge rightwards makes the panel narrower, so the delta is inverted.
      const next = panelWidthForViewport(startWidth - (moved.clientX - startX))
      panel.style.width = `${next}px`
      updateResizeValue(handle, next)
    }
    let active = true
    const cleanup = (commit: boolean): void => {
      if (!active) return
      active = false
      handle.classList.remove('wts-resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', done)
      window.removeEventListener('pointercancel', cancelResize)
      window.removeEventListener('blur', cancelResize)
      handle.removeEventListener('lostpointercapture', cancelResize)
      activeResizeCleanup = null
      if (commit) setState({ panelWidth: Math.round(panel.getBoundingClientRect().width) })
      else {
        panel.style.width = `${startWidth}px`
        updateResizeValue(handle, startWidth)
      }
    }
    const done = (ended: PointerEvent): void => {
      if (ended.pointerId === pointerId) cleanup(true)
    }
    const cancelResize = (ended?: PointerEvent | Event): void => {
      if (ended !== undefined && 'pointerId' in ended && ended.pointerId !== pointerId) return
      cleanup(false)
    }
    activeResizeCleanup = cancelResize
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
    window.addEventListener('pointercancel', cancelResize)
    window.addEventListener('blur', cancelResize)
    handle.addEventListener('lostpointercapture', cancelResize)
  })
  panel.appendChild(handle)

  const header = document.createElement('div')
  header.className = 'flex items-center gap-2 px-3 py-2 border-b border-base-300'
  const title = document.createElement('h2')
  title.className = 'font-semibold text-sm grow'
  title.textContent = PANEL_TITLE

  // Only present in settings, and it is the primary way back — the gear becomes a state indicator
  // rather than a toggle, because a gear that also means "leave settings" is a gear that lies.
  const backButton = document.createElement('button')
  backButton.setAttribute('data-wts-back', '')
  backButton.className = 'btn btn-ghost btn-xs btn-circle'
  backButton.title = 'Back to templates'
  backButton.setAttribute('aria-label', 'Back to templates')
  backButton.appendChild(icon('arrowBack', 'size-4'))
  backButton.addEventListener('click', showTree)

  const settingsButton = document.createElement('button')
  settingsButton.setAttribute('data-wts-settings', '')
  settingsButton.className = 'btn btn-ghost btn-xs btn-circle'
  settingsButton.title = 'Settings'
  settingsButton.setAttribute('aria-label', 'Settings')
  settingsButton.setAttribute('aria-pressed', 'false')
  settingsButton.appendChild(icon('settings', 'size-4'))
  settingsButton.addEventListener('click', toggleSettings)

  const closeButton = document.createElement('button')
  closeButton.className = 'btn btn-ghost btn-xs btn-circle'
  closeButton.title = 'Close'
  closeButton.setAttribute('aria-label', 'Close')
  closeButton.appendChild(icon('close', 'size-4'))
  closeButton.addEventListener('click', closePanel)

  header.append(backButton, title, settingsButton, closeButton)

  const body = document.createElement('div')
  body.setAttribute('data-wts-body', '')
  Object.assign(body.style, { display: 'flex', flexDirection: 'column', minHeight: '0', flex: '1' })

  panel.append(header, body)
  return panel
}
