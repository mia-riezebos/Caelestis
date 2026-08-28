import type {
  CaelestisPanel,
  CaelestisRailControl,
  PanelIntent,
  PanelModel,
  RailControlIntent,
  RailControlModel,
} from '@caelestis/ui/elements'
import { isEnabled as isDebugEnabled, log, setEnabled as setDebugEnabled } from '../debug.js'
import { redraw } from '../main.js'
import { DEFAULT_MARKER_BUDGET, MARKER_BUDGET_OPTIONS } from '../marker-budget.js'
import { isProfileEnabled, setProfileEnabled } from '../profile.js'
import { forgetServer } from '../server-cache.js'
import {
  type ColourNavigationOrder,
  type ConnectedServer,
  cancelServerProbe,
  canonicalServerUrl,
  forgetAdmittedServerContents,
  forgetScopes,
  getState,
  installServerConnectionRetry,
  isCurrentServerConnection,
  loadState,
  MAX_CONNECTED_SERVERS,
  onStateChange,
  previewGlobalAppearance,
  probeServer,
  refreshStoredServers,
  removeServer,
  setState,
  upsertServer,
} from '../state.js'
import { onServerStatusChange } from '../telemetry.js'
import { APPEARANCE_CONTROLS, DEFAULT_APPEARANCE } from '../templates/appearance.js'
import { forgetServerTemplates, onLocalChange } from '../templates/local-store.js'
import { pixelAccounting } from '../templates/mismatch.js'
import { forgetNodes, nodeScopeKey } from '../templates/server-nodes.js'
import { endServerGeneration, forgetChunks, serverTemplateKey } from '../templates/server-sync.js'
import { isPaintOpen, onPaintSelectionChange } from '../wplace-paint.js'
import { accessTokenSection, forgetCachedTokens, prefetchAccessTokens } from './access-tokens.js'
import { whileBusy } from './button.js'
import { isColourPickerOpen } from './colour-picker.js'
import { coloursSection } from './colours.js'
import { frameQueue } from './frame-queue.js'
import type { IconName } from './icons.js'
import { icon } from './icons.js'
import { mismatchSettings } from './marker-settings.js'
import { CLEAR_OF_RAIL, EDGE, GAP, SURFACE_RADIUS } from './metrics.js'
import { pixelStylePresets } from './pixel-style-presets.js'
import { profilePanel } from './profile.js'
import { mismatchModeButton, syncMismatchModeState } from './rail-controls.js'
import { createRangeGestures } from './range-gestures.js'
import { sliderRow } from './slider.js'
import { progressChangesCanReorder } from './sort.js'
import { installStyles } from './styles.js'
import { applyWplaceTheme } from './theme.js'
import { PANEL_ID, toast } from './toast.js'
import { cancelDestinationAdmissions } from './transplant.js'
import {
  isTreeDragActive,
  type TemplateTreeAdapter,
  type TreeCallbacks,
  templateTreeAdapter,
} from './tree.js'
import {
  cancelTreeActionSetup,
  copyServerTemplateToLocal,
  copyToServer,
  createFolder,
  dropOnServerNode,
  importTemplate,
  moveBranch,
  openContextMenu,
  treeActionUsesServer,
} from './tree-actions.js'
import { forgetServerRows, onServerSnapshot, primeFromCache } from './tree-server-state.js'

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
const BUTTON_ID = 'caelestis-rail-button'

const maximumPanelWidth = (): number => Math.min(720, Math.max(0, window.innerWidth - 96))
const minimumPanelWidth = (): number => Math.min(260, maximumPanelWidth())
const panelWidthForViewport = (wanted: number): number =>
  Math.min(maximumPanelWidth(), Math.max(minimumPanelWidth(), wanted))

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
const BUTTON_TOOLTIP = `${APP_NAME} — shared templates (C)`

type View = 'tree' | 'settings' | 'appearance'

let currentView: View = 'tree'
let open = false
let alarmBadge = 0
let searchQuery = ''
const rangeGestures = createRangeGestures()

/**
 * wplace marks an open rail button by adding `btn-primary`, measured by opening theirs and diffing
 * the class list. Using the same class rather than a colour of our own means our button lights up
 * in whatever their theme calls primary, now and after any theme change.
 */
const panelRailModel = (): RailControlModel => ({
  id: 'panel',
  label: BUTTON_TOOLTIP,
  pressed: open,
  expanded: open,
  controls: PANEL_ID,
  ...(alarmBadge > 0 ? { badge: alarmBadge } : {}),
})

const syncRailButtonState = (): void => {
  const button = document.getElementById(BUTTON_ID) as CaelestisRailControl | null
  if (button === null) return
  button.model = panelRailModel()
}

const railButton = (): CaelestisRailControl => {
  const existing = document.getElementById(BUTTON_ID)
  if (existing !== null) return existing as CaelestisRailControl
  const button = document.createElement('caelestis-rail-control')
  button.id = BUTTON_ID
  button.model = panelRailModel()
  applyWplaceTheme(button)
  button.addEventListener('caelestis-rail-intent', (event) => {
    const intent = (event as CustomEvent<RailControlIntent>).detail
    if (intent.id === 'panel') togglePanel()
  })
  return button
}

/**
 * The unacknowledged-alarm count. Not "how many alarms are active" — that number stays lit for
 * hours on a griefed template and stops being read. This one means "something new since you last
 * looked", so it clears itself by being seen.
 */
export const setAlarmBadge = (count: number): void => {
  alarmBadge = Math.max(0, count)
  syncRailButtonState()
}

/**
 * A section heading: an icon in a tinted chip, then the name at normal weight and full contrast.
 *
 * Not faded all-caps. A settings pane is scanned for the section you want, and the previous
 * treatment made every heading — the one thing you are actually looking for — the least legible
 * text on the screen.
 */
const sectionHeader = (title: string, glyph: IconName): HTMLElement => {
  const row = document.createElement('div')
  row.className = 'flex items-center gap-2 px-3 pt-5 pb-2'
  const chip = document.createElement('span')
  chip.className = 'bg-base-200 flex items-center justify-center'
  Object.assign(chip.style, {
    borderRadius: '0.5rem',
    width: '1.75rem',
    height: '1.75rem',
    flex: '0 0 auto',
  })
  chip.appendChild(icon(glyph, 'size-4'))
  const h = document.createElement('h3')
  h.className = 'text-sm font-semibold'
  h.textContent = title
  row.append(chip, h)
  return row
}

/**
 * Redraw whatever the panel is showing when the state changes underneath it.
 *
 * The panel used to subscribe to nothing, so every row showed whatever was true when it was last
 * drawn by an interaction. That was survivable while templates only ever appeared because someone
 * in this panel imported one — and stopped being survivable the moment a background sync could add
 * one: the canvas updated, the tree did not, and a template drew over the map with its own switch
 * reading "off" because the row had been drawn before it existed.
 *
 * **Every view, not only the tree.** A keybind is a change from outside the panel by definition, so
 * pressing `W` moved the markers and left the switch that claims to control them reading the
 * opposite — and clicking it then did nothing visible, because it was already in the state it was
 * being asked for.
 *
 * Skipped mid-gesture. A rename is an open text field, a drag is a row in flight, and a slider is
 * held under the pointer; replacing any of those takes the thing away from the hand using it. The
 * colour picker counts even though it is not in the panel — it is anchored to a swatch that is, so
 * rebuilding would detach it from its own anchor. Its close callback requests the deferred redraw.
 */
let owedRefresh = false
const heldPanelPointers = new Set<number>()

const refreshView = (): void => {
  if (!open) return
  const root = document.getElementById(PANEL_ID)
  if (root === null) return
  const held =
    isColourPickerOpen() ||
    isTreeDragActive() ||
    heldPanelPointers.size > 0 ||
    root.querySelector('.caelestis-dragging') !== null ||
    (root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement)
  if (held) {
    owedRefresh = true
    return
  }
  owedRefresh = false
  // What the user has typed survives the rebuild. A view is rebuilt from stored state, and a field
  // being filled in is not stored state yet, so redrawing over it threw the half-typed address away
  // — most visibly on the blur that pays this debt back, which is exactly when a rebuild lands.
  const drafts = new Map<string, string>()
  for (const field of root.querySelectorAll<HTMLInputElement>('[data-caelestis-draft]')) {
    const key = field.dataset.caelestisDraft
    if (key !== undefined && field.value !== '') drafts.set(key, field.value)
  }
  showView(currentView)
  if (drafts.size === 0) return
  for (const field of root.querySelectorAll<HTMLInputElement>('[data-caelestis-draft]')) {
    const draft = field.dataset.caelestisDraft
    const kept = draft === undefined ? undefined : drafts.get(draft)
    if (kept !== undefined) field.value = kept
  }
}

let manifestTreeRefreshQueued = false
const queueManifestTreeRefresh = (): void => {
  if (manifestTreeRefreshQueued) return
  manifestTreeRefreshQueued = true
  queueMicrotask(() => {
    manifestTreeRefreshQueued = false
    if (!open || currentView !== 'tree') return
    if (isTreeDragActive()) {
      owedRefresh = true
      return
    }
    rerenderTree()
  })
}

onServerSnapshot((_server, result) => {
  if (result.status === 'admitted' && result.changed) queueManifestTreeRefresh()
})

/**
 * Pay back a redraw that was declined while something was being held.
 *
 * Suppressing a redraw is a debt. Without this the panel simply lost it: a template arriving from a
 * server while a name was being typed, or a keybind pressed mid-drag, stayed invisible until some
 * unrelated change happened to redraw the view. Deferred by a tick because both events that call it
 * fire *before* the thing they announce has finished letting go.
 */
const repayRefresh = (): void => {
  if (!owedRefresh) return
  setTimeout(refreshView, 0)
}

const settingRow = (label: string, hint: string | null, control: HTMLElement): HTMLElement => {
  const row = document.createElement('div')
  row.className = 'flex items-center justify-between gap-4 px-3 py-2'
  row.style.minHeight = '3rem'
  const text = document.createElement('div')
  text.className = 'flex flex-col'
  const name = document.createElement('span')
  name.className = 'text-sm'
  name.textContent = label
  text.append(name)
  if (hint !== null) {
    const sub = document.createElement('span')
    sub.className = 'text-xs opacity-60'
    sub.textContent = hint
    text.appendChild(sub)
  }
  row.append(text, control)
  return row
}

const checkbox = (value: boolean, onChange: (next: boolean) => void): HTMLInputElement => {
  const el = document.createElement('input')
  el.type = 'checkbox'
  el.className = 'checkbox checkbox-sm'
  el.checked = value
  el.addEventListener('change', () => onChange(el.checked))
  return el
}

/** Which servers' rows are open. Kept across re-renders, which rebuild the whole pane. */
const expandedServers = new Set<string>()

/**
 * Servers whose row has already been opened for them, so it is done once and not fought over.
 *
 * A server asking for a token is opened without being asked, because the one thing it needs is
 * inside. Doing that on every render would mean it could never be closed again.
 */
const autoExpanded = new Set<string>()
const disconnectingServerUrls = new Set<string>()

const hasSingleKeySegmentAfter = (key: string, prefix: string): boolean => {
  if (!key.startsWith(prefix)) return false
  const suffix = key.slice(prefix.length)
  return suffix !== '' && !suffix.includes(':')
}

/**
 * Disconnect: take the server out of the list, and everything it put on this machine with it.
 *
 * Removing it from the list used to be all that happened, and the ordinary sync is what removes a
 * server's templates — so a disconnected server was never synced again and its templates stayed on
 * the canvas forever, belonging to a server no longer in the list, with no row anywhere to switch
 * them off from. The only way back was a reload.
 *
 * Everything it left, in the order that keeps the map honest: the drawn templates first, then the
 * things that describe them, then the bytes they were built from, then the preferences that can no
 * longer refer to anything.
 */
const disconnectServer = async (server: ConnectedServer): Promise<void> => {
  if (disconnectingServerUrls.has(server.url)) return
  disconnectingServerUrls.add(server.url)
  try {
    if (treeActionUsesServer(server.url)) {
      cancelTreeActionSetup(new Error('copy destination disconnected'))
    }
    cancelDestinationAdmissions(server.url)
    cancelServerProbe(server.url)
    // Anything already downloading for this server lands stale rather than drawing an overlay with no
    // server row left to control it.
    endServerGeneration(server.url)
    forgetAdmittedServerContents(server.url)
    // Stop polls and stale refresh callbacks from beginning a replacement generation while cleanup
    // waits for per-template writes.
    removeServer(server.url)
    await forgetServerTemplates(server.url)
    const hashes = forgetServerRows(server.url)
    const nodes = forgetNodes(server.url)
    forgetChunks(hashes)
    forgetCachedTokens(server.url)
    const serverTemplatePrefix = serverTemplateKey(server.url, '')
    const legacyTreeTemplatePrefix = `st:${encodeURIComponent(server.url)}:`
    forgetScopes([
      `server:${server.url}`,
      ...nodes.map((id) => nodeScopeKey(server.url, id)),
      ...getState().hiddenScopes.filter(
        (key) =>
          hasSingleKeySegmentAfter(key, serverTemplatePrefix) ||
          hasSingleKeySegmentAfter(key, legacyTreeTemplatePrefix),
      ),
    ])
    expandedServers.delete(server.url)
    autoExpanded.delete(server.url)
    await forgetServer(server.url)
    redraw()
    showView('settings')
  } finally {
    disconnectingServerUrls.delete(server.url)
  }
}

/**
 * One connected server: its name and state, and everything about it behind a caret.
 *
 * Expandable because a server has more than one thing to say about it and only one of them is worth
 * a line in a list. Collapsed it is a name and whether it is working; open it is the token you
 * connect with, the tokens it will accept from other people, and the way to disconnect.
 *
 * Disconnect lives inside rather than on the collapsed row. It used to sit beside the name, one
 * stray click from throwing a server away, in a list where every other control is harmless — and it
 * is not something anyone reaches for while scanning.
 */
const serverRow = (server: ConnectedServer): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'px-3 py-2'
  // Opened for you when it is asking for something, once — the token field is inside, and a row you
  // have to discover before you can fix it is a row that reads as broken rather than as waiting.
  if (server.status === 'needs-token' && !autoExpanded.has(server.url)) {
    autoExpanded.add(server.url)
    expandedServers.add(server.url)
  }
  const open = expandedServers.has(server.url)

  const top = document.createElement('button')
  top.type = 'button'
  top.className = 'flex items-center gap-2 w-full'
  top.setAttribute('aria-expanded', String(open))

  const caret = icon('caret', 'size-3 opacity-60')
  caret.style.flex = '0 0 auto'
  caret.style.transition = 'transform 120ms ease-out'
  caret.style.transform = open ? 'rotate(90deg)' : 'rotate(0deg)'

  const name = document.createElement('span')
  name.className = 'text-sm'
  name.style.flex = '1'
  name.style.overflow = 'hidden'
  name.style.textOverflow = 'ellipsis'
  name.style.whiteSpace = 'nowrap'
  name.style.textAlign = 'left'
  name.textContent = server.info?.name ?? server.url
  name.title = server.url

  top.append(caret, name)
  // Only trouble gets a badge. A server that is in this list at all is one you added and one that
  // works, so "connected" was a green label on every row saying what the absence of a label already
  // said — and it made the two rows that do need attention harder to pick out, not easier.
  if (server.status !== 'connected') {
    const badge = document.createElement('span')
    badge.className =
      server.status === 'needs-token'
        ? 'badge badge-sm badge-warning'
        : 'badge badge-sm badge-error'
    badge.textContent = server.status === 'needs-token' ? 'token' : 'offline'
    top.appendChild(badge)
  }
  top.addEventListener('click', () => {
    if (open) expandedServers.delete(server.url)
    else expandedServers.add(server.url)
    showView('settings')
  })
  // A pointer arriving at the row is the earliest honest sign someone is about to open it, and the
  // tokens are the one thing inside that has to be asked for. Fetching now means the expansion opens
  // at its final height rather than growing a moment later, and it costs a request that was about to
  // happen anyway.
  top.addEventListener('pointerenter', () => prefetchAccessTokens(server))
  wrap.appendChild(top)

  // Why it is offline, which the two words on the row above cannot carry. Nothing extra for a
  // server wanting a token: the row says so, and what to do about it is one click away.
  if (!open) {
    if (server.status === 'unreachable' && server.error !== undefined) {
      const why = document.createElement('p')
      why.className = 'text-xs opacity-60'
      why.style.marginTop = '0.125rem'
      why.textContent = server.error
      wrap.appendChild(why)
    }
    return wrap
  }

  const body = document.createElement('div')
  body.style.marginTop = '0.5rem'
  body.style.paddingLeft = '1.25rem'

  /**
   * The token you connect with, always editable.
   *
   * It used to appear only while the server was refusing you, so a token that had been accepted
   * could not be changed without disconnecting and adding the server again — which is exactly what
   * you need to do when yours is rotated or upgraded to admin.
   */
  const codeRow = document.createElement('div')
  codeRow.className = 'flex gap-2'
  const code = document.createElement('input')
  code.dataset.caelestisDraft = `token:${server.url}`
  code.type = 'password'
  code.autocomplete = 'off'
  code.className = 'input input-sm input-bordered'
  code.style.flex = '1'
  code.style.minWidth = '0'
  code.placeholder = server.token === null ? 'Access token' : '••••••••'
  code.setAttribute('aria-label', 'Your access token for this server')
  const submit = document.createElement('button')
  submit.className = 'btn btn-sm btn-primary'
  submit.textContent = server.status === 'connected' ? 'Update' : 'Connect'

  const status = document.createElement('p')
  status.className = 'text-xs opacity-60'
  status.style.marginTop = '0.25rem'
  status.textContent =
    server.status === 'needs-token'
      ? 'This server needs an access token from whoever runs it.'
      : server.status === 'unreachable'
        ? (server.error ?? 'Could not be reached.')
        : server.tokenUsable === false
          ? 'Your saved token was not accepted. Connected without it.'
          : server.isAdmin
            ? 'Your token can change this server.'
            : 'Your token can read this server.'

  const attempt = async (): Promise<void> => {
    const value = code.value.trim()
    if (value === '') return
    status.className = 'text-xs opacity-60'
    status.textContent = 'Checking…'
    const next = await whileBusy(
      submit,
      () => probeServer(server.url, value),
      `server:probe:${server.url}`,
    )
    if (next === null) return
    if (next.superseded === true) return
    if (!stillConnected(server)) return
    if (next.status === 'connected') {
      cancelDestinationAdmissions(server.url)
      upsertServer(next)
      // Closed again, because what was open for is done. Left open, a row that opened itself would
      // stay open on a pane that is otherwise a short list of servers.
      expandedServers.delete(server.url)
      showView('settings')
      return
    }
    // A wrong token and an unreachable server are different problems with different fixes, so they
    // must not share a message.
    const message =
      next.status === 'needs-token'
        ? 'That token was not accepted. Ask whoever runs the server for a current one.'
        : `Could not reach the server. ${next.error ?? ''}`.trim()
    // A background redraw during the probe leaves this row's status element detached, and writing
    // the failure into it put the answer somewhere nobody can see. Say it out loud instead.
    if (!status.isConnected) {
      toast(message, 'error')
      return
    }
    status.className = 'text-xs text-error'
    status.textContent = message
  }

  submit.addEventListener('click', () => void attempt())
  code.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void attempt()
  })
  codeRow.append(code, submit)
  body.append(codeRow, status)

  // Only for someone who can actually use it. The routes are admin-only, so for anyone else this
  // would be a section that exists to say 403.
  if (server.isAdmin) body.appendChild(accessTokenSection(server))

  const disconnect = document.createElement('button')
  disconnect.className = 'btn btn-sm btn-ghost text-error'
  disconnect.style.marginTop = '0.75rem'
  disconnect.textContent = 'Disconnect'
  disconnect.addEventListener('click', () => void disconnectServer(server))
  body.appendChild(disconnect)

  wrap.appendChild(body)
  return wrap
}

/**
 * How overlays look: the defaults every overlay follows, and the colours any of them may draw.
 *
 * Its own view rather than a section of settings. Settings is a page you visit rarely — a server to
 * connect, a switch to flip once — while this is the page you come back to constantly, and burying
 * a colour grid below server plumbing made the thing used most the thing furthest down.
 *
 * Everything here is a *default*. An overlay that has been given settings of its own ignores all of
 * it; see `hiddenColoursFor`.
 */
const appearanceView = (): HTMLElement => {
  const view = document.createElement('div')
  Object.assign(view.style, { overflowY: 'auto', flex: '1', minHeight: '0' })
  const rerender = (): void => showView('appearance')
  const state = getState()

  view.appendChild(sectionHeader('Appearance', 'tune'))
  view.appendChild(
    settingRow(
      'Pixel style',
      null,
      pixelStylePresets(state.appearance, (values) => {
        setState({ appearance: { ...getState().appearance, ...values } })
        redraw()
        rerender()
      }),
    ),
  )

  const outline = document.createElement('input')
  outline.type = 'checkbox'
  outline.className = 'toggle toggle-sm'
  outline.checked = state.appearance.contrastOutline
  outline.setAttribute('aria-label', 'Contrast outline')
  outline.addEventListener('change', () => {
    setState({
      appearance: { ...getState().appearance, contrastOutline: outline.checked },
    })
    previewGlobalAppearance(getState().appearance)
    redraw()
    rerender()
  })
  view.appendChild(
    settingRow(
      'Contrast outline',
      'Visible behind the overlay until Wplace art covers it',
      outline,
    ),
  )

  // Same sliders as the per-overlay menu, deliberately — one vocabulary, learned once.
  const sliders = document.createElement('div')
  sliders.className = 'px-3 pb-2'
  for (const control of APPEARANCE_CONTROLS) {
    let dirty = false
    let row: ReturnType<typeof sliderRow>
    const commit = (): void => {
      if (!dirty) return
      dirty = false
      const next = Number(row.input.value)
      // Read the live value rather than the one captured when this row was built, so dragging one
      // slider cannot revert another.
      setState({
        appearance: { ...getState().appearance, [control.key]: next },
      })
    }
    row = sliderRow({
      label: control.label,
      value: state.appearance[control.key],
      defaultValue: DEFAULT_APPEARANCE[control.key],
      min: control.min,
      max: control.max,
      step: control.step,
      format: control.format,
      disabled: control.key === 'contrastOutlineSize' && !state.appearance.contrastOutline,
      onInput: (next) => {
        dirty = true
        previewGlobalAppearance({
          ...getState().appearance,
          [control.key]: next,
        })
        redraw()
      },
      onReset: (next) => {
        dirty = false
        setState({ appearance: { ...getState().appearance, [control.key]: next } })
        previewGlobalAppearance(getState().appearance)
        redraw()
        rerender()
      },
    })
    rangeGestures.bind(row.input, commit)
    sliders.appendChild(row.element)
  }
  view.appendChild(sliders)

  view.appendChild(sectionHeader('Markers', 'search'))
  const setAppearance = (patch: Partial<typeof state.appearance>): void => {
    setState({ appearance: { ...getState().appearance, ...patch } })
  }

  // The same block the per-overlay menu shows, at this pane's density — one place that decides what
  // these switches are called and which of them qualifies which.
  const markers = document.createElement('div')
  markers.className = 'px-3 pb-2'
  markers.appendChild(
    mismatchSettings(
      { ...state.appearance, hiddenColours: state.hiddenColours },
      (patch) => {
        setAppearance(patch)
      },
      rerender,
    ),
  )
  view.appendChild(markers)
  const markerBudget = document.createElement('select')
  markerBudget.className = 'select select-bordered select-sm'
  for (const value of MARKER_BUDGET_OPTIONS) {
    const option = document.createElement('option')
    option.value = String(value)
    option.textContent =
      value === DEFAULT_MARKER_BUDGET
        ? `${value.toLocaleString()} (default)`
        : value.toLocaleString()
    option.selected = value === state.markerBudget
    markerBudget.appendChild(option)
  }
  markerBudget.addEventListener('change', () => {
    setState({ markerBudget: Number(markerBudget.value) })
  })
  view.appendChild(
    settingRow(
      'Visible marker limit',
      'Approximate GPU target per marker kind across the viewport. Higher limits use more GPU time.',
      markerBudget,
    ),
  )

  view.appendChild(sectionHeader('Colours', 'palette'))
  view.appendChild(coloursSection(rerender, refreshView))
  return view
}

const settingsView = (): HTMLElement => {
  const view = document.createElement('div')
  Object.assign(view.style, { overflowY: 'auto', flex: '1', minHeight: '0' })

  view.appendChild(sectionHeader('Servers', 'server'))
  const addRow = document.createElement('div')
  addRow.className = 'px-3 pb-2 flex gap-2'
  const url = document.createElement('input')
  url.dataset.caelestisDraft = 'add-server'
  url.type = 'url'
  url.className = 'input input-sm input-bordered'
  url.style.flex = '1'
  url.style.minWidth = '0'
  url.placeholder = 'https://templates.example.org'
  const add = document.createElement('button')
  add.className = 'btn btn-sm btn-primary'
  add.textContent = 'Add'
  const status = document.createElement('p')
  status.className = 'text-xs px-3 pb-2'
  status.style.display = 'none'

  const connect = async (): Promise<void> => {
    const value = url.value.trim()
    if (value === '') return
    let canonical: string | null = null
    try {
      canonical = canonicalServerUrl(value)
    } catch {
      // Let probeServer render the existing invalid-address error below.
    }
    if (canonical !== null && getState().servers.some((server) => server.url === canonical)) {
      status.style.display = ''
      status.className = 'text-xs px-3 pb-2 text-error'
      status.textContent = `${canonical} is already connected.`
      return
    }
    if (canonical !== null && disconnectingServerUrls.has(canonical)) {
      status.style.display = ''
      status.className = 'text-xs px-3 pb-2 opacity-60'
      status.textContent = `Still disconnecting ${canonical}. Try again in a moment.`
      return
    }
    status.style.display = ''
    status.className = 'text-xs px-3 pb-2 opacity-60'
    status.textContent = 'Connecting…'
    // Keyed on the URL being probed rather than on the button, because the settings pane is rebuilt
    // on any state change and hands back a fresh enabled one — the case `whileBusy`'s own docstring
    // names, and these two probes are the example in it.
    const server = await whileBusy(add, () => probeServer(value, null), `server:probe:${value}`)
    if (server === null) return
    if (server.superseded === true) return
    if (server.status === 'unreachable') {
      status.className = 'text-xs px-3 pb-2 text-error'
      status.textContent = `Could not reach ${server.url}. Check the address and that the server allows this origin.`
      return
    }
    const fail = (message: string): void => {
      status.className = 'text-xs px-3 pb-2 text-error'
      status.textContent = message
    }
    // This probe was anonymous, so writing it over a URL that is already connected replaces a
    // working token with nothing: a protected server drops to "needs a token" and an open one loses
    // its admin credential. Adding a server you already have is a no-op with an explanation.
    if (getState().servers.some((one) => one.url === server.url)) {
      fail(`${server.url} is already connected.`)
      return
    }
    // `upsertServer` refuses past the limit. Ignoring that cleared the field and redrew the view, so
    // the thirty-third server looked added and simply was not there.
    if (!upsertServer(server)) {
      fail(`Already connected to ${MAX_CONNECTED_SERVERS} servers. Disconnect one first.`)
      return
    }
    url.value = ''
    // Re-render so the new server's row appears — it is what carries the status badge and, when the
    // server wants one, the access-token field. Without this the panel reported "needs a token" and
    // then offered nowhere to type one.
    showView('settings')
  }

  add.addEventListener('click', () => void connect())
  url.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void connect()
  })
  addRow.append(url, add)
  view.appendChild(addRow)
  view.appendChild(status)

  for (const server of getState().servers) view.appendChild(serverRow(server))

  const state = getState()

  view.appendChild(sectionHeader('Painting', 'palette'))
  const navigationOrder = document.createElement('select')
  navigationOrder.className = 'select select-bordered select-sm'
  navigationOrder.setAttribute('aria-label', 'Middle-click colour order')
  for (const [value, label] of [
    ['unpainted-first', 'Unpainted, then mismatched'],
    ['mismatched-first', 'Mismatched, then unpainted'],
  ] satisfies ReadonlyArray<readonly [ColourNavigationOrder, string]>) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    option.selected = value === state.colourNavigationOrder
    navigationOrder.appendChild(option)
  }
  navigationOrder.addEventListener('change', () => {
    setState({ colourNavigationOrder: navigationOrder.value as ColourNavigationOrder })
  })
  view.appendChild(
    settingRow(
      'Middle-click colour order',
      'Visits remaining pixels only inside the template intersecting the viewport centre; nearest is used only in empty space.',
      navigationOrder,
    ),
  )

  view.appendChild(sectionHeader('Contribution', 'share'))
  view.appendChild(
    settingRow(
      'Report my activity',
      'Shares paint activity only in areas covered by server templates, and only with the servers providing those templates. Together with shared tiles, this powers progress bars, contribution, pace and progress graphs, and timelapses.',
      checkbox(state.reportPaints, (next) => setState({ reportPaints: next })),
    ),
  )
  view.appendChild(
    settingRow(
      'Share tiles',
      'Shares fetched tiles only in areas covered by server templates, and only with the servers providing those templates. Together with reported activity, this powers progress bars, contribution, pace and progress graphs, and timelapses.',
      checkbox(state.shareTiles, (next) => setState({ shareTiles: next })),
    ),
  )

  view.appendChild(sectionHeader('Diagnostics', 'bug'))
  view.appendChild(
    settingRow(
      'Debug logging',
      'Verbose console output for bug reports',
      checkbox(isDebugEnabled(), (next) => {
        setDebugEnabled(next)
      }),
    ),
  )
  view.appendChild(
    settingRow(
      'Performance profiling',
      'Measures Caelestis CPU, GPU and known buffers. Profiling adds a small overhead.',
      checkbox(isProfileEnabled(), (next) => {
        setProfileEnabled(next)
        showView('settings')
      }),
    ),
  )
  if (isProfileEnabled()) view.appendChild(profilePanel())
  return view
}

let activeTreeAdapter: TemplateTreeAdapter | null = null

const treeCallbacks = (): TreeCallbacks => ({
  onAddServer: () => showView('settings'),
  onCreateFolder: (target) => void createFolder(target, rerenderTree),
  onImportTemplate: (target) => void importTemplate(target, rerenderTree),
  onContextMenu: (target, event) => openContextMenu(target, event, rerenderTree),
  onCopyToServer: (id) => void copyToServer(id, rerenderTree),
  onDropInServer: (server, nodeId, draggedKey, beforeKey) =>
    dropOnServerNode(server, nodeId, draggedKey, beforeKey, rerenderTree),
  onDropInLocal: async (draggedKey, folderId) => {
    if (draggedKey.startsWith('node:')) {
      return await moveBranch(draggedKey, { kind: 'local', folderId }, rerenderTree)
    }
    if (draggedKey.startsWith('st:')) {
      return await copyServerTemplateToLocal(draggedKey, folderId, rerenderTree)
    }
    return null
  },
})

const panelModel = (width = panelWidthForViewport(getState().panelWidth)): PanelModel => ({
  view: currentView,
  width,
  minWidth: minimumPanelWidth(),
  maxWidth: maximumPanelWidth(),
  ...(currentView === 'tree' && activeTreeAdapter !== null
    ? { tree: activeTreeAdapter.model }
    : {}),
})

/** Wplace adapter around the shared panel shell. View contents migrate in the following slices. */
const buildSveltePanel = (): CaelestisPanel => {
  const panel = document.createElement('caelestis-panel')
  panel.id = PANEL_ID
  panel.setAttribute('aria-label', PANEL_TITLE)
  Object.assign(panel.style, {
    position: 'fixed',
    right: `${CLEAR_OF_RAIL}px`,
    top: `${EDGE}px`,
    bottom: `${EDGE}px`,
    zIndex: '30',
    display: 'block',
    minHeight: '0',
    overflow: 'hidden',
    borderRadius: SURFACE_RADIUS,
  } satisfies Partial<CSSStyleDeclaration>)
  panel.model = panelModel()
  applyWplaceTheme(panel)
  panel.addEventListener('caelestis-panel-intent', (event) => {
    const intent = (event as CustomEvent<PanelIntent>).detail
    switch (intent.type) {
      case 'navigate':
        showView(intent.view)
        break
      case 'close':
        setOpen(false)
        break
      case 'resize-preview':
        redraw()
        break
      case 'resize-commit':
        setState({ panelWidth: intent.width })
        break
      case 'tree':
        if (intent.intent.type === 'search') {
          searchQuery = intent.intent.query
          rerenderTree()
        } else if (intent.intent.type === 'sort') {
          setState({ sort: intent.intent.sort })
          rerenderTree()
        } else {
          activeTreeAdapter?.handle(intent.intent)
        }
        break
    }
  })
  return panel
}

/**
 * The element that actually scrolls in a view, which is not always the view.
 *
 * The tree keeps its toolbar fixed and scrolls a child, so reading `scrollTop` off the view root
 * read zero every time and the position was never restored — in the one view long enough for that
 * to matter. A view whose root is its own scroller is unmarked and answers itself.
 */
/**
 * How many destinations a chooser will render.
 *
 * A server may legally answer with `MAX_TREE_NODES` folders, and building a hundred thousand
 * `<option>` elements synchronously locks the tab for as long as it takes. A dropdown stopped being
 * a usable way to pick long before this many anyway; past it the answer is to type a path, not to
 * scroll one.
 */
/**
 * Whether this connection is still in the list.
 *
 * Asked after any await that precedes a write, because the panel stays usable while a slow server
 * is being talked to. Disconnecting during a token probe used to put the removed server back, since
 * `upsertServer` cannot tell "update this row" from "add this row".
 */
const stillConnected = (server: ConnectedServer): boolean => isCurrentServerConnection(server)

/**
 * Whichever tree is currently on screen.
 *
 * Every row callback would otherwise close over the `renderTree` of the build that created it, and
 * `setState`
 * notifies synchronously — so an action that writes state before it redraws (expanding a collapsed
 * parent, say) has had the whole view replaced underneath it, and its own closure then paints an
 * element that is no longer in the document. Routing through this makes a stale closure redraw the
 * live tree instead of a detached one.
 */
const rerenderTree = (): void => {
  if (!open || currentView !== 'tree') return
  const panel = document.getElementById(PANEL_ID) as CaelestisPanel | null
  if (panel === null) return
  activeTreeAdapter = templateTreeAdapter(treeCallbacks(), rerenderTree, searchQuery)
  panel.model = panelModel(panel.getBoundingClientRect().width)
}

/**
 * What the splitter reports to assistive technology.
 *
 * Module-level because the bounds come from the viewport: a window resize moves them, and that
 * handler lives outside the builder that made the handle.
 */

const scrollerIn = (view: Element | null): HTMLElement | null =>
  view?.querySelector<HTMLElement>('[data-caelestis-scroller]') ??
  (view instanceof HTMLElement ? view : null)

const showView = (view: View): void => {
  const staying = currentView === view
  currentView = view
  const panel = document.getElementById(PANEL_ID) as CaelestisPanel | null
  if (panel === null) return

  /**
   * Keep the scroll position when re-rendering the view you are already on.
   *
   * Every control here re-renders by rebuilding the whole view, which throws away the scroller with
   * it — so toggling a colour near the bottom of settings jumped back to the top, and toggling the
   * next one meant scrolling down again. Switching *between* views still starts at the top, which is
   * right: that is a new thing to read, not the same one redrawn.
   */
  const previous = scrollerIn(panel.firstElementChild)
  const scrollTop = staying && previous !== null ? previous.scrollTop : 0

  const next =
    view === 'settings' ? settingsView() : view === 'appearance' ? appearanceView() : null
  panel.replaceChildren(...(next === null ? [] : [next]))
  if (view === 'tree') {
    activeTreeAdapter = templateTreeAdapter(treeCallbacks(), rerenderTree, searchQuery)
    void primeFromCache(rerenderTree)
  } else {
    activeTreeAdapter = null
  }
  const scroller = scrollerIn(next)
  if (scrollTop > 0 && scroller !== null) scroller.scrollTop = scrollTop
  panel.model = panelModel(panel.getBoundingClientRect().width)
  log('install', `panel view: ${view}`)
}

const setOpen = (next: boolean): void => {
  open = next
  syncRailButtonState()
  const existing = document.getElementById(PANEL_ID)
  if (!open) {
    cancelTreeActionSetup(new Error('panel closed'))
    existing?.remove()
    // Give map-anchored controls the reclaimed width immediately, even while the map is still.
    redraw()
    return
  }
  if (existing !== null) return
  document.body.appendChild(buildSveltePanel())
  showView(currentView)
  // The panel's measured left edge is now the map controls' right edge.
  redraw()
}

/** Open or close the main Caelestis panel through the same path as its rail button. */
export const togglePanel = (): void => setOpen(!open)

const RAIL_ID = 'caelestis-rail'

/**
 * Our own rail, beneath wplace's when they have one and in its place when they do not.
 *
 * Our button used to be appended *into* their rail, which looked native and disappeared with it —
 * and it disappears exactly when the paint drawer opens, which is when these controls are most
 * wanted. Owning the container decouples the two: it is positioned against theirs while theirs is on
 * screen, so it still reads as part of the same stack, and simply stays put when theirs goes.
 *
 * Positioned rather than laid out, because their rail is Svelte-rendered and free to re-render at
 * any moment. Anything we put inside it is on loan; anything we position against it is not.
 */
const railContainer = (): HTMLElement => {
  const existing = document.getElementById(RAIL_ID)
  if (existing !== null) return existing
  const el = document.createElement('div')
  el.id = RAIL_ID
  el.className = 'flex flex-col items-center gap-3'
  Object.assign(el.style, { position: 'fixed', zIndex: '30' })
  document.body.appendChild(el)
  return el
}

/**
 * Keep our rail where wplace's is, and following it when it moves.
 *
 * Read from their rail's own box rather than from a copy of their Tailwind offsets: they own that
 * layout and are free to change it, and a hardcoded corner would drift the moment they do. The
 * fallback matters more than it looks — it is the paint-drawer case, where their rail is gone and
 * there is nothing left to measure.
 */
const positionRail = (): void => {
  const rail = railContainer()
  const theirs = findRail()?.rail.getBoundingClientRect()
  if (theirs !== undefined && theirs.width > 0) {
    rail.style.left = `${theirs.left}px`
    rail.style.top = `${theirs.bottom + GAP}px`
    rail.style.right = ''
    return
  }
  rail.style.left = ''
  // Theirs is gone — the paint-drawer case — so ours takes its place at the same inset.
  rail.style.right = `${EDGE}px`
  rail.style.top = `${EDGE}px`
}

/**
 * Follow the colour wplace has selected, for every overlay at once.
 *
 * On the rail rather than only in the panel because it is toggled constantly while painting, and
 * opening a panel to reach it costs more than the mode saves. It says nothing while their drawer is
 * shut — there is no selected colour then — which the tooltip carries.
 */
const colourRailModel = (): RailControlModel => {
  const on = getState().onlySelectedColour
  const label = on ? 'Showing only the selected colour' : 'Show only the selected colour'
  return {
    id: 'colour',
    label: isPaintOpen() ? `${label} (S)` : `${label} — open wplace's paint drawer to pick one (S)`,
    pressed: on,
  }
}

const colourModeButton = (): CaelestisRailControl => {
  const existing = document.getElementById(COLOUR_MODE_ID)
  if (existing !== null) return existing as CaelestisRailControl
  const button = document.createElement('caelestis-rail-control')
  button.id = COLOUR_MODE_ID
  button.model = colourRailModel()
  applyWplaceTheme(button)
  button.addEventListener('caelestis-rail-intent', (event) => {
    const intent = (event as CustomEvent<RailControlIntent>).detail
    if (intent.id !== 'colour') return
    setState({ onlySelectedColour: !getState().onlySelectedColour })
    syncColourModeState()
  })
  return button
}

const COLOUR_MODE_ID = 'caelestis-colour-mode'

export const syncColourModeState = (): void => {
  const button = document.getElementById(COLOUR_MODE_ID) as CaelestisRailControl | null
  if (button === null) return
  button.model = colourRailModel()
}

/**
 * Keep our rail on screen and our buttons in it.
 *
 * The rail is rendered by wplace's own Svelte app, which is free to re-render at any moment. Ours is
 * separate, so the observer is only here to notice *their* rail moving or vanishing — not to rescue
 * a button they threw away.
 */
export const installPanel = (): void => {
  loadState()
  void refreshStoredServers(refreshView)
  installServerConnectionRetry(refreshView)
  installStyles()
  const rail = railContainer()
  rail.append(railButton(), colourModeButton(), mismatchModeButton())
  syncRailButtonState()
  syncColourModeState()
  syncMismatchModeState()
  positionRail()
  log('install', 'rail installed beside wplace’s')

  const sync = (): void => {
    // Their re-render may have taken our buttons if anything ever moves them; put them back cheaply.
    for (const button of [railButton(), colourModeButton(), mismatchModeButton()]) {
      if (!rail.contains(button)) rail.appendChild(button)
    }
    positionRail()
  }
  // Once per frame, not once per mutation. `sync` walks every button in the document looking for
  // their rail and then measures it, and wplace is a live map that mutates its DOM continuously —
  // so the unbatched version ran a full-document scan and forced a layout on every one of them.
  let queued = false
  const queueSync = (): void => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      sync()
    })
  }
  new MutationObserver(queueSync).observe(document.body, {
    childList: true,
    subtree: true,
  })
  window.addEventListener('resize', () => {
    positionRail()
    const panel = document.getElementById(PANEL_ID) as CaelestisPanel | null
    if (panel === null) return
    const width = panelWidthForViewport(getState().panelWidth)
    panel.model = panelModel(width)
    redraw()
  })
  onStateChange(syncColourModeState)
  onStateChange(syncMismatchModeState)
  // Once, here, rather than each time a view is built: subscribing from inside `treeView` added a
  // fresh listener on every switch back to it, so the tenth visit redrew the panel ten times per
  // change.
  onStateChange(refreshView)
  onLocalChange(
    frameQueue(() => {
      if (currentView === 'tree') refreshView()
    }),
  )
  pixelAccounting.onChange(
    frameQueue(() => {
      if (currentView !== 'tree') return
      if (progressChangesCanReorder(getState().sort)) {
        refreshView()
        return
      }
      rerenderTree()
    }),
  )
  onServerStatusChange(() => {
    if (currentView === 'tree') refreshView()
  })
  for (const ending of ['dragend', 'focusout'])
    document.addEventListener(ending, repayRefresh, true)
  document.addEventListener(
    'pointerdown',
    (event) => {
      const panel = document.getElementById(PANEL_ID)
      if (panel !== null && event.composedPath().includes(panel)) {
        heldPanelPointers.add(event.pointerId)
      }
    },
    true,
  )
  for (const ending of ['pointerup', 'pointercancel'] as const) {
    document.addEventListener(
      ending,
      (event) => {
        heldPanelPointers.delete(event.pointerId)
        repayRefresh()
      },
      true,
    )
  }
  window.addEventListener('blur', () => {
    heldPanelPointers.clear()
    repayRefresh()
  })
  // Opening wplace's paint drawer changes what the appearance grid is showing without changing any
  // state of ours, so neither listener above hears it and the grid sat showing the switches the
  // mode had already overridden. Only that view: the tree is expensive to rebuild and a colour
  // click while painting would rebuild it every time.
  onPaintSelectionChange(() => {
    syncColourModeState()
    if (currentView === 'appearance') refreshView()
  })
}
