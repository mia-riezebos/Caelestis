import { warn } from '../debug.js'
import { viewportCentre } from '../main.js'
import {
  type ConnectedServer,
  createNode,
  deleteNode as deleteNodeOnServer,
  getState,
  listNodes,
  removeTreeStateKeys,
  renameNode as renameNodeOnServer,
  setState,
  uploadTemplate,
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
import type { IconName } from './icons.js'
import { icon } from './icons.js'
import { PANEL_ID } from './panel-chrome.js'
import { toast } from './panel-notifications.js'
import {
  admitTemplates,
  completionAfterImport,
  finalImportNotice,
  IMPORT_ACCEPT,
  importedImageNextStep,
  once,
  restoreConnectedFocus,
} from './panel-workflow.js'
import { type SortOrder, sortControl } from './sort.js'
import {
  cancelRenaming,
  forgetNodeOrder,
  nodeTreeKey,
  primeFromCache,
  refreshNodes,
  startRenaming,
  type TreeTarget,
  treeContents,
} from './tree.js'

type PanelRequestScope = 'view' | 'mutation'

export interface TreeViewShell {
  readonly copyOperations: {
    readonly begin: (key: string) => (() => void) | null
    readonly isActive: (key: string) => boolean
  }
  readonly ownerGeneration: () => number
  readonly ownsTreeView: (generation: number) => boolean
  readonly panelRequest: (scope?: PanelRequestScope) => {
    controller: AbortController
    finish: () => void
  }
  readonly showSettings: () => void
}

const MAX_COPY_DESTINATIONS = 2_000

let searchQuery = ''
let activeTreeRender: (() => void) | null = null
let cancelActiveConfirm: (() => void) | null = null
let cancelActiveCopy: (() => void) | null = null
let closeActiveContextMenu: ((restoreFocus: boolean) => void) | null = null
let shell: TreeViewShell | null = null

const treeShell = (): TreeViewShell => {
  if (shell === null) throw new Error('tree view shell is not installed')
  return shell
}

const panelRequest = (
  scope: PanelRequestScope = 'view',
): { controller: AbortController; finish: () => void } => treeShell().panelRequest(scope)

const copyOperations = {
  begin: (key: string): (() => void) | null => treeShell().copyOperations.begin(key),
  isActive: (key: string): boolean => treeShell().copyOperations.isActive(key),
}

export const treeView = (nextShell: TreeViewShell): HTMLElement => {
  shell = nextShell
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
          onAddServer: () => treeShell().showSettings(),
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
    // No early return for a delete already running elsewhere: `removeLocalTemplate` joins it and
    // answers with its outcome, so this surface still reports a genuine failure and still stays
    // quiet about a success it did not start.
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
  const ownerGeneration = treeShell().ownerGeneration()
  const stillOwned = (): boolean => treeShell().ownsTreeView(ownerGeneration)
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

export const rerenderActiveTree = (): void => activeTreeRender?.()

export const deactivateTreeView = (): void => {
  activeTreeRender = null
}

export const closeTreeContextMenu = (restoreFocus: boolean): void => {
  closeActiveContextMenu?.(restoreFocus)
}

export const cancelTreeConfirm = (): void => cancelActiveConfirm?.()

export const cancelTreeCopy = (): void => cancelActiveCopy?.()
