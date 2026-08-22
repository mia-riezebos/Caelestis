import { isEnabled as isDebugEnabled, log, setEnabled as setDebugEnabled, warn } from '../debug.js'
import { redraw, viewportCentre } from '../main.js'
import { forgetServer } from '../server-cache.js'
import {
  type ConnectedServer,
  countNodeSubtree,
  createLocalFolder,
  createNode,
  deleteNode as deleteNodeOnServer,
  deleteTemplate as deleteTemplateOnServer,
  forgetScopes,
  getState,
  listServerNodes,
  loadState,
  moveLocalFolder,
  moveNode as moveNodeOnServer,
  onStateChange,
  type ProgressPlacement,
  patchTemplate,
  previewGlobalAppearance,
  probeServer,
  refreshStoredServers,
  removeLocalFolder,
  removeServer,
  removeTreeStateKeys,
  renameLocalFolder,
  renameNode as renameNodeOnServer,
  renameServer as renameServerOnServer,
  setState,
  uploadTemplate,
  uploadTemplateVersion,
  upsertServer,
} from '../state.js'
import { APPEARANCE_CONTROLS, UNPAINTED_LIMIT_CONTROL } from '../templates/appearance.js'
import { importFile } from '../templates/import.js'
import {
  addLocalTemplate,
  localTemplates as allLocal,
  copyAsLocalTemplate,
  forgetServerTemplates,
  localTemplates,
  onLocalChange,
  removeLocalTemplate,
  renameLocalTemplate,
  setTemplateFolder,
  templateAsPng,
} from '../templates/local-store.js'
import { beginMove, movingId, reserveMove, stopMoveForDeletion } from '../templates/move.js'
import { centreOf, navigateTo } from '../templates/navigate.js'
import { forgetNodes, nodeScopeKey } from '../templates/server-nodes.js'
import { endServerGeneration, forgetChunks, serverTemplateKey } from '../templates/server-sync.js'
import { isPaintOpen, onPaintSelectionChange } from '../wplace-paint.js'
import { accessTokenSection, forgetCachedTokens, prefetchAccessTokens } from './access-tokens.js'
import { whileBusy } from './button.js'
import { isColourPickerOpen } from './colour-picker.js'
import { coloursSection } from './colours.js'
import { confirmDestructive } from './confirm.js'
import type { IconName } from './icons.js'
import { icon } from './icons.js'
import { mismatchSettings } from './marker-settings.js'
import { CLEAR_OF_RAIL, EDGE, GAP, SURFACE_RADIUS } from './metrics.js'
import { sortControl } from './sort.js'
import { installStyles } from './styles.js'
import { type Destination, type Source, transplant } from './transplant.js'
import {
  findServerNode,
  findServerTemplate,
  forgetServerRows,
  nodeTreeKey,
  primeFromCache,
  refreshNodes,
  serverTemplateAt,
  serverTemplateTreeKey,
  startRenaming,
  type TreeTarget,
  templatesOfNode,
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
const BUTTON_ID = 'caelestis-rail-button'
const PANEL_ID = 'caelestis-panel'

const maximumPanelWidth = (): number => Math.min(720, Math.max(0, window.innerWidth - 96))
const minimumPanelWidth = (): number => Math.min(260, maximumPanelWidth())
/**
 * Every way a pointer gesture stops.
 *
 * `pointerup` alone is the happy path. A gesture the browser takes back for a system swipe fires
 * `pointercancel` instead, and one whose capture is stolen fires `lostpointercapture` — both leave a
 * drag running forever if only the first is listened for.
 */
const ENDINGS = ['pointerup', 'pointercancel', 'lostpointercapture'] as const

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
const BUTTON_TOOLTIP = `${APP_NAME} — shared templates`

type View = 'tree' | 'settings' | 'appearance'

const MOVES_RANGE = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

/** The header title for each view, and `null` where the panel keeps its own name. */
const VIEW_TITLE: Record<View, string | null> = {
  tree: null,
  settings: 'Settings',
  appearance: 'Appearance',
}

let currentView: View = 'tree'
let open = false
let searchQuery = ''

/**
 * wplace marks an open rail button by adding `btn-primary`, measured by opening theirs and diffing
 * the class list. Using the same class rather than a colour of our own means our button lights up
 * in whatever their theme calls primary, now and after any theme change.
 */
export const RAIL_BUTTON_CLASS = 'btn btn-square shadow-md relative'

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
  button.addEventListener('click', togglePanel)
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
  const existing = button.querySelector('[data-caelestis-badge]')
  if (count <= 0) {
    existing?.remove()
    return
  }
  const badge = existing ?? document.createElement('span')
  badge.setAttribute('data-caelestis-badge', '')
  badge.className = 'badge badge-sm badge-error absolute -top-1 -right-1'
  badge.textContent = String(count)
  if (existing === null) button.appendChild(badge)
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

const _emptyState = (): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'flex flex-col items-center text-center gap-3 py-10 px-4'
  const art = document.createElement('div')
  art.className = 'opacity-30'
  art.appendChild(icon('extension', 'size-10'))
  const title = document.createElement('p')
  title.className = 'font-medium'
  title.textContent = 'No servers connected'
  const body = document.createElement('p')
  body.className = 'text-sm opacity-70'
  body.style.maxWidth = '16rem'
  // The empty state is the whole onboarding: it has to say what a server is and what to do next,
  // because there is no other moment where anyone will read that.
  body.textContent =
    'Templates come from a server your alliance runs. Add its address to see everything it shares.'
  const action = document.createElement('button')
  action.className = 'btn btn-primary btn-sm'
  action.textContent = 'Add a server'
  action.addEventListener('click', () => showView('settings'))
  wrap.append(art, title, body, action)
  return wrap
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

  toolbar.append(
    search,
    sortControl(getState().sort, (next) => {
      setState({ sort: next })
      showView('tree')
    }),
  )

  const body = document.createElement('div')
  Object.assign(body.style, { overflowY: 'auto', flex: '1', minHeight: '0' })
  const renderTree = (): void => {
    body.replaceChildren(
      treeContents(
        {
          onAddServer: () => showView('settings'),
          onCreateFolder: (target) => void createFolder(target, renderTree),
          onImportTemplate: (target) => void importTemplate(target, renderTree),
          onRename: (target, name) => void applyRename(target, name, renderTree),
          onDelete: (target) => void applyDelete(target, renderTree),
          onContextMenu: (target, event) => openContextMenu(target, event, renderTree),
          onGoTo: goTo,
          onPlace: (id) => beginMove(id, renderTree),
          onCopyToServer: (id) => void copyToServer(id, renderTree),
          onError: (message) => toast(message, 'error'),
          onDropInServer: (server, nodeId, draggedKey, beforeKey) =>
            dropOnServerNode(server, nodeId, draggedKey, beforeKey, renderTree),
          onMoveLocal: async (draggedKey, parentKey, _beforeKey) => {
            // `local` is the root of the category; `lf:<id>` is a folder within it.
            const parentFolderId =
              parentKey?.startsWith('lf:') === true ? parentKey.slice('lf:'.length) : null
            // Something from a server, dropped into Local. It is a move rather than a reorder, and
            // it lands here because Local's rows are the ones that own dropping *between* rows.
            if (draggedKey.startsWith('node:')) {
              return await moveBranch(
                draggedKey,
                { kind: 'local', folderId: parentFolderId },
                renderTree,
              )
            }
            if (draggedKey.startsWith('st:')) {
              return await copyServerTemplateToLocal(draggedKey, parentFolderId, renderTree)
            }
            // Reparent first, then place. One drop target, two kinds of passenger — which it is
            // comes from the dragged row's own key, so nothing else has to care.
            if (draggedKey.startsWith('local:')) {
              if (!(await setTemplateFolder(draggedKey.slice('local:'.length), parentFolderId))) {
                toast('Could not move that template into the folder.', 'error')
                renderTree()
                return null
              }
              renderTree()
              return draggedKey
            } else if (draggedKey.startsWith('lf:')) {
              const folderId = draggedKey.slice('lf:'.length)
              moveLocalFolder(folderId, parentFolderId)
              return getState().localFolders.find((folder) => folder.id === folderId)?.parentId ===
                parentFolderId
                ? draggedKey
                : null
            }
            return null
          },
        },
        renderTree,
        searchQuery,
      ),
    )
  }
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value
    if (searchTimer !== null) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchTimer = null
      renderTree()
    }, 100)
  })
  renderTree()
  // Paint what the servers said last time, then let a live fetch replace it.
  void primeFromCache(renderTree)

  view.append(toolbar, body)
  return view
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
const refreshView = (): void => {
  if (!open) return
  if (isColourPickerOpen()) return
  const root = document.getElementById(PANEL_ID)
  if (root === null) return
  if (root.querySelector('.caelestis-dragging') !== null) return
  const active = document.activeElement
  if (root.contains(active) && active instanceof HTMLInputElement) return
  showView(currentView)
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

/**
 * A dropdown built from our own elements rather than a `<select>`.
 *
 * A native select's popup is drawn by the browser, so its corners cannot be given the `rounded-xl`
 * every other popout here uses — it rendered as a square-cornered list against rounded everything
 * else. Owning the list is the only way to make it match.
 *
 * Width is fixed rather than fitted to content, so a column of these lines up on both edges instead
 * of only the right; but narrower than it was, since sizing for the longest label in the app made
 * every short one look padded.
 */
const select = (
  options: readonly (readonly [string, string])[],
  value: string,
  onChange: (next: string) => void,
): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.style.position = 'relative'
  wrap.style.flex = '0 0 auto'

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn btn-sm btn-outline justify-between font-normal'
  button.style.width = '9rem'
  const label = document.createElement('span')
  label.className = 'caelestis-name'
  label.style.textAlign = 'left'
  label.textContent = options.find(([id]) => id === value)?.[1] ?? ''
  const caret = icon('caret', 'size-4 opacity-60')
  caret.style.transform = 'rotate(90deg)'
  button.append(label, caret)

  const close = (): void => {
    wrap.querySelector('[data-caelestis-options]')?.remove()
  }

  button.addEventListener('click', () => {
    if (wrap.querySelector('[data-caelestis-options]') !== null) {
      close()
      return
    }
    // Only one popout at a time, ours or another row's.
    for (const el of document.querySelectorAll('[data-caelestis-options]')) el.remove()
    const list = document.createElement('ul')
    list.setAttribute('data-caelestis-options', '')
    list.className = 'menu bg-base-100 shadow-2xl'
    Object.assign(list.style, {
      position: 'absolute',
      right: '0',
      top: 'calc(100% + 0.25rem)',
      zIndex: '40',
      // The same radius as the panel and every other popout. This is the whole reason it is not a
      // native select.
      borderRadius: SURFACE_RADIUS,
      padding: '0.25rem',
      width: '11rem',
      display: 'block',
    })
    for (const [id, text] of options) {
      const item = document.createElement('li')
      const choice = document.createElement('button')
      choice.type = 'button'
      choice.className = 'flex items-center gap-2'
      const tick = icon('check', 'size-4')
      // Reserved rather than conditional, so the labels do not shift as the selection moves.
      tick.style.visibility = id === value ? 'visible' : 'hidden'
      const name = document.createElement('span')
      name.textContent = text
      choice.append(tick, name)
      choice.addEventListener('click', () => {
        close()
        onChange(id)
      })
      item.appendChild(choice)
      list.appendChild(item)
    }
    wrap.appendChild(list)
    // Dismiss on a pointerdown outside, on the next tick so the opening click does not close it.
    setTimeout(() => {
      const dismiss = (event: PointerEvent): void => {
        if (event.target instanceof Node && wrap.contains(event.target)) return
        close()
        window.removeEventListener('pointerdown', dismiss)
      }
      window.addEventListener('pointerdown', dismiss)
    }, 0)
  })

  wrap.appendChild(button)
  return wrap
}

/**
 * A fraction, as a slider reading out in per cent.
 *
 * Sized to sit where a checkbox sits in a `settingRow`, so a switch and a limit line up as the pair
 * they are rather than as two unrelated rows.
 */
const _percentSlider = (value: number, onChange: (next: number) => void): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'flex items-center gap-2'
  wrap.style.flex = '0 0 auto'
  const { min, max, step, format } = UNPAINTED_LIMIT_CONTROL
  const input = document.createElement('input')
  input.type = 'range'
  input.className = 'range range-xs'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.value = String(value)
  input.style.width = '7rem'
  const readout = document.createElement('span')
  readout.className = 'text-xs opacity-60'
  readout.style.width = '2.5rem'
  readout.style.textAlign = 'right'
  readout.textContent = format(value)
  input.addEventListener('input', () => {
    const next = Number(input.value)
    readout.textContent = format(next)
    onChange(next)
  })
  wrap.append(input, readout)
  return wrap
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
const disconnectServer = (server: ConnectedServer): void => {
  // Anything already downloading for this server lands stale rather than drawing an overlay with no
  // server row left to control it.
  endServerGeneration(server.url)
  forgetServerTemplates(server.url)
  const hashes = forgetServerRows(server.url)
  const nodes = forgetNodes(server.url)
  forgetChunks(hashes)
  forgetCachedTokens(server.url)
  const serverTemplatePrefix = `srv:${server.url}:`
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
  removeServer(server.url)
  void forgetServer(server.url)
  redraw()
  showView('settings')
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
        : server.isAdmin
          ? 'Your token can change this server.'
          : 'Your token can read this server.'

  const attempt = async (): Promise<void> => {
    const value = code.value.trim()
    if (value === '') return
    status.className = 'text-xs opacity-60'
    status.textContent = 'Checking…'
    const next = await whileBusy(submit, () => probeServer(server.url, value))
    if (next === null) return
    if (next.status === 'connected') {
      upsertServer(next)
      // Closed again, because what was open for is done. Left open, a row that opened itself would
      // stay open on a pane that is otherwise a short list of servers.
      expandedServers.delete(server.url)
      showView('settings')
      return
    }
    // A wrong token and an unreachable server are different problems with different fixes, so they
    // must not share a message.
    status.className = 'text-xs text-error'
    status.textContent =
      next.status === 'needs-token'
        ? 'That token was not accepted. Ask whoever runs the server for a current one.'
        : `Could not reach the server. ${next.error ?? ''}`.trim()
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
  disconnect.addEventListener('click', () => disconnectServer(server))
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
      'Display progress bars',
      null,
      select(
        [
          ['inline', 'Inline'],
          ['expanded', 'When expanded'],
          ['hidden', 'Never'],
        ],
        state.progress,
        (next) => {
          setState({ progress: next as ProgressPlacement })
          rerender()
        },
      ),
    ),
  )

  // Same sliders as the per-overlay menu, deliberately — one vocabulary, learned once.
  const sliders = document.createElement('div')
  sliders.className = 'px-3 pb-2'
  for (const control of APPEARANCE_CONTROLS) {
    const row = document.createElement('label')
    row.className = 'flex items-center gap-3 py-1'
    const name = document.createElement('span')
    name.className = 'text-sm'
    name.style.width = '5rem'
    name.style.flex = '0 0 auto'
    name.textContent = control.label
    const input = document.createElement('input')
    input.type = 'range'
    input.className = 'range range-xs'
    input.min = String(control.min)
    input.max = String(control.max)
    input.step = String(control.step)
    input.value = String(state.appearance[control.key])
    input.style.flex = '1'
    input.style.minWidth = '0'
    const readout = document.createElement('span')
    readout.className = 'text-xs opacity-60'
    readout.style.width = '2.75rem'
    readout.style.flex = '0 0 auto'
    readout.style.textAlign = 'right'
    readout.textContent = control.format(state.appearance[control.key])
    let dirty = false
    let keyHeld = false
    const commit = (): void => {
      if (!dirty) return
      dirty = false
      const next = Number(input.value)
      // Read the live value rather than the one captured when this row was built, so dragging one
      // slider cannot revert another.
      setState({ appearance: { ...getState().appearance, [control.key]: next } })
    }
    input.addEventListener('input', () => {
      dirty = true
      const next = Number(input.value)
      readout.textContent = control.format(next)
      previewGlobalAppearance({ ...getState().appearance, [control.key]: next })
      redraw()
    })
    input.addEventListener('keydown', (event) => {
      if (MOVES_RANGE.has(event.key)) keyHeld = true
    })
    input.addEventListener('change', () => {
      if (!keyHeld) commit()
    })
    input.addEventListener('keyup', (event) => {
      if (!MOVES_RANGE.has(event.key)) return
      keyHeld = false
      commit()
    })
    for (const ending of ENDINGS) input.addEventListener(ending, commit)
    input.addEventListener('blur', () => setTimeout(commit, 0))
    row.append(name, input, readout)
    sliders.appendChild(row)
  }
  view.appendChild(sliders)

  view.appendChild(sectionHeader('Mismatches', 'search'))
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
    status.style.display = ''
    status.className = 'text-xs px-3 pb-2 opacity-60'
    status.textContent = 'Connecting…'
    const server = await whileBusy(add, () => probeServer(value, null))
    if (server === null) return
    if (server.status === 'unreachable') {
      status.className = 'text-xs px-3 pb-2 text-error'
      status.textContent = `Could not reach ${server.url}. Check the address and that the server allows this origin.`
      return
    }
    upsertServer(server)
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

  view.appendChild(sectionHeader('Contribution', 'share'))
  view.appendChild(
    settingRow(
      'Report my activity',
      'Sends your paint activity on templates to the respective servers.',
      checkbox(state.reportPaints, (next) => setState({ reportPaints: next })),
    ),
  )
  view.appendChild(
    settingRow(
      'Share tiles',
      'Forwards tiles with templates to respective servers.',
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
  return view
}

/** A transient message anchored to the panel, so an action can report without a dialog. */
const toast = (message: string, kind: 'info' | 'warning' | 'error' = 'info'): void => {
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

/** A name nobody has to type: "New folder", then "New folder 2", and so on. */
const freeFolderName = (taken: ReadonlySet<string>): string => {
  const base = 'New folder'
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; n < 500; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base} ${Date.now()}`
}

/** `local:<id>` is a template; `local`, `server:<url>` and `node:<id>` are containers. */
const localTemplateId = (target: TreeTarget): string | null =>
  target.key.startsWith('local:') ? target.key.slice('local:'.length) : null

const goTo = (templateId: string): void => {
  const template = localTemplates().find((candidate) => candidate.id === templateId)
  if (template !== undefined) navigateTo(centreOf(template))
}

const applyRename = async (
  target: TreeTarget,
  name: string,
  rerender: () => void,
): Promise<void> => {
  const templateId = localTemplateId(target)
  if (templateId !== null) {
    await renameLocalTemplate(templateId, name)
    rerender()
    return
  }
  const folderId = localFolderIdOf(target)
  if (folderId !== null) {
    renameLocalFolder(folderId, name)
    rerender()
    return
  }
  if (target.server !== null && target.templateId !== undefined) {
    // One column on the server, and deliberately not a new version: the pixels have not moved, so
    // nothing that caches chunks should be told to re-download them.
    const result = await patchTemplate(target.server, target.templateId, { name })
    if (!result.ok) toast(result.message, 'error')
    await refreshNodes(target.server, rerender)
    return
  }
  if (target.server !== null && target.nodeId === null) {
    // The server's own row. Renaming it is a write everyone sees, unlike the Local row directly
    // above it in the tree, which is this browser's alone.
    const result = await renameServerOnServer(target.server, name)
    if (!result.ok) toast(result.message, 'error')
    rerender()
    return
  }
  if (target.server === null || target.nodeId === null) {
    toast('There is nothing to rename here.', 'warning')
    rerender()
    return
  }
  const result = await renameNodeOnServer(target.server, target.nodeId, name)
  if (!result.ok) toast(result.message, 'error')
  await refreshNodes(target.server, rerender)
}

/**
 * Delete sits in a context menu one slip away from Rename, and a folder is not recoverable from the
 * client, so it always asks first.
 */
const askToDelete = (
  kind: string,
  name: string,
  note?: string,
  restoreFocusTo: HTMLElement | null = null,
): Promise<boolean> =>
  confirmDestructive({
    // Their shape: the heading asks, the body names the thing and says what happens to it.
    title: `Delete ${kind}?`,
    body: `${name} will be permanently removed.`,
    ...(note === undefined ? {} : { note }),
    confirmLabel: 'Delete',
    restoreFocusTo,
  })

const applyDelete = async (
  target: TreeTarget,
  rerender: () => void,
  restoreFocusTo: HTMLElement | null = null,
): Promise<void> => {
  const templateId = localTemplateId(target)
  if (templateId !== null) {
    if (
      !(await askToDelete(
        'template',
        target.name,
        'It is stored in this browser only.',
        restoreFocusTo,
      ))
    ) {
      return
    }
    // Join an existing delete in the store rather than returning early: every surface that asked
    // still receives the real outcome. If placement was active, reserve its slot until deletion is
    // known to have succeeded; a failed delete restores exactly the preview the user was moving.
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
  const folderId = localFolderIdOf(target)
  if (folderId !== null) {
    const confirmed = await confirmDestructive({
      title: `Delete “${target.name}”?`,
      body: 'The folder will be removed.',
      // Say where things go, because "delete" on a container reads as "delete what is inside it".
      note: 'Anything inside it moves up one level rather than being deleted.',
      confirmLabel: 'Delete',
      restoreFocusTo,
    })
    if (!confirmed) return
    // The folder goes only once everything inside it has somewhere else to be. A write that fails —
    // IndexedDB gone, or a compare-and-swap lost to another tab — leaves that template pointing at a
    // folder id, and the tree renders templates by matching their folder to one that exists, so
    // removing the folder anyway would take the template off screen for good.
    const parentId = getState().localFolders.find((f) => f.id === folderId)?.parentId ?? null
    const stranded: string[] = []
    for (const template of localTemplates()) {
      if (template.folderId !== folderId) continue
      if (!(await setTemplateFolder(template.id, parentId))) stranded.push(template.name)
    }
    if (stranded.length > 0) {
      toast(
        stranded.length === 1
          ? `Could not move “${stranded[0]}” out of “${target.name}”, so the folder was kept.`
          : `Could not move ${stranded.length} templates out of “${target.name}”, so the folder was kept.`,
        'error',
      )
      rerender()
      return
    }
    removeLocalFolder(folderId)
    removeTreeStateKeys(new Set([target.key]))
    rerender()
    return
  }
  if (target.server !== null && target.templateId !== undefined) {
    const confirmed = await askToDelete(
      'published template',
      target.name,
      // Said plainly because it is the one delete here that reaches other people: everyone
      // connected to this server loses it, not just this browser.
      'Everyone connected to this server will stop seeing it.',
      restoreFocusTo,
    )
    if (!confirmed) return
    const result = await deleteTemplateOnServer(target.server, target.templateId)
    if (!result.ok) toast(result.message, 'error')
    await refreshNodes(target.server, rerender)
    return
  }
  if (target.server === null || target.nodeId === null) {
    toast('Nothing to delete here yet.', 'warning')
    return
  }
  /**
   * A folder on a server, which is never only a folder.
   *
   * The count comes from the server rather than the tree, because the tree only knows what it has
   * fetched — a folder nobody has expanded has never been listed — and "delete 1 folder" for
   * something holding forty templates is the kind of wrong that only shows up afterwards.
   */
  const holding = await countNodeSubtree(target.server, target.nodeId)
  const inside =
    holding === null
      ? null
      : {
          folders: Math.max(0, holding.nodes - 1),
          templates: holding.templates,
        }
  const contents =
    inside === null || (inside.folders === 0 && inside.templates === 0)
      ? null
      : [
          inside.folders > 0 ? `${inside.folders} subfolder${inside.folders === 1 ? '' : 's'}` : '',
          inside.templates > 0
            ? `${inside.templates} template${inside.templates === 1 ? '' : 's'}`
            : '',
        ]
          .filter((part) => part !== '')
          .join(' and ')

  const confirmed = await confirmDestructive({
    title: `Delete “${target.name}”?`,
    body:
      contents === null
        ? `${target.name} will be permanently removed.`
        : `${target.name} and everything in it — ${contents} — will be permanently removed.`,
    ...(contents === null
      ? {}
      : { note: 'Everyone connected to this server loses all of it, and it cannot be undone.' }),
    confirmLabel: 'Delete',
    restoreFocusTo,
  })
  if (!confirmed) return

  // Cascade only where there is something to cascade. An empty folder deletes as it always did, so
  // a server that does not know the flag still answers.
  const result = await deleteNodeOnServer(target.server, target.nodeId, contents !== null)
  if (!result.ok) toast(result.message, 'error')
  await refreshNodes(target.server, rerender)
}

/**
 * Move a published template into another folder on the same server.
 *
 * A picker rather than a drag, because the tree's drag path is Local-only and a server move is a
 * write someone else sees — worth one deliberate confirmation rather than a gesture that can happen
 * by accident during a scroll.
 */
const moveServerTemplate = async (target: TreeTarget, rerender: () => void): Promise<void> => {
  const { server, templateId } = target
  if (server === null || templateId === undefined) return
  const nodes = await listServerNodes(server)
  const destinations = nodes.filter((node) => node.id !== target.nodeId)
  if (destinations.length === 0) {
    toast('There is nowhere else to put it — this server has one folder.', 'warning')
    return
  }

  const panel = document.getElementById(PANEL_ID)
  if (panel === null) return
  panel.querySelector('[data-caelestis-move]')?.remove()
  const box = document.createElement('div')
  box.setAttribute('data-caelestis-move', '')
  box.className = 'alert flex flex-col items-stretch gap-2 text-xs'
  Object.assign(box.style, { margin: '0 0.5rem 0.5rem', padding: '0.625rem 0.75rem' })

  const label = document.createElement('span')
  label.textContent = `Move “${target.name}” to:`
  const chooser = document.createElement('select')
  chooser.className = 'select select-xs select-bordered'
  for (const node of destinations) {
    const option = document.createElement('option')
    option.value = node.id
    option.textContent = node.path
    chooser.appendChild(option)
  }

  const buttons = document.createElement('div')
  buttons.className = 'flex gap-2 justify-end'
  const cancel = document.createElement('button')
  cancel.className = 'btn btn-xs btn-ghost'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', () => box.remove())
  const go = document.createElement('button')
  go.className = 'btn btn-xs btn-primary'
  go.textContent = 'Move'
  go.addEventListener('click', () => {
    void whileBusy(go, async () => {
      const result = await patchTemplate(server, templateId, { nodeId: chooser.value })
      box.remove()
      if (!result.ok) toast(result.message, 'error')
      await refreshNodes(server, rerender)
    })
  })
  buttons.append(cancel, go)
  box.append(label, chooser, buttons)
  panel.appendChild(box)
}

/**
 * A template dropped onto a folder on a server.
 *
 * Three journeys behind one gesture, and which one it is comes from what was dragged:
 *
 * - **From Local** — an upload. The same thing "Copy to a server" does, with the destination
 *   already answered by where it was dropped.
 * - **Within one server** — a refile, which is a single column and touches no pixels.
 * - **Across servers** — a move: the artwork is uploaded to the destination and then removed from
 *   the source. Confirmed first, because the second half is destructive to something other people
 *   can see, and a drag is easy to make by accident.
 *
 * A drop that would change nothing is silently ignored rather than round-tripping to say so.
 */
/**
 * Move a whole folder — a server's node or a Local one — to wherever it was dropped.
 *
 * Confirmed first when it crosses a boundary, because the source end of it is a delete that other
 * people can see, and a drag is easy to make by accident. Nothing is removed until the destination
 * holds the entire branch; see `transplant`.
 */
const moveBranch = async (
  draggedKey: string,
  destination: Destination,
  rerender: () => void,
): Promise<string | null> => {
  const fromServer = draggedKey.startsWith('node:')
  const found = fromServer ? findServerNode(draggedKey) : null
  if (fromServer && found === null) return null
  const sourceId = found?.node.id ?? draggedKey.slice(draggedKey.indexOf(':') + 1)

  const sourceServer =
    found === null
      ? null
      : (getState().servers.find((candidate) => candidate.url === found.serverUrl) ?? null)
  if (fromServer && sourceServer === null) return null

  /**
   * Within one server, a move is one field: the node's parent.
   *
   * Nothing is copied and no pixels move — the templates hang off node ids that do not change — so
   * this is a different operation from crossing a boundary, and asking to confirm it would be
   * asking about a folder drag inside a single tree, which nobody expects.
   */
  if (
    destination.kind === 'server' &&
    sourceServer !== null &&
    destination.server.url === sourceServer.url
  ) {
    if (found !== null && destination.nodeId === found.node.parentId) return draggedKey
    const moved = await moveNodeOnServer(destination.server, sourceId, destination.nodeId)
    if (!moved.ok) toast(moved.message, 'error')
    await refreshNodes(destination.server, rerender)
    return moved.ok ? draggedKey : null
  }

  const sourceName = sourceServer?.info?.name ?? sourceServer?.url ?? 'Local'
  const destinationName =
    destination.kind === 'local'
      ? 'Local'
      : (destination.server.info?.name ?? destination.server.url)
  const confirmed = await confirmDestructive({
    title: `Move this folder to ${destinationName}?`,
    body: `Everything inside it is copied to ${destinationName} first, and only then removed from ${sourceName}.`,
    ...(sourceServer === null
      ? {}
      : { note: `Everyone connected to ${sourceName} will stop seeing it.` }),
    confirmLabel: 'Move',
  })
  if (!confirmed) return null

  const source: Source =
    sourceServer === null
      ? { kind: 'local', folderId: sourceId }
      : { kind: 'server', server: sourceServer, nodeId: sourceId }

  toast('Moving…')
  const result = await transplant(source, destination, (server, nodeId) =>
    templatesOfNode(server.url, nodeId),
  )
  if (result.ok) toast(result.message)
  else toast(result.message, 'error')
  if (sourceServer !== null) await refreshNodes(sourceServer, rerender)
  if (destination.kind === 'server') await refreshNodes(destination.server, rerender)
  rerender()
  if (!result.ok || result.destinationRootId === undefined) return null
  return destination.kind === 'server'
    ? nodeTreeKey(destination.server, result.destinationRootId)
    : `lf:${result.destinationRootId}`
}

/**
 * Take a single published template into Local, and off the server.
 *
 * The pixels come from the copy already drawn, so nothing is downloaded twice — and if it has not
 * finished arriving there is nothing to move yet, which is worth saying rather than half-doing.
 */
const copyServerTemplateToLocal = async (
  templateKey: string,
  folderId: string | null,
  rerender: () => void,
): Promise<string | null> => {
  const found = findServerTemplate(templateKey)
  if (found === null) return null
  const templateId = found.template.id
  const source = getState().servers.find((candidate) => candidate.url === found.serverUrl)
  if (source === undefined) return null
  const drawn = allLocal().find(
    (candidate) => candidate.id === serverTemplateKey(found.serverUrl, templateId),
  )
  if (drawn === undefined) {
    toast('That template has not finished loading yet — try again in a moment.', 'warning')
    return null
  }

  const sourceName = source.info?.name ?? source.url
  const confirmed = await confirmDestructive({
    title: `Move “${found.template.name}” into Local?`,
    body: `It is copied into this browser first, and only then removed from ${sourceName}.`,
    note: `Everyone connected to ${sourceName} will stop seeing it.`,
    confirmLabel: 'Move',
  })
  if (!confirmed) return null

  const copied = await copyAsLocalTemplate(
    drawn,
    `local-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
  )
  if (!(await setTemplateFolder(copied.id, folderId))) {
    toast('Copied into Local, but could not put it in that folder.', 'error')
    rerender()
    return null
  }
  const removed = await deleteTemplateOnServer(source, templateId)
  if (!removed.ok) toast(`Copied into Local, but ${removed.message}`, 'error')
  else toast(`Moved “${found.template.name}” into Local.`)
  await refreshNodes(source, rerender)
  rerender()
  return `local:${copied.id}`
}

const dropOnServerNode = async (
  server: ConnectedServer,
  nodeId: string | null,
  draggedKey: string,
  _beforeKey: string | null,
  rerender: () => void,
): Promise<string | null> => {
  // A folder is a branch, not a row: its structure and everything hanging off it must exist at the
  // destination before anything is taken off the source. `transplant` owns that ordering; this only
  // decides which end is which.
  //
  // This is also the one destination that may be the server itself rather than a folder on it —
  // dropping onto the server's own row means the top level. A template cannot go there, because a
  // template has to live in a folder, which is why the null check below is after this.
  if (draggedKey.startsWith('node:') || draggedKey.startsWith('lf:')) {
    return await moveBranch(draggedKey, { kind: 'server', server, nodeId }, rerender)
  }
  if (nodeId === null) return null

  if (draggedKey.startsWith('local:')) {
    const local = allLocal().find((candidate) => candidate.id === draggedKey.slice('local:'.length))
    if (local === undefined) return null
    const png = await templateAsPng(local)
    if (png === null) {
      toast('Could not encode that template.', 'error')
      return null
    }
    const result = await uploadTemplate(server, {
      nodeId,
      name: local.name,
      originX: local.originX,
      originY: local.originY,
      png,
    })
    if (result.ok) toast(`Uploaded “${local.name}” to ${server.info?.name ?? server.url}.`)
    else toast(result.message, 'error')
    await refreshNodes(server, rerender)
    return result.ok ? serverTemplateTreeKey(server, result.id) : null
  }

  if (!draggedKey.startsWith('st:')) return null
  const found = findServerTemplate(draggedKey)
  if (found === null) return null
  const templateId = found.template.id

  if (found.serverUrl === server.url) {
    if (found.template.nodeId === nodeId) return draggedKey
    const result = await patchTemplate(server, templateId, { nodeId })
    if (!result.ok) toast(result.message, 'error')
    await refreshNodes(server, rerender)
    return result.ok ? draggedKey : null
  }

  const source = getState().servers.find((candidate) => candidate.url === found.serverUrl)
  if (source === undefined) return null
  const sourceName = source.info?.name ?? source.url
  const destinationName = server.info?.name ?? server.url
  const confirmed = await confirmDestructive({
    title: `Move “${found.template.name}” to ${destinationName}?`,
    body: `It will be uploaded to ${destinationName} and removed from ${sourceName}.`,
    note: `Everyone connected to ${sourceName} will stop seeing it.`,
    confirmLabel: 'Move',
  })
  if (!confirmed) return null

  // The pixels come from the copy already on the canvas, which is the assembled result of that
  // server's own chunks — so a cross-server move needs no second download.
  const drawn = allLocal().find(
    (candidate) => candidate.id === serverTemplateKey(found.serverUrl, templateId),
  )
  if (drawn === undefined) {
    toast('That template has not finished loading yet — try again in a moment.', 'warning')
    return null
  }
  const png = await templateAsPng(drawn)
  if (png === null) {
    toast('Could not encode that template.', 'error')
    return null
  }

  const uploaded = await uploadTemplate(server, {
    nodeId,
    name: found.template.name,
    originX: drawn.originX,
    originY: drawn.originY,
    png,
  })
  if (!uploaded.ok) {
    // Nothing has been removed yet, so a failure here leaves both sides exactly as they were.
    toast(uploaded.message, 'error')
    return null
  }
  const removed = await deleteTemplateOnServer(source, templateId)
  if (!removed.ok) {
    toast(`Copied to ${destinationName}, but could not remove it from ${sourceName}.`, 'error')
  } else {
    toast(`Moved “${found.template.name}” to ${destinationName}.`)
  }
  await refreshNodes(source, rerender)
  await refreshNodes(server, rerender)
  return serverTemplateTreeKey(server, uploaded.id)
}

/** Whether the row's template is published, read from the copy the row itself was drawn from. */
const publishedStateOf = (target: TreeTarget): boolean =>
  target.server !== null && target.templateId !== undefined
    ? (serverTemplateAt(target.server.url, target.templateId)?.published ?? false)
    : false

/**
 * Replace a published template's artwork with a local template's.
 *
 * Deliberately sourced from Local rather than from a file picker: a raw image has no placement, and
 * the origin is half of what a version *is*. Getting a template positioned locally and then pushing
 * it up is the same path `copyToServer` already establishes — this is that path for artwork that
 * already exists on the server.
 */
const replaceServerArtwork = async (target: TreeTarget, rerender: () => void): Promise<void> => {
  const { server, templateId } = target
  if (server === null || templateId === undefined) return
  const sources = allLocal()
  if (sources.length === 0) {
    toast('Import the new artwork into Local first, and place it where it belongs.', 'warning')
    return
  }

  const panel = document.getElementById(PANEL_ID)
  if (panel === null) return
  panel.querySelector('[data-caelestis-replace]')?.remove()
  const box = document.createElement('div')
  box.setAttribute('data-caelestis-replace', '')
  box.className = 'alert flex flex-col items-stretch gap-2 text-xs'
  Object.assign(box.style, { margin: '0 0.5rem 0.5rem', padding: '0.625rem 0.75rem' })

  const label = document.createElement('span')
  label.textContent = `Replace “${target.name}” with:`
  const chooser = document.createElement('select')
  chooser.className = 'select select-xs select-bordered'
  for (const candidate of sources) {
    const option = document.createElement('option')
    option.value = candidate.id
    option.textContent = candidate.name
    chooser.appendChild(option)
  }
  const note = document.createElement('span')
  note.className = 'opacity-60'
  note.textContent = 'Its position travels with it — the server re-slices from where it sits now.'

  const buttons = document.createElement('div')
  buttons.className = 'flex gap-2 justify-end'
  const cancel = document.createElement('button')
  cancel.className = 'btn btn-xs btn-ghost'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', () => box.remove())
  const go = document.createElement('button')
  go.className = 'btn btn-xs btn-primary'
  go.textContent = 'Replace'
  go.addEventListener('click', () => {
    const source = sources.find((candidate) => candidate.id === chooser.value)
    if (source === undefined) return
    void whileBusy(go, async () => {
      label.textContent = 'Encoding…'
      const png = await templateAsPng(source)
      if (png === null) {
        toast('Could not encode that template.', 'error')
        box.remove()
        return
      }
      label.textContent = `Uploading ${Math.round(png.size / 1024)} KB…`
      const result = await uploadTemplateVersion(server, templateId, {
        originX: source.originX,
        originY: source.originY,
        name: source.name,
        png,
      })
      box.remove()
      if (result.ok) toast(`Replaced the artwork for “${target.name}”.`)
      else toast(result.message, 'error')
      await refreshNodes(server, rerender)
    })
  })
  buttons.append(cancel, go)
  box.append(label, chooser, note, buttons)
  panel.appendChild(box)
}

/** Publish or unpublish, which is the difference between everyone seeing it and only admins. */
const setServerTemplatePublished = async (
  target: TreeTarget,
  published: boolean,
  rerender: () => void,
): Promise<void> => {
  const { server, templateId } = target
  if (server === null || templateId === undefined) return
  const result = await patchTemplate(server, templateId, { published })
  if (!result.ok) toast(result.message, 'error')
  await refreshNodes(server, rerender)
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
  document.querySelector('[data-caelestis-menu]')?.remove()
  const invoker = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  const menu = document.createElement('ul')
  menu.setAttribute('data-caelestis-menu', '')
  menu.className = 'menu bg-base-100 shadow-2xl'
  Object.assign(menu.style, {
    position: 'fixed',
    left: `${event.clientX}px`,
    top: `${event.clientY}px`,
    zIndex: '60',
    borderRadius: SURFACE_RADIUS,
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
  const published = publishedStateOf(target)
  const entries: ReadonlyArray<readonly [IconName, string, () => void]> =
    // A template on a server, which is a different set of verbs from either a folder or a local
    // template: it can be moved between folders, published, and replaced with new artwork.
    target.templateId !== undefined
      ? [
          ['move', 'Move to folder', () => void moveServerTemplate(target, rerender)],
          published
            ? [
                'eyeOff',
                'Unpublish',
                () => void setServerTemplatePublished(target, false, rerender),
              ]
            : ['eye', 'Publish', () => void setServerTemplatePublished(target, true, rerender)],
          ['uploadFile', 'Replace artwork', () => void replaceServerArtwork(target, rerender)],
          rename,
          remove,
        ]
      : templateId === null
        ? [
            ['createFolder', 'New folder', () => void createFolder(target, rerender)],
            ['uploadFile', 'Import template', () => void importTemplate(target, rerender)],
            rename,
            remove,
          ]
        : [
            ['search', 'Go to', () => void goTo(templateId)],
            ['move', 'Move', () => beginMove(templateId, rerender)],
            ['uploadFile', 'Copy to a server', () => void copyToServer(templateId, rerender)],
            rename,
            remove,
          ]
  for (const [glyph, label, run] of entries) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.className = label === 'Delete' ? 'text-error' : ''
    button.appendChild(icon(glyph, 'size-4'))
    const text = document.createElement('span')
    text.textContent = label
    button.appendChild(text)
    button.addEventListener('click', () => {
      menu.remove()
      run()
    })
    item.appendChild(button)
    menu.appendChild(item)
  }
  document.body.appendChild(menu)
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
  setTimeout(() => {
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && menu.contains(event.target)) return
      menu.remove()
      window.removeEventListener('pointerdown', dismiss)
    }
    window.addEventListener('pointerdown', dismiss)
  }, 0)
}

const importTemplate = async (target: TreeTarget, rerender: () => void): Promise<void> => {
  if (target.server !== null) {
    // Uploading to a server needs the template to exist and be placed first; that is the local
    // flow, and copy-to-server is the step after it.
    toast('Import into Local first, then copy it to a server.', 'warning')
    return
  }
  const picker = document.createElement('input')
  picker.type = 'file'
  picker.accept = '.wplace,.json,image/png,image/*'
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
        if (first === undefined) return
        const reservation = first.source === 'image' ? reserveMove() : null
        if (first.source === 'image' && reservation === null) {
          toast('Finish the current placement, then import this image again.', 'warning')
          return
        }
        // Straight into whichever Local folder was clicked. Importing from a folder's own button
        // and then finding the result at the top level would make the button a lie.
        const folderId = localFolderIdOf(target)
        const admitted: string[] = []
        try {
          for (const template of imported) {
            await addLocalTemplate(template)
            admitted.push(template.id)
            if (folderId !== null && !(await setTemplateFolder(template.id, folderId))) {
              throw new Error(`could not move ${template.name} into the selected folder`)
            }
          }
          rerender()

          const moved = first.moved
          toast(
            `Imported ${first.name} — ${first.width}x${first.height}` +
              (moved > 0 ? `, ${moved.toLocaleString()} pixels quantised` : ''),
          )
          if (first.source === 'image') {
            // The reservation spans persistence, so another placement cannot strand this image in
            // volatile state between admission and `beginMove`.
            if (reservation === null || !reservation.start(first.id, rerender)) {
              for (const template of imported) await removeLocalTemplate(template.id)
              rerender()
              toast(
                'Another placement started. Finish it, then import this image again.',
                'warning',
              )
            }
          } else {
            // It already knows where it belongs, so go and look at it — centred on the template and
            // zoomed to fit it, in-game. Changing the URL would reload and throw the import away.
            navigateTo(centreOf(first))
          }
        } catch (error) {
          for (const id of admitted) await removeLocalTemplate(id)
          rerender()
          throw error
        } finally {
          reservation?.release()
        }
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
const copyToServer = async (templateId: string, rerender: () => void): Promise<void> => {
  const template = allLocal().find((candidate) => candidate.id === templateId)
  if (template === undefined) return
  const targets = getState().servers.filter((server) => server.isAdmin)
  if (targets.length === 0) {
    toast('No server here accepts uploads — you need an admin code on one.', 'warning')
    return
  }

  const panel = document.getElementById(PANEL_ID)
  if (panel === null) return
  panel.querySelector('[data-caelestis-copy]')?.remove()
  const box = document.createElement('div')
  box.setAttribute('data-caelestis-copy', '')
  box.className = 'alert flex flex-col items-stretch gap-2 text-xs'
  Object.assign(box.style, { margin: '0 0.5rem 0.5rem', padding: '0.625rem 0.75rem' })

  const label = document.createElement('span')
  label.textContent = `Copy “${template.name}” to:`
  const chooser = document.createElement('select')
  chooser.className = 'select select-xs select-bordered'
  for (const server of targets) {
    for (const node of await listServerNodes(server)) {
      const option = document.createElement('option')
      option.value = `${server.url}|${node.id}`
      option.textContent = `${server.info?.name ?? server.url} · ${node.path}`
      chooser.appendChild(option)
    }
  }
  if (chooser.options.length === 0) {
    toast('Create a folder on the server first — a template has to live somewhere.', 'warning')
    return
  }

  const buttons = document.createElement('div')
  buttons.className = 'flex gap-2 justify-end'
  const cancel = document.createElement('button')
  cancel.className = 'btn btn-xs btn-ghost'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', () => box.remove())
  const go = document.createElement('button')
  go.className = 'btn btn-xs btn-primary'
  go.textContent = 'Copy'
  go.addEventListener('click', () => {
    const [url, nodeId] = (chooser.value ?? '').split('|')
    const server = targets.find((candidate) => candidate.url === url)
    if (server === undefined || nodeId === undefined) return
    // The same refusal Delete makes, for the same reason: this dialog stays open while the map is
    // used, and a placement in progress means the stored origin is the one being dragged away
    // from. Copying it would put the template on the server at a position nobody chose.
    if (movingId() === template.id) {
      toast(`Finish placing “${template.name}” before copying it.`, 'warning')
      return
    }
    void whileBusy(go, async () => {
      label.textContent = 'Encoding…'
      const png = await templateAsPng(template)
      if (png === null) {
        toast('Could not encode that template.', 'error')
        box.remove()
        return
      }
      label.textContent = `Uploading ${Math.round(png.size / 1024)} KB…`
      const result = await uploadTemplate(server, {
        nodeId,
        name: template.name,
        originX: template.originX,
        originY: template.originY,
        png,
      })
      box.remove()
      if (result.ok) {
        toast(`Copied “${template.name}” to ${server.info?.name ?? server.url}.`)
        await refreshNodes(server, rerender)
      } else {
        toast(result.message, 'error')
      }
    })
  })
  buttons.append(cancel, go)
  box.append(label, chooser, buttons)
  panel.appendChild(box)
}

/** `lf:<id>` is a Local folder; `local` is the Local root. */
const localFolderIdOf = (target: TreeTarget): string | null =>
  target.key.startsWith('lf:') ? target.key.slice('lf:'.length) : null

const isLocalTarget = (target: TreeTarget): boolean =>
  target.server === null && (target.key === 'local' || target.key.startsWith('lf:'))

const createFolder = async (target: TreeTarget, rerender: () => void): Promise<void> => {
  const { server, nodeId } = target
  if (isLocalTarget(target)) {
    // Nested under whichever Local folder was clicked, or at the top when it was Local itself.
    const parentId = localFolderIdOf(target)
    const taken = new Set(getState().localFolders.map((folder) => folder.name.toLowerCase()))
    const folder = createLocalFolder(parentId, freeFolderName(taken))
    startRenaming(`lf:${folder.id}`)
    rerender()
    return
  }
  if (server === null) {
    toast('Nothing to create a folder in here.', 'warning')
    return
  }
  // No dialog: pick a free name, create it, and drop straight into renaming it. Asking for a name
  // before the thing exists is a question with no context; renaming one that is on screen is not.
  const existing = await listServerNodes(server)
  const name = freeFolderName(new Set(existing.map((node) => node.name.toLowerCase())))
  const result = await createNode(server, name, nodeId)
  if (!result.ok) {
    toast(result.message, 'error')
    return
  }
  // Refresh before rendering: the row we are about to put into rename mode does not exist in the
  // cached node list yet, so re-rendering first would draw a tree without it and drop the rename.
  startRenaming(nodeTreeKey(server, result.node.id))
  await refreshNodes(server, rerender)
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
    // Clear of the rail on the right, and starting on the same line as it — our surfaces are read
    // together, so they begin together.
    right: `${CLEAR_OF_RAIL}px`,
    top: `${EDGE}px`,
    bottom: `${EDGE}px`,
    // wplace's own chrome sits at z-40 (the rail) and z-50 (its overlay layer), and the map canvas
    // is unpositioned. Sitting at 30 puts us above the canvas and beneath everything of theirs, so
    // their rail and menus open over our panel rather than being trapped behind it.
    zIndex: '30',
    width: `${panelWidthForViewport(getState().panelWidth)}px`,
    display: 'flex',
    flexDirection: 'column',
    minHeight: '0',
    color: 'var(--color-base-content, inherit)',
    borderRadius: SURFACE_RADIUS,
    overflow: 'hidden',
  } satisfies Partial<CSSStyleDeclaration>)

  const handle = document.createElement('div')
  handle.className = 'caelestis-resize'
  // A separator that can be moved is a splitter, and a splitter has to be reachable and readable:
  // the role and the label alone announced a control that could not be focused or operated, which
  // is a promise the 6px strip could not keep.
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-label', 'Resize panel')
  handle.setAttribute('aria-orientation', 'vertical')
  handle.tabIndex = 0
  const noteWidth = (width: number): void => {
    handle.setAttribute('aria-valuenow', String(Math.round(width)))
    handle.setAttribute('aria-valuemin', String(Math.round(minimumPanelWidth())))
    handle.setAttribute('aria-valuemax', String(Math.round(maximumPanelWidth())))
  }
  noteWidth(getState().panelWidth)
  const KEYBOARD_STEP_PX = 16
  handle.addEventListener('keydown', (event) => {
    const step =
      event.key === 'ArrowLeft'
        ? KEYBOARD_STEP_PX
        : event.key === 'ArrowRight'
          ? -KEYBOARD_STEP_PX
          : 0
    if (step === 0) return
    event.preventDefault()
    const next = panelWidthForViewport(panel.getBoundingClientRect().width + step)
    panel.style.width = `${next}px`
    noteWidth(next)
    setState({ panelWidth: Math.round(next) })
  })
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    handle.classList.add('caelestis-resizing')
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
      // Dragging the left edge rightwards makes the panel narrower, so the delta is inverted.
      const next = panelWidthForViewport(startWidth - (moved.clientX - startX))
      panel.style.width = `${next}px`
      noteWidth(next)
    }
    // The same three endings every other drag here listens for. Ending on `pointerup` alone left a
    // cancelled drag — the browser claiming the pointer for a system gesture — with `pointermove`
    // still bound, so the panel went on resizing under a pointer nobody was pressing.
    const done = (): void => {
      handle.classList.remove('caelestis-resizing')
      window.removeEventListener('pointermove', move)
      for (const ending of ENDINGS) window.removeEventListener(ending, done)
      setState({ panelWidth: Math.round(panel.getBoundingClientRect().width) })
    }
    window.addEventListener('pointermove', move)
    for (const ending of ENDINGS) window.addEventListener(ending, done)
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
  backButton.setAttribute('data-caelestis-back', '')
  backButton.className = 'btn btn-ghost btn-xs btn-circle'
  backButton.title = 'Back to templates'
  backButton.setAttribute('aria-label', 'Back to templates')
  backButton.appendChild(icon('arrowBack', 'size-4'))
  backButton.addEventListener('click', () => showView('tree'))

  const appearanceButton = document.createElement('button')
  appearanceButton.setAttribute('data-caelestis-appearance', '')
  appearanceButton.className = 'btn btn-ghost btn-xs btn-circle'
  appearanceButton.title = 'Appearance'
  appearanceButton.setAttribute('aria-label', 'Appearance')
  appearanceButton.setAttribute('aria-pressed', 'false')
  // A palette, not sliders. Two gear-adjacent glyphs side by side read as two settings buttons and
  // say nothing about which is which; a palette says what the page is about before it is opened.
  appearanceButton.appendChild(icon('palette', 'size-4'))
  appearanceButton.addEventListener('click', () =>
    showView(currentView === 'appearance' ? 'tree' : 'appearance'),
  )

  const settingsButton = document.createElement('button')
  settingsButton.setAttribute('data-caelestis-settings', '')
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

  header.append(backButton, title, appearanceButton, settingsButton, closeButton)

  const body = document.createElement('div')
  body.setAttribute('data-caelestis-body', '')
  Object.assign(body.style, { display: 'flex', flexDirection: 'column', minHeight: '0', flex: '1' })
  body.appendChild(treeView())

  panel.append(header, body)
  return panel
}

const showView = (view: View): void => {
  const staying = currentView === view
  currentView = view
  const panel = document.getElementById(PANEL_ID)
  const body = panel?.querySelector('[data-caelestis-body]')
  const title = panel?.querySelector('h2')
  if (!body || !title) return

  /**
   * Keep the scroll position when re-rendering the view you are already on.
   *
   * Every control here re-renders by rebuilding the whole view, which throws away the scroller with
   * it — so toggling a colour near the bottom of settings jumped back to the top, and toggling the
   * next one meant scrolling down again. Switching *between* views still starts at the top, which is
   * right: that is a new thing to read, not the same one redrawn.
   */
  const previous = body.firstElementChild
  const scrollTop = staying && previous instanceof HTMLElement ? previous.scrollTop : 0

  const next =
    view === 'settings' ? settingsView() : view === 'appearance' ? appearanceView() : treeView()
  body.replaceChildren(next)
  if (scrollTop > 0) next.scrollTop = scrollTop
  title.textContent = VIEW_TITLE[view] ?? PANEL_TITLE

  const back = panel?.querySelector<HTMLElement>('[data-caelestis-back]')
  if (back) back.style.visibility = view === 'tree' ? 'hidden' : 'visible'

  for (const [attribute, owns] of [
    ['data-caelestis-settings', 'settings'],
    ['data-caelestis-appearance', 'appearance'],
  ] as const) {
    const button = panel?.querySelector<HTMLElement>(`[${attribute}]`)
    if (!button) continue
    const here = view === owns
    // btn-active is DaisyUI's pressed state, so it reads as "you are here" in their theme.
    button.className = `btn btn-ghost btn-xs btn-circle${here ? ' btn-active' : ''}`
    button.setAttribute('aria-pressed', String(here))
  }
  log('install', `panel view: ${view}`)
}

const setOpen = (next: boolean): void => {
  open = next
  syncRailButtonState()
  const existing = document.getElementById(PANEL_ID)
  if (!open) {
    existing?.remove()
    return
  }
  if (existing !== null) return
  document.body.appendChild(buildPanel())
  showView(currentView)
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
const colourModeButton = (): HTMLButtonElement => {
  const existing = document.getElementById(COLOUR_MODE_ID)
  if (existing !== null) return existing as HTMLButtonElement
  const button = document.createElement('button')
  button.id = COLOUR_MODE_ID
  button.className = RAIL_BUTTON_CLASS
  button.appendChild(icon('palette'))
  button.addEventListener('click', () => {
    setState({ onlySelectedColour: !getState().onlySelectedColour })
    syncColourModeState()
  })
  return button
}

const COLOUR_MODE_ID = 'caelestis-colour-mode'

export const syncColourModeState = (): void => {
  const button = document.getElementById(COLOUR_MODE_ID)
  if (button === null) return
  const on = getState().onlySelectedColour
  button.className = on ? `${RAIL_BUTTON_CLASS} btn-primary` : RAIL_BUTTON_CLASS
  button.setAttribute('aria-pressed', String(on))
  const label = on ? 'Showing only the selected colour' : 'Show only the selected colour'
  // Says why nothing happened, at the moment it does not: the mode needs a colour to follow.
  button.title = isPaintOpen() ? label : `${label} — open wplace's paint drawer to pick one`
  button.setAttribute('aria-label', label)
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
  installStyles()
  const rail = railContainer()
  rail.append(railButton(), colourModeButton())
  syncRailButtonState()
  syncColourModeState()
  positionRail()
  log('install', 'rail installed beside wplace’s')

  const sync = (): void => {
    // Their re-render may have taken our buttons if anything ever moves them; put them back cheaply.
    if (!rail.contains(railButton())) rail.append(railButton(), colourModeButton())
    positionRail()
  }
  new MutationObserver(sync).observe(document.body, { childList: true, subtree: true })
  window.addEventListener('resize', () => {
    positionRail()
    const panel = document.getElementById(PANEL_ID)
    if (panel !== null) panel.style.width = `${panelWidthForViewport(getState().panelWidth)}px`
  })
  onStateChange(syncColourModeState)
  // Once, here, rather than each time a view is built: subscribing from inside `treeView` added a
  // fresh listener on every switch back to it, so the tenth visit redrew the panel ten times per
  // change.
  onStateChange(refreshView)
  onLocalChange(refreshView)
  // Opening wplace's paint drawer changes what the appearance grid is showing without changing any
  // state of ours, so neither listener above hears it and the grid sat showing the switches the
  // mode had already overridden. Only that view: the tree is expensive to rebuild and a colour
  // click while painting would rebuild it every time.
  onPaintSelectionChange(() => {
    syncColourModeState()
    if (currentView === 'appearance') refreshView()
  })
}
