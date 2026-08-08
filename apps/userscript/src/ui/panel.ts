import { canvasPixelToLatLng } from '@wts/shared'
import { isEnabled as isDebugEnabled, log, setEnabled as setDebugEnabled, warn } from '../debug.js'
import { viewportCentre } from '../main.js'
import { forgetServer } from '../server-cache.js'
import {
  type ConnectedServer,
  countNodeSubtree,
  createLocalFolder,
  createNode,
  deleteNode as deleteNodeOnServer,
  deleteTemplate as deleteTemplateOnServer,
  getState,
  listNodes,
  loadState,
  moveLocalFolder,
  onStateChange,
  type ProgressPlacement,
  patchTemplate,
  probeServer,
  removeLocalFolder,
  removeServer,
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
  localTemplates,
  onLocalChange,
  removeLocalTemplate,
  renameLocalTemplate,
  setTemplateFolder,
  templateAsPng,
} from '../templates/local-store.js'
import { beginMove } from '../templates/move.js'
import { centreOf, navigateTo } from '../templates/navigate.js'
import { serverTemplateKey } from '../templates/server-sync.js'
import { coloursSection } from './colours.js'
import { confirmDestructive } from './confirm.js'
import type { IconName } from './icons.js'
import { icon } from './icons.js'
import { DEFAULT_SORT, type SortOrder, sortControl } from './sort.js'
import { installStyles } from './styles.js'
import { type Destination, type Source, transplant } from './transplant.js'
import {
  findServerNode,
  findServerTemplate,
  placeKey,
  primeFromCache,
  refreshNodes,
  serverTemplateAt,
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

type View = 'tree' | 'settings' | 'appearance'

/** The header title for each view, and `null` where the panel keeps its own name. */
const VIEW_TITLE: Record<View, string | null> = {
  tree: null,
  settings: 'Settings',
  appearance: 'Appearance',
}

let currentView: View = 'tree'
let open = false
let sortOrder: SortOrder = DEFAULT_SORT

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

const emptyState = (): HTMLElement => {
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
  search.append(searchIcon, searchInput)

  toolbar.append(
    search,
    sortControl(sortOrder, (next) => {
      sortOrder = next
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
          onDropOnNode: (target, draggedKey) =>
            void dropOnServerNode(target, draggedKey, renderTree),
          onMoveLocal: (draggedKey, parentKey, beforeKey) => {
            // `local` is the root of the category; `lf:<id>` is a folder within it.
            const parentFolderId =
              parentKey?.startsWith('lf:') === true ? parentKey.slice('lf:'.length) : null
            // Something from a server, dropped into Local. It is a move rather than a reorder, and
            // it lands here because Local's rows are the ones that own dropping *between* rows.
            if (draggedKey.startsWith('node:')) {
              void moveBranch(draggedKey, { kind: 'local', folderId: parentFolderId }, renderTree)
              return
            }
            if (draggedKey.startsWith('st:')) {
              void copyServerTemplateToLocal(
                draggedKey.slice('st:'.length),
                parentFolderId,
                renderTree,
              )
              return
            }
            // Reparent first, then place. One drop target, two kinds of passenger — which it is
            // comes from the dragged row's own key, so nothing else has to care.
            if (draggedKey.startsWith('local:')) {
              void setTemplateFolder(draggedKey.slice('local:'.length), parentFolderId)
            } else if (draggedKey.startsWith('lf:')) {
              moveLocalFolder(draggedKey.slice('lf:'.length), parentFolderId)
            }
            placeKey(draggedKey, beforeKey)
          },
        },
        renderTree,
      ),
    )
  }
  renderTree()
  // Paint what the servers said last time, then let a live fetch replace it.
  void primeFromCache(renderTree)

  /**
   * Redraw the tree when the store changes underneath it.
   *
   * The panel used to subscribe to nothing, so every row showed whatever was true when it was last
   * drawn by an interaction. That was survivable while templates only ever appeared because someone
   * in this panel imported one — and stopped being survivable the moment a background sync could
   * add one: the canvas updated, the tree did not, and a template drew over the map with its own
   * switch reading "off" because the row had been drawn before it existed. Clicking it then sent
   * "on" and only the second click turned it off, which is exactly as baffling as it sounds.
   *
   * Skipped mid-gesture. A rename is an open text field and a drag is a row in flight; replacing
   * the whole subtree under either takes it away from the pointer.
   */
  const refreshTree = (): void => {
    if (!open || currentView !== 'tree') return
    const root = document.getElementById(PANEL_ID)
    if (root === null) return
    if (root.querySelector('.wts-dragging') !== null) return
    if (root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement)
      return
    renderTree()
  }
  onLocalChange(refreshTree)
  onStateChange(refreshTree)

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
  label.className = 'wts-name'
  label.style.textAlign = 'left'
  label.textContent = options.find(([id]) => id === value)?.[1] ?? ''
  const caret = icon('caret', 'size-4 opacity-60')
  caret.style.transform = 'rotate(90deg)'
  button.append(label, caret)

  const close = (): void => {
    wrap.querySelector('[data-wts-options]')?.remove()
  }

  button.addEventListener('click', () => {
    if (wrap.querySelector('[data-wts-options]') !== null) {
      close()
      return
    }
    // Only one popout at a time, ours or another row's.
    for (const el of document.querySelectorAll('[data-wts-options]')) el.remove()
    const list = document.createElement('ul')
    list.setAttribute('data-wts-options', '')
    list.className = 'menu bg-base-100 shadow-2xl'
    Object.assign(list.style, {
      position: 'absolute',
      right: '0',
      top: 'calc(100% + 0.25rem)',
      zIndex: '40',
      // The same radius as the panel and every other popout. This is the whole reason it is not a
      // native select.
      borderRadius: '0.75rem',
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
const percentSlider = (value: number, onChange: (next: number) => void): HTMLElement => {
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
    removeServer(server.url)
    void forgetServer(server.url)
    showView('settings')
  })

  top.append(name, badge, remove)
  wrap.appendChild(top)

  if (server.status !== 'needs-token') {
    if (server.status === 'unreachable') {
      const why = document.createElement('p')
      why.className = 'text-xs opacity-60'
      why.textContent = server.error ?? 'Could not be reached.'
      wrap.appendChild(why)
    }
    return wrap
  }

  const codeRow = document.createElement('div')
  codeRow.className = 'flex gap-2'
  codeRow.style.marginTop = '0.375rem'
  const code = document.createElement('input')
  code.type = 'password'
  code.autocomplete = 'off'
  code.className = 'input input-sm input-bordered'
  code.style.flex = '1'
  code.style.minWidth = '0'
  code.placeholder = 'Access code'
  const submit = document.createElement('button')
  submit.className = 'btn btn-sm btn-primary'
  submit.textContent = 'Connect'

  const status = document.createElement('p')
  status.className = 'text-xs opacity-60'
  status.style.marginTop = '0.25rem'
  status.textContent = 'This server needs an access code from whoever runs it.'

  const attempt = async (): Promise<void> => {
    const value = code.value.trim()
    if (value === '') return
    submit.classList.add('btn-disabled')
    status.className = 'text-xs opacity-60'
    status.textContent = 'Checking…'
    const next = await probeServer(server.url, value)
    submit.classList.remove('btn-disabled')
    if (next.status === 'connected') {
      upsertServer(next)
      showView('settings')
      return
    }
    // A wrong code and an unreachable server are different problems with different fixes, so they
    // must not share a message.
    status.className = 'text-xs text-error'
    status.textContent =
      next.status === 'needs-token'
        ? 'That code was not accepted. Ask whoever runs the server for a current one.'
        : `Could not reach the server. ${next.error ?? ''}`.trim()
  }

  submit.addEventListener('click', () => void attempt())
  code.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void attempt()
  })

  codeRow.append(code, submit)
  wrap.append(codeRow, status)
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
    input.addEventListener('input', () => {
      const next = Number(input.value)
      readout.textContent = control.format(next)
      // Read the live value rather than the one captured when this row was built, so dragging one
      // slider cannot revert another.
      setState({ appearance: { ...getState().appearance, [control.key]: next } })
    })
    row.append(name, input, readout)
    sliders.appendChild(row)
  }
  view.appendChild(sliders)

  view.appendChild(sectionHeader('Mismatches', 'search'))
  const setAppearance = (patch: Partial<typeof state.appearance>): void => {
    setState({ appearance: { ...getState().appearance, ...patch } })
  }
  view.appendChild(
    settingRow(
      'Mark mismatched pixels',
      'A crosshair on every pixel the canvas disagrees with, the same size at any zoom',
      checkbox(state.appearance.markMismatch, (next) => setAppearance({ markMismatch: next })),
    ),
  )
  view.appendChild(
    settingRow(
      'Count unpainted as mismatched',
      'Otherwise only pixels painted the wrong colour are marked',
      checkbox(state.appearance.markUnpainted, (next) => setAppearance({ markUnpainted: next })),
    ),
  )
  view.appendChild(
    settingRow(
      'Only once this much is left',
      'Above this, an unbuilt template is nothing but crosshairs and says nothing',
      percentSlider(state.appearance.unpaintedLimit, (next) =>
        setAppearance({ unpaintedLimit: next }),
      ),
    ),
  )

  view.appendChild(sectionHeader('Colours', 'palette'))
  view.appendChild(coloursSection(rerender))
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
    add.classList.add('btn-disabled')
    status.style.display = ''
    status.className = 'text-xs px-3 pb-2 opacity-60'
    status.textContent = 'Connecting…'
    const server = await probeServer(value, null)
    add.classList.remove('btn-disabled')
    if (server.status === 'unreachable') {
      status.className = 'text-xs px-3 pb-2 text-error'
      status.textContent = `Could not reach ${server.url}. Check the address and that the server allows this origin.`
      return
    }
    upsertServer(server)
    url.value = ''
    // Re-render so the new server's row appears — it is what carries the status badge and, when the
    // server wants one, the access-code field. Without this the panel reported "needs a code" and
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
  panel.querySelector('[data-wts-toast]')?.remove()
  const el = document.createElement('div')
  el.setAttribute('data-wts-toast', '')
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
const askToDelete = (kind: string, name: string, note?: string): Promise<boolean> =>
  confirmDestructive({
    // Their shape: the heading asks, the body names the thing and says what happens to it.
    title: `Delete ${kind}?`,
    body: `${name} will be permanently removed.`,
    ...(note === undefined ? {} : { note }),
    confirmLabel: 'Delete',
  })

const applyDelete = async (target: TreeTarget, rerender: () => void): Promise<void> => {
  const templateId = localTemplateId(target)
  if (templateId !== null) {
    if (!(await askToDelete('template', target.name, 'It is stored in this browser only.'))) {
      return
    }
    await removeLocalTemplate(templateId)
    rerender()
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
    })
    if (!confirmed) return
    for (const template of localTemplates()) {
      if (template.folderId === folderId) {
        await setTemplateFolder(
          template.id,
          getState().localFolders.find((f) => f.id === folderId)?.parentId ?? null,
        )
      }
    }
    removeLocalFolder(folderId)
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
  const nodes = await listNodes(server)
  const destinations = nodes.filter((node) => node.id !== target.nodeId)
  if (destinations.length === 0) {
    toast('There is nowhere else to put it — this server has one folder.', 'warning')
    return
  }

  const panel = document.getElementById(PANEL_ID)
  if (panel === null) return
  panel.querySelector('[data-wts-move]')?.remove()
  const box = document.createElement('div')
  box.setAttribute('data-wts-move', '')
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
    void (async () => {
      go.classList.add('btn-disabled')
      const result = await patchTemplate(server, templateId, { nodeId: chooser.value })
      box.remove()
      if (!result.ok) toast(result.message, 'error')
      await refreshNodes(server, rerender)
    })()
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
): Promise<void> => {
  const fromServer = draggedKey.startsWith('node:')
  const sourceId = draggedKey.slice(draggedKey.indexOf(':') + 1)
  const found = fromServer ? findServerNode(sourceId) : null
  if (fromServer && found === null) return

  const sourceServer =
    found === null
      ? null
      : (getState().servers.find((candidate) => candidate.url === found.serverUrl) ?? null)
  if (fromServer && sourceServer === null) return

  // Dropping a folder back into the place it already lives is a no-op, not a round trip.
  if (
    destination.kind === 'server' &&
    sourceServer !== null &&
    destination.server.url === sourceServer.url
  ) {
    toast('Moving folders within one server is not supported yet.', 'warning')
    return
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
  if (!confirmed) return

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
}

/**
 * Take a single published template into Local, and off the server.
 *
 * The pixels come from the copy already drawn, so nothing is downloaded twice — and if it has not
 * finished arriving there is nothing to move yet, which is worth saying rather than half-doing.
 */
const copyServerTemplateToLocal = async (
  templateId: string,
  folderId: string | null,
  rerender: () => void,
): Promise<void> => {
  const found = findServerTemplate(templateId)
  if (found === null) return
  const source = getState().servers.find((candidate) => candidate.url === found.serverUrl)
  if (source === undefined) return
  const drawn = allLocal().find(
    (candidate) => candidate.id === serverTemplateKey(found.serverUrl, templateId),
  )
  if (drawn === undefined) {
    toast('That template has not finished loading yet — try again in a moment.', 'warning')
    return
  }

  const sourceName = source.info?.name ?? source.url
  const confirmed = await confirmDestructive({
    title: `Move “${found.template.name}” into Local?`,
    body: `It is copied into this browser first, and only then removed from ${sourceName}.`,
    note: `Everyone connected to ${sourceName} will stop seeing it.`,
    confirmLabel: 'Move',
  })
  if (!confirmed) return

  const copied = await addLocalTemplate({
    ...drawn,
    id: `local-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    source: 'image',
  })
  setTemplateFolder(copied.id, folderId)
  const removed = await deleteTemplateOnServer(source, templateId)
  if (!removed.ok) toast(`Copied into Local, but ${removed.message}`, 'error')
  else toast(`Moved “${found.template.name}” into Local.`)
  await refreshNodes(source, rerender)
  rerender()
}

const dropOnServerNode = async (
  target: TreeTarget,
  draggedKey: string,
  rerender: () => void,
): Promise<void> => {
  const { server, nodeId } = target
  if (server === null || nodeId === null) return

  // A folder is a branch, not a row: its structure and everything hanging off it must exist at the
  // destination before anything is taken off the source. `transplant` owns that ordering; this only
  // decides which end is which.
  if (draggedKey.startsWith('node:') || draggedKey.startsWith('lf:')) {
    await moveBranch(draggedKey, { kind: 'server', server, nodeId }, rerender)
    return
  }

  if (draggedKey.startsWith('local:')) {
    const local = allLocal().find((candidate) => candidate.id === draggedKey.slice('local:'.length))
    if (local === undefined) return
    const png = await templateAsPng(local)
    if (png === null) {
      toast('Could not encode that template.', 'error')
      return
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
    return
  }

  if (!draggedKey.startsWith('st:')) return
  const templateId = draggedKey.slice('st:'.length)
  const found = findServerTemplate(templateId)
  if (found === null) return

  if (found.serverUrl === server.url) {
    if (found.template.nodeId === nodeId) return
    const result = await patchTemplate(server, templateId, { nodeId })
    if (!result.ok) toast(result.message, 'error')
    await refreshNodes(server, rerender)
    return
  }

  const source = getState().servers.find((candidate) => candidate.url === found.serverUrl)
  if (source === undefined) return
  const sourceName = source.info?.name ?? source.url
  const destinationName = server.info?.name ?? server.url
  const confirmed = await confirmDestructive({
    title: `Move “${found.template.name}” to ${destinationName}?`,
    body: `It will be uploaded to ${destinationName} and removed from ${sourceName}.`,
    note: `Everyone connected to ${sourceName} will stop seeing it.`,
    confirmLabel: 'Move',
  })
  if (!confirmed) return

  // The pixels come from the copy already on the canvas, which is the assembled result of that
  // server's own chunks — so a cross-server move needs no second download.
  const drawn = allLocal().find(
    (candidate) => candidate.id === serverTemplateKey(found.serverUrl, templateId),
  )
  if (drawn === undefined) {
    toast('That template has not finished loading yet — try again in a moment.', 'warning')
    return
  }
  const png = await templateAsPng(drawn)
  if (png === null) {
    toast('Could not encode that template.', 'error')
    return
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
    return
  }
  const removed = await deleteTemplateOnServer(source, templateId)
  if (!removed.ok) {
    toast(`Copied to ${destinationName}, but could not remove it from ${sourceName}.`, 'error')
  } else {
    toast(`Moved “${found.template.name}” to ${destinationName}.`)
  }
  await refreshNodes(source, rerender)
  await refreshNodes(server, rerender)
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
  panel.querySelector('[data-wts-replace]')?.remove()
  const box = document.createElement('div')
  box.setAttribute('data-wts-replace', '')
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
    void (async () => {
      const source = sources.find((candidate) => candidate.id === chooser.value)
      if (source === undefined) return
      go.classList.add('btn-disabled')
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
    })()
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
  document.querySelector('[data-wts-menu]')?.remove()
  const menu = document.createElement('ul')
  menu.setAttribute('data-wts-menu', '')
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
    () => void applyDelete(target, rerender),
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
        // Straight into whichever Local folder was clicked. Importing from a folder's own button
        // and then finding the result at the top level would make the button a lie.
        const folderId = localFolderIdOf(target)
        for (const template of imported) {
          await addLocalTemplate(template)
          if (folderId !== null) await setTemplateFolder(template.id, folderId)
        }
        rerender()

        const first = imported[0]
        if (first === undefined) return
        const moved = first.moved
        toast(
          `Imported ${first.name} — ${first.width}x${first.height}` +
            (moved > 0 ? `, ${moved.toLocaleString()} pixels quantised` : ''),
        )
        if (first.source === 'image') {
          // An image arrives with no placement of its own, so placing it is not an extra step —
          // it is the rest of the import.
          beginMove(first.id, rerender)
        } else {
          // It already knows where it belongs, so go and look at it — centred on the template and
          // zoomed to fit it, in-game. Changing the URL would reload and throw the import away.
          navigateTo(centreOf(first))
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
  panel.querySelector('[data-wts-copy]')?.remove()
  const box = document.createElement('div')
  box.setAttribute('data-wts-copy', '')
  box.className = 'alert flex flex-col items-stretch gap-2 text-xs'
  Object.assign(box.style, { margin: '0 0.5rem 0.5rem', padding: '0.625rem 0.75rem' })

  const label = document.createElement('span')
  label.textContent = `Copy “${template.name}” to:`
  const chooser = document.createElement('select')
  chooser.className = 'select select-xs select-bordered'
  for (const server of targets) {
    for (const node of await listNodes(server)) {
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
    void (async () => {
      const [url, nodeId] = (chooser.value ?? '').split('|')
      const server = targets.find((candidate) => candidate.url === url)
      if (server === undefined || nodeId === undefined) return
      go.classList.add('btn-disabled')
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
    })()
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
  const existing = await listNodes(server)
  const name = freeFolderName(new Set(existing.map((node) => node.name.toLowerCase())))
  const result = await createNode(server, name, nodeId)
  if (!result.ok) {
    toast(result.message, 'error')
    return
  }
  // Refresh before rendering: the row we are about to put into rename mode does not exist in the
  // cached node list yet, so re-rendering first would draw a tree without it and drop the rename.
  startRenaming(`node:${result.node.id}`)
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
    // The rail is `absolute top-2 right-2` with 40px buttons: 8 + 40 = 48px occupied. Clear it with
    // the same 12px rhythm the rail itself uses between buttons.
    right: '3.75rem',
    top: '1rem',
    bottom: '1rem',
    // wplace's own chrome sits at z-40 (the rail) and z-50 (its overlay layer), and the map canvas
    // is unpositioned. Sitting at 30 puts us above the canvas and beneath everything of theirs, so
    // their rail and menus open over our panel rather than being trapped behind it.
    zIndex: '30',
    width: `${Math.min(getState().panelWidth, window.innerWidth - 96)}px`,
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
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault()
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
      // Dragging the left edge rightwards makes the panel narrower, so the delta is inverted.
      const next = Math.min(720, Math.max(260, startWidth - (moved.clientX - startX)))
      panel.style.width = `${next}px`
    }
    const done = (): void => {
      handle.classList.remove('wts-resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', done)
      setState({ panelWidth: Math.round(panel.getBoundingClientRect().width) })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
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

  const appearanceButton = document.createElement('button')
  appearanceButton.setAttribute('data-wts-appearance', '')
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

  header.append(backButton, title, appearanceButton, settingsButton, closeButton)

  const body = document.createElement('div')
  body.setAttribute('data-wts-body', '')
  Object.assign(body.style, { display: 'flex', flexDirection: 'column', minHeight: '0', flex: '1' })
  body.appendChild(treeView())

  panel.append(header, body)
  return panel
}

const showView = (view: View): void => {
  const staying = currentView === view
  currentView = view
  const panel = document.getElementById(PANEL_ID)
  const body = panel?.querySelector('[data-wts-body]')
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

  const back = panel?.querySelector<HTMLElement>('[data-wts-back]')
  if (back) back.style.visibility = view === 'tree' ? 'hidden' : 'visible'

  for (const [attribute, owns] of [
    ['data-wts-settings', 'settings'],
    ['data-wts-appearance', 'appearance'],
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

/**
 * Keep the button on the rail.
 *
 * The rail is rendered by wplace's own Svelte app, which is free to re-render and drop anything we
 * appended. An observer costs nothing and turns "the button disappeared after I opened a menu" into
 * a non-event.
 */
export const installPanel = (): void => {
  loadState()
  installStyles()
  let warned = false
  const attach = (): void => {
    const existing = document.getElementById(BUTTON_ID)
    const found = findRail()
    if (found === null) {
      if (!warned) {
        warned = true
        warn('install', `no "${ANCHOR_LABEL}" button on the page yet — watching for it`)
      }
      return
    }
    // Already in the right place, directly after the anchor.
    if (existing !== null && existing.previousElementSibling === found.after) return
    existing?.remove()
    found.after.insertAdjacentElement('afterend', railButton())
    syncRailButtonState()
    log('install', 'rail button attached below Overlays')
  }

  attach()
  new MutationObserver(attach).observe(document.body, { childList: true, subtree: true })
}
