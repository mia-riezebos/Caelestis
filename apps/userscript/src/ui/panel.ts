import { log, warn } from '../debug.js'
import { viewportCentre } from '../main.js'
import { forgetServer } from '../server-cache.js'
import {
  type ConnectedServer,
  canonicalServerUrl,
  createNode,
  deleteNode as deleteNodeOnServer,
  getState,
  listNodes,
  loadState,
  MAX_CONNECTED_SERVERS,
  probeServer,
  refreshStoredServers,
  removeServer,
  removeTreeStateKeys,
  renameNode as renameNodeOnServer,
  setState,
  uploadTemplate,
  upsertServer,
} from '../state.js'
import { importFile } from '../templates/import.js'
import {
  addLocalTemplate,
  localTemplates as allLocal,
  localTemplates,
  placeLocalTemplate,
  removeLocalTemplate,
  renameLocalTemplate,
  templateAsPng,
} from '../templates/local-store.js'
import {
  beginMove,
  isMoving,
  movePreviewOrigin,
  reserveMove,
  stopMoveForDeletion,
} from '../templates/move.js'
import { centreOf, navigateTo } from '../templates/navigate.js'
import { loadAccount, onAccountChange } from '../wplace-account.js'
import { coloursSection } from './colours.js'
import type { IconName } from './icons.js'
import { icon } from './icons.js'
import {
  admitTemplates,
  cancelViewOwnedWork,
  completionAfterImport,
  createKeyedOperationGate,
  createRerenderGate,
  createResizeCommitter,
  finalImportNotice,
  IMPORT_ACCEPT,
  importedImageNextStep,
  once,
  restoreConnectedFocus,
  toastMount,
} from './panel-workflow.js'
import { type SortOrder, sortControl } from './sort.js'
import { installStyles } from './styles.js'
import {
  cancelRenaming,
  forgetNodeOrder,
  forgetServerTree,
  nodeTreeKey,
  primeFromCache,
  refreshNodes,
  startRenaming,
  type TreeTarget,
  treeContents,
} from './tree.js'

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

/**
 * How to find the rail.
 *
 * Not by its classes. `.flex.flex-col.items-center.gap-3` is Tailwind utility soup that describes a
 * layout, not an identity — several elements on the page match it, `querySelector` returns whichever
 * comes first in the document, and ours landed in the wrong one. Anchor on the thing we actually
 * mean instead: wplace's own Overlays button, whose parent *is* the rail by definition. Ours then
 * lands directly beneath it, which is where it was asked to go.
 */
const ANCHOR_LABEL = 'Overlays'

const findRail = (): { rail: Element; after: Element } | null => {
  for (const button of document.querySelectorAll('button')) {
    const label = button.getAttribute('title') ?? button.getAttribute('aria-label') ?? ''
    if (label.trim() !== ANCHOR_LABEL) continue
    const rail = button.parentElement
    if (rail !== null) return { rail, after: button }
  }
  return null
}
const BUTTON_ID = 'wts-rail-button'
const PANEL_ID = 'wts-panel'

/**
 * Named for the alliance it was built for. From Latin `caelum` — sky, heavens — so it carries
 * "shared" and "above everything" without having to say either.
 *
 * A proper noun rather than a functional label like the buttons around it, which is right for a
 * third-party addition: it should not read as another wplace feature. The tooltip carries the
 * explanation, since "Caelestis" alone teaches a first-time user nothing.
 */
const APP_NAME = 'Caelestis'
const PANEL_TITLE = APP_NAME
const BUTTON_TOOLTIP = `${APP_NAME} — shared templates`
const MAX_COPY_DESTINATIONS = 2_000

type View = 'tree' | 'settings'

let currentView: View = 'tree'
let open = false
let searchQuery = ''
let activeResizeCleanup: (() => void) | null = null
let activeKeyboardResizeCommit: (() => void) | null = null
let activeTreeRender: (() => void) | null = null
let cancelActiveConfirm: (() => void) | null = null
let cancelActiveCopy: (() => void) | null = null
let closeActiveContextMenu: ((restoreFocus: boolean) => void) | null = null
let viewportResizeInstalled = false
let accountObserverInstalled = false
let panelOwnerGeneration = 0
let controlLabelSerial = 0
const connectionAttempts = new Map<string, number>()
const activePanelRequests = new Map<AbortController, () => void>()
const copyOperations = createKeyedOperationGate()
const panelRerenders = createRerenderGate(() => rerenderWhenIdle())

type PanelRequestScope = 'view' | 'mutation'

const beginConnectionAttempt = (url: string): (() => boolean) => {
  const generation = (connectionAttempts.get(url) ?? 0) + 1
  connectionAttempts.set(url, generation)
  return () => connectionAttempts.get(url) === generation
}

const panelRequest = (
  scope: PanelRequestScope = 'view',
): { controller: AbortController; finish: () => void } => {
  const controller = new AbortController()
  const releaseRerender = scope === 'view' ? panelRerenders.hold() : null
  if (releaseRerender !== null) activePanelRequests.set(controller, releaseRerender)
  return {
    controller,
    finish: () => {
      if (scope !== 'view') return
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

const maximumPanelWidth = (): number => Math.min(720, Math.max(0, window.innerWidth - 96))
const minimumPanelWidth = (): number => Math.min(260, maximumPanelWidth())
const panelWidthForViewport = (wanted: number): number =>
  Math.min(maximumPanelWidth(), Math.max(minimumPanelWidth(), wanted))

const updateResizeValue = (handle: HTMLElement, width: number): void => {
  handle.setAttribute('aria-valuemin', String(minimumPanelWidth()))
  handle.setAttribute('aria-valuemax', String(maximumPanelWidth()))
  handle.setAttribute('aria-valuenow', String(Math.round(width)))
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
  if (currentView === 'tree') activeTreeRender?.()
  else rerenderWhenIdle()
}

/**
 * wplace marks an open rail button by adding `btn-primary`, measured by opening theirs and diffing
 * the class list. Using the same class rather than a colour of our own means our button lights up
 * in whatever their theme calls primary, now and after any theme change.
 */
const RAIL_BUTTON_CLASS = 'btn btn-square shadow-md relative'

const syncRailButtonState = (): void => {
  const button = document.getElementById(BUTTON_ID)
  if (button === null) return
  button.className = open ? `${RAIL_BUTTON_CLASS} btn-primary` : RAIL_BUTTON_CLASS
  button.setAttribute('aria-expanded', String(open))
}

const railButton = (): HTMLButtonElement => {
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
  button.addEventListener('click', () => setOpen(!open))
  return button
}

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

const sectionHeader = (title: string): HTMLElement => {
  const h = document.createElement('h3')
  h.className = 'text-xs font-semibold opacity-60 uppercase tracking-wide px-3 pt-4 pb-1'
  h.textContent = title
  return h
}

const treeView = (): HTMLElement => {
  const view = document.createElement('div')
  Object.assign(view.style, { display: 'flex', flexDirection: 'column', minHeight: '0', flex: '1' })

  // Search and sort share a row: both are ways of finding one template among many, and giving sort
  // its own row would push the tree down for a control most people set once.
  const toolbar = document.createElement('div')
  toolbar.className = 'flex items-center gap-1'
  Object.assign(toolbar.style, { margin: '0.75rem 0.75rem 0' })

  const search = document.createElement('label')
  search.className = 'input input-sm input-bordered flex items-center gap-2'
  Object.assign(search.style, { flex: '1', minWidth: '0' })
  const searchIcon = icon('search', 'size-4 opacity-50')
  const searchInput = document.createElement('input')
  searchInput.type = 'search'
  searchInput.style.flex = '1'
  searchInput.style.minWidth = '0'
  searchInput.placeholder = 'Search templates'
  searchInput.setAttribute('aria-label', 'Search templates')
  searchInput.value = searchQuery
  search.append(searchIcon, searchInput)

  const rerenderTree = (): void => activeTreeRender?.()
  let sortElement: HTMLElement
  const changeSort = (next: SortOrder): void => {
    setState({ sort: next })
    // Only row order changed. Rebuilding the whole view resets the tree scroller and makes the
    // freshly focused replacement trigger satisfy DaisyUI's focus-within open rule.
    rerenderTree()
    const replacement = sortControl(next, changeSort)
    sortElement.replaceWith(replacement)
    sortElement = replacement
    requestAnimationFrame(() =>
      replacement.querySelector<HTMLElement>('[data-wts-sort]')?.focus({ preventScroll: true }),
    )
  }
  sortElement = sortControl(getState().sort, changeSort)
  toolbar.append(search, sortElement)

  const body = document.createElement('div')
  Object.assign(body.style, { overflowY: 'auto', flex: '1', minHeight: '0' })
  let renderTree: () => void
  const backgroundRenderTree = (): void => {
    if (activeTreeRender !== renderTree) {
      rerenderTree()
      return
    }
    const focused = document.activeElement
    if (
      focused !== null &&
      body.contains(focused) &&
      focused.closest('[data-wts-renaming]') !== null
    ) {
      body.addEventListener('focusout', () => setTimeout(backgroundRenderTree, 0), { once: true })
      return
    }
    renderTree()
  }
  renderTree = (): void => {
    if (activeTreeRender !== renderTree) {
      rerenderTree()
      return
    }
    const focused = document.activeElement as HTMLElement | null
    const focusedRow = focused?.closest<HTMLElement>('[data-wts-key]') ?? null
    const focusKey = focusedRow?.dataset.wtsKey ?? null
    const focusLabel = focused?.getAttribute('aria-label') ?? null
    const focusedRename = focused?.matches('[data-wts-rename]') === true
    const focusedRowItself = focused === focusedRow
    const scrollTop = body.scrollTop
    body.replaceChildren(
      treeContents(
        {
          onAddServer: () => showView('settings'),
          onCreateFolder: (target) => void createFolder(target, rerenderTree),
          onImportTemplate: (target) => void importTemplate(target, rerenderTree),
          onRename: (target, name) => void applyRename(target, name, rerenderTree),
          onDelete: (target) => void applyDelete(target, rerenderTree),
          onContextMenu: (target, event) => openContextMenu(target, event, rerenderTree),
          onGoTo: goTo,
          onCopyToServer: (id, invoker) => void copyToServer(id, rerenderTree, invoker),
          onError: (message) => toast(message, 'error'),
        },
        rerenderTree,
        searchQuery,
        backgroundRenderTree,
      ),
    )
    if (focusKey !== null) {
      const nextRow = [...body.querySelectorAll<HTMLElement>('[data-wts-key]')].find(
        (row) => row.dataset.wtsKey === focusKey,
      )
      const nextFocus = focusedRowItself
        ? nextRow
        : focusedRename
          ? nextRow?.querySelector<HTMLElement>('[data-wts-rename]')
          : [...(nextRow?.querySelectorAll<HTMLElement>('[aria-label]') ?? [])].find(
              (control) => control.getAttribute('aria-label') === focusLabel,
            )
      nextFocus?.focus({ preventScroll: true })
    }
    body.scrollTop = scrollTop
  }
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value
    if (searchTimer !== null) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchTimer = null
      rerenderTree()
    }, 100)
  })
  activeTreeRender = renderTree
  renderTree()
  // Paint what the servers said last time, then let a live fetch replace it.
  void primeFromCache(rerenderTree)

  view.append(toolbar, body)
  return view
}

const settingRow = (label: string, hint: string | null, control: HTMLElement): HTMLElement => {
  const row = document.createElement('div')
  row.className = 'flex items-center justify-between gap-4 px-3 py-2'
  row.style.minHeight = '3rem'
  const text = document.createElement('div')
  text.className = 'flex flex-col'
  const name = document.createElement('span')
  const labelId = `wts-setting-${++controlLabelSerial}`
  name.id = labelId
  name.className = 'text-sm'
  name.textContent = label
  text.append(name)
  if (hint !== null) {
    const sub = document.createElement('span')
    sub.className = 'text-xs opacity-60'
    sub.textContent = hint
    text.appendChild(sub)
  }
  control.setAttribute('aria-labelledby', labelId)
  row.append(text, control)
  return row
}

const announce = (element: HTMLElement, message: string, error = false): void => {
  element.setAttribute('role', error ? 'alert' : 'status')
  element.setAttribute('aria-live', error ? 'assertive' : 'polite')
  element.textContent = message
}

const checkbox = (): HTMLInputElement => {
  const el = document.createElement('input')
  el.type = 'checkbox'
  el.className = 'checkbox checkbox-sm'
  return el
}

const retryServerButton = (server: ConnectedServer, label: string): HTMLButtonElement => {
  const button = document.createElement('button')
  button.className = 'btn btn-xs btn-ghost'
  button.textContent = label
  button.addEventListener('click', () => {
    if (button.disabled) return
    button.disabled = true
    void (async () => {
      const ownsAttempt = beginConnectionAttempt(server.url)
      const request = panelRequest()
      try {
        const next = await probeServer(server.url, server.token, request.controller.signal)
        if (
          request.controller.signal.aborted ||
          !ownsAttempt() ||
          getState().servers.find((candidate) => candidate.url === server.url) !== server
        ) {
          return
        }
        upsertServer(next)
        showView('settings', true)
      } finally {
        request.finish()
        if (button.isConnected) button.disabled = false
      }
    })()
  })
  return button
}

/**
 * One connected server, and the single action its status implies.
 *
 * The code field only exists once the server has said it wants one. Asking up front is the fastest
 * way to lose someone whose server does not need a code at all, which most will not.
 */
const serverRow = (server: ConnectedServer): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'px-3 py-2'

  const top = document.createElement('div')
  top.className = 'flex items-center gap-2'
  const name = document.createElement('span')
  name.className = 'text-sm'
  name.style.flex = '1'
  name.style.overflow = 'hidden'
  name.style.textOverflow = 'ellipsis'
  name.style.whiteSpace = 'nowrap'
  name.textContent = server.info?.name ?? server.url
  name.title = server.url

  const badge = document.createElement('span')
  badge.className =
    server.status === 'connected'
      ? 'badge badge-xs badge-success'
      : server.status === 'needs-token'
        ? 'badge badge-xs badge-warning'
        : 'badge badge-xs badge-error'
  badge.textContent =
    server.status === 'connected'
      ? 'connected'
      : server.status === 'needs-token'
        ? 'code'
        : 'offline'

  const remove = document.createElement('button')
  remove.className = 'btn btn-ghost btn-xs btn-circle'
  remove.title = 'Disconnect'
  remove.setAttribute('aria-label', `Disconnect ${server.info?.name ?? server.url}`)
  remove.appendChild(icon('close', 'size-3'))
  remove.addEventListener('click', () => {
    // Invalidate only work owned by this connection. Requests and uploads for other servers must
    // survive an unrelated disconnect.
    beginConnectionAttempt(server.url)
    forgetServerTree(server.url)
    removeServer(server.url)
    void forgetServer(server.url)
    showView('settings', true)
  })

  top.append(name, badge, remove)
  wrap.appendChild(top)

  if (server.status !== 'needs-token') {
    if (server.status === 'unreachable') {
      const why = document.createElement('p')
      why.className = 'text-xs opacity-60'
      why.textContent = server.error ?? 'Could not be reached.'
      wrap.appendChild(why)
      wrap.appendChild(retryServerButton(server, 'Retry'))
    } else if (!server.isAdmin) {
      wrap.appendChild(retryServerButton(server, 'Recheck admin access'))
    }
    return wrap
  }

  const codeRow = document.createElement('div')
  codeRow.className = 'flex gap-2'
  codeRow.style.marginTop = '0.375rem'
  const code = document.createElement('input')
  code.type = 'password'
  code.dataset.wtsDraftCode = server.url
  code.autocomplete = 'off'
  code.className = 'input input-sm input-bordered'
  code.style.flex = '1'
  code.style.minWidth = '0'
  code.placeholder = 'Access code'
  code.setAttribute('aria-label', `Access code for ${server.info?.name ?? server.url}`)
  const submit = document.createElement('button')
  submit.className = 'btn btn-sm btn-primary'
  submit.textContent = 'Connect'

  const status = document.createElement('p')
  status.className = 'text-xs opacity-60'
  status.style.marginTop = '0.25rem'
  announce(status, 'This server needs an access code from whoever runs it.')

  let checking = false
  const attempt = async (): Promise<void> => {
    if (checking) return
    const value = code.value.trim()
    if (value === '') return
    checking = true
    submit.disabled = true
    status.className = 'text-xs opacity-60'
    announce(status, 'Checking…')
    const ownsAttempt = beginConnectionAttempt(server.url)
    const request = panelRequest()
    const next = await probeServer(server.url, value, request.controller.signal)
    request.finish()
    checking = false
    submit.disabled = false
    if (request.controller.signal.aborted) return
    if (
      !ownsAttempt() ||
      getState().servers.find((candidate) => candidate.url === server.url) !== server
    )
      return
    if (next.status === 'connected') {
      upsertServer(next)
      code.value = ''
      showView('settings', true)
      return
    }
    // A wrong code and an unreachable server are different problems with different fixes, so they
    // must not share a message.
    status.className = 'text-xs text-error'
    announce(
      status,
      next.status === 'needs-token'
        ? 'That code was not accepted. Ask whoever runs the server for a current one.'
        : `Could not reach the server. ${next.error ?? ''}`.trim(),
      true,
    )
  }

  submit.addEventListener('click', () => void attempt())
  code.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void attempt()
  })

  codeRow.append(code, submit)
  wrap.append(codeRow, status)
  return wrap
}

const settingsView = (): HTMLElement => {
  const view = document.createElement('div')
  view.dataset.wtsSettingsScroll = ''
  Object.assign(view.style, { overflowY: 'auto', flex: '1', minHeight: '0' })

  view.appendChild(sectionHeader('Servers'))
  const addRow = document.createElement('div')
  addRow.className = 'px-3 pb-2 flex gap-2'
  const url = document.createElement('input')
  url.type = 'url'
  url.dataset.wtsDraftUrl = ''
  url.className = 'input input-sm input-bordered'
  url.style.flex = '1'
  url.style.minWidth = '0'
  url.placeholder = 'https://templates.example.org'
  url.setAttribute('aria-label', 'Template server URL')
  const add = document.createElement('button')
  add.className = 'btn btn-sm btn-primary'
  add.textContent = 'Add'
  const status = document.createElement('p')
  status.className = 'text-xs px-3 pb-2'
  status.style.display = 'none'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')

  let connecting = false
  const connect = async (): Promise<void> => {
    if (connecting) return
    const value = url.value.trim()
    if (value === '') return
    let canonical: string
    try {
      canonical = canonicalServerUrl(value)
    } catch (error) {
      status.style.display = ''
      status.className = 'text-xs px-3 pb-2 text-error'
      announce(status, String(error), true)
      return
    }
    if (getState().servers.some((server) => server.url === canonical)) {
      status.style.display = ''
      status.className = 'text-xs px-3 pb-2 opacity-60'
      announce(status, 'That server is already connected.')
      return
    }
    if (getState().servers.length >= MAX_CONNECTED_SERVERS) {
      status.style.display = ''
      status.className = 'text-xs px-3 pb-2 text-error'
      announce(status, `You can connect at most ${MAX_CONNECTED_SERVERS} servers.`, true)
      return
    }
    connecting = true
    add.disabled = true
    status.style.display = ''
    status.className = 'text-xs px-3 pb-2 opacity-60'
    announce(status, 'Connecting…')
    const ownsAttempt = beginConnectionAttempt(canonical)
    const request = panelRequest()
    const server = await probeServer(canonical, null, request.controller.signal)
    request.finish()
    connecting = false
    add.disabled = false
    if (request.controller.signal.aborted) return
    if (!ownsAttempt()) return
    if (server.status === 'unreachable') {
      status.className = 'text-xs px-3 pb-2 text-error'
      announce(
        status,
        `Could not reach ${server.url}. Check the address and that the server allows this origin.`,
        true,
      )
      return
    }
    if (!upsertServer(server)) {
      status.className = 'text-xs px-3 pb-2 text-error'
      announce(status, `You can connect at most ${MAX_CONNECTED_SERVERS} servers.`, true)
      return
    }
    url.value = ''
    // Re-render so the new server's row appears — it is what carries the status badge and, when the
    // server wants one, the access-code field. Without this the panel reported "needs a code" and
    // then offered nowhere to type one.
    showView('settings', true)
  }

  add.addEventListener('click', () => void connect())
  url.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void connect()
  })
  addRow.append(url, add)
  view.appendChild(addRow)
  view.appendChild(status)

  for (const server of getState().servers) view.appendChild(serverRow(server))

  view.appendChild(sectionHeader('Colours'))
  view.appendChild(coloursSection())

  view.appendChild(sectionHeader('Diagnostics'))
  const debugRow = settingRow('Debug logging', 'Verbose console output for bug reports', checkbox())
  view.appendChild(debugRow)
  return view
}

/** A transient message anchored to the panel, so an action can report without a dialog. */
const toast = (message: string, kind: 'info' | 'warning' | 'error' = 'info'): void => {
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
    Object.assign(el.style, {
      position: 'fixed',
      right: '4rem',
      bottom: '1rem',
      zIndex: '60',
      maxWidth: '24rem',
    })
  }
  el.textContent = message
  mount.appendChild(el)
  setTimeout(() => el.remove(), 6000)
}

const refreshAfterMutation = async (
  server: ConnectedServer,
  rerender: () => void,
): Promise<boolean> => {
  if (!isCurrentServer(server)) return false
  const request = panelRequest('mutation')
  const refreshed = await refreshNodes(server, rerender, true, request.controller.signal)
  request.finish()
  if (request.controller.signal.aborted || (!refreshed.ok && refreshed.cancelled)) return false
  if (refreshed.ok || refreshed.superseded) return true
  toast(`Saved, but the folder list could not refresh. ${refreshed.message}`, 'warning')
  return false
}

const ASTRAL = /[\u{10000}-\u{10FFFF}]/gu

/** Keep generated names unique under the backend's derived-path rules, not only as display text. */
const folderSlug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(ASTRAL, '-')
    .replace(/[^\p{L}\p{N}.]+/gu, '-')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()

/** A name nobody has to type: "New folder", then "New folder 2", and so on. */
const freeFolderName = (taken: ReadonlySet<string>): string => {
  const base = 'New folder'
  if (!taken.has(folderSlug(base))) return base
  for (let n = 2; n < 500; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(folderSlug(candidate))) return candidate
  }
  return `${base} ${Date.now()}`
}

/** `local:<id>` is a template; `local`, `server:<url>` and `node:<id>` are containers. */
const localTemplateId = (target: TreeTarget): string | null =>
  target.key.startsWith('local:') ? target.key.slice('local:'.length) : null

const isCurrentServer = (server: ConnectedServer): boolean =>
  getState().servers.find((candidate) => candidate.url === server.url) === server

const goTo = (templateId: string): void => {
  const template = localTemplates().find((candidate) => candidate.id === templateId)
  if (template === undefined) return
  if (!template.everPlaced) {
    toast('Finish placing this import before navigating away.', 'warning')
    return
  }
  const preview = movePreviewOrigin(template.id)
  navigateTo(
    centreOf(preview === null ? template : { ...template, originX: preview.x, originY: preview.y }),
  )
}

const applyRename = async (
  target: TreeTarget,
  name: string,
  rerender: () => void,
): Promise<void> => {
  const templateId = localTemplateId(target)
  if (templateId !== null) {
    let renamed = false
    try {
      renamed = await renameLocalTemplate(templateId, name)
    } catch (error) {
      warn('install', 'local rename failed', String(error))
    }
    if (!renamed) {
      toast(`Could not rename “${target.name}”.`, 'error')
    }
    rerender()
    return
  }
  if (target.server === null || target.nodeId === null) {
    toast('Local folders are not stored yet — see 32-local-templates.', 'warning')
    rerender()
    return
  }
  if (!isCurrentServer(target.server)) {
    toast('That server connection changed. Try again.', 'warning')
    rerender()
    return
  }
  const request = panelRequest('mutation')
  const result = await renameNodeOnServer(
    target.server,
    target.nodeId,
    name,
    request.controller.signal,
  )
  request.finish()
  if (request.controller.signal.aborted) return
  if (!result.ok) {
    toast(result.message, 'error')
    rerender()
    return
  }
  if (!isCurrentServer(target.server)) return
  await refreshAfterMutation(target.server, rerender)
}

/**
 * Ask before destroying something.
 *
 * Delete sits in a context menu one slip away from Rename, and a folder is not recoverable from the
 * client. The confirm names the thing rather than saying "are you sure", so the answer does not
 * depend on remembering what was right-clicked.
 */
const confirmDestructive = (
  message: string,
  restoreFocusTo: HTMLElement | null = null,
): Promise<boolean> =>
  new Promise((resolve) => {
    cancelActiveConfirm?.()
    const panel = document.getElementById(PANEL_ID)
    if (panel === null) {
      resolve(false)
      return
    }
    panel.querySelector('[data-wts-confirm]')?.remove()
    const box = document.createElement('div')
    box.setAttribute('data-wts-confirm', '')
    box.className = 'alert alert-warning flex flex-col items-stretch gap-2 text-xs'
    Object.assign(box.style, { margin: '0 0.5rem 0.5rem', padding: '0.625rem 0.75rem' })
    const text = document.createElement('span')
    text.textContent = message
    const buttons = document.createElement('div')
    buttons.className = 'flex gap-2 justify-end'
    const cancel = document.createElement('button')
    cancel.className = 'btn btn-xs btn-ghost'
    cancel.textContent = 'Cancel'
    const confirm = document.createElement('button')
    confirm.className = 'btn btn-xs btn-error'
    confirm.textContent = 'Delete'
    let settled = false
    const finish = (answer: boolean): void => {
      if (settled) return
      settled = true
      if (cancelActiveConfirm === cancelPending) cancelActiveConfirm = null
      box.remove()
      restoreConnectedFocus(restoreFocusTo)
      resolve(answer)
    }
    const cancelPending = (): void => finish(false)
    cancelActiveConfirm = cancelPending
    cancel.addEventListener('click', () => finish(false))
    confirm.addEventListener('click', () => finish(true))
    buttons.append(cancel, confirm)
    box.append(text, buttons)
    panel.appendChild(box)
    confirm.focus()
  })

const applyDelete = async (
  target: TreeTarget,
  rerender: () => void,
  restoreFocusTo: HTMLElement | null = null,
): Promise<void> => {
  const templateId = localTemplateId(target)
  if (templateId !== null) {
    if (
      !(await confirmDestructive(`Delete “${target.name}”? This cannot be undone.`, restoreFocusTo))
    )
      return
    const stoppedMove = stopMoveForDeletion(templateId)
    try {
      const removed = await removeLocalTemplate(templateId)
      if (!removed) {
        toast(`Could not delete “${target.name}”.`, 'error')
        if (
          stoppedMove !== null &&
          !stoppedMove.reservation.start(templateId, rerender, stoppedMove.origin)
        ) {
          toast(`Could not restore placement for “${target.name}”.`, 'error')
        }
        return
      }
      removeTreeStateKeys(new Set([target.key]))
      rerender()
    } catch (error) {
      warn('install', 'local delete failed', String(error))
      toast(`Could not delete “${target.name}”.`, 'error')
      if (
        stoppedMove !== null &&
        !stoppedMove.reservation.start(templateId, rerender, stoppedMove.origin)
      ) {
        toast(`Could not restore placement for “${target.name}”.`, 'error')
      }
    } finally {
      stoppedMove?.reservation.release()
    }
    return
  }
  if (target.server === null || target.nodeId === null) {
    toast('Nothing to delete here yet.', 'warning')
    return
  }
  if (
    !(await confirmDestructive(`Delete “${target.name}”? This cannot be undone.`, restoreFocusTo))
  )
    return
  if (!isCurrentServer(target.server)) {
    toast('That server connection changed. Try again.', 'warning')
    rerender()
    return
  }
  const request = panelRequest('mutation')
  const result = await deleteNodeOnServer(target.server, target.nodeId, request.controller.signal)
  request.finish()
  if (request.controller.signal.aborted) return
  if (!result.ok) {
    toast(result.message, 'error')
    rerender()
    return
  }
  if (!isCurrentServer(target.server)) return
  forgetNodeOrder(target.server, target.nodeId)
  await refreshAfterMutation(target.server, rerender)
}

/**
 * A right-click menu carrying the row's actions plus the ones deliberately kept off it.
 *
 * Move and Delete are here rather than on the row because a row action sits under the cursor
 * during an ordinary hover: Move takes over the canvas and Delete destroys the template, and
 * neither should be one stray click away. The template's own menu on the canvas carries them too.
 *
 * Dismissed by the next pointerdown anywhere, which is what every native menu does and what people
 * try first.
 */
const openContextMenu = (target: TreeTarget, event: MouseEvent, rerender: () => void): void => {
  closeActiveContextMenu?.(false)
  const invoker = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  const menu = document.createElement('ul')
  menu.setAttribute('data-wts-menu', '')
  menu.setAttribute('role', 'menu')
  menu.tabIndex = -1
  menu.className = 'menu bg-base-100 shadow-2xl'
  Object.assign(menu.style, {
    position: 'fixed',
    left: `${event.clientX}px`,
    top: `${event.clientY}px`,
    zIndex: '60',
    borderRadius: '0.5rem',
    padding: '0.25rem',
    width: '11rem',
  })

  const templateId = localTemplateId(target)
  const rename: readonly [IconName, string, () => void] = [
    'rename',
    'Rename',
    () => {
      startRenaming(target.key)
      rerender()
    },
  ]
  const remove: readonly [IconName, string, () => void] = [
    'trash',
    'Delete',
    () => void applyDelete(target, rerender, invoker),
  ]
  const entries: ReadonlyArray<readonly [IconName, string, () => void]> =
    templateId === null
      ? [
          ['createFolder', 'New folder', () => void createFolder(target, rerender)],
          ...(target.server === null
            ? ([
                ['uploadFile', 'Import template', () => void importTemplate(target, rerender)],
              ] as const)
            : []),
          ...(target.nodeId !== null ? [rename, remove] : []),
        ]
      : [
          ['search', 'Go to', () => void goTo(templateId)],
          [
            'move',
            'Move',
            () => {
              if (!beginMove(templateId, rerender)) {
                toast(
                  'Finish the placement already in progress, then move this template.',
                  'warning',
                )
              }
            },
          ],
          [
            'uploadFile',
            'Copy to a server',
            () => void copyToServer(templateId, rerender, invoker),
          ],
          rename,
          remove,
        ]
  for (const [glyph, label, run] of entries) {
    const item = document.createElement('li')
    item.setAttribute('role', 'none')
    const button = document.createElement('button')
    button.setAttribute('role', 'menuitem')
    button.tabIndex = -1
    button.className = label === 'Delete' ? 'text-error' : ''
    button.appendChild(icon(glyph, 'size-4'))
    const text = document.createElement('span')
    text.textContent = label
    button.appendChild(text)
    button.addEventListener('click', () => {
      closeActiveContextMenu?.(false)
      run()
    })
    item.appendChild(button)
    menu.appendChild(item)
  }
  document.body.appendChild(menu)
  if (event.clientX === 0 && event.clientY === 0 && invoker !== null) {
    const invokerBox = invoker.getBoundingClientRect()
    menu.style.left = `${invokerBox.left}px`
    menu.style.top = `${invokerBox.bottom}px`
  }
  // Keep it on screen when the click lands near an edge.
  const box = menu.getBoundingClientRect()
  if (box.right > window.innerWidth) menu.style.left = `${window.innerWidth - box.width - 8}px`
  if (box.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - box.height - 8}px`
  // Dismiss on a pointerdown *outside* the menu.
  //
  // Dismissing on any pointerdown looked right and made every item dead: pointerdown precedes
  // click, so the menu was removed from the document before the click could reach the button it
  // was pressed on, and nothing happened. The synthetic `.click()` in the first test bypassed
  // pointerdown entirely and so never saw it.
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  let pointerInstalled = false
  const dismiss = (pointer: PointerEvent): void => {
    if (pointer.target instanceof Node && menu.contains(pointer.target)) return
    closeActiveContextMenu?.(true)
  }
  const close = (restoreFocus: boolean): void => {
    if (closeActiveContextMenu !== close) return
    closeActiveContextMenu = null
    if (pointerInstalled) window.removeEventListener('pointerdown', dismiss)
    menu.remove()
    if (restoreFocus && invoker?.isConnected) invoker.focus()
  }
  closeActiveContextMenu = close
  menu.addEventListener('keydown', (key) => {
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const focusAt = (index: number): void => buttons.at(index)?.focus()
    if (key.key === 'Escape') {
      key.preventDefault()
      close(true)
    } else if (key.key === 'ArrowDown') {
      key.preventDefault()
      focusAt((current + 1) % buttons.length)
    } else if (key.key === 'ArrowUp') {
      key.preventDefault()
      focusAt((current - 1 + buttons.length) % buttons.length)
    } else if (key.key === 'Home') {
      key.preventDefault()
      focusAt(0)
    } else if (key.key === 'End') {
      key.preventDefault()
      focusAt(-1)
    }
  })
  setTimeout(() => {
    if (closeActiveContextMenu !== close) return
    pointerInstalled = true
    window.addEventListener('pointerdown', dismiss)
    buttons[0]?.focus()
  }, 0)
}

const importTemplate = async (target: TreeTarget, rerender: () => void): Promise<void> => {
  if (target.server !== null) {
    // Uploading to a server needs the template to exist and be placed first; that is the local
    // flow, and copy-to-server is the step after it.
    toast('Import into Local first, then copy it to a server.', 'warning')
    return
  }
  if (isMoving()) {
    toast('Finish the current placement before importing another template.', 'warning')
    return
  }
  const ownerGeneration = panelOwnerGeneration
  const stillOwned = (): boolean =>
    open && currentView === 'tree' && panelOwnerGeneration === ownerGeneration
  const picker = document.createElement('input')
  picker.type = 'file'
  picker.accept = IMPORT_ACCEPT
  picker.addEventListener('change', () => {
    void (async () => {
      const file = picker.files?.[0]
      if (file === undefined) return
      const centre = viewportCentre() ?? { x: 0, y: 0 }
      try {
        toast(`Reading ${file.name}…`)
        const imported = await importFile(file, centre)
        if (imported.length === 0) {
          toast('Nothing importable in that file.', 'error')
          return
        }
        const first = imported[0]
        if (first?.source === 'image') {
          const ownedBeforePersist = stillOwned()
          const reservation = ownedBeforePersist ? reserveMove() : null
          if (ownedBeforePersist && reservation === null) {
            toast('Finish the current placement, then import this image again.', 'warning')
            return
          }
          try {
            await addLocalTemplate(first)
            rerender()
            if (importedImageNextStep(stillOwned(), reservation !== null) === 'persist') {
              let persisted = false
              try {
                persisted = await placeLocalTemplate(first.id, first.originX, first.originY)
              } catch (error) {
                await removeLocalTemplate(first.id).catch(() => false)
                rerender()
                toast(`Could not keep imported image: ${String(error)}`, 'error')
                return
              }
              if (!persisted) {
                await removeLocalTemplate(first.id).catch(() => false)
                rerender()
                toast('Could not keep imported image in local storage.', 'error')
                return
              }
              rerender()
              const notice = finalImportNotice(first, 1, 1, null)
              toast(`${notice.message} — placed at the map centre; use Move to adjust it`)
              return
            }
            if (reservation === null || !reservation.start(first.id, rerender)) {
              const discarded = await removeLocalTemplate(first.id)
              rerender()
              toast(
                discarded
                  ? 'Another placement started. Finish it, then import this image again.'
                  : 'Could not start placement for this image. Remove it or place it before reloading.',
                discarded ? 'warning' : 'error',
              )
              return
            }
            const notice = finalImportNotice(first, 1, 1, null)
            toast(notice.message, notice.tone)
          } finally {
            reservation?.release()
          }
          return
        }
        const admitted = await admitTemplates(imported, addLocalTemplate)
        const added = admitted.added.length
        const failure = admitted.failures[0] ?? null
        rerender()

        if (failure !== null) {
          if (added === 0) toast(`Could not import: ${String(failure)}`, 'error')
          if (added === 0) return
        }

        const firstPlaced = admitted.added[0]
        if (firstPlaced === undefined) return
        const completion = completionAfterImport(
          finalImportNotice(firstPlaced, added, imported.length, failure),
          stillOwned(),
          isMoving(),
        )
        toast(completion.message, completion.tone)
        // Non-image formats already know where they belong, so go and look at the first one —
        // centred on the template and zoomed to fit it, in-game. Changing the URL would reload and
        // throw the import away.
        if (completion.navigate) navigateTo(centreOf(firstPlaced))
      } catch (error) {
        toast(`Could not import: ${String(error)}`, 'error')
      }
    })()
  })
  picker.style.display = 'none'
  document.body.appendChild(picker)
  picker.click()
  setTimeout(() => picker.remove(), 60_000)
}

/**
 * Copy a local template onto a server.
 *
 * Only servers where the code is admin can receive one, and only a real node can hold it, so both
 * are chosen here rather than assumed. The placement travels with it — the whole point of getting
 * it right locally first is not having to do it again on the other side.
 */
const copyToServer = async (
  templateId: string,
  rerender: () => void,
  restoreFocusTo: HTMLElement | null = null,
): Promise<void> => {
  const template = allLocal().find((candidate) => candidate.id === templateId)
  if (template === undefined) return
  if (copyOperations.isActive(templateId)) {
    toast(`A copy of “${template.name}” is already in progress.`, 'warning')
    return
  }
  if (!template.everPlaced || movePreviewOrigin(template.id) !== null) {
    toast('Finish placing this template before copying it to a server.', 'warning')
    return
  }
  const openingRevision = template.revision
  const targets = getState().servers.filter((server) => server.isAdmin)
  if (targets.length === 0) {
    toast('No server here accepts uploads — you need an admin code on one.', 'warning')
    return
  }

  const panel = document.getElementById(PANEL_ID)
  if (panel === null) return
  cancelActiveCopy?.()
  const box = document.createElement('div')
  box.setAttribute('data-wts-copy', '')
  box.setAttribute('role', 'group')
  box.setAttribute('aria-label', `Copy ${template.name} to a server`)
  box.className = 'alert flex flex-col items-stretch gap-2 text-xs'
  Object.assign(box.style, { margin: '0 0.5rem 0.5rem', padding: '0.625rem 0.75rem' })

  const label = document.createElement('span')
  label.setAttribute('role', 'status')
  label.setAttribute('aria-live', 'polite')
  label.textContent = 'Loading destinations…'
  const serverChooser = document.createElement('select')
  serverChooser.setAttribute('aria-label', 'Server')
  serverChooser.className = 'select select-xs select-bordered'
  targets.forEach((server, index) => {
    const option = document.createElement('option')
    option.value = String(index)
    option.textContent = server.info?.name ?? server.url
    serverChooser.appendChild(option)
  })
  const filter = document.createElement('input')
  filter.type = 'search'
  filter.setAttribute('aria-label', 'Filter folders')
  filter.className = 'input input-xs input-bordered'
  filter.placeholder = 'Filter folders'
  const chooser = document.createElement('select')
  chooser.setAttribute('aria-label', 'Destination folder')
  chooser.className = 'select select-xs select-bordered'
  chooser.disabled = true
  const buttons = document.createElement('div')
  buttons.className = 'flex gap-2 justify-end'
  const cancel = document.createElement('button')
  cancel.className = 'btn btn-xs btn-ghost'
  cancel.textContent = 'Cancel'
  const controllers: AbortController[] = []
  let filterTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let closeCopy: () => void
  closeCopy = once(() => {
    closed = true
    if (filterTimer !== null) clearTimeout(filterTimer)
    for (const controller of controllers) controller.abort()
    box.remove()
    if (cancelActiveCopy === closeCopy) cancelActiveCopy = null
    restoreConnectedFocus(restoreFocusTo)
  })
  cancelActiveCopy = closeCopy
  cancel.addEventListener('click', closeCopy)
  const go = document.createElement('button')
  go.className = 'btn btn-xs btn-primary'
  go.textContent = 'Copy'
  go.disabled = true
  buttons.append(cancel, go)
  box.append(label, serverChooser, filter, chooser, buttons)
  panel.appendChild(box)
  serverChooser.focus()

  let destinationController: AbortController | null = null
  let loadedNodes: readonly {
    readonly id: string
    readonly path: string
    readonly search: string
  }[] = []
  let loadGeneration = 0
  const renderDestinations = (): void => {
    chooser.replaceChildren()
    const needle = filter.value.trim().toLocaleLowerCase()
    let matches = 0
    for (const node of loadedNodes) {
      if (needle !== '' && !node.search.includes(needle)) {
        continue
      }
      matches++
      if (chooser.options.length >= MAX_COPY_DESTINATIONS) continue
      const option = document.createElement('option')
      option.value = node.id
      option.textContent = node.path
      chooser.appendChild(option)
    }
    chooser.disabled = chooser.options.length === 0
    go.disabled = chooser.options.length === 0
    label.textContent =
      matches > chooser.options.length
        ? `Showing ${chooser.options.length.toLocaleString()} of ${matches.toLocaleString()} matching folders — narrow the filter to reach the rest.`
        : matches === 0
          ? needle === ''
            ? 'Create a folder on this server first.'
            : 'No folders match that filter.'
          : `Copy “${template.name}” to:`
  }
  const loadSelectedServer = async (): Promise<void> => {
    destinationController?.abort()
    const generation = ++loadGeneration
    const server = targets[Number(serverChooser.value)]
    if (server === undefined) return
    loadedNodes = []
    chooser.replaceChildren()
    chooser.disabled = true
    go.disabled = true
    if (getState().servers.find((candidate) => candidate.url === server.url) !== server) {
      label.textContent = 'That server was disconnected. Choose another server or reopen Copy.'
      return
    }
    label.textContent = `Loading folders from ${server.info?.name ?? server.url}…`
    const controller = new AbortController()
    destinationController = controller
    controllers.push(controller)
    const result = await listNodes(server, controller.signal)
    if (closed || controller.signal.aborted || generation !== loadGeneration) return
    if (getState().servers.find((candidate) => candidate.url === server.url) !== server) {
      loadedNodes = []
      chooser.replaceChildren()
      label.textContent = 'That server was disconnected. Choose another server or reopen Copy.'
      return
    }
    if (!result.ok) {
      loadedNodes = []
      chooser.replaceChildren()
      label.textContent = `Could not load folders. ${result.message}`
      return
    }
    loadedNodes = result.nodes.map((node) => ({
      id: node.id,
      path: node.path,
      search: `${node.path}\n${node.name}`.toLocaleLowerCase(),
    }))
    renderDestinations()
  }
  serverChooser.addEventListener('change', () => void loadSelectedServer())
  filter.addEventListener('input', () => {
    if (filterTimer !== null) clearTimeout(filterTimer)
    filterTimer = setTimeout(() => {
      filterTimer = null
      if (!closed) renderDestinations()
    }, 150)
  })
  await loadSelectedServer()
  if (!box.isConnected) return

  let uploading = false
  go.addEventListener('click', () => {
    if (uploading) return
    void (async () => {
      const selected = targets[Number(serverChooser.value)]
      const nodeId = chooser.value || undefined
      const server = getState().servers.find((candidate) => candidate.url === selected?.url)
      if (
        selected === undefined ||
        server === undefined ||
        nodeId === undefined ||
        !server.isAdmin ||
        server.info?.id !== selected.info?.id ||
        server.season !== selected.season ||
        server.token !== selected.token
      ) {
        closeCopy()
        toast('That server connection changed. Open Copy again.', 'warning')
        return
      }
      const releaseCopy = copyOperations.begin(templateId)
      if (releaseCopy === null) {
        closeCopy()
        toast(`A copy of “${template.name}” is already in progress.`, 'warning')
        return
      }
      uploading = true
      go.disabled = true
      serverChooser.disabled = true
      filter.disabled = true
      chooser.disabled = true
      let uploadStarted = false
      try {
        const source = allLocal().find((candidate) => candidate.id === templateId)
        if (
          source === undefined ||
          source.revision !== openingRevision ||
          !source.everPlaced ||
          movePreviewOrigin(source.id) !== null
        ) {
          closeCopy()
          toast('That template changed. Open Copy again.', 'warning')
          return
        }
        label.textContent = 'Encoding…'
        const encodeController = new AbortController()
        controllers.push(encodeController)
        const png = await templateAsPng(source, encodeController.signal)
        if (closed) return
        if (png === null) throw new Error('encoder returned no image')
        const ready = allLocal().find((candidate) => candidate.id === templateId)
        if (
          ready === undefined ||
          ready.revision !== openingRevision ||
          !ready.everPlaced ||
          movePreviewOrigin(ready.id) !== null
        ) {
          closeCopy()
          toast('That template changed while it was encoding. Open Copy again.', 'warning')
          return
        }
        if (getState().servers.find((candidate) => candidate.url === server.url) !== server) {
          throw new Error('server connection changed while encoding')
        }
        label.textContent = `Uploading ${Math.round(png.size / 1024)} KB…`
        uploadStarted = true
        const result = await uploadTemplate(server, {
          nodeId,
          name: ready.name,
          originX: ready.originX,
          originY: ready.originY,
          png,
        })
        if (!result.ok) throw new Error(result.message)
        if (getState().servers.find((candidate) => candidate.url === server.url) !== server) {
          closeCopy()
          toast(
            `Copied “${ready.name}”, but that server was disconnected here. Reconnect to refresh it.`,
            'warning',
          )
          return
        }
        closeCopy()
        toast(`Copied “${ready.name}” to ${server.info?.name ?? server.url}.`)
        await refreshAfterMutation(server, rerender)
      } catch (error) {
        if (closed && !uploadStarted) return
        toast(`Could not copy: ${String(error)}`, 'error')
        label.textContent = `Copy “${template.name}” to:`
        uploading = false
        if (box.isConnected) {
          serverChooser.disabled = false
          filter.disabled = false
          chooser.disabled = chooser.options.length === 0
          go.disabled = chooser.options.length === 0
        }
      } finally {
        releaseCopy()
      }
    })()
  })
}

const createFolder = async (target: TreeTarget, rerender: () => void): Promise<void> => {
  const { server, nodeId } = target
  if (server === null) {
    toast('Local folders are not stored yet — see 32-local-templates.', 'warning')
    return
  }
  if (!isCurrentServer(server)) {
    toast('That server connection changed. Try again.', 'warning')
    rerender()
    return
  }
  const request = panelRequest('mutation')
  // No dialog: pick a free name, create it, and drop straight into renaming it. Asking for a name
  // before the thing exists is a question with no context; renaming one that is on screen is not.
  const existing = await listNodes(server, request.controller.signal)
  if (request.controller.signal.aborted) {
    request.finish()
    return
  }
  if (!existing.ok) {
    request.finish()
    toast(existing.message, 'error')
    return
  }
  if (!isCurrentServer(server)) {
    request.finish()
    toast('That server connection changed. Try again.', 'warning')
    rerender()
    return
  }
  const name = freeFolderName(
    new Set(
      existing.nodes
        .filter((node) => node.parentId === nodeId)
        .map((node) => folderSlug(node.name)),
    ),
  )
  const result = await createNode(server, name, nodeId, request.controller.signal)
  request.finish()
  if (request.controller.signal.aborted) return
  if (!result.ok) {
    toast(result.message, 'error')
    return
  }
  if (!isCurrentServer(server)) return
  const collapsed = getState().collapsed
  if (collapsed.includes(target.key)) {
    setState({ collapsed: collapsed.filter((key) => key !== target.key) })
  }
  // Refresh before rendering: the row we are about to put into rename mode does not exist in the
  // cached node list yet, so re-rendering first would draw a tree without it and drop the rename.
  startRenaming(nodeTreeKey(server, result.node.id))
  if (!(await refreshAfterMutation(server, rerender))) cancelRenaming()
}

const buildPanel = (): HTMLElement => {
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
  backButton.addEventListener('click', () => showView('tree'))

  const settingsButton = document.createElement('button')
  settingsButton.setAttribute('data-wts-settings', '')
  settingsButton.className = 'btn btn-ghost btn-xs btn-circle'
  settingsButton.title = 'Settings'
  settingsButton.setAttribute('aria-label', 'Settings')
  settingsButton.setAttribute('aria-pressed', 'false')
  settingsButton.appendChild(icon('settings', 'size-4'))
  settingsButton.addEventListener('click', () =>
    showView(currentView === 'settings' ? 'tree' : 'settings'),
  )

  const closeButton = document.createElement('button')
  closeButton.className = 'btn btn-ghost btn-xs btn-circle'
  closeButton.title = 'Close'
  closeButton.setAttribute('aria-label', 'Close')
  closeButton.appendChild(icon('close', 'size-4'))
  closeButton.addEventListener('click', () => setOpen(false))

  header.append(backButton, title, settingsButton, closeButton)

  const body = document.createElement('div')
  body.setAttribute('data-wts-body', '')
  Object.assign(body.style, { display: 'flex', flexDirection: 'column', minHeight: '0', flex: '1' })

  panel.append(header, body)
  return panel
}

interface SettingsDrafts {
  readonly serverUrl: string
  readonly accessCodes: ReadonlyMap<string, string>
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
  return { serverUrl, accessCodes, focused, scrollTop }
}

const restoreSettingsDrafts = (panel: HTMLElement, drafts: SettingsDrafts): void => {
  const serverUrl = panel.querySelector<HTMLInputElement>('[data-wts-draft-url]')
  if (serverUrl !== null) serverUrl.value = drafts.serverUrl
  for (const input of panel.querySelectorAll<HTMLInputElement>('[data-wts-draft-code]')) {
    const value = input.dataset.wtsDraftCode
    if (value !== undefined) input.value = drafts.accessCodes.get(value) ?? ''
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
  closeActiveContextMenu?.(false)
  if (view !== currentView) {
    panelOwnerGeneration++
    cancelViewOwnedWork(cancelPanelRequests, cancelActiveConfirm, cancelActiveCopy)
  }
  currentView = view
  const panel = document.getElementById(PANEL_ID)
  const drafts = preserveDrafts && panel !== null ? settingsDrafts(panel) : null
  const body = panel?.querySelector('[data-wts-body]')
  const title = panel?.querySelector('h2')
  if (!body || !title) return
  const inSettings = view === 'settings'
  if (inSettings) void loadAccount()
  activeTreeRender = null
  body.replaceChildren(inSettings ? settingsView() : treeView())
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
  syncRailButtonState()
  const existing = document.getElementById(PANEL_ID)
  if (!open) {
    const restoreRailFocus =
      existing !== null &&
      document.activeElement !== null &&
      existing.contains(document.activeElement)
    panelOwnerGeneration++
    closeActiveContextMenu?.(false)
    cancelPanelRequests()
    activeTreeRender = null
    activeKeyboardResizeCommit?.()
    activeKeyboardResizeCommit = null
    activeResizeCleanup?.()
    cancelActiveConfirm?.()
    cancelActiveCopy?.()
    cancelRenaming()
    existing?.remove()
    if (restoreRailFocus) queueMicrotask(() => document.getElementById(BUTTON_ID)?.focus())
    return
  }
  if (existing !== null) return
  document.body.appendChild(buildPanel())
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
    window.addEventListener('resize', () => {
      activeResizeCleanup?.()
      const panel = document.getElementById(PANEL_ID)
      if (panel !== null) {
        const width = panelWidthForViewport(getState().panelWidth)
        panel.style.width = `${width}px`
        const handle = panel.querySelector<HTMLElement>('[role="separator"]')
        if (handle !== null) updateResizeValue(handle, width)
      }
    })
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
    found.after.insertAdjacentElement('afterend', railButton())
    syncRailButtonState()
    log('install', 'rail button attached below Overlays')
  }

  attach()
  new MutationObserver(attach).observe(document.body, { childList: true, subtree: true })
}
