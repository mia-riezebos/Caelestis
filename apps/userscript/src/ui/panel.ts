import { log, warn } from '../debug.js'
import { viewportCentre } from '../main.js'
import { forgetServer } from '../server-cache.js'
import {
  type ConnectedServer,
  createNode,
  deleteNode as deleteNodeOnServer,
  getState,
  listNodes,
  loadState,
  probeServer,
  refreshStoredServers,
  removeCustomOrderKeys,
  removeServer,
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
  removeLocalTemplate,
  renameLocalTemplate,
  templateAsPng,
} from '../templates/local-store.js'
import { beginMove } from '../templates/move.js'
import { centreOf, navigateTo } from '../templates/navigate.js'
import { coloursSection } from './colours.js'
import type { IconName } from './icons.js'
import { icon } from './icons.js'
import { sortControl } from './sort.js'
import { installStyles } from './styles.js'
import {
  forgetNodeOrder,
  forgetServerTree,
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

type View = 'tree' | 'settings'

let currentView: View = 'tree'
let open = false
let searchQuery = ''
let activeResizeCleanup: (() => void) | null = null

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
        },
        renderTree,
        searchQuery,
      ),
    )
  }
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value
    renderTree()
  })
  renderTree()
  // Paint what the servers said last time, then let a live fetch replace it.
  void primeFromCache(renderTree)

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

const checkbox = (): HTMLInputElement => {
  const el = document.createElement('input')
  el.type = 'checkbox'
  el.className = 'checkbox checkbox-sm'
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
    forgetServerTree(server.url)
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

  let checking = false
  const attempt = async (): Promise<void> => {
    if (checking) return
    const value = code.value.trim()
    if (value === '') return
    checking = true
    submit.disabled = true
    status.className = 'text-xs opacity-60'
    status.textContent = 'Checking…'
    const next = await probeServer(server.url, value)
    checking = false
    submit.disabled = false
    if (getState().servers.find((candidate) => candidate.url === server.url) !== server) return
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

const settingsView = (): HTMLElement => {
  const view = document.createElement('div')
  Object.assign(view.style, { overflowY: 'auto', flex: '1', minHeight: '0' })

  view.appendChild(sectionHeader('Servers'))
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

  let connecting = false
  const connect = async (): Promise<void> => {
    if (connecting) return
    const value = url.value.trim()
    if (value === '') return
    connecting = true
    add.disabled = true
    status.style.display = ''
    status.className = 'text-xs px-3 pb-2 opacity-60'
    status.textContent = 'Connecting…'
    const server = await probeServer(value, null)
    connecting = false
    add.disabled = false
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

  view.appendChild(sectionHeader('Colours'))
  view.appendChild(coloursSection(() => showView('settings')))

  view.appendChild(sectionHeader('Diagnostics'))
  const debugRow = settingRow('Debug logging', 'Verbose console output for bug reports', checkbox())
  view.appendChild(debugRow)
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
    if (!(await renameLocalTemplate(templateId, name))) {
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
  const result = await renameNodeOnServer(target.server, target.nodeId, name)
  if (!result.ok) toast(result.message, 'error')
  await refreshNodes(target.server, rerender)
}

/**
 * Ask before destroying something.
 *
 * Delete sits in a context menu one slip away from Rename, and a folder is not recoverable from the
 * client. The confirm names the thing rather than saying "are you sure", so the answer does not
 * depend on remembering what was right-clicked.
 */
const confirmDestructive = (message: string): Promise<boolean> =>
  new Promise((resolve) => {
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
    const finish = (answer: boolean): void => {
      box.remove()
      resolve(answer)
    }
    cancel.addEventListener('click', () => finish(false))
    confirm.addEventListener('click', () => finish(true))
    buttons.append(cancel, confirm)
    box.append(text, buttons)
    panel.appendChild(box)
    confirm.focus()
  })

const applyDelete = async (target: TreeTarget, rerender: () => void): Promise<void> => {
  const templateId = localTemplateId(target)
  if (templateId !== null) {
    if (!(await confirmDestructive(`Delete “${target.name}”? This cannot be undone.`))) return
    // No early return for a delete already running elsewhere: `removeLocalTemplate` joins it and
    // answers with its outcome, so this surface still reports a genuine failure and still stays
    // quiet about a success it did not start.
    if (!(await removeLocalTemplate(templateId))) {
      toast(`Could not delete “${target.name}”.`, 'error')
      return
    }
    removeCustomOrderKeys(new Set([target.key]))
    rerender()
    return
  }
  if (target.server === null || target.nodeId === null) {
    toast('Nothing to delete here yet.', 'warning')
    return
  }
  if (!(await confirmDestructive(`Delete “${target.name}”? This cannot be undone.`))) return
  const result = await deleteNodeOnServer(target.server, target.nodeId)
  if (!result.ok) toast(result.message, 'error')
  else forgetNodeOrder(target.server.url, target.nodeId)
  await refreshNodes(target.server, rerender)
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
        let added = 0
        let failure: unknown = null
        for (const template of imported) {
          try {
            await addLocalTemplate(template)
            added++
          } catch (error) {
            failure = error
            break
          }
        }
        rerender()

        if (failure !== null) {
          toast(
            added === 0
              ? `Could not import: ${String(failure)}`
              : `Imported ${added} of ${imported.length}; the rest could not be added: ${String(failure)}`,
            'error',
          )
          if (added === 0) return
        }

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
  label.textContent = 'Loading destinations…'
  const chooser = document.createElement('select')
  chooser.className = 'select select-xs select-bordered'
  chooser.disabled = true
  const buttons = document.createElement('div')
  buttons.className = 'flex gap-2 justify-end'
  const cancel = document.createElement('button')
  cancel.className = 'btn btn-xs btn-ghost'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', () => box.remove())
  const go = document.createElement('button')
  go.className = 'btn btn-xs btn-primary'
  go.textContent = 'Copy'
  go.disabled = true
  buttons.append(cancel, go)
  box.append(label, chooser, buttons)
  panel.appendChild(box)

  const loaded = await Promise.all(
    targets.map(async (server) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      try {
        return { server, nodes: await listNodes(server, controller.signal) }
      } finally {
        clearTimeout(timeout)
      }
    }),
  )
  if (!box.isConnected) return
  for (const { server, nodes } of loaded) {
    for (const node of nodes) {
      const option = document.createElement('option')
      option.value = `${server.url}|${node.id}`
      option.textContent = `${server.info?.name ?? server.url} · ${node.path}`
      chooser.appendChild(option)
    }
  }
  if (chooser.options.length === 0) {
    toast('Create a folder on the server first — a template has to live somewhere.', 'warning')
    box.remove()
    return
  }
  label.textContent = `Copy “${template.name}” to:`
  chooser.disabled = false
  go.disabled = false
  let uploading = false
  go.addEventListener('click', () => {
    if (uploading) return
    void (async () => {
      const [url, nodeId] = (chooser.value ?? '').split('|')
      const server = targets.find((candidate) => candidate.url === url)
      if (server === undefined || nodeId === undefined) return
      uploading = true
      go.disabled = true
      try {
        label.textContent = 'Encoding…'
        const png = await templateAsPng(template)
        if (png === null) throw new Error('encoder returned no image')
        label.textContent = `Uploading ${Math.round(png.size / 1024)} KB…`
        const result = await uploadTemplate(server, {
          nodeId,
          name: template.name,
          originX: template.originX,
          originY: template.originY,
          png,
        })
        if (!result.ok) throw new Error(result.message)
        box.remove()
        toast(`Copied “${template.name}” to ${server.info?.name ?? server.url}.`)
        await refreshNodes(server, rerender)
      } catch (error) {
        toast(`Could not copy: ${String(error)}`, 'error')
        label.textContent = `Copy “${template.name}” to:`
        uploading = false
        go.disabled = false
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
    activeResizeCleanup?.()
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
      else panel.style.width = `${startWidth}px`
    }
    const done = (): void => cleanup(true)
    const cancelResize = (): void => cleanup(false)
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
  body.appendChild(treeView())

  panel.append(header, body)
  return panel
}

const showView = (view: View): void => {
  currentView = view
  const panel = document.getElementById(PANEL_ID)
  const body = panel?.querySelector('[data-wts-body]')
  const title = panel?.querySelector('h2')
  if (!body || !title) return
  const inSettings = view === 'settings'
  body.replaceChildren(inSettings ? settingsView() : treeView())
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
    activeResizeCleanup?.()
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
  void refreshStoredServers().then(() => {
    if (document.getElementById(PANEL_ID) !== null) showView(currentView)
  })
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
