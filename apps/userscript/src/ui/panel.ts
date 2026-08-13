import { log, warn } from '../debug.js'
import { loadState, refreshStoredServers } from '../state.js'
import { loadAccount, onAccountChange } from '../wplace-account.js'
import {
  buildPanel,
  cancelPointerResize,
  commitKeyboardResize,
  PANEL_ID,
  PANEL_TITLE,
  resizePanelForViewport,
} from './panel-chrome.js'
import { ANCHOR_LABEL, BUTTON_ID, findRail, railButton, syncRailButtonState } from './panel-rail.js'
import { settingsView } from './panel-settings.js'
import {
  cancelTreeConfirm,
  cancelTreeCopy,
  closeTreeContextMenu,
  deactivateTreeView,
  rerenderActiveTree,
  treeView,
} from './panel-tree-view.js'
import {
  cancelViewOwnedWork,
  createKeyedOperationGate,
  createRerenderGate,
  readTransientStatus,
  restoreTransientStatus,
  type TransientStatus,
} from './panel-workflow.js'
import { installStyles } from './styles.js'
import { cancelRenaming } from './tree.js'

/**
 * Our button on wplace's right-hand rail, and the panel it opens.
 *
 * Two things make this look native rather than bolted on, and neither is a matter of copying values:
 *
 * 1. **wplace ships DaisyUI**, with `data-theme="custom-winter"` on `<html>`. Borrowing their
 *    component classes means our surfaces inherit their theme tokens, including any theme they add
 *    later. The coupling is real: if they drop DaisyUI our chrome loses its skin.
 *
 *    **But borrow components, never invent utilities.** Tailwind ships only the classes a site
 *    actually uses, so a utility wplace has no use for is simply absent from their stylesheet.
 *    Measured on the live page, `right-16`, `bottom-4`, `w-full`, `min-h-0` and `text-base-content`
 *    are all missing — which is why the first version of this panel rendered in the top-left corner
 *    with `position: fixed` applied and nothing else. So: **layout is inline styles**, which cannot
 *    silently evaporate, and only classes they demonstrably use (`btn`, `badge`, `input`, `select`,
 *    `checkbox`, `bg-base-100`, `rounded-box`, `shadow-*`) are borrowed.
 * 2. **Their rail is their own markup**, not a MapLibre control — `.maplibregl-ctrl-top-right` is
 *    empty. So we append to a Svelte-rendered list, which means it can be re-rendered out from under
 *    us; see the observer below.
 *
 * The panel is deliberately **not a modal**. No backdrop, no focus trap, nothing to dismiss. Most of
 * what it controls is on the map behind it, so covering or freezing the map would hide the very
 * thing you opened it to change.
 */

type View = 'tree' | 'settings'

let currentView: View = 'tree'
let open = false
let viewportResizeInstalled = false
let accountObserverInstalled = false
let panelOwnerGeneration = 0
const activePanelRequests = new Map<AbortController, () => void>()
const copyOperations = createKeyedOperationGate()
const panelRerenders = createRerenderGate(() => rerenderWhenIdle())

const panelRequest = (): { controller: AbortController; finish: () => void } => {
  const controller = new AbortController()
  const releaseRerender = panelRerenders.hold()
  activePanelRequests.set(controller, releaseRerender)
  return {
    controller,
    finish: () => {
      const release = activePanelRequests.get(controller)
      activePanelRequests.delete(controller)
      release?.()
    },
  }
}

const cancelPanelRequests = (): void => {
  panelRerenders.cancel()
  for (const [controller, release] of activePanelRequests) {
    controller.abort()
    release()
  }
  activePanelRequests.clear()
}

const rerenderWhenIdle = (): void => {
  if (activePanelRequests.size > 0) {
    panelRerenders.request()
    return
  }
  const panel = document.getElementById(PANEL_ID)
  if (panel === null) return
  const focused = document.activeElement
  if (focused !== null && panel.contains(focused) && focused.matches(':active')) {
    // Do not detach a pressed control between pointer/key down and its click. Focus alone is not a
    // render lock: keyboard users commonly leave a button or access-code field focused.
    const settle = (): void => {
      window.removeEventListener('pointerup', settle)
      window.removeEventListener('pointercancel', settle)
      window.removeEventListener('keyup', settle)
      setTimeout(rerenderWhenIdle, 0)
    }
    window.addEventListener('pointerup', settle, { once: true })
    window.addEventListener('pointercancel', settle, { once: true })
    window.addEventListener('keyup', settle, { once: true })
    return
  }
  showView(currentView, true)
}

const rerenderAccountWhenRelevant = (): void => {
  if (open && currentView === 'settings') rerenderWhenIdle()
}

const rerenderServersWhenRelevant = (): void => {
  if (!open) return
  if (currentView === 'tree') rerenderActiveTree()
  else rerenderWhenIdle()
}

interface SettingsDrafts {
  readonly serverUrl: string
  readonly accessCodes: ReadonlyMap<string, string>
  readonly statuses: ReadonlyMap<string, TransientStatus>
  readonly focused: {
    readonly kind: 'url' | 'code'
    readonly server?: string
    readonly selectionStart: number | null
    readonly selectionEnd: number | null
    readonly selectionDirection: 'forward' | 'backward' | 'none' | null
  } | null
  readonly scrollTop: number
}

const settingsDrafts = (panel: HTMLElement): SettingsDrafts => {
  const serverUrl = panel.querySelector<HTMLInputElement>('[data-wts-draft-url]')?.value ?? ''
  const accessCodes = new Map<string, string>()
  for (const input of panel.querySelectorAll<HTMLInputElement>('[data-wts-draft-code]')) {
    const server = input.dataset.wtsDraftCode
    if (server !== undefined) accessCodes.set(server, input.value)
  }
  const statuses = new Map<string, TransientStatus>()
  for (const status of panel.querySelectorAll<HTMLElement>('[data-wts-draft-status]')) {
    const key = status.dataset.wtsDraftStatus
    const saved = readTransientStatus(status)
    if (key !== undefined && saved !== null) statuses.set(key, saved)
  }
  const active = document.activeElement
  let focused: SettingsDrafts['focused'] = null
  if (active instanceof HTMLInputElement) {
    const selection = {
      selectionStart: active.selectionStart,
      selectionEnd: active.selectionEnd,
      selectionDirection: active.selectionDirection,
    }
    if (active.matches('[data-wts-draft-url]')) {
      focused = { kind: 'url', ...selection }
    } else {
      const server = active.dataset.wtsDraftCode
      if (server !== undefined) focused = { kind: 'code', server, ...selection }
    }
  }
  const scrollTop = panel.querySelector<HTMLElement>('[data-wts-settings-scroll]')?.scrollTop ?? 0
  return { serverUrl, accessCodes, statuses, focused, scrollTop }
}

const restoreSettingsDrafts = (panel: HTMLElement, drafts: SettingsDrafts): void => {
  const serverUrl = panel.querySelector<HTMLInputElement>('[data-wts-draft-url]')
  if (serverUrl !== null) serverUrl.value = drafts.serverUrl
  for (const input of panel.querySelectorAll<HTMLInputElement>('[data-wts-draft-code]')) {
    const value = input.dataset.wtsDraftCode
    if (value !== undefined) input.value = drafts.accessCodes.get(value) ?? ''
  }
  for (const status of panel.querySelectorAll<HTMLElement>('[data-wts-draft-status]')) {
    const key = status.dataset.wtsDraftStatus
    const saved = key === undefined ? undefined : drafts.statuses.get(key)
    if (saved !== undefined) restoreTransientStatus(status, saved)
  }
  const scroller = panel.querySelector<HTMLElement>('[data-wts-settings-scroll]')
  if (scroller !== null) scroller.scrollTop = drafts.scrollTop
  const focused = drafts.focused
  if (focused === null) return
  const target =
    focused.kind === 'url'
      ? panel.querySelector<HTMLInputElement>('[data-wts-draft-url]')
      : [...panel.querySelectorAll<HTMLInputElement>('[data-wts-draft-code]')].find(
          (input) => input.dataset.wtsDraftCode === focused.server,
        )
  if (target === null || target === undefined) return
  target.focus({ preventScroll: true })
  if (focused.selectionStart !== null && focused.selectionEnd !== null) {
    target.setSelectionRange(
      focused.selectionStart,
      focused.selectionEnd,
      focused.selectionDirection ?? undefined,
    )
  }
}

const showView = (view: View, preserveDrafts = false): void => {
  closeTreeContextMenu(false)
  if (view !== currentView) {
    panelOwnerGeneration++
    cancelViewOwnedWork(cancelPanelRequests, cancelTreeConfirm, cancelTreeCopy)
  }
  currentView = view
  const panel = document.getElementById(PANEL_ID)
  const drafts = preserveDrafts && panel !== null ? settingsDrafts(panel) : null
  const body = panel?.querySelector('[data-wts-body]')
  const title = panel?.querySelector('h2')
  if (!body || !title) return
  const inSettings = view === 'settings'
  if (inSettings) void loadAccount()
  deactivateTreeView()
  body.replaceChildren(
    inSettings
      ? settingsView({
          isSettingsView: () => currentView === 'settings',
          panelRequest,
          showSettings: () => showView('settings', true),
        })
      : treeView({
          copyOperations,
          ownerGeneration: () => panelOwnerGeneration,
          ownsTreeView: (generation) =>
            open && currentView === 'tree' && panelOwnerGeneration === generation,
          showSettings: () => showView('settings'),
        }),
  )
  if (drafts !== null && panel !== null) restoreSettingsDrafts(panel, drafts)
  title.textContent = inSettings ? 'Settings' : PANEL_TITLE

  const back = panel?.querySelector<HTMLElement>('[data-wts-back]')
  if (back) back.style.visibility = inSettings ? 'visible' : 'hidden'

  const gear = panel?.querySelector<HTMLElement>('[data-wts-settings]')
  if (gear) {
    // btn-active is DaisyUI's pressed state, so it reads as "you are here" in their theme.
    gear.className = `btn btn-ghost btn-xs btn-circle${inSettings ? ' btn-active' : ''}`
    gear.setAttribute('aria-pressed', String(inSettings))
  }
  log('install', `panel view: ${view}`)
}

const setOpen = (next: boolean): void => {
  open = next
  syncRailButtonState(open)
  const existing = document.getElementById(PANEL_ID)
  if (!open) {
    const restoreRailFocus =
      existing !== null &&
      document.activeElement !== null &&
      existing.contains(document.activeElement)
    panelOwnerGeneration++
    closeTreeContextMenu(false)
    cancelPanelRequests()
    deactivateTreeView()
    commitKeyboardResize()
    cancelPointerResize()
    cancelTreeConfirm()
    cancelTreeCopy()
    cancelRenaming()
    existing?.remove()
    if (restoreRailFocus) queueMicrotask(() => document.getElementById(BUTTON_ID)?.focus())
    return
  }
  if (existing !== null) return
  document.body.appendChild(
    buildPanel(
      () => showView('tree'),
      () => showView(currentView === 'settings' ? 'tree' : 'settings'),
      () => setOpen(false),
    ),
  )
  showView(currentView)
}

/**
 * Keep the button on the rail.
 *
 * The rail is rendered by wplace's own Svelte app, which is free to re-render and drop anything we
 * appended. An observer costs nothing and turns "the button disappeared after I opened a menu" into
 * a non-event.
 */
export const installPanel = (): void => {
  loadState()
  if (!accountObserverInstalled) {
    accountObserverInstalled = true
    onAccountChange(rerenderAccountWhenRelevant)
  }
  void refreshStoredServers(rerenderServersWhenRelevant)
  installStyles()
  if (!viewportResizeInstalled) {
    viewportResizeInstalled = true
    window.addEventListener('resize', resizePanelForViewport)
  }
  let warned = false
  const attach = (): void => {
    const existing = document.getElementById(BUTTON_ID)
    const previous = existing?.previousElementSibling
    const previousLabel = previous?.getAttribute('title') ?? previous?.getAttribute('aria-label')
    if (previousLabel?.trim() === ANCHOR_LABEL) return
    const found = findRail()
    if (found === null) {
      if (!warned) {
        warned = true
        warn('install', `no "${ANCHOR_LABEL}" button on the page yet — watching for it`)
      }
      return
    }
    existing?.remove()
    found.after.insertAdjacentElement(
      'afterend',
      railButton(() => setOpen(!open)),
    )
    syncRailButtonState(open)
    log('install', 'rail button attached below Overlays')
  }

  attach()
  new MutationObserver(attach).observe(document.body, { childList: true, subtree: true })
}

export { setAlarmBadge } from './panel-notifications.js'
