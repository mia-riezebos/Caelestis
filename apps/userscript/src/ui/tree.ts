import { cacheServer, loadServerCache } from '../server-cache.js'
import {
  type ConnectedServer,
  getState,
  listNodes,
  removeCustomOrderKeys,
  setState,
  type TreeNode,
  takeProbedNodes,
} from '../state.js'
import { localTemplates, setLocalVisible } from '../templates/local-store.js'
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
  readonly onCopyToServer: (templateId: string) => void
  readonly onError: (message: string) => void
}

const collapsed = new Set<string>()
/** The row currently being renamed, if any. Inline editing beats a modal for a one-field change. */
let renaming: string | null = null
let renameDraft: { readonly key: string; value: string } | null = null
const TREE_DRAG_TYPE = 'application/x-caelestis-tree-key'
const MAX_RENDERED_ROWS = 2_000
const MAX_TOTAL_SERVER_NODES = 100_000

/**
 * Nodes per server, fetched once and refreshed on demand.
 *
 * Rendering happens synchronously, so the tree draws what it has and fills in when the fetch lands.
 * A server with no nodes yet and a server whose nodes have not arrived look the same for a moment,
 * which is the right trade against blocking the whole panel on a network call.
 */
interface ServerTree {
  readonly serverId: string
  readonly season: number
  readonly nodes: readonly TreeNode[]
}

const nodesByServer = new Map<string, ServerTree>()
const refreshGeneration = new Map<string, number>()
const refreshedConnections = new WeakSet<ConnectedServer>()
export type NodeRefreshResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }
const refreshes = new WeakMap<ConnectedServer, Promise<NodeRefreshResult>>()

const serverIdentity = (server: ConnectedServer): string | null =>
  server.info === null || server.season === null ? null : `${server.info.id}:${server.season}`

const treeFor = (server: ConnectedServer): readonly TreeNode[] | undefined => {
  const identity = serverIdentity(server)
  const entry = nodesByServer.get(server.url)
  return identity !== null &&
    entry !== undefined &&
    `${entry.serverId}:${entry.season}` === identity
    ? entry.nodes
    : undefined
}

export const nodeTreeKey = (server: ConnectedServer, nodeId: string): string =>
  `node:${server.info?.id ?? server.url}:${server.season ?? 'unknown'}:${nodeId}`

export const forgetServerTree = (url: string): void => {
  const entry = nodesByServer.get(url)
  const keys = new Set([`server:${url}`])
  if (entry !== undefined) {
    for (const node of entry.nodes) {
      keys.add(`node:${entry.serverId}:${entry.season}:${node.id}`)
      keys.add(`node:${node.id}`)
    }
  }
  removeCustomOrderKeys(keys)
  nodesByServer.delete(url)
  refreshGeneration.delete(url)
}

export const forgetNodeOrder = (server: ConnectedServer, nodeId: string): void => {
  const nodes = treeFor(server) ?? []
  const children = new Map<string, string[]>()
  for (const node of nodes) {
    if (node.parentId === null) continue
    const bucket = children.get(node.parentId) ?? []
    bucket.push(node.id)
    children.set(node.parentId, bucket)
  }
  const pending = [nodeId]
  const keys = new Set<string>()
  while (pending.length > 0) {
    const id = pending.pop()
    if (id === undefined || keys.has(nodeTreeKey(server, id))) continue
    keys.add(nodeTreeKey(server, id))
    keys.add(`node:${id}`)
    pending.push(...(children.get(id) ?? []))
  }
  removeCustomOrderKeys(keys)
}

export const refreshNodes = async (
  server: ConnectedServer,
  rerender: () => void,
  force = false,
): Promise<NodeRefreshResult> => {
  if (!server.isAdmin) return { ok: false, message: 'Admin access is required to refresh folders.' }
  const existing = refreshes.get(server)
  if (!force && existing !== undefined) {
    const result = await existing
    queueMicrotask(rerender)
    return result
  }
  const generation = (refreshGeneration.get(server.url) ?? 0) + 1
  refreshGeneration.set(server.url, generation)
  const loading = Promise.resolve().then(async (): Promise<NodeRefreshResult> => {
    const probed = takeProbedNodes(server)
    const result =
      probed === undefined ? await listNodes(server) : { ok: true as const, nodes: probed }
    refreshedConnections.add(server)
    if (getState().servers.find((candidate) => candidate.url === server.url) !== server) {
      return { ok: false, message: 'The server connection changed during refresh.' }
    }
    if (refreshGeneration.get(server.url) !== generation) {
      return { ok: false, message: 'A newer folder refresh replaced this one.' }
    }
    if (!result.ok) return result
    const identity = serverIdentity(server)
    if (identity === null || server.info === null || server.season === null) {
      return { ok: false, message: 'The server identity is unavailable.' }
    }
    let retainedNodes = 0
    for (const [url, entry] of nodesByServer) {
      if (url !== server.url) retainedNodes += entry.nodes.length
    }
    if (retainedNodes + result.nodes.length > MAX_TOTAL_SERVER_NODES) {
      return {
        ok: false,
        message: `Connected server folders exceed the ${MAX_TOTAL_SERVER_NODES.toLocaleString()}-node client limit.`,
      }
    }
    nodesByServer.set(server.url, {
      serverId: server.info.id,
      season: server.season,
      nodes: result.nodes,
    })
    void cacheServer({
      url: server.url,
      serverId: server.info.id,
      season: server.season,
      nodes: result.nodes,
      fetchedAt: Date.now(),
    })
    return { ok: true }
  })
  refreshes.set(server, loading)
  const result = await loading
  if (refreshes.get(server) === loading) refreshes.delete(server)
  queueMicrotask(rerender)
  return result
}

/**
 * Draw what a server said last time, immediately, before anything is fetched.
 *
 * Without it the tree is empty on every page load until each server answers, which is the wrong
 * first impression and gets worse the more servers are connected.
 */
export const primeFromCache = async (rerender: () => void): Promise<void> => {
  const configured = getState().servers.map((server) => server.url)
  for (const entry of await loadServerCache(configured)) {
    const server = getState().servers.find((candidate) => candidate.url === entry.url)
    if (
      server?.info?.id !== entry.serverId ||
      server.season !== entry.season ||
      nodesByServer.has(entry.url)
    ) {
      continue
    }
    let retainedNodes = 0
    for (const [url, retained] of nodesByServer) {
      if (url !== entry.url) retainedNodes += retained.nodes.length
    }
    if (retainedNodes + entry.nodes.length > MAX_TOTAL_SERVER_NODES) continue
    nodesByServer.set(entry.url, entry)
  }
  rerender()
}

export const startRenaming = (key: string): void => {
  renaming = key
  renameDraft = null
}
export const cancelRenaming = (): void => {
  renaming = null
  renameDraft = null
}
const disabled = new Set<string>()

const isExpanded = (key: string): boolean => !collapsed.has(key)
const isEnabled = (key: string): boolean => !disabled.has(key)
const toggle = (set: Set<string>, key: string): void => {
  if (set.has(key)) set.delete(key)
  else set.add(key)
}

interface OrderedItem {
  readonly key: string
  readonly name: string
}

export const nodeSiblingItems = (
  server: ConnectedServer,
  nodes: readonly TreeNode[],
): ReadonlyArray<OrderedItem & { readonly node: TreeNode }> =>
  nodes.map((node) => ({ key: nodeTreeKey(server, node.id), name: node.name, node }))

const orderedItems = <T extends OrderedItem>(
  items: readonly T[],
  rank: ReadonlyMap<string, number>,
): readonly T[] => {
  if (getState().sort.field === 'name') {
    const direction = getState().sort.direction === 'desc' ? -1 : 1
    return [...items].sort(
      (a, b) => direction * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  }
  const ranked: Array<{ readonly item: T; readonly rank: number }> = []
  const unranked: T[] = []
  for (const item of items) {
    const itemRank = rank.get(item.key)
    if (itemRank === undefined) unranked.push(item)
    else ranked.push({ item, rank: itemRank })
  }
  ranked.sort((a, b) => a.rank - b.rank)
  return [...ranked.map(({ item }) => item), ...unranked]
}

const isTreeDrag = (transfer: DataTransfer | null): boolean =>
  transfer?.types.includes(TREE_DRAG_TYPE) === true

const isTreeKey = (key: string): boolean =>
  key === 'local' ||
  key.startsWith('local:') ||
  key.startsWith('node:') ||
  key.startsWith('server:')

export const reorderedSiblings = (
  keys: readonly string[],
  from: string,
  to: string,
  after: boolean,
): readonly string[] | null => {
  if (!keys.includes(from)) return null
  const next = keys.filter((key) => key !== from)
  const index = next.indexOf(to)
  if (index === -1) return null
  next.splice(after ? index + 1 : index, 0, from)
  return next
}

const moveKey = (keys: readonly string[], from: string, to: string, after: boolean): void => {
  const next = reorderedSiblings(keys, from, to, after)
  if (next === null) return
  const siblings = new Set(keys)
  const current = getState().customOrder
  const firstSibling = current.findIndex((key) => siblings.has(key))
  const retained = current.filter((key) => !siblings.has(key))
  retained.splice(firstSibling === -1 ? retained.length : firstSibling, 0, ...next)
  setState({ customOrder: retained })
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
  if (options.container) row.setAttribute('aria-expanded', String(isExpanded(options.key)))

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
    const startingRename = renameDraft?.key !== options.key
    if (startingRename) renameDraft = { key: options.key, value: options.name }
    input.type = 'text'
    input.dataset.wtsRename = ''
    input.className = 'input input-xs input-bordered'
    input.value = renameDraft?.value ?? options.name
    input.style.flex = '1'
    input.style.minWidth = '0'
    input.addEventListener('click', (event) => event.stopPropagation())
    input.addEventListener('input', () => {
      if (renameDraft?.key === options.key) renameDraft.value = input.value
    })
    row.appendChild(input)
    if (startingRename) {
      requestAnimationFrame(() => {
        input.focus()
        input.select()
      })
    }
  } else {
    name.className = 'wts-name text-sm'
    name.textContent = options.name
    row.appendChild(name)
    // A tooltip that repeats fully visible text is noise; only label what is actually clipped.
    name.addEventListener(
      'pointerenter',
      () => {
        if (name.scrollWidth > name.clientWidth) name.title = options.name
      },
      { once: true },
    )
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
      renameDraft = null
      if (value !== '' && value !== options.name) options.onRename?.(value)
      else options.rerender()
    }
    const cancel = (): void => {
      renaming = null
      renameDraft = null
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
    if (!options.container) return
    toggle(collapsed, options.key)
    options.rerender()
  }
  if (options.container) {
    if (!editing) row.addEventListener('click', expand)
    row.addEventListener('keydown', (event) => {
      if (event.target !== row) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        expand()
      }
    })
  }

  if (options.onContextMenu !== undefined) {
    row.addEventListener('contextmenu', (event) => {
      const target = event.target as { closest?: (selector: string) => Element | null } | null
      if (target?.closest?.('input,[contenteditable="true"]')) {
        return
      }
      event.preventDefault()
      options.onContextMenu?.(event)
    })
  }

  if (!draggable || editing) return row

  let hideTimer: ReturnType<typeof setTimeout> | null = null
  row.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData(TREE_DRAG_TYPE, options.key)
    event.dataTransfer?.setData('text/plain', options.key)
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move'
    // Take the row out of the flow, so what is on screen is the drag image plus the hole it will
    // land in — nothing else. Leaving it in place at reduced opacity reads as a duplicate, and
    // every row below shifts as the placeholder is inserted.
    //
    // Deferred by a tick because the browser captures the drag image *after* dragstart returns;
    // hiding it synchronously would drag an invisible ghost.
    hideTimer = setTimeout(() => {
      hideTimer = null
      row.classList.add('wts-dragging')
    }, 0)
  })
  row.addEventListener('dragend', () => {
    if (hideTimer !== null) clearTimeout(hideTimer)
    hideTimer = null
    row.classList.remove('wts-dragging')
    clearDropMarks(row.parentElement ?? document)
  })
  row.addEventListener('dragover', (event) => {
    if (!isTreeDrag(event.dataTransfer)) return
    event.preventDefault()
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
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
    if (!isTreeDrag(event.dataTransfer)) return
    event.preventDefault()
    const parent = row.parentElement
    const from = event.dataTransfer?.getData(TREE_DRAG_TYPE)
    const into = row.classList.contains('wts-drop-into')
    if (parent !== null) clearDropMarks(parent)
    if (from === undefined || !isTreeKey(from) || from === options.key) return
    if (into) {
      options.onDropInto?.(from)
      return
    }
    if (!options.siblings.includes(from)) return
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

export const treeContents = (
  callbacks: TreeCallbacks,
  rerender: () => void,
  query = '',
  backgroundRerender = rerender,
): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.setAttribute('role', 'tree')
  wrap.className = 'flex flex-col'
  // Breathing room between rows, and between the first row and the search field above it.
  wrap.style.gap = '0.125rem'
  wrap.style.paddingTop = '0.5rem'
  wrap.style.paddingBottom = '0.5rem'

  const servers = getState().servers
  const rank = new Map(getState().customOrder.map((key, index) => [key, index]))
  const ordered = orderedItems(
    [
      { key: 'local', name: 'Local' },
      ...servers.map((server) => ({
        key: `server:${server.url}`,
        name: server.info?.name ?? server.url,
      })),
    ],
    rank,
  ).map((item) => item.key)
  const needle = query.trim().toLocaleLowerCase()

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
        onRename: undefined,
        actions: canEdit
          ? [
              {
                icon: 'createFolder',
                label: 'New folder',
                run: () => callbacks.onCreateFolder(target),
              },
              ...(isLocal
                ? [
                    {
                      icon: 'uploadFile' as const,
                      label: 'Import template',
                      run: () => callbacks.onImportTemplate(target),
                    },
                  ]
                : []),
            ]
          : undefined,
      }),
    )
    if (!isExpanded(key) && needle === '') continue

    if (server !== undefined && server.status === 'connected') {
      const known = treeFor(server)
      if (known === undefined) {
        // First sight of this server: kick off the fetch, draw nothing extra this pass.
        if (!refreshedConnections.has(server)) {
          void refreshNodes(server, backgroundRerender)
        }
      } else {
        if (!refreshedConnections.has(server)) {
          void refreshNodes(server, backgroundRerender)
        }
        const byParent = new Map<string | null, TreeNode[]>()
        for (const node of known) {
          const siblings = byParent.get(node.parentId) ?? []
          siblings.push(node)
          byParent.set(node.parentId, siblings)
        }
        const matches = new Map<string, boolean>()
        const nodeMatches = (node: TreeNode): boolean => {
          const memoised = matches.get(node.id)
          if (memoised !== undefined) return memoised
          if (needle === '' || node.name.toLocaleLowerCase().includes(needle)) return true
          // A provisional value also makes this defensive if an old cache predates validation.
          matches.set(node.id, false)
          const result = (byParent.get(node.id) ?? []).some((child) => nodeMatches(child))
          matches.set(node.id, result)
          return result
        }
        let renderedRows = 0
        const renderChildren = (parentId: string | null, depth: number): void => {
          if (renderedRows >= MAX_RENDERED_ROWS) return
          const siblings = byParent.get(parentId) ?? []
          const orderedSiblings = orderedItems(nodeSiblingItems(server, siblings), rank)
          const siblingKeys = orderedSiblings.map((item) => item.key)
          for (const item of orderedSiblings) {
            if (renderedRows >= MAX_RENDERED_ROWS) break
            const node = item.node
            if (!nodeMatches(node)) continue
            const nodeKey = nodeTreeKey(server, node.id)
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
                siblings: siblingKeys,
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
                    ]
                  : undefined,
              }),
            )
            renderedRows++
            if (isExpanded(nodeKey) || needle !== '') renderChildren(node.id, depth + 1)
          }
        }
        renderChildren(null, 1)
        if (known.length === 0) {
          wrap.appendChild(
            childText(needle === '' ? 'No templates published yet.' : 'No matches.', 0),
          )
        } else if (renderedRows === 0 && needle !== '') {
          wrap.appendChild(childText('No matches.', 0))
        } else if (renderedRows >= MAX_RENDERED_ROWS) {
          wrap.appendChild(
            childText(`Showing the first ${MAX_RENDERED_ROWS.toLocaleString()} matches.`, 0),
          )
        }
        continue
      }
    }

    if (isLocal) {
      const allMine = localTemplates()
      const mine = allMine.filter(
        (template) => needle === '' || template.name.toLocaleLowerCase().includes(needle),
      )
      const orderedMine = orderedItems(
        allMine.map((template) => ({
          key: `local:${template.id}`,
          name: template.name,
          template,
        })),
        rank,
      )
      const localKeys = orderedMine.map((item) => item.key)
      for (const item of orderedMine) {
        const { key, template } = item
        if (needle !== '' && !template.name.toLocaleLowerCase().includes(needle)) continue
        const templateTarget: TreeTarget = {
          server: null,
          nodeId: null,
          key,
          name: template.name,
        }
        const row = treeRow({
          key,
          name: template.name,
          kind: 'image',
          depth: 1,
          meta: `${template.width}×${template.height}`,
          container: false,
          siblings: localKeys,
          rerender,
          checked: template.visible,
          onToggleChecked: (on) => {
            void setLocalVisible(template.id, on).then((changed) => {
              if (!changed) callbacks.onError(`Could not change visibility for “${template.name}”.`)
              rerender()
            })
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
        wrap.appendChild(row)
      }
      if (mine.length === 0) {
        wrap.appendChild(childText(needle === '' ? 'No local templates yet.' : 'No matches.', 0))
      }
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

  if (renaming !== null && wrap.querySelector('[data-wts-rename]') === null) {
    renaming = null
    renameDraft = null
  }

  return wrap
}
