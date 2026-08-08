import { cacheServer, loadServerCache, type ServerTemplate } from '../server-cache.js'
import {
  type ConnectedServer,
  getState,
  isScopeVisible,
  type LocalFolder,
  listServerContents,
  setLocalFolderVisible,
  setScopeVisible,
  setState,
  type TreeNode,
} from '../state.js'
import {
  isServerTemplate,
  localTemplates,
  type PlacedTemplate,
  setLocalVisible,
} from '../templates/local-store.js'
import { serverTemplateKey, syncServerTemplates } from '../templates/server-sync.js'
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
  /**
   * Set when the row is a template published on a server, rather than a folder.
   *
   * The two need telling apart because every action means something different on each: renaming a
   * folder rewrites the paths of everything beneath it, renaming a template is one column. Before
   * this, `server !== null` was enough to mean "a folder on a server", and adding template rows is
   * what stopped that being true.
   */
  readonly templateId?: string
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
  /** Move a dragged Local row to a place in the tree: a container, and the key it goes before. */
  readonly onMoveLocal: (
    draggedKey: string,
    parentKey: string | null,
    beforeKey: string | null,
  ) => void
  /**
   * Something was dropped onto a server's folder.
   *
   * One callback for three journeys, because they are one gesture: a Local template lands as an
   * upload, a template already on this server is refiled, and one from another server moves across.
   * Which of those it is comes from the dragged key, not from the caller.
   */
  readonly onDropOnNode: (target: TreeTarget, draggedKey: string) => void
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

/** Templates per server, from the manifest, on the same terms as the nodes above. */
const templatesByServer = new Map<string, readonly ServerTemplate[]>()

/**
 * Which server holds a template, given only its id.
 *
 * A drag carries one string, and a template row's key is `st:<id>` — so a drop has the template but
 * not where it came from, and a cross-server move needs both ends. Ids are UUIDv7 and unique across
 * servers in practice, so the first match is the right one.
 */
export const findServerTemplate = (
  id: string,
): { serverUrl: string; template: ServerTemplate } | null => {
  for (const [serverUrl, templates] of templatesByServer) {
    const template = templates.find((candidate) => candidate.id === id)
    if (template !== undefined) return { serverUrl, template }
  }
  return null
}

/**
 * What a server last said about one template, for whoever is acting on a row.
 *
 * Read from the same cache the row was drawn from, so a menu can never offer "Unpublish" on a row
 * drawn as unpublished — the two would otherwise be answering from different copies.
 */
export const serverTemplateAt = (serverUrl: string, id: string): ServerTemplate | null =>
  templatesByServer.get(serverUrl)?.find((template) => template.id === id) ?? null

/**
 * Re-read what a server publishes: its folders and the templates under them.
 *
 * **Not gated on admin.** The tree is what a read code is for — seeing what the alliance is
 * building. Only *changing* it is privileged, and that boundary is drawn per row by `canEdit`.
 * Refusing to fetch here left every member looking at a connected server with nothing under it.
 *
 * Both in one call, from the manifest, which is also the only way they can agree: a template row is
 * drawn under its folder, so fetching one without the other puts templates under folders that are
 * not there, or leaves a folder claiming to be empty a moment after something landed in it.
 */
export const refreshNodes = async (
  server: ConnectedServer,
  rerender: () => void,
): Promise<void> => {
  const { nodes, templates } = await listServerContents(server)
  nodesByServer.set(server.url, nodes)
  templatesByServer.set(server.url, templates)
  void cacheServer({ url: server.url, nodes, templates, fetchedAt: Date.now() })
  rerender()
  // Every caller of this is a mutation that just landed — a publish, an upload, a delete. Waiting
  // out the poll to see it on the canvas would make each of those feel like it had not worked.
  void syncServerTemplates(server)
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
    if (!templatesByServer.has(entry.url) && entry.templates !== undefined) {
      templatesByServer.set(entry.url, entry.templates)
    }
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

/**
 * Put `key` immediately before `beforeKey` in the custom order, or last when that is null.
 *
 * One flat list across the whole tree, because each level only ever sorts among its own children —
 * a key's rank is meaningless outside its parent, so the lists cannot interfere.
 */
export const placeKey = (key: string, beforeKey: string | null): void => {
  const next = getState().customOrder.filter((candidate) => candidate !== key)
  const index = beforeKey === null ? -1 : next.indexOf(beforeKey)
  if (index === -1) next.push(key)
  else next.splice(index, 0, key)
  setState({ customOrder: next })
}

const moveKey = (keys: readonly string[], from: string, to: string, after: boolean): void => {
  const next = keys.filter((key) => key !== from)
  const index = next.indexOf(to)
  if (index === -1) return
  next.splice(after ? index + 1 : index, 0, from)
  setState({ customOrder: next })
}

/**
 * Where a drop would land: a container and the key it goes before, `null` meaning last.
 *
 * Held at module level rather than recomputed on `drop`, because the drop may not land on the row
 * that computed it — the placeholder itself is a drop target, and it sits *between* rows. The rule
 * is that whatever the outline shows is what happens, so the outline's own position is the answer
 * and the drop only has to read it.
 */
/** The row being dragged, and the container it came from — needed to police reparenting. */
let dragging: { key: string; parentKey: string | null } | null = null

let dropTarget: {
  readonly parentKey: string | null
  readonly beforeKey: string | null
  readonly apply: (draggedKey: string, parentKey: string | null, beforeKey: string | null) => void
  readonly rerender: () => void
} | null = null

/** Held open where the dragged row would land — a hole says "here"; a line only says "near here". */
const placeholder = (depth: number): HTMLElement => {
  const el = document.createElement('div')
  el.className = 'wts-placeholder'
  el.dataset.wtsPlaceholder = ''
  // Indented to the level it would land at, so the outline says *where* and not merely *between
  // which two rows* — the two differ exactly when the drop would change a row's parent.
  el.style.marginLeft = `${0.25 + depth * 1.125}rem`
  // The outline accepts the drop itself. Aiming at a gap and having to hit a row instead is the
  // thing that made filing into a folder feel like a trick — and a `dragover` alone was not enough,
  // since a drop landing here bubbled past every row's handler and was simply lost.
  el.addEventListener('dragover', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  el.addEventListener('drop', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const target = dropTarget
    const from = event.dataTransfer?.getData('text/plain')
    clearDropMarks(el.parentElement ?? document)
    dropTarget = null
    dragging = null
    if (target === null || from === undefined || from === '' || from === target.beforeKey) return
    target.apply(from, target.parentKey, target.beforeKey)
    target.rerender()
  })
  return el
}

/** Rows in document order, ignoring the one being dragged and the placeholder. */
const visibleRows = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('[data-wts-key]')].filter(
    (row) => !row.classList.contains('wts-dragging'),
  )

/**
 * Resolve a pointer position over one row into a place in the tree.
 *
 * Above the midpoint means "before this row", at this row's own level. Below means "after", and
 * after is where the interesting case is: the row following an **expanded** container is its first
 * child, so landing after it means landing *inside* it, while after a **collapsed** container means
 * beside it. That is what the rows look like on screen, so it is what the drop does — no separate
 * "middle third means into" gesture to discover, and no way to aim at a gap and be refused.
 */
const resolveDrop = (
  row: HTMLElement,
  clientY: number,
): {
  parentKey: string | null
  beforeKey: string | null
  depth: number
  /** Where to insert the outline. Null appends, which is what "last in this list" means. */
  before: Element | null
} => {
  const box = row.getBoundingClientRect()
  const above = clientY < box.top + box.height / 2
  const depth = Number(row.dataset.wtsDepth ?? 0)
  const parentKey = row.dataset.wtsParent ?? null
  const key = row.dataset.wtsKey ?? null

  if (above) return { parentKey, beforeKey: key, depth, before: row }

  const isContainer = row.dataset.wtsContainer !== undefined
  const expanded = key !== null && isExpanded(key)
  const next = row.nextElementSibling
  if (isContainer && expanded) {
    // Into it, ahead of whatever it already holds.
    const firstChild = next instanceof HTMLElement ? (next.dataset.wtsKey ?? null) : null
    return {
      parentKey: key,
      beforeKey: firstChild,
      depth: depth + 1,
      before: next,
    }
  }
  // Beside it. Skip over anything nested under this row so "after" means after its whole subtree.
  let cursor: Element | null = next
  while (cursor instanceof HTMLElement && Number(cursor.dataset.wtsDepth ?? 0) > depth) {
    cursor = cursor.nextElementSibling
  }
  const beforeKey = cursor instanceof HTMLElement ? (cursor.dataset.wtsKey ?? null) : null
  return { parentKey, beforeKey, depth, before: cursor }
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
  /** The row this one sits under, so a drop can resolve to a place in the tree rather than a row. */
  readonly parentKey?: string | null | undefined
  /**
   * Whether a drop here may change the dragged row's parent.
   *
   * False leaves reordering intact but refuses any move that would file something somewhere else.
   * Order is a local preference and always the user's to set; where a template *lives* is shared
   * structure, and only an admin may rearrange that.
   */
  readonly canReparent?: boolean | undefined
  /** Dimmed, for a row that exists but is not doing anything yet — an unpublished template. */
  readonly muted?: boolean | undefined
  readonly actions?: ReadonlyArray<{ icon: IconName; label: string; run: () => void }> | undefined
  /** Present only where the user can actually change things; absent means no rename affordance. */
  readonly onRename?: ((name: string) => void) | undefined
  readonly onContextMenu?: ((event: MouseEvent) => void) | undefined
  readonly siblings: readonly string[]
  readonly rerender: () => void
  readonly onDropInto?: ((draggedKey: string) => void) | undefined
  /**
   * Drop resolved to a position: which container it lands in, and which key it lands before.
   *
   * Supersedes `onDropInto` where it is provided. A tree move is a parent *and* an index — offering
   * only "into this container" forced everything to the end of the list, and offering only
   * "before/after this row" could never change a row's parent.
   */
  readonly onDropAt?:
    | ((draggedKey: string, parentKey: string | null, beforeKey: string | null) => void)
    | undefined
  /** When present, the row reflects this instead of the tree's own disabled set. */
  readonly checked?: boolean | undefined
  readonly onToggleChecked?: ((on: boolean) => void) | undefined
}

const treeRow = (options: RowOptions): HTMLElement => {
  const draggable = isReorderable(getState().sort)
  const row = document.createElement('div')
  row.className = 'wts-row flex items-center gap-1'
  row.dataset.wtsKey = options.key
  if (options.parentKey !== undefined && options.parentKey !== null) {
    row.dataset.wtsParent = options.parentKey
  }
  row.dataset.wtsDepth = String(options.depth)
  if (options.container) row.dataset.wtsContainer = ''
  row.style.padding = '0.25rem 0.5rem'
  // One indent step per level, on top of the fixed gutter.
  row.style.marginLeft = `${0.25 + options.depth * 1.125}rem`
  row.style.marginRight = '0.5rem'
  row.style.minHeight = '2rem'
  if (options.muted === true) row.style.opacity = '0.55'
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
    dragging = { key: options.key, parentKey: options.parentKey ?? null }
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
    dropTarget = null
    dragging = null
  })
  row.addEventListener('dragover', (event) => {
    event.preventDefault()
    const parent = row.parentElement
    if (parent === null) return
    clearDropMarks(parent)

    const place = options.onDropAt
    if (place === undefined) {
      // Rows without a position handler still reorder among their own siblings, which is all a
      // server's nodes can do until there is an endpoint for moving one.
      const box = row.getBoundingClientRect()
      const offset = (event.clientY - box.top) / box.height
      const into =
        options.container && options.onDropInto !== undefined && offset > 0.3 && offset < 0.7
      if (into) {
        row.classList.add('wts-drop-into')
        return
      }
      parent.insertBefore(placeholder(options.depth), offset < 0.5 ? row : row.nextSibling)
      return
    }

    const resolved = resolveDrop(row, event.clientY)
    // Reordering is ours to do — it is a client-side preference. Changing a row's *parent* is a
    // change to the shared structure, so without the right to make it the drop is simply not
    // offered: no outline appears, which reads as "not there" without needing to say so.
    if (
      options.canReparent !== true &&
      dragging !== null &&
      resolved.parentKey !== dragging.parentKey
    ) {
      return
    }
    dropTarget = {
      parentKey: resolved.parentKey,
      beforeKey: resolved.beforeKey,
      apply: place,
      rerender: options.rerender,
    }
    parent.insertBefore(placeholder(resolved.depth), resolved.before)
  })
  row.addEventListener('drop', (event) => {
    event.preventDefault()
    const parent = row.parentElement
    const from = event.dataTransfer?.getData('text/plain')
    const into = row.classList.contains('wts-drop-into')
    const target = dropTarget
    if (parent !== null) clearDropMarks(parent)
    dropTarget = null
    if (from === undefined || from === '') return

    if (target !== null) {
      // Whatever the outline showed, including a drop that landed on the outline itself.
      if (from === target.beforeKey) return
      target.apply(from, target.parentKey, target.beforeKey)
      target.rerender()
      return
    }
    if (from === options.key) return
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
        // A category is a group like a folder is: switching it off takes everything under it off
        // the canvas, and leaves every row inside saying exactly what it said before.
        checked: isScopeVisible(key),
        onToggleChecked: (on) => {
          setScopeVisible(key, on)
          rerender()
        },
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
        const published = templatesByServer.get(server.url) ?? []
        const templatesIn = (nodeId: string): readonly ServerTemplate[] =>
          published.filter((template) => template.nodeId === nodeId)

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
                // Dropping onto a folder files a template into it: a local one is uploaded here, a
                // template already on this server is moved, and one from another server crosses
                // over. The dedicated buttons still exist — this is the shortcut, not the only way.
                onDropInto: canEdit
                  ? (draggedKey) => callbacks.onDropOnNode(nodeTarget, draggedKey)
                  : undefined,
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
            if (!isExpanded(nodeKey)) continue
            renderChildren(node.id, depth + 1)
            for (const template of templatesIn(node.id)) {
              const templateKey = `st:${template.id}`
              // The copy on the canvas, if the sync has fetched it yet. Absent means the row is
              // drawn from the manifest alone — which is the right first frame, since the manifest
              // arrives long before the chunks do.
              const drawn = localTemplates().find(
                (candidate) => candidate.id === serverTemplateKey(server.url, template.id),
              )
              const templateTarget: TreeTarget = {
                server,
                nodeId: node.id,
                key: templateKey,
                name: template.name,
                templateId: template.id,
              }
              wrap.appendChild(
                treeRow({
                  key: templateKey,
                  name: template.name,
                  // The same glyph a Local template row wears: it is the same kind of thing, and
                  // where it lives is said by the tree rather than by the icon.
                  kind: 'image',
                  depth: depth + 1,
                  container: false,
                  siblings: templatesIn(node.id).map((candidate) => `st:${candidate.id}`),
                  rerender,
                  // Unpublished ones are visible to an admin and nobody else, so they have to look
                  // different — otherwise the tree shows a template that members cannot see and
                  // gives no hint why.
                  muted: !template.published,
                  ...(template.published ? {} : { meta: 'unpublished' }),
                  // Drafts draw too — for the admin who can see them, which is the only person the
                  // manifest lists them for — so they get the same switch as anything else.
                  checked: drawn?.visible ?? false,
                  onToggleChecked: (on: boolean) => {
                    if (drawn !== undefined) setLocalVisible(drawn.id, on)
                    rerender()
                  },
                  onContextMenu: canEdit
                    ? (event) => callbacks.onContextMenu(templateTarget, event)
                    : undefined,
                  onRename: canEdit
                    ? (value) => callbacks.onRename(templateTarget, value)
                    : undefined,
                }),
              )
            }
          }
        }
        renderChildren(null, 1)
        if (known.length === 0) wrap.appendChild(childText('No templates published yet.', 0))
        continue
      }
    }

    if (isLocal) {
      // Local means "only in this browser". Server templates share the store — everything that
      // draws them takes a `PlacedTemplate` and does not care where it came from — but they are
      // listed under the server publishing them, not here.
      const mine = localTemplates().filter((template) => !isServerTemplate(template))
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
        parentKey: string,
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
          parentKey,
          canReparent: true,
          siblings,
          rerender,
          onDropAt: callbacks.onMoveLocal,
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
       * One ordered list per level, folders and templates together.
       *
       * Not folders-first. Sorting by kind means a template can never be put above a folder, and the
       * order someone drags things into is the whole point of a custom order — a rule that quietly
       * overrides it makes the drag look broken rather than constrained.
       */
      const renderLocal = (parentId: string | null, depth: number, parentKey: string): void => {
        const childFolders = foldersIn(parentId)
        const childTemplates = templatesIn(parentId)
        const byKey = new Map<string, LocalFolder | PlacedTemplate>()
        for (const folder of childFolders) byKey.set(`lf:${folder.id}`, folder)
        for (const template of childTemplates) byKey.set(`local:${template.id}`, template)
        const keys = orderedKeys([...byKey.keys()])

        for (const key of keys) {
          const item = byKey.get(key)
          if (item === undefined) continue

          if (key.startsWith('lf:')) {
            const folder = item as LocalFolder
            const folderTarget: TreeTarget = { server: null, nodeId: null, key, name: folder.name }
            wrap.appendChild(
              treeRow({
                key,
                name: folder.name,
                kind: 'folder',
                depth,
                container: true,
                parentKey,
                canReparent: true,
                siblings: keys,
                rerender,
                checked: folder.visible,
                onToggleChecked: (on) => {
                  setLocalFolderVisible(folder.id, on)
                  rerender()
                },
                onContextMenu: (event) => callbacks.onContextMenu(folderTarget, event),
                onRename: (value) => callbacks.onRename(folderTarget, value),
                onDropAt: callbacks.onMoveLocal,
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
            if (isExpanded(key)) renderLocal(folder.id, depth + 1, key)
            continue
          }

          wrap.appendChild(templateRow(item as PlacedTemplate, depth, keys, parentKey))
        }

        if (parentId !== null && keys.length === 0) wrap.appendChild(childText('Empty.', depth))
      }

      renderLocal(null, 1, 'local')
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
