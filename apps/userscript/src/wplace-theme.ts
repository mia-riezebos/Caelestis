import { log, warn } from './debug.js'
import { getMap } from './map-handle.js'
import { getWplaceState } from './wplace-state.js'

/**
 * Wplace's light and dark theme, toggled from a key.
 *
 * Wplace keeps the theme in three places: a `theme` key in localStorage, a `data-theme` attribute
 * on the document element (DaisyUI reads that), and a Svelte state that swaps the map basemap
 * between the `liberty` and `fiord` styles. Only their own setter touches all three, and the only
 * thing that calls it is a pair of buttons inside the settings dialog. The old shortcut looked for
 * those buttons by `aria-label`, and when Wplace moved the label into the button text the key went
 * quietly dead.
 *
 * So this no longer depends on one selector. In order:
 *
 * 0. Call their setter. `wplace-state.ts` catches the state object as it is built, and assigning
 *    its `theme` is exactly what their button does. This is the normal path.
 * 1. If a theme control is on screen, click it. That runs their setter and keeps every copy of the
 *    state in step.
 * 2. Otherwise open the settings dialog with a stylesheet that hides it, click the control, and
 *    close it again. Same result, nothing visible.
 * 3. If neither control can be found, set the attribute and storage ourselves and swap the map
 *    style by rewriting the style URL the map last loaded. Their internal state lags until the
 *    next reload, but the page and the map change now.
 *
 * Theme names are read from the page, not assumed: the dark theme is whatever is not the light
 * one, and the light one is whatever was last seen when the page was not dark.
 */

const THEME_STORAGE_KEY = 'theme'
const DARK_THEME = 'dark'
const DEFAULT_LIGHT_THEME = 'custom-winter'
const SYNC_STYLE_ID = 'caelestis-theme-sync'
const SYNC_TIMEOUT_MS = 600
const SYNC_POLL_MS = 16
/** Basemap style names by theme, used only when the map's own URL cannot be read. */
const STYLE_FOR_THEME: Record<string, string> = { [DARK_THEME]: 'fiord', light: 'liberty' }
/** Where Wplace serves its basemap styles; the fallback when the resource log holds no style. */
const STYLE_BASE = 'https://maps.wplace.live/styles'

let rememberedLight = DEFAULT_LIGHT_THEME
let syncing = false

const root = (): HTMLElement => document.documentElement

/** The theme Wplace currently applies, from the attribute first and storage second. */
export const currentWplaceTheme = (): string => {
  const applied = root().getAttribute('data-theme')
  let theme = applied !== null && applied !== '' ? applied : null
  if (theme === null) {
    try {
      theme = localStorage.getItem(THEME_STORAGE_KEY)
    } catch {
      theme = null
    }
  }
  const resolved = theme ?? rememberedLight
  if (resolved !== DARK_THEME) rememberedLight = resolved
  return resolved
}

export const isWplaceDarkTheme = (): boolean => currentWplaceTheme() === DARK_THEME

const nextTheme = (): string => (isWplaceDarkTheme() ? rememberedLight : DARK_THEME)

const accessibleName = (element: Element): string =>
  `${element.getAttribute('aria-label') ?? ''} ${element.textContent ?? ''}`.trim().toLowerCase()

/**
 * Any on-screen control that would switch to `theme`.
 *
 * Tried by meaning, not markup: a group labelled Theme with a button that is not pressed, then any
 * button whose name says "dark" or "light", then the legacy `aria-label` form.
 */
const nativeControlFor = (theme: string, scope: ParentNode = document): HTMLElement | null => {
  const wantDark = theme === DARK_THEME
  const groups = scope.querySelectorAll<HTMLElement>('[role="group"][aria-label]')
  for (const group of groups) {
    if (!/theme/i.test(group.getAttribute('aria-label') ?? '')) continue
    const buttons = [...group.querySelectorAll<HTMLElement>('button, [role="button"]')]
    const byName = buttons.find((button) =>
      wantDark
        ? /\bdark\b|\bnight\b/.test(accessibleName(button))
        : /\blight\b/.test(accessibleName(button)),
    )
    if (byName !== undefined) return byName
    const unpressed = buttons.find((button) => button.getAttribute('aria-pressed') === 'false')
    if (unpressed !== undefined) return unpressed
  }
  const candidates = scope.querySelectorAll<HTMLElement>('button, [role="button"]')
  for (const button of candidates) {
    const name = accessibleName(button)
    if (!/\b(dark|light|night)\b/.test(name) || !/mode|theme/.test(name)) continue
    if (wantDark ? /\b(dark|night)\b/.test(name) : /\blight\b/.test(name)) return button
  }
  return null
}

const isEnabled = (element: HTMLElement): boolean =>
  !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true'

const openDialogs = (): HTMLDialogElement[] => [
  ...document.querySelectorAll<HTMLDialogElement>('dialog[open]'),
]

const settingsOpener = (): HTMLElement | null => {
  const buttons = document.querySelectorAll<HTMLElement>('button, [role="button"]')
  for (const button of buttons) {
    const name = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`
    if (/settings/i.test(name) && isEnabled(button)) return button
  }
  return null
}

/** The basemap style the map last loaded, from the browser's own resource log. */
const lastStyleUrl = (): string | null => {
  if (typeof performance === 'undefined') return null
  const entries = performance.getEntriesByType('resource') as { name: string }[]
  for (let index = entries.length - 1; index >= 0; index--) {
    const name = entries[index]?.name ?? ''
    if (/\/styles\/[^/?#]+\/?$/.test(name)) return name
  }
  return null
}

/** Rewrite the last style URL for the other theme, or build one from the known names. */
const styleUrlFor = (theme: string): string | null => {
  const last = lastStyleUrl()
  const wanted = theme === DARK_THEME ? STYLE_FOR_THEME[DARK_THEME] : STYLE_FOR_THEME.light
  if (wanted === undefined) return null
  if (last === null) return `${STYLE_BASE}/${wanted}`
  return last.replace(/\/styles\/[^/?#]+(\/?)$/, `/styles/${wanted}$1`)
}

/** Steps 3: apply the theme without Wplace's help. */
const applyDirectly = (theme: string): void => {
  root().setAttribute('data-theme', theme)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Storage can be unavailable; the attribute is what the page reads.
  }
  const map = getMap() as { setStyle?: (style: string) => unknown } | null
  const style = styleUrlFor(theme)
  if (map?.setStyle !== undefined && style !== null) {
    try {
      map.setStyle(style)
    } catch (error) {
      warn('install', 'could not swap the map style for the theme', String(error))
    }
  }
  log('install', 'theme applied directly', { theme, style })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Step 2: run Wplace's own setter through a settings dialog nobody sees.
 *
 * Resolves true when the control was found and clicked. The hiding stylesheet covers every open
 * dialog and its backdrop, so this is skipped while some other dialog is already up.
 */
const syncThroughSettings = async (theme: string): Promise<boolean> => {
  if (syncing || openDialogs().length > 0) return false
  const opener = settingsOpener()
  if (opener === null) return false
  syncing = true
  const hide = document.createElement('style')
  hide.id = SYNC_STYLE_ID
  hide.textContent =
    'dialog[open]{visibility:hidden!important;pointer-events:none!important}dialog[open]::backdrop{visibility:hidden!important;background:transparent!important}'
  document.head.appendChild(hide)
  const active = document.activeElement
  try {
    opener.click()
    const deadline = Date.now() + SYNC_TIMEOUT_MS
    let control: HTMLElement | null = null
    let dialog: HTMLDialogElement | undefined
    while (Date.now() < deadline) {
      dialog = openDialogs().at(-1)
      control = dialog === undefined ? null : nativeControlFor(theme, dialog)
      if (control !== null) break
      await sleep(SYNC_POLL_MS)
    }
    if (control === null) {
      dialog?.close()
      return false
    }
    control.click()
    dialog?.close()
    return currentWplaceTheme() === theme
  } catch (error) {
    warn('install', 'theme sync through settings failed', String(error))
    return false
  } finally {
    hide.remove()
    syncing = false
    if (active instanceof HTMLElement && document.activeElement !== active) {
      try {
        active.focus({ preventScroll: true })
      } catch {
        // Focus is best effort.
      }
    }
  }
}

/**
 * Toggle Wplace's theme. Returns true when a switch was started, so the caller can claim the key.
 *
 * The switch itself may finish a frame later when it has to go through the settings dialog; the
 * attribute and storage always end up changed, one way or another.
 */
export const toggleWplaceTheme = (): boolean => {
  if (typeof document === 'undefined') return false
  const theme = nextTheme()
  // Their own setter, when the state object was caught at startup: the direct, complete path.
  const state = getWplaceState()
  if (state !== null) {
    try {
      state.theme = theme
      if (currentWplaceTheme() === theme) return true
    } catch (error) {
      warn('install', 'Wplace theme setter failed; falling back', String(error))
    }
  }
  const visible = nativeControlFor(theme)
  if (visible !== null && isEnabled(visible)) {
    visible.click()
    if (currentWplaceTheme() === theme) return true
  }
  void syncThroughSettings(theme).then((synced) => {
    if (!synced && currentWplaceTheme() !== theme) applyDirectly(theme)
  })
  return true
}
