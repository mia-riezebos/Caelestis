import { cacheServer, loadServerCache } from '../server-cache.js'
import {
  type ConnectedServer,
  getState,
  listNodes,
  MAX_TREE_NODES,
  removeTreeStateKeys,
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
  readonly onCopyToServer: (templateId: string, invoker: HTMLElement) => void
  readonly onError: (message: string) => void
}

let activeTreeKey: string | null = null
/** The row currently being renamed, if any. Inline editing beats a modal for a one-field change. */
let renaming: string | null = null
let renameDraft: { readonly key: string; value: string } | null = null
const TREE_DRAG_TYPE = 'application/x-caelestis-tree-key'
const MAX_RENDERED_ROWS = 2_000
const MAX_TOTAL_SERVER_NODES = MAX_TREE_NODES
const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })

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
const nodeErrors = new WeakMap<ConnectedServer, string>()
export type NodeRefreshResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly message: string
      readonly cancelled?: true
      readonly superseded?: true
    }
const refreshes = new WeakMap<ConnectedServer, Promise<NodeRefreshResult>>()

const serverIdentity = (server: ConnectedServer): string | null => {
  if (server.info !== null && server.season !== null) return `${server.info.id}:${server.season}`
  return server.lastVerified === null || server.lastVerified === undefined
    ? null
    : `${server.lastVerified.serverId}:${server.lastVerified.season}`
}

const treeFor = (server: ConnectedServer): readonly TreeNode[] | undefined => {
  const identity = serverIdentity(server)
  const entry = nodesByServer.get(server.url)
  return identity !== null &&
    entry !== undefined &&
    `${entry.serverId}:${entry.season}` === identity
    ? entry.nodes
    : undefined
}

export const nodeTreeKey = (server: ConnectedServer, nodeId: string): string => {
  const identity = serverIdentity(server) ?? 'unknown:unknown'
  return `node:${encodeURIComponent(server.url)}:${identity}:${nodeId}`
}

export const forgetServerTree = (url: string): void => {
  const entry = nodesByServer.get(url)
  const prefix = `node:${encodeURIComponent(url)}:`
  const state = getState()
  const keys = new Set([
    `server:${url}`,
    ...state.customOrder.filter((key) => key.startsWith(prefix)),
    ...state.collapsed.filter((key) => key.startsWith(prefix)),
  ])
  if (entry !== undefined) {
    for (const node of entry.nodes) {
      keys.add(`node:${encodeURIComponent(url)}:${entry.serverId}:${entry.season}:${node.id}`)
      // Clean up the pre-URL namespace and the original unscoped prototype key as well.
      keys.add(`node:${entry.serverId}:${entry.season}:${node.id}`)
      keys.add(`node:${node.id}`)
    }
  }
  removeTreeStateKeys(keys)
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
  removeTreeStateKeys(keys)
}

export const refreshNodes = async (
  server: ConnectedServer,
  rerender: () => void,
  force = false,
  signal?: AbortSignal,
): Promise<NodeRefreshResult> => {
  const existing = refreshes.get(server)
  if (!force && existing !== undefined) {
    const result = await existing
    queueMicrotask(rerender)
    return result
  }
  // Every successful manifest probe already carries the public node tree. Consume that first: a
  // read-only or anonymous connection cannot call the admin route, but it still owns the manifest
  // folders it just verified.
  const pendingProbe = takeProbedNodes(server)
  const probed = force ? undefined : pendingProbe
  if (!server.isAdmin && probed === undefined) {
    return { ok: false, message: 'Admin access is required to refresh folders.' }
  }
  const generation = (refreshGeneration.get(server.url) ?? 0) + 1
  refreshGeneration.set(server.url, generation)
  const loading = Promise.resolve().then(async (): Promise<NodeRefreshResult> => {
    const result =
      probed === undefined ? await listNodes(server, signal) : { ok: true as const, nodes: probed }
    if (signal?.aborted) {
      return { ok: false, message: 'Folder refresh cancelled.', cancelled: true }
    }
    if (getState().servers.find((candidate) => candidate.url === server.url) !== server) {
      return { ok: false, message: 'The server connection changed during refresh.' }
    }
    if (refreshGeneration.get(server.url) !== generation) {
      return {
        ok: false,
        message: 'A newer folder refresh replaced this one.',
        superseded: true,
      }
    }
    refreshedConnections.add(server)
    if (!result.ok) {
      nodeErrors.set(server, result.message)
      return result
    }
    const identity = serverIdentity(server)
    if (identity === null || server.info === null || server.season === null) {
      const failure = { ok: false as const, message: 'The server identity is unavailable.' }
      nodeErrors.set(server, failure.message)
      return failure
    }
    let retainedNodes = 0
    for (const [url, entry] of nodesByServer) {
      if (url !== server.url) retainedNodes += entry.nodes.length
    }
    if (retainedNodes + result.nodes.length > MAX_TOTAL_SERVER_NODES) {
      const failure = {
        ok: false as const,
        message: `Connected server folders exceed the ${MAX_TOTAL_SERVER_NODES.toLocaleString()}-node client limit.`,
      }
      nodeErrors.set(server, failure.message)
      return failure
    }
    nodeErrors.delete(server)
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
  if (!signal?.aborted) queueMicrotask(rerender)
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
      server?.lastVerified?.serverId !== entry.serverId ||
      server.lastVerified.season !== entry.season ||
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

const isExpanded = (key: string): boolean => !getState().collapsed.includes(key)
const isEnabled = (key: string): boolean => !disabled.has(key)
const toggle = (set: Set<string>, key: string): void => {
  if (set.has(key)) set.delete(key)
  else set.add(key)
}

interface OrderedItem {
  readonly key: string
  readonly name: string
  readonly createdAt?: number
}

export const nodeSiblingItems = (
  server: ConnectedServer,
  nodes: readonly TreeNode[],
): ReadonlyArray<OrderedItem & { readonly node: TreeNode }> =>
  nodes.map((node) => ({
    key: nodeTreeKey(server, node.id),
    name: node.name,
    createdAt: node.createdAt,
    node,
  }))

export const canRetryNodeRefresh = (server: ConnectedServer): boolean => server.isAdmin

export const localSiblingKeys = (
  templates: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  needle: string,
): readonly string[] => {
  const folded = needle.toLocaleLowerCase()
  return templates
    .filter((template) => folded === '' || template.name.toLocaleLowerCase().includes(folded))
    .map((template) => `local:${template.id}`)
}

/** @internal Pure ordering seam used to pin custom-order fallback behavior. */
export const orderedItems = <T extends OrderedItem>(
  items: readonly T[],
  rank: ReadonlyMap<string, number>,
  limit = Number.POSITIVE_INFINITY,
): readonly T[] => {
  const bounded = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : items.length
  if (bounded === 0) return []
  const takeFirst = (compare: (a: T, b: T) => number): readonly T[] => {
    if (bounded >= items.length) return [...items].sort(compare)
    const heap: T[] = []
    const siftUp = (start: number): void => {
      let index = start
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2)
        const item = heap[index]
        const parentItem = heap[parent]
        if (item === undefined || parentItem === undefined || compare(item, parentItem) <= 0) break
        ;[heap[index], heap[parent]] = [parentItem, item]
        index = parent
      }
    }
    const siftDown = (): void => {
      let index = 0
      while (true) {
        const left = index * 2 + 1
        const right = left + 1
        let worst = index
        const leftItem = heap[left]
        const currentWorst = heap[worst]
        if (
          leftItem !== undefined &&
          currentWorst !== undefined &&
          compare(leftItem, currentWorst) > 0
        ) {
          worst = left
        }
        const rightItem = heap[right]
        const nextWorst = heap[worst]
        if (
          rightItem !== undefined &&
          nextWorst !== undefined &&
          compare(rightItem, nextWorst) > 0
        ) {
          worst = right
        }
        if (worst === index) return
        const current = heap[index]
        const replacement = heap[worst]
        if (current === undefined || replacement === undefined) return
        ;[heap[index], heap[worst]] = [replacement, current]
        index = worst
      }
    }
    for (const item of items) {
      if (heap.length < bounded) {
        heap.push(item)
        siftUp(heap.length - 1)
      } else if (heap[0] !== undefined && compare(item, heap[0]) < 0) {
        heap[0] = item
        siftDown()
      }
    }
    return heap.sort(compare)
  }
  if (getState().sort.field === 'name') {
    const direction = getState().sort.direction === 'desc' ? -1 : 1
    return takeFirst(
      (a, b) => direction * NAME_COLLATOR.compare(a.name, b.name) || a.key.localeCompare(b.key),
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
  // The manifest's array order exists for deterministic hashing, not presentation. New, unranked
  // server rows surface newest-first until the user's durable custom order takes over.
  unranked.sort(
    (a, b) => (b.createdAt ?? Number.NEGATIVE_INFINITY) - (a.createdAt ?? Number.NEGATIVE_INFINITY),
  )
  return [...ranked.map(({ item }) => item), ...unranked].slice(0, bounded)
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

export const replaceSiblingOrder = (
  current: readonly string[],
  siblings: readonly string[],
  next: readonly string[],
): readonly string[] => {
  const siblingSet = new Set(siblings)
  const firstSibling = current.findIndex((key) => siblingSet.has(key))
  const retained = current.filter((key) => !siblingSet.has(key))
  const insertion = firstSibling === -1 ? retained.length : firstSibling
  return [...retained.slice(0, insertion), ...next, ...retained.slice(insertion)]
}

const moveKey = (keys: readonly string[], from: string, to: string, after: boolean): void => {
  const next = reorderedSiblings(keys, from, to, after)
  if (next === null) return
  if (next.every((key, index) => key === keys[index])) return
  const current = getState().customOrder
  setState({ customOrder: replaceSiblingOrder(current, keys, next) })
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
  /** Search reveals descendants without changing the user's durable collapsed state. */
  readonly forceExpanded?: boolean | undefined
  readonly actions?:
    | ReadonlyArray<{ icon: IconName; label: string; run: (invoker: HTMLElement) => void }>
    | undefined
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
  row.tabIndex = -1
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-level', String(options.depth + 1))
  const expanded = options.forceExpanded === true || isExpanded(options.key)
  if (options.forceExpanded === true) row.dataset.wtsForceExpanded = ''
  if (options.container) row.setAttribute('aria-expanded', String(expanded))

  if (options.container) {
    const glyph = icon('caret', 'size-4 opacity-60')
    glyph.style.flex = '0 0 auto'
    glyph.style.transition = 'transform 120ms ease-out'
    glyph.style.transform = expanded ? 'rotate(90deg)' : 'rotate(0deg)'
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
  row.draggable = draggable && !editing
  if (editing) row.dataset.wtsRenaming = ''
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
    let submitted = false
    const commit = (): void => {
      if (submitted) return
      submitted = true
      const value = input.value.trim()
      renaming = null
      renameDraft = null
      input.disabled = true
      for (const button of group.querySelectorAll('button')) button.disabled = true
      row.focus({ preventScroll: true })
      if (value !== '' && value !== options.name) options.onRename?.(value)
      else options.rerender()
    }
    const cancel = (): void => {
      if (submitted) return
      renaming = null
      renameDraft = null
      row.focus({ preventScroll: true })
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
        action.run(button)
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
    if (!options.container || options.forceExpanded === true) return
    const next = new Set(getState().collapsed)
    toggle(next, options.key)
    setState({ collapsed: [...next] })
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

  if (draggable && !editing) {
    row.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown')
    row.addEventListener('keydown', (event) => {
      if (event.target !== row || !event.altKey) return
      const index = options.siblings.indexOf(options.key)
      const target =
        event.key === 'ArrowUp'
          ? options.siblings[index - 1]
          : event.key === 'ArrowDown'
            ? options.siblings[index + 1]
            : undefined
      if (target === undefined) return
      event.preventDefault()
      event.stopPropagation()
      moveKey(options.siblings, options.key, target, event.key === 'ArrowDown')
      options.rerender()
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
  el.setAttribute('role', 'treeitem')
  el.setAttribute('aria-level', String(depth + 2))
  el.setAttribute('aria-disabled', 'true')
  el.className = 'text-xs opacity-60'
  el.style.padding = '0.125rem 0.75rem 0.375rem'
  el.style.paddingLeft = `${2.5 + depth * 1.125}rem`
  el.textContent = text
  return el
}

const childRetry = (text: string, depth: number, retry: () => void): HTMLElement => {
  const row = document.createElement('div')
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-level', String(depth + 2))
  row.className = 'flex items-center gap-2'
  row.style.padding = '0.125rem 0.75rem 0.375rem'
  row.style.paddingLeft = `${2.5 + depth * 1.125}rem`
  const message = document.createElement('span')
  message.className = 'text-xs opacity-60'
  message.textContent = text
  const button = document.createElement('button')
  button.className = 'btn btn-xs btn-ghost'
  button.textContent = 'Retry'
  button.addEventListener('click', retry)
  row.append(message, button)
  return row
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
  let renderedServerRows = 0

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
        forceExpanded: needle !== '',
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

    if (server !== undefined && (server.status === 'connected' || treeFor(server) !== undefined)) {
      const known = treeFor(server)
      const nodeError = nodeErrors.get(server)
      if (known === undefined) {
        // First sight of this server: kick off the fetch, draw nothing extra this pass.
        if (server.status === 'connected' && !refreshedConnections.has(server)) {
          void refreshNodes(server, backgroundRerender)
        }
      } else {
        if (server.status === 'connected' && !refreshedConnections.has(server)) {
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
        let truncated = false
        const renderChildren = (parentId: string | null, depth: number): void => {
          const siblings = byParent.get(parentId) ?? []
          const remaining = MAX_RENDERED_ROWS - renderedServerRows
          if (remaining <= 0) {
            truncated = siblings.length > 0
            return
          }
          const matchingSiblings = siblings.filter((node) => nodeMatches(node))
          const orderedSiblings = orderedItems(
            nodeSiblingItems(server, matchingSiblings),
            rank,
            remaining,
          )
          if (orderedSiblings.length < matchingSiblings.length) truncated = true
          const siblingKeys = orderedSiblings.map((item) => item.key)
          for (const item of orderedSiblings) {
            const node = item.node
            if (renderedServerRows >= MAX_RENDERED_ROWS) {
              truncated = true
              break
            }
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
                forceExpanded: needle !== '',
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
            renderedServerRows++
            if (isExpanded(nodeKey) || needle !== '') renderChildren(node.id, depth + 1)
          }
        }
        renderChildren(null, 1)
        if (server.status === 'connected' && nodeError !== undefined) {
          wrap.appendChild(
            canRetryNodeRefresh(server)
              ? childRetry(`Could not refresh folders. ${nodeError}`, 0, () => {
                  void refreshNodes(server, backgroundRerender, true)
                })
              : childText(`Could not refresh folders. ${nodeError}`, 0),
          )
        } else if (server.status === 'connected' && known.length === 0) {
          wrap.appendChild(
            childText(needle === '' ? 'No templates published yet.' : 'No matches.', 0),
          )
        } else if (truncated) {
          wrap.appendChild(
            childText(
              renderedRows === 0
                ? `No folders from this server are shown because the panel's ${MAX_RENDERED_ROWS.toLocaleString()}-folder limit was reached by earlier servers.`
                : `Showing ${renderedRows.toLocaleString()} folders from this server; the panel's ${MAX_RENDERED_ROWS.toLocaleString()}-folder limit has been reached.`,
              0,
            ),
          )
        } else if (renderedRows === 0 && needle !== '') {
          wrap.appendChild(childText('No matches.', 0))
        }
        // A stale tree is useful context while a server is offline or needs a new code, but it must
        // not hide that connection state. Healthy trees need no extra status row.
        if (server.status === 'connected') continue
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
      const localKeys = localSiblingKeys(
        orderedMine.map((item) => item.template),
        needle,
      )
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
            void setLocalVisible(template.id, on)
              .then((changed) => {
                if (!changed)
                  callbacks.onError(`Could not change visibility for “${template.name}”.`)
                rerender()
              })
              .catch((error: unknown) => {
                callbacks.onError(
                  `Could not change visibility for “${template.name}”. ${String(error)}`,
                )
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
              run: (invoker) => callbacks.onCopyToServer(template.id, invoker),
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
      actions.setAttribute('role', 'treeitem')
      actions.setAttribute('aria-level', '2')
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
      const nodeError = nodeErrors.get(server)
      wrap.appendChild(
        nodeError === undefined
          ? childText('Loading folders…', 0)
          : canRetryNodeRefresh(server)
            ? childRetry(`Could not load folders. ${nodeError}`, 0, () => {
                void refreshNodes(server, backgroundRerender, true)
              })
            : childText(`Could not load folders. ${nodeError}`, 0),
      )
    } else if (server.status === 'needs-token') {
      wrap.appendChild(childText('Needs an access code — add it in settings.', 0))
    } else {
      wrap.appendChild(childText(`Could not be reached. ${server.error ?? ''}`.trim(), 0))
    }
  }

  const addWrap = document.createElement('div')
  addWrap.setAttribute('role', 'treeitem')
  addWrap.setAttribute('aria-level', '1')
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

  const rows = [...wrap.querySelectorAll<HTMLElement>('[role="treeitem"][data-wts-key]')]
  const active = rows.find((row) => row.dataset.wtsKey === activeTreeKey) ?? rows[0]
  const activate = (row: HTMLElement): void => {
    for (const candidate of rows) {
      candidate.tabIndex = candidate === row ? 0 : -1
      for (const control of candidate.querySelectorAll<HTMLElement>('button,input')) {
        control.tabIndex = candidate === row ? 0 : -1
      }
    }
    activeTreeKey = row.dataset.wtsKey ?? null
  }
  if (active !== undefined) activate(active)
  wrap.addEventListener('focusin', (event) => {
    const row = (event.target as Element | null)?.closest<HTMLElement>('[role="treeitem"]')
    if (row === null || row === undefined || !wrap.contains(row)) return
    activate(row)
  })
  wrap.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return
    const row = (event.target as Element | null)?.closest<HTMLElement>('[role="treeitem"]')
    if (row === null || row === undefined || event.target !== row) return
    const index = rows.indexOf(row)
    let next: HTMLElement | undefined
    if (event.key === 'ArrowDown') next = rows[index + 1]
    else if (event.key === 'ArrowUp') next = rows[index - 1]
    else if (event.key === 'Home') next = rows[0]
    else if (event.key === 'End') next = rows.at(-1)
    else if (event.key === 'ArrowRight') {
      if (row.getAttribute('aria-expanded') === 'false') {
        event.preventDefault()
        row.click()
        return
      }
      const child = rows[index + 1]
      if (
        child !== undefined &&
        Number(child.getAttribute('aria-level')) > Number(row.getAttribute('aria-level'))
      ) {
        next = child
      }
    } else if (event.key === 'ArrowLeft') {
      if (
        row.getAttribute('aria-expanded') === 'true' &&
        row.dataset.wtsForceExpanded === undefined
      ) {
        event.preventDefault()
        row.click()
        return
      }
      const level = Number(row.getAttribute('aria-level'))
      for (let candidate = index - 1; candidate >= 0; candidate--) {
        const parent = rows[candidate]
        if (parent !== undefined && Number(parent.getAttribute('aria-level')) < level) {
          next = parent
          break
        }
      }
    }
    if (next === undefined) return
    event.preventDefault()
    next.focus()
  })

  return wrap
}
