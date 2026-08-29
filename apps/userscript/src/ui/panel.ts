import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import type {
  AppearanceEditorIntent,
  AppearanceEditorModel,
  CaelestisPanel,
  CaelestisRailControl,
  PanelIntent,
  PanelModel,
  RailControlIntent,
  RailControlModel,
  SettingsIntent,
  SettingsModel,
} from '@caelestis/ui/elements'
import {
  accessTokensModel,
  createServerAccessToken,
  forgetCachedTokens,
  loadMoreAccessTokens,
  prefetchAccessTokens,
  refreshAccessTokens,
  revokeServerAccessToken,
} from '../application/access-tokens.js'
import { cancelDestinationAdmissions } from '../application/transplant.js'
import {
  cancelTreeActionSetup,
  copyServerTemplateToLocal,
  copyToServer,
  createFolder,
  dropOnServerNode,
  handleTreeActionPresentationIntent,
  importTemplate,
  moveBranch,
  openContextMenu,
  treeActionPresentation,
  treeActionUsesServer,
} from '../application/tree-actions.js'
import {
  forgetServerRows,
  onServerSnapshot,
  primeFromCache,
} from '../application/tree-server-state.js'
import { isEnabled as isDebugEnabled, log, setEnabled as setDebugEnabled } from '../debug.js'
import { redraw } from '../main.js'
import { MARKER_BUDGET_OPTIONS } from '../marker-budget.js'
import {
  isProfileEnabled,
  profileReport,
  profileSnapshot,
  resetProfile,
  setProfileEnabled,
} from '../profile.js'
import { forgetServer } from '../server-cache.js'
import {
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
import {
  APPEARANCE_CONTROLS,
  DEFAULT_APPEARANCE,
  PIXEL_STYLE_PRESETS,
  pixelStylePresetOf,
} from '../templates/appearance.js'
import { globalHiddenColours } from '../templates/colour-filter.js'
import { forgetServerTemplates, onLocalChange } from '../templates/local-store.js'
import { pixelAccounting } from '../templates/mismatch.js'
import { forgetNodes, nodeScopeKey } from '../templates/server-nodes.js'
import { endServerGeneration, forgetChunks, serverTemplateKey } from '../templates/server-sync.js'
import { ownedColours, refreshAccount } from '../wplace-account.js'
import { isPaintOpen, onPaintSelectionChange, selectedColour } from '../wplace-paint.js'
import { activeColourPreset, type ColourPresetId, hiddenForPreset } from './colours.js'
import { frameQueue } from './frame-queue.js'
import { CLEAR_OF_RAIL, EDGE, GAP, SURFACE_RADIUS } from './metrics.js'
import { panelWidthAfterMount } from './panel-geometry.js'
import { mismatchModeButton, syncMismatchModeState } from './rail-controls.js'
import { progressChangesCanReorder } from './sort.js'
import { applyWplaceTheme } from './theme.js'
import { PANEL_ID } from './toast.js'
import {
  isTreeDragActive,
  type TemplateTreeAdapter,
  type TreeCallbacks,
  templateTreeAdapter,
} from './tree.js'
import { findWplaceRail } from './wplace-rail.js'

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
 * mean instead: one of wplace's own rail buttons, whose parent *is* the rail by definition. The
 * logged-in rail has Overlays; the logged-out rail has Search and Leaderboard. Ours then lands
 * directly beneath whichever native rail is on screen.
 */
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
    (root.shadowRoot?.querySelector('[data-caelestis-colour-picker]') ?? null) !== null ||
    isTreeDragActive() ||
    heldPanelPointers.size > 0 ||
    (root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement)
  if (held) {
    owedRefresh = true
    return
  }
  owedRefresh = false
  showView(currentView)
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

let activeTreeAdapter: TemplateTreeAdapter | null = null

const settingsMessages = new Map<string, string>()
const pendingServers = new Set<string>()
let addServerPending = false
let addServerMessage: string | undefined
let profileStatus: string | undefined

const formatBytes = (value: number | null): string => {
  if (value === null) return 'Unavailable'
  if (value < 1024) return `${value} B`
  const units = ['KiB', 'MiB', 'GiB']
  let amount = value / 1024
  let unit = units[0] ?? 'KiB'
  for (let index = 1; index < units.length && amount >= 1024; index++) {
    amount /= 1024
    unit = units[index] ?? unit
  }
  return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${unit}`
}

const formatMilliseconds = (value: number): string => `${value.toFixed(value >= 10 ? 1 : 2)} ms`

const settingsModel = (): SettingsModel => {
  const state = getState()
  for (const server of state.servers) {
    if (server.status === 'needs-token' && !autoExpanded.has(server.url)) {
      autoExpanded.add(server.url)
      expandedServers.add(server.url)
    }
  }
  const snapshot = isProfileEnabled() ? profileSnapshot() : null
  return {
    servers: state.servers.map((server) => {
      const message = settingsMessages.get(server.url)
      return {
        url: server.url,
        name: server.info?.name ?? server.url,
        status: server.status,
        ...(server.error === undefined ? {} : { error: server.error }),
        expanded: expandedServers.has(server.url),
        tokenSaved: server.token !== null,
        ...(server.tokenUsable === undefined ? {} : { tokenUsable: server.tokenUsable }),
        isAdmin: server.isAdmin,
        ...(server.isAdmin && expandedServers.has(server.url)
          ? { accessTokens: accessTokensModel(server, refreshSettings) }
          : {}),
        ...(pendingServers.has(server.url) ? { pending: true } : {}),
        ...(message === undefined ? {} : { message }),
      }
    }),
    ...(addServerPending ? { addServerPending: true } : {}),
    ...(addServerMessage === undefined ? {} : { addServerMessage }),
    colourNavigationOrder: state.colourNavigationOrder,
    reportPaints: state.reportPaints,
    shareTiles: state.shareTiles,
    debugLogging: isDebugEnabled(),
    performanceProfiling: isProfileEnabled(),
    ...(snapshot === null
      ? {}
      : {
          profile: {
            note: 'CPU and GPU cover measured Caelestis work. Frame timing, long tasks and heap cover the whole tab.',
            metrics: [
              {
                id: 'main',
                label: 'Measured CPU',
                value: `${snapshot.cpu.main.dutyPercent.toFixed(2)}%`,
              },
              {
                id: 'worker',
                label: 'Worker CPU',
                value: `${snapshot.cpu.worker.dutyPercent.toFixed(2)}%`,
              },
              {
                id: 'gpu',
                label: 'Overlay GPU',
                value:
                  snapshot.gpu.supported === false
                    ? 'Unavailable'
                    : snapshot.gpu.count === 0
                      ? 'Waiting for a frame'
                      : formatMilliseconds(snapshot.gpu.averageMs),
              },
              {
                id: 'buffers',
                label: 'Known buffers',
                value: formatBytes(snapshot.memory.knownTotalBytes),
              },
              {
                id: 'heap',
                label: 'Page JS heap',
                value: formatBytes(snapshot.memory.pageUsedJSHeapBytes),
              },
              {
                id: 'frames',
                label: 'Frame p95',
                value:
                  snapshot.frames.count === 0
                    ? 'Waiting for a frame'
                    : `${formatMilliseconds(snapshot.frames.p95Ms)} · ${snapshot.frames.estimatedFps?.toFixed(0) ?? '0'} fps`,
              },
              {
                id: 'long-tasks',
                label: 'Page long tasks',
                value: `${snapshot.longTasks.count} · ${formatMilliseconds(snapshot.longTasks.totalMs)}`,
              },
            ],
            ...(profileStatus === undefined ? {} : { status: profileStatus }),
          },
        }),
  }
}

const refreshSettings = (): void => {
  if (open && currentView === 'settings') showView('settings')
}

let profileTimer: number | null = null
const syncProfileTimer = (): void => {
  const wanted = open && currentView === 'settings' && isProfileEnabled()
  if (wanted && profileTimer === null) {
    profileTimer = window.setInterval(refreshSettings, 1_000)
  } else if (!wanted && profileTimer !== null) {
    window.clearInterval(profileTimer)
    profileTimer = null
  }
}

const connectServer = async (value: string): Promise<void> => {
  if (addServerPending) return
  addServerPending = true
  addServerMessage = 'Connecting…'
  refreshSettings()
  try {
    let canonical: string | null = null
    try {
      canonical = canonicalServerUrl(value)
    } catch {
      /* probe reports the address error */
    }
    if (canonical !== null && getState().servers.some((server) => server.url === canonical)) {
      addServerMessage = `${canonical} is already connected.`
      return
    }
    if (canonical !== null && disconnectingServerUrls.has(canonical)) {
      addServerMessage = `Still disconnecting ${canonical}. Try again in a moment.`
      return
    }
    const server = await probeServer(value, null)
    if (server.superseded === true) return
    if (server.status === 'unreachable') {
      addServerMessage = `Could not reach ${server.url}. Check the address and that the server allows this origin.`
      return
    }
    if (getState().servers.some((one) => one.url === server.url)) {
      addServerMessage = `${server.url} is already connected.`
      return
    }
    if (!upsertServer(server)) {
      addServerMessage = `Already connected to ${MAX_CONNECTED_SERVERS} servers. Disconnect one first.`
      return
    }
    addServerMessage = undefined
  } finally {
    addServerPending = false
    refreshSettings()
  }
}

const updateServerToken = async (url: string, token: string): Promise<void> => {
  const server = getState().servers.find((candidate) => candidate.url === url)
  if (server === undefined || pendingServers.has(url)) return
  pendingServers.add(url)
  settingsMessages.set(url, 'Checking…')
  refreshSettings()
  try {
    const next = await probeServer(url, token)
    if (next.superseded === true || !stillConnected(server)) return
    if (next.status === 'connected') {
      cancelDestinationAdmissions(url)
      upsertServer(next)
      expandedServers.delete(url)
      settingsMessages.delete(url)
      return
    }
    settingsMessages.set(
      url,
      next.status === 'needs-token'
        ? 'That token was not accepted. Ask whoever runs the server for a current one.'
        : `Could not reach the server. ${next.error ?? ''}`.trim(),
    )
  } finally {
    pendingServers.delete(url)
    refreshSettings()
  }
}

const handleSettingsIntent = (intent: SettingsIntent): void => {
  switch (intent.type) {
    case 'add-server':
      void connectServer(intent.url)
      break
    case 'toggle-server':
      if (intent.expanded) {
        expandedServers.add(intent.url)
        const server = getState().servers.find((candidate) => candidate.url === intent.url)
        if (server?.isAdmin === true) refreshAccessTokens(server, refreshSettings)
      } else expandedServers.delete(intent.url)
      refreshSettings()
      break
    case 'prefetch-server': {
      const server = getState().servers.find((candidate) => candidate.url === intent.url)
      if (server !== undefined) prefetchAccessTokens(server)
      break
    }
    case 'update-server-token':
      void updateServerToken(intent.url, intent.token)
      break
    case 'disconnect-server': {
      const server = getState().servers.find((candidate) => candidate.url === intent.url)
      if (server !== undefined) void disconnectServer(server)
      break
    }
    case 'load-more-access-tokens': {
      const server = getState().servers.find((candidate) => candidate.url === intent.url)
      if (server?.isAdmin === true) loadMoreAccessTokens(server, refreshSettings)
      break
    }
    case 'create-access-token': {
      const server = getState().servers.find((candidate) => candidate.url === intent.url)
      if (server?.isAdmin === true)
        createServerAccessToken(server, intent.label, intent.scope, refreshSettings)
      break
    }
    case 'revoke-access-token': {
      const server = getState().servers.find((candidate) => candidate.url === intent.url)
      if (server?.isAdmin === true)
        revokeServerAccessToken(server, intent.tokenHash, intent.label, refreshSettings)
      break
    }
    case 'set-colour-navigation-order':
      setState({ colourNavigationOrder: intent.value })
      break
    case 'set-boolean':
      if (intent.key === 'debugLogging') setDebugEnabled(intent.value)
      else if (intent.key === 'performanceProfiling') setProfileEnabled(intent.value)
      else setState({ [intent.key]: intent.value })
      refreshSettings()
      break
    case 'reset-profile':
      resetProfile()
      profileStatus = 'Reset'
      refreshSettings()
      break
    case 'copy-profile':
      if (navigator.clipboard === undefined) {
        profileStatus = 'Clipboard unavailable'
        refreshSettings()
        break
      }
      void navigator.clipboard.writeText(profileReport()).then(
        () => {
          profileStatus = 'Copied'
          refreshSettings()
        },
        () => {
          profileStatus = 'Clipboard unavailable'
          refreshSettings()
        },
      )
      break
  }
}

const appearanceModel = (): AppearanceEditorModel => {
  const state = getState()
  const effectiveHidden = new Set(globalHiddenColours())
  const activePixelPreset = pixelStylePresetOf(state.appearance)
  const activePreset = activeColourPreset(state.hiddenColours)
  const selected = selectedColour()
  const selectedColourName = selected === null ? undefined : WPLACE_PALETTE[selected]?.name
  return {
    values: state.appearance,
    sliders: APPEARANCE_CONTROLS.map((control) => ({
      key: control.key,
      label: control.label,
      value: state.appearance[control.key],
      defaultValue: DEFAULT_APPEARANCE[control.key],
      min: control.min,
      max: control.max,
      step: control.step,
      format:
        control.key === 'rotation'
          ? 'degrees'
          : control.key === 'contrastOutlineSize'
            ? 'decimal-pixels'
            : 'percent',
      ...(control.key === 'contrastOutlineSize' && !state.appearance.contrastOutline
        ? { disabled: true }
        : {}),
    })),
    pixelPresets: PIXEL_STYLE_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      active: preset.id === activePixelPreset,
    })),
    colourPresets: (
      [
        ['all', 'All'],
        ['free', 'Free'],
        ['premium', 'Premium'],
        ['owned', 'Owned'],
      ] as const
    ).map(([id, label]) => ({
      id,
      label,
      active: id === activePreset,
      ...(id === 'owned' && ownedColours() === null ? { disabled: true } : {}),
    })),
    palette: WPLACE_PALETTE.filter((colour) => colour.index !== TRANSPARENT_INDEX).map(
      (colour) => ({
        index: colour.index,
        name: colour.name,
        hex: colour.hex,
        kind: colour.kind,
        visible: !effectiveHidden.has(colour.index),
      }),
    ),
    onlySelectedColour: state.onlySelectedColour,
    paintOpen: isPaintOpen(),
    ...(selectedColourName === undefined ? {} : { selectedColourName }),
    markerBudget: state.markerBudget,
    markerBudgetOptions: MARKER_BUDGET_OPTIONS,
  }
}

const handleAppearanceIntent = (intent: AppearanceEditorIntent): void => {
  switch (intent.type) {
    case 'layout':
      break
    case 'preview-number':
    case 'preview-colour':
      previewGlobalAppearance({ ...getState().appearance, [intent.key]: intent.value })
      redraw()
      break
    case 'commit-number':
    case 'commit-colour':
      setState({ appearance: { ...getState().appearance, [intent.key]: intent.value } })
      redraw()
      break
    case 'set-boolean':
      setState({ appearance: { ...getState().appearance, [intent.key]: intent.value } })
      redraw()
      break
    case 'set-colour':
      setState({ appearance: { ...getState().appearance, [intent.key]: intent.value } })
      redraw()
      break
    case 'pixel-preset': {
      const preset = PIXEL_STYLE_PRESETS.find((candidate) => candidate.id === intent.id)
      if (preset === undefined) break
      setState({ appearance: { ...getState().appearance, ...preset.values } })
      redraw()
      break
    }
    case 'colour-preset':
      if (!['all', 'free', 'premium', 'owned'].includes(intent.id)) break
      setState({ hiddenColours: hiddenForPreset(intent.id as ColourPresetId) })
      redraw()
      break
    case 'toggle-colour': {
      const base =
        getState().onlySelectedColour && isPaintOpen()
          ? globalHiddenColours()
          : getState().hiddenColours
      const hidden = new Set(base)
      if (intent.visible) hidden.delete(intent.index)
      else hidden.add(intent.index)
      setState({ hiddenColours: [...hidden], onlySelectedColour: false })
      redraw()
      break
    }
    case 'only-selected-colour':
      setState({ onlySelectedColour: intent.value })
      redraw()
      break
    case 'marker-budget':
      if (MARKER_BUDGET_OPTIONS.some((value) => value === intent.value)) {
        setState({ markerBudget: intent.value })
      }
      break
  }
}

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
    ? { tree: { ...activeTreeAdapter.model, ...treeActionPresentation() } }
    : {}),
  ...(currentView === 'appearance' ? { appearance: appearanceModel() } : {}),
  ...(currentView === 'settings' ? { settings: settingsModel() } : {}),
})

const currentPanelWidth = (panel: CaelestisPanel): number =>
  panelWidthAfterMount(panel.getBoundingClientRect().width, panel.model.width)

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
        if (handleTreeActionPresentationIntent(intent.intent)) {
          break
        }
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
      case 'appearance':
        handleAppearanceIntent(intent.intent)
        break
      case 'settings':
        handleSettingsIntent(intent.intent)
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
  panel.model = panelModel(currentPanelWidth(panel))
}

/**
 * What the splitter reports to assistive technology.
 *
 * Module-level because the bounds come from the viewport: a window resize moves them, and that
 * handler lives outside the builder that made the handle.
 */

const showView = (view: View): void => {
  currentView = view
  const panel = document.getElementById(PANEL_ID) as CaelestisPanel | null
  if (panel === null) return

  if (view === 'settings') settingsModel()
  if (view === 'tree') {
    activeTreeAdapter = templateTreeAdapter(treeCallbacks(), rerenderTree, searchQuery)
    void primeFromCache(rerenderTree)
  } else {
    activeTreeAdapter = null
    if (view === 'appearance') refreshAccount(refreshView)
  }
  panel.model = panelModel(currentPanelWidth(panel))
  syncProfileTimer()
  log('install', `panel view: ${view}`)
}

const setOpen = (next: boolean): void => {
  open = next
  syncRailButtonState()
  const existing = document.getElementById(PANEL_ID)
  if (!open) {
    cancelTreeActionSetup(new Error('panel closed'))
    existing?.remove()
    syncProfileTimer()
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
  const theirs = findWplaceRail()?.getBoundingClientRect()
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
