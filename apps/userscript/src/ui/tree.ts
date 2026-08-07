import { cacheServer, loadServerCache } from '../server-cache.js'
import {
  type ConnectedServer,
  getState,
  type LocalFolder,
  listNodes,
  setState,
  type TreeNode,
} from '../state.js'
import { localTemplates, type PlacedTemplate, setLocalVisible } from '../templates/local-store.js'
import { type IconName, icon } from './icons.js'
import { isReorderable } from './sort.js'

/**
 * The tree: one root per source, plus `Local`.
 *
 * Row anatomy, left to right: **caret, kind icon, name, meta, row actions, checkbox**. The caret
 * leads because it is what makes a list read as a tree; the checkbox trails because it is what you
 * act on once you have found the row. Row actions sit just inside it and appear on hover, so a
 * quiet list stays quiet.
 *
 * The whole row is the expand target — a caret is a 24px hit area on a 300px row, and everything
 * between them is dead space otherwise.
 */

export interface TreeTarget {
  readonly server: ConnectedServer | null
  readonly nodeId: string | null
  readonly key: string
  readonly name: string
}

export interface TreeCallbacks {
  readonly onAddServer: () => void
  readonly onCreateFolder: (target: TreeTarget) => void
  readonly onImportTemplate: (target: TreeTarget) => void
  readonly onRename: (target: TreeTarget, name: string) => void
  readonly onDelete: (target: TreeTarget) => void
  readonly onContextMenu: (target: TreeTarget, event: MouseEvent) => void
  /** Frame a local template on the map. */
  readonly onGoTo: (templateId: string) => void
  readonly onPlace: (templateId: string) => void
  readonly onCopyToServer: (templateId: string) => void
  /** File a dragged row — a template or another folder — into a Local folder. */
  readonly onMoveIntoLocalFolder: (draggedKey: string, folderId: string) => void
}

const collapsed = new Set<string>()
/** The row currently being renamed, if any. Inline editing beats a modal for a one-field change. */
let renaming: string | null = null

/**
 * Nodes per server, fetched once and refreshed on demand.
 *
 * Rendering happens synchronously, so the tree draws what it has and fills in when the fetch lands.
 * A server with no nodes yet and a server whose nodes have not arrived look the same for a moment,
 * which is the right trade against blocking the whole panel on a network call.
 */
const nodesByServer = new Map<string, readonly TreeNode[]>()

export const refreshNodes = async (
  server: ConnectedServer,
  rerender: () => void,
): Promise<void> => {
  if (!server.isAdmin) return
  const nodes = await listNodes(server)
  nodesByServer.set(server.url, nodes)
  void cacheServer({ url: server.url, nodes, fetchedAt: Date.now() })
  rerender()
}

/**
 * Draw what a server said last time, immediately, before anything is fetched.
 *
 * Without it the tree is empty on every page load until each server answers, which is the wrong
 * first impression and gets worse the more servers are connected.
 */
export const primeFromCache = async (rerender: () => void): Promise<void> => {
  for (const entry of await loadServerCache()) {
    if (!nodesByServer.has(entry.url)) nodesByServer.set(entry.url, entry.nodes)
  }
  rerender()
}

export const startRenaming = (key: string): void => {
  renaming = key
}
const disabled = new Set<string>()

const isExpanded = (key: string): boolean => !collapsed.has(key)
const isEnabled = (key: string): boolean => !disabled.has(key)
const toggle = (set: Set<string>, key: string): void => {
  if (set.has(key)) set.delete(key)
  else set.add(key)
}

const orderedKeys = (keys: readonly string[]): readonly string[] => {
  const rank = new Map(getState().customOrder.map((key, index) => [key, index]))
  return [...keys].sort(
    (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
  )
}

const moveKey = (keys: readonly string[], from: string, to: string, after: boolean): void => {
  const next = keys.filter((key) => key !== from)
  const index = next.indexOf(to)
  if (index === -1) return
  next.splice(after ? index + 1 : index, 0, from)
  setState({ customOrder: next })
}

/** Held open where the dragged row would land — a hole says "here"; a line only says "near here". */
const placeholder = (): HTMLElement => {
  const el = document.createElement('div')
  el.className = 'wts-placeholder'
  el.dataset.wtsPlaceholder = ''
  return el
}

const clearDropMarks = (root: ParentNode): void => {
  for (const el of root.querySelectorAll('[data-wts-placeholder]')) el.remove()
  for (const el of root.querySelectorAll('.wts-drop-into')) el.classList.remove('wts-drop-into')
}

interface RowOptions {
  readonly key: string
  readonly name: string
  readonly kind: IconName
  readonly depth: number
  readonly meta?: string
  /** Containers accept a drop *into* them; leaves only reorder between siblings. */
  readonly container: boolean
  readonly actions?: ReadonlyArray<{ icon: IconName; label: string; run: () => void }> | undefined
  /** Present only where the user can actually change things; absent means no rename affordance. */
  readonly onRename?: ((name: string) => void) | undefined
  readonly onContextMenu?: ((event: MouseEvent) => void) | undefined
  readonly siblings: readonly string[]
  readonly rerender: () => void
  readonly onDropInto?: ((draggedKey: string) => void) | undefined
  /** When present, the row reflects this instead of the tree's own disabled set. */
  readonly checked?: boolean | undefined
  readonly onToggleChecked?: ((on: boolean) => void) | undefined
}

const treeRow = (options: RowOptions): HTMLElement => {
  const draggable = isReorderable(getState().sort)
  const row = document.createElement('div')
  row.className = 'wts-row flex items-center gap-1'
  row.dataset.wtsKey = options.key
  row.style.padding = '0.25rem 0.5rem'
  // One indent step per level, on top of the fixed gutter.
  row.style.marginLeft = `${0.25 + options.depth * 1.125}rem`
  row.style.marginRight = '0.5rem'
  row.style.minHeight = '2rem'
  row.draggable = draggable
  row.tabIndex = 0
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-expanded', String(isExpanded(options.key)))

  if (options.container) {
    const glyph = icon('caret', 'size-4 opacity-60')
    glyph.style.flex = '0 0 auto'
    glyph.style.transition = 'transform 120ms ease-out'
    glyph.style.transform = isExpanded(options.key) ? 'rotate(90deg)' : 'rotate(0deg)'
    row.appendChild(glyph)
  } else {
    // A leaf still needs the caret's width, or its name hangs left of every sibling's.
    const spacer = document.createElement('span')
    spacer.style.flex = '0 0 auto'
    spacer.style.width = '1rem'
    row.appendChild(spacer)
  }

  const kind = icon(options.kind, 'size-4 opacity-60')
  kind.style.flex = '0 0 auto'
  row.appendChild(kind)

  const editing = renaming === options.key && options.onRename !== undefined
  const input = document.createElement('input')
  const name = document.createElement('span')
  if (editing) {
    input.type = 'text'
    input.className = 'input input-xs input-bordered'
    input.value = options.name
    input.style.flex = '1'
    input.style.minWidth = '0'
    input.addEventListener('click', (event) => event.stopPropagation())
    row.appendChild(input)
    requestAnimationFrame(() => {
      input.focus()
      input.select()
    })
  } else {
    name.className = 'wts-name text-sm'
    name.textContent = options.name
    row.appendChild(name)
    // A tooltip that repeats fully visible text is noise; only label what is actually clipped.
    requestAnimationFrame(() => {
      if (name.scrollWidth > name.clientWidth) name.title = options.name
    })
  }

  if (options.meta !== undefined) {
    const meta = document.createElement('span')
    meta.className = 'text-xs opacity-50'
    meta.style.flex = '0 0 auto'
    meta.textContent = options.meta
    row.appendChild(meta)
  }

  if (editing) {
    // Confirm and cancel take the place of the row's own actions while renaming, so the row never
    // offers two different things to do with the same click.
    const group = document.createElement('span')
    group.className = 'flex items-center gap-0.5'
    group.style.flex = '0 0 auto'
    const commit = (): void => {
      const value = input.value.trim()
      renaming = null
      if (value !== '' && value !== options.name) options.onRename?.(value)
      else options.rerender()
    }
    const cancel = (): void => {
      renaming = null
      options.rerender()
    }
    for (const [glyphName, label, run] of [
      ['check', 'Save', commit],
      ['close', 'Cancel', cancel],
    ] as ReadonlyArray<readonly [IconName, string, () => void]>) {
      const button = document.createElement('button')
      button.className = 'btn btn-ghost btn-xs btn-circle'
      button.title = label
      button.setAttribute('aria-label', label)
      button.appendChild(icon(glyphName, 'size-4'))
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        run()
      })
      group.appendChild(button)
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') commit()
      if (event.key === 'Escape') cancel()
    })
    row.appendChild(group)
  } else if (options.actions !== undefined && options.actions.length > 0) {
    const group = document.createElement('span')
    group.className = 'wts-actions flex items-center gap-0.5'
    group.style.flex = '0 0 auto'
    for (const action of options.actions) {
      const button = document.createElement('button')
      button.className = 'btn btn-ghost btn-xs btn-circle'
      button.title = action.label
      button.setAttribute('aria-label', action.label)
      button.appendChild(icon(action.icon, 'size-4'))
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        action.run()
      })
      group.appendChild(button)
    }
    row.appendChild(group)
  }

  const check = document.createElement('input')
  check.type = 'checkbox'
  check.className = 'checkbox checkbox-sm'
  check.style.flex = '0 0 auto'
  check.checked = options.checked ?? isEnabled(options.key)
  check.setAttribute('aria-label', `Show ${options.name}`)
  check.addEventListener('click', (event) => event.stopPropagation())
  check.addEventListener('change', () => {
    if (options.onToggleChecked !== undefined) {
      options.onToggleChecked(check.checked)
      return
    }
    toggle(disabled, options.key)
    options.rerender()
  })
  row.appendChild(check)

  const expand = (): void => {
    toggle(collapsed, options.key)
    options.rerender()
  }
  if (!editing) row.addEventListener('click', expand)
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      expand()
    }
  })

  if (options.onContextMenu !== undefined) {
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      options.onContextMenu?.(event)
    })
  }

  if (!draggable || editing) return row

  row.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData('text/plain', options.key)
    // Take the row out of the flow, so what is on screen is the drag image plus the hole it will
    // land in — nothing else. Leaving it in place at reduced opacity reads as a duplicate, and
    // every row below shifts as the placeholder is inserted.
    //
    // Deferred by a tick because the browser captures the drag image *after* dragstart returns;
    // hiding it synchronously would drag an invisible ghost.
    setTimeout(() => row.classList.add('wts-dragging'), 0)
  })
  row.addEventListener('dragend', () => {
    row.classList.remove('wts-dragging')
    clearDropMarks(row.parentElement ?? document)
  })
  row.addEventListener('dragover', (event) => {
    event.preventDefault()
    const parent = row.parentElement
    if (parent === null) return
    const box = row.getBoundingClientRect()
    const offset = (event.clientY - box.top) / box.height
    // The middle third of a container means "into"; the outer thirds mean "between".
    const into =
      options.container && options.onDropInto !== undefined && offset > 0.3 && offset < 0.7
    clearDropMarks(parent)
    if (into) {
      row.classList.add('wts-drop-into')
      return
    }
    parent.insertBefore(placeholder(), offset < 0.5 ? row : row.nextSibling)
  })
  row.addEventListener('drop', (event) => {
    event.preventDefault()
    const parent = row.parentElement
    const from = event.dataTransfer?.getData('text/plain')
    const into = row.classList.contains('wts-drop-into')
    if (parent !== null) clearDropMarks(parent)
    if (from === undefined || from === '' || from === options.key) return
    if (into) {
      options.onDropInto?.(from)
      return
    }
    const box = row.getBoundingClientRect()
    moveKey(options.siblings, from, options.key, event.clientY > box.top + box.height / 2)
    options.rerender()
  })

  return row
}

const childText = (text: string, depth: number): HTMLElement => {
  const el = document.createElement('p')
  el.className = 'text-xs opacity-60'
  el.style.padding = '0.125rem 0.75rem 0.375rem'
  el.style.paddingLeft = `${2.5 + depth * 1.125}rem`
  el.textContent = text
  return el
}

export const treeContents = (callbacks: TreeCallbacks, rerender: () => void): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.setAttribute('role', 'tree')
  wrap.className = 'flex flex-col'
  // Breathing room between rows, and between the first row and the search field above it.
  wrap.style.gap = '0.125rem'
  wrap.style.paddingTop = '0.5rem'
  wrap.style.paddingBottom = '0.5rem'

  const servers = getState().servers
  const keys = ['local', ...servers.map((server) => `server:${server.url}`)]
  const ordered = orderedKeys(keys)

  for (const key of ordered) {
    const server = servers.find((candidate) => `server:${candidate.url}` === key)
    const isLocal = key === 'local'
    if (!isLocal && server === undefined) continue

    const target: TreeTarget = {
      server: server ?? null,
      nodeId: null,
      key,
      name: isLocal ? 'Local' : (server?.info?.name ?? server?.url ?? ''),
    }
    // Only where the code can actually act. Offering create to someone who will only ever get a
    // 403 is worse than not offering it — Local always can, since nothing gates it.
    const canEdit = isLocal || (server?.isAdmin ?? false)

    wrap.appendChild(
      treeRow({
        key,
        name: target.name,
        // A rack and a folder are different things and read differently at a glance.
        kind: isLocal ? 'folder' : 'server',
        depth: 0,
        container: true,
        siblings: ordered,
        rerender,
        onContextMenu: canEdit ? (event) => callbacks.onContextMenu(target, event) : undefined,
        onRename: canEdit ? (value) => callbacks.onRename(target, value) : undefined,
        actions: canEdit
          ? [
              {
                icon: 'createFolder',
                label: 'New folder',
                run: () => callbacks.onCreateFolder(target),
              },
              {
                icon: 'uploadFile',
                label: 'Import template',
                run: () => callbacks.onImportTemplate(target),
              },
            ]
          : undefined,
      }),
    )
    if (!isExpanded(key)) continue

    if (server !== undefined && server.status === 'connected') {
      const known = nodesByServer.get(server.url)
      if (known === undefined) {
        // First sight of this server: kick off the fetch, draw nothing extra this pass.
        void refreshNodes(server, rerender)
      } else {
        const byParent = new Map<string | null, TreeNode[]>()
        for (const node of known) {
          const siblings = byParent.get(node.parentId) ?? []
          siblings.push(node)
          byParent.set(node.parentId, siblings)
        }
        const renderChildren = (parentId: string | null, depth: number): void => {
          for (const node of byParent.get(parentId) ?? []) {
            const nodeKey = `node:${node.id}`
            const nodeTarget: TreeTarget = {
              server,
              nodeId: node.id,
              key: nodeKey,
              name: node.name,
            }
            wrap.appendChild(
              treeRow({
                key: nodeKey,
                name: node.name,
                kind: 'folder',
                depth,
                container: true,
                siblings: (byParent.get(parentId) ?? []).map((n) => `node:${n.id}`),
                rerender,
                onContextMenu: canEdit
                  ? (event) => callbacks.onContextMenu(nodeTarget, event)
                  : undefined,
                onRename: canEdit ? (value) => callbacks.onRename(nodeTarget, value) : undefined,
                actions: canEdit
                  ? [
                      {
                        icon: 'createFolder',
                        label: 'New folder',
                        run: () => callbacks.onCreateFolder(nodeTarget),
                      },
                      {
                        icon: 'uploadFile',
                        label: 'Import template',
                        run: () => callbacks.onImportTemplate(nodeTarget),
                      },
                    ]
                  : undefined,
              }),
            )
            if (isExpanded(nodeKey)) renderChildren(node.id, depth + 1)
          }
        }
        renderChildren(null, 1)
        if (known.length === 0) wrap.appendChild(childText('No templates published yet.', 0))
        continue
      }
    }

    if (isLocal) {
      const mine = localTemplates()
      const folders = getState().localFolders

      /** Templates sitting directly in one folder, or at the top of Local when null. */
      const templatesIn = (folderId: string | null): readonly PlacedTemplate[] =>
        mine.filter((template) => (template.folderId ?? null) === folderId)
      const foldersIn = (parentId: string | null): readonly LocalFolder[] =>
        folders.filter((folder) => folder.parentId === parentId)

      const templateRow = (
        template: PlacedTemplate,
        depth: number,
        siblings: readonly string[],
      ): HTMLElement => {
        const key = `local:${template.id}`
        const templateTarget: TreeTarget = {
          server: null,
          nodeId: null,
          key,
          name: template.name,
        }
        return treeRow({
          key,
          name: template.name,
          kind: 'image',
          depth,
          meta: `${template.width}×${template.height}`,
          container: false,
          siblings,
          rerender,
          checked: template.visible,
          onToggleChecked: (on) => {
            setLocalVisible(template.id, on)
            rerender()
          },
          onContextMenu: (event) => callbacks.onContextMenu(templateTarget, event),
          onRename: (value) => callbacks.onRename(templateTarget, value),
          // Only the two that are safe to hit by accident on a hover target. Move takes over the
          // canvas and Remove destroys the template, so both live in the right-click menu and in
          // the template's own menu on the canvas, where reaching them is deliberate.
          actions: [
            { icon: 'search', label: 'Go to', run: () => callbacks.onGoTo(template.id) },
            {
              icon: 'uploadFile',
              label: 'Copy to a server',
              run: () => callbacks.onCopyToServer(template.id),
            },
          ],
        })
      }

      /**
       * Folders, then the templates beside them, at every level.
       *
       * Folders first rather than interleaved: a folder is a place to go and a template is a thing
       * to look at, and mixing them means hunting for the one you want among rows that behave
       * differently when clicked.
       */
      const renderLocal = (parentId: string | null, depth: number): void => {
        const childFolders = foldersIn(parentId)
        const folderKeys = childFolders.map((folder) => `lf:${folder.id}`)
        for (const folder of childFolders) {
          const key = `lf:${folder.id}`
          const folderTarget: TreeTarget = {
            server: null,
            nodeId: null,
            key,
            name: folder.name,
          }
          wrap.appendChild(
            treeRow({
              key,
              name: folder.name,
              kind: 'folder',
              depth,
              container: true,
              siblings: folderKeys,
              rerender,
              onContextMenu: (event) => callbacks.onContextMenu(folderTarget, event),
              onRename: (value) => callbacks.onRename(folderTarget, value),
              // Dropping onto a folder files the dragged row inside it. Both a template and another
              // folder can go in; the move is refused only when it would put a folder inside itself.
              onDropInto: (draggedKey) => {
                callbacks.onMoveIntoLocalFolder(draggedKey, folder.id)
                rerender()
              },
              actions: [
                {
                  icon: 'createFolder',
                  label: 'New folder',
                  run: () => callbacks.onCreateFolder(folderTarget),
                },
                {
                  icon: 'uploadFile',
                  label: 'Import template',
                  run: () => callbacks.onImportTemplate(folderTarget),
                },
              ],
            }),
          )
          if (isExpanded(key)) renderLocal(folder.id, depth + 1)
        }
        const here = templatesIn(parentId)
        const keys = here.map((template) => `local:${template.id}`)
        for (const template of here) wrap.appendChild(templateRow(template, depth, keys))
        if (parentId !== null && childFolders.length === 0 && here.length === 0) {
          wrap.appendChild(childText('Empty.', depth))
        }
      }

      renderLocal(null, 1)
      if (mine.length === 0) wrap.appendChild(childText('No local templates yet.', 0))
      // The hover action exists too, but an empty state is where someone is actually looking for
      // the way in, so it gets a visible button.
      const actions = document.createElement('div')
      actions.style.padding = '0 0.75rem 0.5rem 2.25rem'
      const importButton = document.createElement('button')
      importButton.className = 'btn btn-xs'
      importButton.textContent = 'Import a template'
      importButton.title = 'A .wplace file, a Blue Marble export, or an image'
      importButton.addEventListener('click', () =>
        callbacks.onImportTemplate({ server: null, nodeId: null, key: 'local', name: 'Local' }),
      )
      actions.appendChild(importButton)
      wrap.appendChild(actions)
      continue
    }
    if (server === undefined) continue
    // No badge for a healthy server: if it is in the list at all, it is connected. Only trouble
    // needs saying, and it says it in words where there is room for them.
    if (server.status === 'connected') {
      wrap.appendChild(childText('No templates published yet.', 0))
    } else if (server.status === 'needs-token') {
      wrap.appendChild(childText('Needs an access code — add it in settings.', 0))
    } else {
      wrap.appendChild(childText(`Could not be reached. ${server.error ?? ''}`.trim(), 0))
    }
  }

  const addWrap = document.createElement('div')
  addWrap.className = 'flex justify-center'
  addWrap.style.padding = '0.5rem 0.75rem 0'
  const add = document.createElement('button')
  add.className = 'btn btn-sm btn-ghost'
  add.appendChild(icon('extension', 'size-4 opacity-60'))
  const addText = document.createElement('span')
  addText.textContent = servers.length === 0 ? 'Add a server' : 'Add another server'
  add.appendChild(addText)
  add.addEventListener('click', callbacks.onAddServer)
  addWrap.appendChild(add)
  wrap.appendChild(addWrap)

  return wrap
}
