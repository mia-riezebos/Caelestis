import { cacheServer, loadServerCache, type ServerTemplate } from '../server-cache.js'
import {
  type ConnectedServer,
  getState,
  isScopeVisible,
  listServerContents,
  MAX_TREE_NODES,
  removeTreeStateKeys,
  setLocalFolderVisible,
  setScopeVisible,
  setState,
  type TreeNode,
  takeProbedNodes,
} from '../state.js'
import { isServerTemplate, localTemplates, setLocalVisible } from '../templates/local-store.js'
import { nodeScopeKey, rememberNodes } from '../templates/server-nodes.js'
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
  readonly onError: (message: string) => void
  /** Move a dragged Local row to a place in the tree: a container, and the key it goes before. */
  readonly onMoveLocal: (
    draggedKey: string,
    parentKey: string | null,
    beforeKey: string | null,
  ) => Promise<string | null>
  /**
   * Something was dropped at a place in a server's tree: which folder, and what it lands before.
   *
   * One callback for every journey, because they are one gesture. What happens comes from the
   * dragged key rather than from the caller: a Local template lands as an upload, a template
   * already here is refiled, one from elsewhere crosses over, a folder is re-parented. `null` for
   * the folder means the server's top level, which only a folder may occupy.
   */
  readonly onDropInServer: (
    server: ConnectedServer,
    nodeId: string | null,
    draggedKey: string,
    beforeKey: string | null,
  ) => Promise<string | null>
}

let activeTreeKey: string | null = null
/** The row currently being renamed, if any. Inline editing beats a modal for a one-field change. */
let renaming: string | null = null
let renameDraft: {
  key: string
  value: string
  selectionStart: number
  selectionEnd: number
} | null = null
const MAX_RENDERED_ROWS = 2_000

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
/** Verified identity belonging to the rows cached at each URL. */
const rowIdentityByServer = new Map<string, string>()

const serverIdentity = (server: ConnectedServer): string | null => {
  if (server.info !== null && server.season !== null) return `${server.info.id}:${server.season}`
  return server.lastVerified == null
    ? null
    : `${server.lastVerified.serverId}:${server.lastVerified.season}`
}

const rowsFor = (
  server: ConnectedServer,
): { nodes: readonly TreeNode[]; templates: readonly ServerTemplate[] } | undefined => {
  const identity = serverIdentity(server)
  if (identity === null || rowIdentityByServer.get(server.url) !== identity) return undefined
  const nodes = nodesByServer.get(server.url)
  if (nodes === undefined) return undefined
  return { nodes, templates: templatesByServer.get(server.url) ?? [] }
}

export const nodeTreeKey = (server: ConnectedServer, nodeId: string): string =>
  `node:${encodeURIComponent(server.url)}:${serverIdentity(server) ?? 'unknown:unknown'}:${nodeId}`

export const serverTemplateTreeKey = (server: ConnectedServer, templateId: string): string =>
  `st:${encodeURIComponent(server.url)}:${serverIdentity(server) ?? 'unknown:unknown'}:${templateId}`

export const forgetServerTree = (url: string): void => {
  const prefix = `node:${encodeURIComponent(url)}:`
  const state = getState()
  removeTreeStateKeys(
    new Set([
      `server:${url}`,
      ...state.customOrder.filter((key) => key.startsWith(prefix)),
      ...state.collapsed.filter((key) => key.startsWith(prefix)),
    ]),
  )
  forgetServerRows(url)
}

interface OrderedItem {
  readonly key: string
  readonly name: string
  readonly createdAt?: number
}

const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })

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

export const canRetryNodeRefresh = (server: ConnectedServer): boolean =>
  server.status === 'connected'

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
        )
          worst = left
        const rightItem = heap[right]
        const nextWorst = heap[worst]
        if (rightItem !== undefined && nextWorst !== undefined && compare(rightItem, nextWorst) > 0)
          worst = right
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
  unranked.sort(
    (a, b) => (b.createdAt ?? Number.NEGATIVE_INFINITY) - (a.createdAt ?? Number.NEGATIVE_INFINITY),
  )
  return [...ranked.map(({ item }) => item), ...unranked].slice(0, bounded)
}

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

export const reorderedVisibleSiblings = (
  allKeys: readonly string[],
  visibleKeys: readonly string[],
  from: string,
  to: string,
  after: boolean,
): readonly string[] | null => {
  if (!allKeys.includes(from)) {
    // An inserted row owns no full-list slot yet. Translate its visible boundary directly into the
    // complete order instead of inventing a shared slot that would displace a hidden sibling.
    if (visibleKeys.length === 0) return [from, ...allKeys]
    if (!visibleKeys.includes(to)) return null
    const index = allKeys.indexOf(to)
    if (index === -1) return null
    const next = [...allKeys]
    next.splice(after ? index + 1 : index, 0, from)
    return next
  }
  const visible = reorderedSiblings(visibleKeys, from, to, after)
  if (visible === null) return null
  const visibleSet = new Set(visibleKeys)
  let cursor = 0
  return allKeys.map((key) => (visibleSet.has(key) ? (visible[cursor++] ?? key) : key))
}

export const replaceSiblingOrder = (
  current: readonly string[],
  siblings: readonly string[],
  next: readonly string[],
): readonly string[] => {
  const siblingSet = new Set(siblings)
  const first = current.findIndex((key) => siblingSet.has(key))
  const retained = current.filter((key) => !siblingSet.has(key))
  const at = first === -1 ? retained.length : first
  return [...retained.slice(0, at), ...next, ...retained.slice(at)]
}

/**
 * Which server holds the template row identified by its server-scoped tree key.
 */
export const findServerTemplate = (
  key: string,
): { serverUrl: string; template: ServerTemplate } | null => {
  for (const server of getState().servers) {
    const template = rowsFor(server)?.templates.find(
      (candidate) => serverTemplateTreeKey(server, candidate.id) === key,
    )
    if (template !== undefined) return { serverUrl: server.url, template }
  }
  return null
}

/**
 * What a server last said about one template, for whoever is acting on a row.
 *
 * Read from the same cache the row was drawn from, so a menu can never offer "Unpublish" on a row
 * drawn as unpublished — the two would otherwise be answering from different copies.
 */
export const serverTemplateAt = (serverUrl: string, id: string): ServerTemplate | null => {
  const server = getState().servers.find((candidate) => candidate.url === serverUrl)
  return server === undefined
    ? null
    : (rowsFor(server)?.templates.find((template) => template.id === id) ?? null)
}

/** Which server holds a folder row — the same scoped-key lookup as `findServerTemplate`. */
export const findServerNode = (key: string): { serverUrl: string; node: TreeNode } | null => {
  for (const server of getState().servers) {
    const node = rowsFor(server)?.nodes.find(
      (candidate) => nodeTreeKey(server, candidate.id) === key,
    )
    if (node !== undefined) return { serverUrl: server.url, node }
  }
  return null
}

/** What a server publishes directly inside one folder. */
export const templatesOfNode = (
  serverUrl: string,
  nodeId: string,
): ReadonlyArray<{ id: string; name: string }> => {
  const server = getState().servers.find((candidate) => candidate.url === serverUrl)
  return server === undefined
    ? []
    : (rowsFor(server)?.templates.filter((template) => template.nodeId === nodeId) ?? [])
}

/**
 * Re-read what a server publishes: its folders and the templates under them.
 *
 * **Not gated on admin.** The tree is what a read token is for — seeing what the alliance is
 * building. Only *changing* it is privileged, and that boundary is drawn per row by `canEdit`.
 * Refusing to fetch here left every member looking at a connected server with nothing under it.
 *
 * Both in one call, from the manifest, which is also the only way they can agree: a template row is
 * drawn under its folder, so fetching one without the other puts templates under folders that are
 * not there, or leaves a folder claiming to be empty a moment after something landed in it.
 *
 * One at a time per server. The render pass calls this for any connected server it has nothing for,
 * and a render pass is cheap to provoke — so a server that is slow, unreachable, or refusing the
 * token got a fresh manifest request on *every* re-render, because a failure leaves the map empty
 * and the next pass sees the same gap. Sharing the in-flight promise makes that one request.
 */
export type NodeRefreshResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly superseded?: true }
const refreshing = new WeakMap<ConnectedServer, Promise<NodeRefreshResult>>()
const refreshedConnections = new WeakSet<ConnectedServer>()
const nodeErrors = new WeakMap<ConnectedServer, string>()
const refreshGeneration = new Map<string, number>()

export const refreshNodes = async (
  server: ConnectedServer,
  rerender: () => void,
  force = false,
): Promise<NodeRefreshResult> => {
  const pending = refreshing.get(server)
  if (!force && pending !== undefined) {
    const result = await pending
    queueMicrotask(rerender)
    return result
  }
  const generation = (refreshGeneration.get(server.url) ?? 0) + 1
  refreshGeneration.set(server.url, generation)
  refreshedConnections.add(server)
  const run = refreshOnce(server, generation)
  refreshing.set(server, run)
  const result = await run
  if (refreshing.get(server) === run) refreshing.delete(server)
  if (result.ok) nodeErrors.delete(server)
  else if (result.superseded !== true) nodeErrors.set(server, result.message)
  queueMicrotask(rerender)
  return result
}

const refreshOnce = async (
  server: ConnectedServer,
  generation: number,
): Promise<NodeRefreshResult> => {
  const contents = await listServerContents(server)
  // Unreachable, so nothing is known. The tree keeps drawing what the cache says rather than
  // emptying itself — a server that blinks should not take its folders off your screen.
  if (contents === null) return { ok: false, message: 'Could not refresh this server.' }
  if (getState().servers.find((candidate) => candidate.url === server.url) !== server) {
    return { ok: false, message: 'The server connection changed during refresh.', superseded: true }
  }
  if (refreshGeneration.get(server.url) !== generation) {
    return { ok: false, message: 'A newer refresh replaced this one.', superseded: true }
  }
  const { nodes, templates } = contents
  const identity = serverIdentity(server)
  if (identity === null) return { ok: false, message: 'The server identity is unavailable.' }
  // The public manifest is now the authoritative snapshot. Retaining the connect-time copy lets a
  // later admin-only consumer resurrect older folders after this refresh has already succeeded.
  takeProbedNodes(server)
  let retainedNodes = 0
  for (const candidate of getState().servers) {
    if (candidate.url === server.url) continue
    retainedNodes += rowsFor(candidate)?.nodes.length ?? 0
  }
  if (retainedNodes + nodes.length > MAX_TREE_NODES) {
    return {
      ok: false,
      message: `Connected server folders exceed the ${MAX_TREE_NODES.toLocaleString()}-node client limit.`,
    }
  }
  nodesByServer.set(server.url, nodes)
  rememberNodes(server.url, nodes)
  templatesByServer.set(server.url, templates)
  rowIdentityByServer.set(server.url, identity)
  if (server.info !== null && server.season !== null) {
    void cacheServer({
      url: server.url,
      serverId: server.info.id,
      season: server.season,
      nodes,
      templates,
      fetchedAt: Date.now(),
    })
  }
  // Every caller of this is a mutation that just landed — a publish, an upload, a delete. Waiting
  // out the poll to see it on the canvas would make each of those feel like it had not worked.
  //
  // Handing over the manifest we just read, rather than letting the sync fetch its own: they are the
  // same document, requested a millisecond apart, and the second one can only disagree with the
  // first by being newer than the tree that is already on screen.
  void syncServerTemplates(server, templates)
  return { ok: true }
}

/**
 * Draw what a server said last time, immediately, before anything is fetched.
 *
 * Without it the tree is empty on every page load until each server answers, which is the wrong
 * first impression and gets worse the more servers are connected.
 */
export const primeFromCache = async (rerender: () => void): Promise<void> => {
  const servers = getState().servers
  for (const entry of await loadServerCache(servers.map((server) => server.url))) {
    const server = servers.find((candidate) => candidate.url === entry.url)
    const identity = server?.lastVerified
    if (
      server === undefined ||
      identity == null ||
      identity.serverId !== entry.serverId ||
      identity.season !== entry.season
    )
      continue
    const replace = rowsFor(server) === undefined
    if (replace) {
      nodesByServer.set(entry.url, entry.nodes)
      rowIdentityByServer.set(entry.url, `${entry.serverId}:${entry.season}`)
      templatesByServer.set(entry.url, entry.templates ?? [])
      // The renderer needs the folder tree too, and it needs it now rather than after the first
      // fetch: a template restored from cache into a folder switched off last session would
      // otherwise draw until the manifest came back and said which folder it was in.
      //
      // Only when nothing has been rendered yet, which is what `replace` means. Installed
      // unconditionally, a cache read that came back after a network refresh put the cached
      // ancestry over the fresh one, so a folder moved since that snapshot took its old parent's
      // visibility until something asked again.
      rememberNodes(entry.url, entry.nodes)
    }
    if (
      !replace &&
      templatesByServer.get(entry.url) === undefined &&
      entry.templates !== undefined
    ) {
      templatesByServer.set(entry.url, entry.templates)
    }
  }
  rerender()
}

/**
 * Forget a server's folders and templates, and say which chunks they were made of.
 *
 * The hashes come back because the chunk cache is content-addressed and cannot tell whose bytes are
 * whose — this map is the last thing that knows, so it answers on the way out.
 */
export const forgetServerRows = (serverUrl: string): readonly string[] => {
  const hashes = (templatesByServer.get(serverUrl) ?? []).flatMap((template) =>
    template.chunks.map((chunk) => chunk.hash),
  )
  nodesByServer.delete(serverUrl)
  templatesByServer.delete(serverUrl)
  rowIdentityByServer.delete(serverUrl)
  refreshGeneration.delete(serverUrl)
  return hashes
}

export const startRenaming = (key: string): void => {
  renaming = key
  renameDraft = null
}
const disabled = new Set<string>()

const isExpanded = (key: string): boolean => !getState().collapsed.includes(key)
const isEnabled = (key: string): boolean => !disabled.has(key)
const toggle = (set: Set<string>, key: string): void => {
  if (set.has(key)) set.delete(key)
  else set.add(key)
}

/**
 * Reorder one row among its siblings without disturbing the rank slots belonging to other levels.
 *
 * It used to build the new order from the sibling list alone and store *that* as the whole custom
 * order — so reordering two categories replaced the flat list with two keys and threw away the
 * arrangement of every folder and template in the tree. `customOrder` spans all levels; only ever
 * edit it, never rewrite it.
 */
const moveKey = (
  keys: readonly string[],
  from: string,
  to: string,
  after: boolean,
  allKeys: readonly string[] = keys,
  allowInsert = false,
): 'moved' | 'unchanged' | 'too-many' => {
  const inserting = !allKeys.includes(from)
  if (inserting && !allowInsert) return 'unchanged'
  const affectedKeys = inserting ? [...allKeys, from] : allKeys
  // `customOrder` is a flat rank list, so preserving an arbitrary filtered sibling order currently
  // requires writing every sibling. Bound that synchronous GM storage write to the same number of
  // rows the UI can render until the persisted format can represent sparse relative positions.
  if (affectedKeys.length > MAX_RENDERED_ROWS) return 'too-many'
  const next =
    allKeys === keys && !inserting
      ? reorderedSiblings(keys, from, to, after)
      : reorderedVisibleSiblings(allKeys, keys, from, to, after)
  if (next === null || (!inserting && next.every((key, index) => key === allKeys[index])))
    return 'unchanged'
  setState({ customOrder: replaceSiblingOrder(getState().customOrder, affectedKeys, next) })
  return 'moved'
}

const placeAmongVisibleSiblings = (
  visibleKeys: readonly string[],
  allKeys: readonly string[],
  from: string,
  beforeKey: string | null,
  allowInsert = false,
): 'moved' | 'unchanged' | 'too-many' => {
  const without = visibleKeys.filter((key) => key !== from)
  const target = beforeKey ?? without.at(-1) ?? from
  return moveKey(visibleKeys, from, target, beforeKey === null, allKeys, allowInsert)
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
let dragging: { key: string; parentKey: string | null; canReparent: boolean } | null = null

let dropTarget: {
  readonly parentKey: string | null
  readonly beforeKey: string | null
  readonly apply: (draggedKey: string, parentKey: string | null, beforeKey: string | null) => void
  readonly rerender: () => void
} | null = null

/** Held open where the dragged row would land — a hole says "here"; a line only says "near here". */
/**
 * The rows a drag is carrying: the one grabbed, and everything nested under it.
 *
 * Read off the rendered list rather than the model, because the model would have to be asked three
 * different ways — a Local folder holds folders and templates, a server node holds nodes and
 * templates — while the DOM already states it once, as depth. The subtree is the run of rows after
 * this one that are deeper than it, which is exactly what a depth-first render produces.
 */
const draggedRows = (row: HTMLElement): HTMLElement[] => {
  const depth = Number(row.dataset.caelestisDepth ?? 0)
  const rows = [row]
  let next = row.nextElementSibling
  while (next instanceof HTMLElement) {
    if (Number(next.dataset.caelestisDepth ?? 0) <= depth) break
    rows.push(next)
    next = next.nextElementSibling
  }
  return rows
}

/** How tall the hole should be: everything in flight, plus the gaps between those rows. */
const draggedHeight = (rows: readonly HTMLElement[]): number => {
  const first = rows[0]
  const last = rows[rows.length - 1]
  if (first === undefined || last === undefined) return 0
  return last.getBoundingClientRect().bottom - first.getBoundingClientRect().top
}

/** Set while a drag is in flight, so every placeholder is cut to the size of what is being moved. */
let draggedPixels = 0

const placeholder = (depth: number): HTMLElement => {
  const el = document.createElement('div')
  el.className = 'caelestis-placeholder'
  el.dataset.caelestisPlaceholder = ''
  // Indented to the level it would land at, so the outline says *where* and not merely *between
  // which two rows* — the two differ exactly when the drop would change a row's parent.
  el.style.marginLeft = `${0.25 + depth * 1.125}rem`
  // The hole is the shape of what would fill it. A folder carrying nine templates leaves a
  // one-row gap otherwise, which reads as "this lands here alone" and makes the list jump on drop.
  if (draggedPixels > 0) el.style.height = `${draggedPixels}px`
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
const _visibleRows = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('[data-caelestis-key]')].filter(
    (row) => !row.classList.contains('caelestis-dragging'),
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
  const depth = Number(row.dataset.caelestisDepth ?? 0)
  const parentKey = row.dataset.caelestisParent ?? null
  const key = row.dataset.caelestisKey ?? null

  if (above) return { parentKey, beforeKey: key, depth, before: row }

  const isContainer = row.dataset.caelestisContainer !== undefined
  const expanded = key !== null && isExpanded(key)
  const next = row.nextElementSibling
  if (isContainer && expanded) {
    // Into it, ahead of whatever it already holds.
    const firstChild = next instanceof HTMLElement ? (next.dataset.caelestisKey ?? null) : null
    return {
      parentKey: key,
      beforeKey: firstChild,
      depth: depth + 1,
      before: next,
    }
  }
  // Beside it. Skip over anything nested under this row so "after" means after its whole subtree.
  let cursor: Element | null = next
  while (cursor instanceof HTMLElement && Number(cursor.dataset.caelestisDepth ?? 0) > depth) {
    cursor = cursor.nextElementSibling
  }
  const beforeKey = cursor instanceof HTMLElement ? (cursor.dataset.caelestisKey ?? null) : null
  return { parentKey, beforeKey, depth, before: cursor }
}

const clearDropMarks = (root: ParentNode): void => {
  for (const el of root.querySelectorAll('[data-caelestis-placeholder]')) el.remove()
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
  /** Search exposes descendants without changing the user's stored collapsed state. */
  readonly forceExpanded?: boolean | undefined
  /** Dimmed, for a row that exists but is not doing anything yet — an unpublished template. */
  readonly muted?: boolean | undefined
  readonly actions?: ReadonlyArray<{ icon: IconName; label: string; run: () => void }> | undefined
  /** Present only where the user can actually change things; absent means no rename affordance. */
  readonly onRename?: ((name: string) => void) | undefined
  readonly onContextMenu?: ((event: MouseEvent) => void) | undefined
  readonly siblings: readonly string[]
  /** Full sibling order, computed only if a filtered or capped view is actually reordered. */
  readonly orderingSiblings?: (() => readonly string[]) | undefined
  /** Resolve the sibling order for the destination level returned by `resolveDrop`. */
  readonly destinationSiblings?:
    | ((parentKey: string | null) =>
        | {
            readonly visible: readonly string[]
            readonly all: () => readonly string[]
          }
        | undefined)
    | undefined
  readonly rerender: () => void
  readonly onError: (message: string) => void
  /**
   * Drop resolved to a position: which container it lands in, and which key it lands before.
   *
   * The only drop there is. There used to be a second one — hovering the middle of a folder
   * highlighted it and dropped *into* it — and it was worse in both directions: it was a gesture
   * you had to already know about, and it ate the middle of every folder row, leaving thin edges as
   * the only way to reorder anything. A position already says which folder something lands in, so
   * the highlight was answering a question the placeholder had answered better.
   */
  readonly onDropAt?:
    | ((
        draggedKey: string,
        parentKey: string | null,
        beforeKey: string | null,
      ) => Promise<string | null>)
    | undefined
  /** When present, the row reflects this instead of the tree's own disabled set. */
  readonly checked?: boolean | undefined
  readonly onToggleChecked?: ((on: boolean) => void) | undefined
}

/** The one sibling level a resolved placement belongs to, whether or not it is the hovered row's. */
const destinationLevel = (
  options: RowOptions,
  parentKey: string | null,
): SiblingLevel | undefined =>
  parentKey === (options.parentKey ?? null)
    ? {
        visible: options.siblings,
        all: options.orderingSiblings ?? (() => options.siblings),
      }
    : options.destinationSiblings?.(parentKey)

const treeRow = (options: RowOptions): HTMLElement => {
  const draggable = isReorderable(getState().sort)
  const row = document.createElement('div')
  row.className = 'caelestis-row flex items-center gap-1'
  row.dataset.caelestisKey = options.key
  if (options.parentKey !== undefined && options.parentKey !== null) {
    row.dataset.caelestisParent = options.parentKey
  }
  row.dataset.caelestisDepth = String(options.depth)
  if (options.container) row.dataset.caelestisContainer = ''
  row.style.padding = '0.25rem 0.5rem'
  // One indent step per level, on top of the fixed gutter.
  row.style.marginLeft = `${0.25 + options.depth * 1.125}rem`
  row.style.marginRight = '0.5rem'
  row.style.minHeight = '2rem'
  if (options.muted === true) row.style.opacity = '0.55'
  row.draggable = draggable
  row.tabIndex = -1
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-level', String(options.depth + 1))
  const expanded = options.forceExpanded === true || isExpanded(options.key)
  if (options.forceExpanded === true) row.dataset.caelestisForceExpanded = ''
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
  const input = document.createElement('input')
  const name = document.createElement('span')
  if (editing) {
    const startingRename = renameDraft?.key !== options.key
    if (startingRename) {
      renameDraft = {
        key: options.key,
        value: options.name,
        selectionStart: 0,
        selectionEnd: options.name.length,
      }
    }
    input.type = 'text'
    input.dataset.caelestisRename = ''
    input.className = 'input input-xs input-bordered'
    input.value = renameDraft?.value ?? options.name
    input.style.flex = '1'
    input.style.minWidth = '0'
    input.addEventListener('click', (event) => event.stopPropagation())
    const retainRenameDraft = (): void => {
      if (renameDraft?.key !== options.key) return
      renameDraft.value = input.value
      renameDraft.selectionStart = input.selectionStart ?? input.value.length
      renameDraft.selectionEnd = input.selectionEnd ?? input.value.length
    }
    input.addEventListener('input', retainRenameDraft)
    input.addEventListener('select', retainRenameDraft)
    row.appendChild(input)
    requestAnimationFrame(() => {
      input.focus()
      if (startingRename) {
        input.select()
      } else {
        input.setSelectionRange(
          renameDraft?.selectionStart ?? input.value.length,
          renameDraft?.selectionEnd ?? input.value.length,
        )
      }
    })
  } else {
    name.className = 'caelestis-name text-sm'
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
    group.className = 'caelestis-actions flex items-center gap-0.5'
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

  /**
   * An eye, not a tick.
   *
   * A tick answers "is this selected", and nothing here is being selected — every one of these rows
   * is either on the map or not, which is a thing you can *see*. The eye says which, and its absence
   * says the other, so a column of these reads as what is drawn rather than as a form to fill in.
   *
   * Still a checkbox underneath. It is the one element that already means "two states, toggled",
   * and hand-rolling a button in its place would owe the whole contract — the label association, the
   * space key, `aria-checked`, the focus ring — for a change that is entirely about what it looks
   * like.
   */
  const check = document.createElement('input')
  check.type = 'checkbox'
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
  const eye = document.createElement('label')
  eye.className = 'caelestis-eye'
  eye.addEventListener('click', (event) => event.stopPropagation())
  const box = document.createElement('span')
  box.appendChild(icon('eye', 'size-4'))
  eye.append(check, box)
  row.appendChild(eye)

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
      const result = moveKey(
        options.siblings,
        options.key,
        target,
        event.key === 'ArrowDown',
        options.orderingSiblings?.() ?? options.siblings,
      )
      if (result === 'too-many') {
        options.onError('This level has too many rows to save a custom order safely.')
      }
      options.rerender()
    })
  }

  if (!draggable || editing) return row

  row.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData('text/plain', options.key)
    dragging = {
      key: options.key,
      parentKey: options.parentKey ?? null,
      canReparent: options.canReparent === true,
    }
    // A folder travels with what is inside it. Measured before anything is hidden, because a hidden
    // row has no height and the hole has to be the size of what left it.
    const moving = draggedRows(row)
    draggedPixels = draggedHeight(moving)
    // Take the rows out of the flow, so what is on screen is the drag image plus the hole they will
    // land in — nothing else. Leaving them in place at reduced opacity reads as a duplicate, and
    // every row below shifts as the placeholder is inserted.
    //
    // Deferred by a tick because the browser captures the drag image *after* dragstart returns;
    // hiding it synchronously would drag an invisible ghost.
    setTimeout(() => {
      for (const moved of moving) moved.classList.add('caelestis-dragging')
    }, 0)
  })
  row.addEventListener('dragend', () => {
    const parent = row.parentElement ?? document
    for (const moved of parent.querySelectorAll('.caelestis-dragging')) {
      moved.classList.remove('caelestis-dragging')
    }
    draggedPixels = 0
    clearDropMarks(parent)
    dropTarget = null
    dragging = null
  })
  row.addEventListener('dragover', (event) => {
    event.preventDefault()
    // A hover owns the only armed placement. If this row cannot offer one, releasing here must do
    // nothing rather than applying whichever row happened to be hovered previously.
    dropTarget = null
    const parent = row.parentElement
    if (parent === null) return
    clearDropMarks(parent)

    const place = options.onDropAt
    if (place === undefined) {
      // Rows without a position handler still reorder among their own siblings when dropped on the
      // row below, but cannot arm the between-row placeholder: that placeholder accepts the drop
      // itself and therefore needs a `dropTarget` describing what it will do.
      return
    }

    const resolved = resolveDrop(row, event.clientY)
    // Reordering is ours to do — it is a client-side preference. Changing a row's *parent* is a
    // change to the shared structure, so without the right to make it the drop is simply not
    // offered: no outline appears, which reads as "not there" without needing to say so.
    if (
      dragging !== null &&
      (options.canReparent !== true || !dragging.canReparent) &&
      resolved.parentKey !== dragging.parentKey
    ) {
      return
    }
    const destination = destinationLevel(options, resolved.parentKey)
    if (destination === undefined) return
    const reparenting = dragging !== null && resolved.parentKey !== dragging.parentKey
    dropTarget = {
      parentKey: resolved.parentKey,
      beforeKey: resolved.beforeKey,
      apply: (draggedKey, parentKey, beforeKey) => {
        if (reparenting) {
          void place(draggedKey, parentKey, beforeKey).then(
            (destinationKey) => {
              if (destinationKey === null) return
              const result = placeAmongVisibleSiblings(
                destination.visible,
                destination.all(),
                destinationKey,
                beforeKey,
                true,
              )
              if (result === 'too-many') {
                options.onError(
                  'The row was moved, but this level has too many rows to save a custom order safely.',
                )
              }
              options.rerender()
            },
            (error: unknown) => {
              options.onError(`Could not move that row. ${String(error)}`)
              options.rerender()
            },
          )
        } else {
          const result = placeAmongVisibleSiblings(
            destination.visible,
            destination.all(),
            draggedKey,
            beforeKey,
          )
          if (result === 'too-many') {
            options.onError('This level has too many rows to save a custom order safely.')
            return
          }
        }
        if (!reparenting) void place(draggedKey, parentKey, beforeKey)
      },
      rerender: options.rerender,
    }
    parent.insertBefore(placeholder(resolved.depth), resolved.before)
  })
  row.addEventListener('drop', (event) => {
    event.preventDefault()
    const parent = row.parentElement
    const from = event.dataTransfer?.getData('text/plain')
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
    const box = row.getBoundingClientRect()
    const result = moveKey(
      options.siblings,
      from,
      options.key,
      event.clientY > box.top + box.height / 2,
      options.orderingSiblings?.() ?? options.siblings,
    )
    if (result === 'too-many') {
      options.onError('This level has too many rows to save a custom order safely.')
    }
    options.rerender()
  })

  return row
}

/**
 * One row, as the thing supplying it sees it.
 *
 * Everything a row needs that depends on *what* it is, and nothing that depends on where it sits.
 * Depth, siblings, ordering, expansion and recursion belong to the renderer below, which is the
 * whole point: they were the parts that had drifted.
 */
interface TreeItem {
  readonly key: string
  readonly name: string
  readonly kind: IconName
  /** Its id as a container, so the renderer can ask for its children. Null for a leaf. */
  readonly childrenOf: string | null
  readonly createdAt?: number
  readonly meta?: string | undefined
  readonly muted?: boolean | undefined
  readonly visible: boolean
  readonly setVisible: (on: boolean) => boolean | Promise<boolean>
  readonly canReparent: boolean
  readonly actions?: ReadonlyArray<{ icon: IconName; label: string; run: () => void }> | undefined
  readonly onRename?: ((name: string) => void) | undefined
  readonly onContextMenu?: ((event: MouseEvent) => void) | undefined
  readonly onDropAt?:
    | ((
        draggedKey: string,
        parentKey: string | null,
        beforeKey: string | null,
      ) => Promise<string | null>)
    | undefined
}

/**
 * Where a level of the tree comes from.
 *
 * Local templates and a server's published ones are the same thing from two places, and they were
 * drawn by two recursive functions written months apart. The second never caught up: server folders
 * ignored the custom order entirely, could not be interleaved with templates, and their visibility
 * switch reached nothing. Three bugs, one cause — so there is one renderer now, and a source is the
 * three things that genuinely differ.
 *
 * What is genuinely different, and all that is: mutations here go over HTTP and can be refused,
 * a row can exist before its pixels do, and order is this browser's preference while structure is
 * the server's. None of that is the shape of a tree.
 */
interface TreeSource {
  readonly children: (parentId: string | null) => readonly TreeItem[]
}

const groupedSource = (
  entries: ReadonlyArray<{ readonly parentId: string | null; readonly item: TreeItem }>,
): TreeSource => {
  const byParent = new Map<string | null, TreeItem[]>()
  for (const { parentId, item } of entries) {
    const siblings = byParent.get(parentId) ?? []
    siblings.push(item)
    byParent.set(parentId, siblings)
  }
  return { children: (parentId) => byParent.get(parentId) ?? [] }
}

const matcherFor = (source: TreeSource, needle: string): ((item: TreeItem) => boolean) => {
  if (needle === '') return () => true
  const matches = new Map<string, boolean>()
  const visiting = new Set<string>()
  const visit = (item: TreeItem): boolean => {
    const cached = matches.get(item.key)
    if (cached !== undefined) return cached
    if (item.name.toLocaleLowerCase().includes(needle)) {
      matches.set(item.key, true)
      return true
    }
    if (item.childrenOf === null || visiting.has(item.key)) {
      matches.set(item.key, false)
      return false
    }
    visiting.add(item.key)
    const result = source.children(item.childrenOf).some(visit)
    visiting.delete(item.key)
    matches.set(item.key, result)
    return result
  }
  return visit
}

interface RenderBudget {
  remaining: number
  truncated: boolean
}

interface SiblingLevel {
  readonly visible: readonly string[]
  readonly all: () => readonly string[]
}

const childText = (text: string, depth: number): HTMLElement => {
  const el = document.createElement('p')
  el.setAttribute('role', 'treeitem')
  el.setAttribute('aria-level', String(depth + 2))
  el.setAttribute('aria-disabled', 'true')
  el.className = 'text-xs opacity-60'
  el.style.padding = '0.125rem 0.75rem 0.375rem'
  el.style.paddingLeft = `${2.5 + depth * 1.125}rem`
  el.dataset.caelestisDepth = String(depth)
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

/**
 * One level of a tree, and every level below it.
 *
 * Ordered and interleaved: folders and templates go into one list and come out in whatever order
 * the user dragged them into. Not folders-first — sorting by kind means a template can never be put
 * above a folder, and a rule that quietly overrides a custom order makes the drag look broken
 * rather than constrained. This used to be true of Local only.
 */
const renderLevel = (
  into: HTMLElement,
  source: TreeSource,
  parentId: string | null,
  depth: number,
  parentKey: string,
  rerender: () => void,
  needle: string,
  rank: ReadonlyMap<string, number>,
  matches: (item: TreeItem) => boolean,
  budget: RenderBudget,
  onError: (message: string) => void,
  siblingLevels: Map<string, SiblingLevel>,
): void => {
  const allSiblings = source.children(parentId)
  const matching = allSiblings.filter(matches)
  const items = orderedItems(matching, rank, budget.remaining)
  if (items.length < matching.length) budget.truncated = true
  const keys = items.map((item) => item.key)
  siblingLevels.set(parentKey, {
    visible: keys,
    all: () => orderedItems(allSiblings, rank).map((sibling) => sibling.key),
  })

  for (const item of items) {
    if (budget.remaining <= 0) {
      budget.truncated = true
      break
    }
    const key = item.key
    into.appendChild(
      treeRow({
        key,
        name: item.name,
        kind: item.kind,
        depth,
        container: item.childrenOf !== null,
        siblings: keys,
        orderingSiblings: () => orderedItems(allSiblings, rank).map((sibling) => sibling.key),
        destinationSiblings: (destinationParentKey) =>
          destinationParentKey === null ? undefined : siblingLevels.get(destinationParentKey),
        parentKey,
        canReparent: item.canReparent,
        forceExpanded: needle !== '',
        rerender,
        onError,
        checked: item.visible,
        onToggleChecked: (on) => {
          void Promise.resolve(item.setVisible(on)).then(
            (changed) => {
              if (!changed) onError(`Could not change visibility for “${item.name}”.`)
              rerender()
            },
            (error: unknown) => {
              onError(`Could not change visibility for “${item.name}”. ${String(error)}`)
              rerender()
            },
          )
        },
        ...(item.meta === undefined ? {} : { meta: item.meta }),
        ...(item.muted === undefined ? {} : { muted: item.muted }),
        ...(item.actions === undefined ? {} : { actions: item.actions }),
        ...(item.onRename === undefined ? {} : { onRename: item.onRename }),
        ...(item.onContextMenu === undefined ? {} : { onContextMenu: item.onContextMenu }),
        ...(item.onDropAt === undefined ? {} : { onDropAt: item.onDropAt }),
      }),
    )
    budget.remaining--
    if (item.childrenOf === null || (needle === '' && !isExpanded(key))) continue
    renderLevel(
      into,
      source,
      item.childrenOf,
      depth + 1,
      key,
      rerender,
      needle,
      rank,
      matches,
      budget,
      onError,
      siblingLevels,
    )
  }

  // Only inside something. "Nothing here" is worth saying about a folder you have just opened; at
  // the top of a source it is the source's own empty state, which says more than this can.
  if (parentId !== null && matching.length === 0) into.appendChild(childText('Empty.', depth))
}

export const treeContents = (
  callbacks: TreeCallbacks,
  rerender: () => void,
  query = '',
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
  const categories = [
    { key: 'local', name: 'Local' },
    ...servers.map((server) => ({
      key: `server:${server.url}`,
      name: server.info?.name ?? server.url,
    })),
  ]
  const keys = categories.map((item) => item.key)
  const ordered = orderedItems(categories, rank).map((item) => item.key)
  const needle = query.trim().toLocaleLowerCase()
  const budget: RenderBudget = { remaining: MAX_RENDERED_ROWS, truncated: false }
  const siblingLevels = new Map<string, SiblingLevel>()

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
        orderingSiblings: () => ordered,
        destinationSiblings: (destinationParentKey) =>
          destinationParentKey === null ? undefined : siblingLevels.get(destinationParentKey),
        parentKey: null,
        rerender,
        onError: callbacks.onError,
        /**
         * Categories reorder among themselves, and only among themselves.
         *
         * Without a position handler a category could only be dropped *onto* another row, so the
         * one place you cannot aim — the gap above the first row — was the only way to reach first
         * place, and it silently did nothing. Reordering was therefore one-way: a category could be
         * moved down past its neighbour and never brought back up.
         *
         * `canReparent` stays off, so nothing can be filed *inside* a category by dragging.
         */
        onDropAt: async (draggedKey, parentKey, beforeKey) => {
          // Another category, reordering among its own kind.
          if (parentKey === null && keys.includes(draggedKey)) {
            return null
          }
          // Landing just under a server's own row means its top level, which is otherwise
          // unreachable: every other destination is a folder, and "no folder" has no other row.
          if (parentKey === key && server !== undefined && canEdit) {
            return await callbacks.onDropInServer(server, null, draggedKey, beforeKey)
          }
          return null
        },
        canReparent: canEdit && !isLocal,
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
    if (!isExpanded(key) && needle === '') continue

    if (server !== undefined) {
      const rows = rowsFor(server)
      if (rows === undefined && server.status === 'connected') {
        if (!refreshedConnections.has(server)) {
          // Exactly one automatic attempt per verified connection. A failed request records an
          // error and waits for the explicit Retry button instead of scheduling itself forever.
          void refreshNodes(server, rerender)
        }
        if (refreshing.has(server)) {
          wrap.appendChild(childText('Loading folders…', 0))
        } else {
          const message = nodeErrors.get(server) ?? 'Could not load this server.'
          wrap.appendChild(
            childRetry(message, 0, () => {
              void refreshNodes(server, rerender, true)
            }),
          )
        }
        continue
      } else if (rows !== undefined) {
        const { nodes: known, templates: published } = rows

        /**
         * A drop anywhere in this server's tree, resolved to a folder.
         *
         * One handler for folder rows and template rows alike. Both used to carry their own, and
         * they disagreed: the template one refused a drop at the server's top level, which is a rule
         * about the thing being *dragged* rather than about the row it landed near. `dropOnServerNode`
         * already enforces it from the dragged key, which is the only place that knows.
         */
        const intoServer = (
          draggedKey: string,
          dropParent: string | null,
          beforeKey: string | null,
        ): Promise<string | null> => {
          const into =
            dropParent === null || dropParent === key
              ? null
              : known.find((node) => nodeTreeKey(server, node.id) === dropParent)?.id
          if (into === undefined) return Promise.resolve(null)
          return callbacks.onDropInServer(server, into, draggedKey, beforeKey)
        }

        /**
         * A server's folders and the templates hanging off them.
         *
         * The three things that make this different from Local live here and nowhere else: renaming
         * and re-parenting go over HTTP and are refused without admin scope, a template row is drawn
         * from the manifest before its pixels have finished downloading, and the switch is this
         * browser's own record rather than anything the server said.
         */
        const entries: Array<{ parentId: string | null; item: TreeItem }> = []
        for (const node of known) {
          const nodeTarget: TreeTarget = {
            server,
            nodeId: node.id,
            key: nodeTreeKey(server, node.id),
            name: node.name,
          }
          entries.push({
            parentId: node.parentId,
            item: {
              key: nodeTreeKey(server, node.id),
              name: node.name,
              kind: 'folder',
              childrenOf: node.id,
              createdAt: node.createdAt,
              visible: isScopeVisible(nodeScopeKey(server.url, node.id)),
              setVisible: (on) => {
                setScopeVisible(nodeScopeKey(server.url, node.id), on)
                return true
              },
              canReparent: canEdit,
              ...(canEdit ? { onDropAt: intoServer } : {}),
              ...(canEdit
                ? {
                    onContextMenu: (event: MouseEvent) =>
                      callbacks.onContextMenu(nodeTarget, event),
                  }
                : {}),
              ...(canEdit
                ? { onRename: (value: string) => callbacks.onRename(nodeTarget, value) }
                : {}),
              ...(canEdit
                ? {
                    actions: [
                      {
                        icon: 'createFolder' as const,
                        label: 'New folder',
                        run: () => callbacks.onCreateFolder(nodeTarget),
                      },
                      {
                        icon: 'uploadFile' as const,
                        label: 'Import template',
                        run: () => callbacks.onImportTemplate(nodeTarget),
                      },
                    ],
                  }
                : {}),
            },
          })
        }
        const drawnById = new Map(
          localTemplates()
            .filter((candidate) => candidate.serverUrl === server.url)
            .map((candidate) => [candidate.serverTemplateId, candidate]),
        )
        for (const template of published) {
          const drawn = drawnById.get(template.id)
          const visibilityKey = serverTemplateKey(server.url, template.id)
          const templateTarget: TreeTarget = {
            server,
            nodeId: template.nodeId,
            key: serverTemplateTreeKey(server, template.id),
            name: template.name,
            templateId: template.id,
          }
          entries.push({
            parentId: template.nodeId,
            item: {
              key: serverTemplateTreeKey(server, template.id),
              name: template.name,
              kind: 'image',
              childrenOf: null,
              createdAt: template.updatedAt,
              muted: !template.published,
              ...(template.published ? {} : { meta: 'unpublished' }),
              visible: drawn?.visible ?? isScopeVisible(visibilityKey),
              setVisible: (on) => {
                // Both stores, always. The scope key is the only one that outlives the page — a
                // server template is memory-only and is re-created from that key on the next load —
                // so writing only the live store meant switching one back on lasted until reload
                // and then silently undid itself.
                setScopeVisible(visibilityKey, on)
                if (drawn !== undefined) return setLocalVisible(drawn.id, on)
                return true
              },
              canReparent: canEdit,
              ...(canEdit ? { onDropAt: intoServer } : {}),
              ...(canEdit
                ? {
                    onContextMenu: (event: MouseEvent) =>
                      callbacks.onContextMenu(templateTarget, event),
                  }
                : {}),
              ...(canEdit
                ? { onRename: (value: string) => callbacks.onRename(templateTarget, value) }
                : {}),
            },
          })
        }
        const source = groupedSource(entries)
        const matches = matcherFor(source, needle)
        const hasMatches = source.children(null).some(matches)
        renderLevel(
          wrap,
          source,
          null,
          1,
          key,
          rerender,
          needle,
          rank,
          matches,
          budget,
          callbacks.onError,
          siblingLevels,
        )
        if (needle !== '' && !hasMatches) wrap.appendChild(childText('No matches.', 0))
        else if (known.length === 0 && published.length === 0)
          wrap.appendChild(childText('No templates published yet.', 0))
        const refreshError = nodeErrors.get(server)
        if (server.status === 'connected' && refreshError !== undefined) {
          wrap.appendChild(
            childRetry(refreshError, 0, () => {
              void refreshNodes(server, rerender, true)
            }),
          )
        }
        if (server.status === 'unreachable') {
          wrap.appendChild(childText(`Could not be reached. ${server.error ?? ''}`.trim(), 0))
        } else if (server.status === 'needs-token') {
          wrap.appendChild(childText('Needs an access token — add it in settings.', 0))
        }
        continue
      }
    }

    if (isLocal) {
      // Local means "only in this browser". Server templates share the store — everything that
      // draws them takes a `PlacedTemplate` and does not care where it came from — but they are
      // listed under the server publishing them, not here.
      const mine = localTemplates().filter((template) => !isServerTemplate(template))
      const entries: Array<{ parentId: string | null; item: TreeItem }> = []
      for (const folder of getState().localFolders) {
        const folderTarget: TreeTarget = {
          server: null,
          nodeId: null,
          key: `lf:${folder.id}`,
          name: folder.name,
        }
        entries.push({
          parentId: folder.parentId,
          item: {
            key: `lf:${folder.id}`,
            name: folder.name,
            kind: 'folder',
            childrenOf: folder.id,
            visible: folder.visible,
            setVisible: (on) => {
              setLocalFolderVisible(folder.id, on)
              return true
            },
            canReparent: true,
            onDropAt: callbacks.onMoveLocal,
            onContextMenu: (event) => callbacks.onContextMenu(folderTarget, event),
            onRename: (value) => callbacks.onRename(folderTarget, value),
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
          },
        })
      }
      for (const template of mine) {
        const templateTarget: TreeTarget = {
          server: null,
          nodeId: null,
          key: `local:${template.id}`,
          name: template.name,
        }
        entries.push({
          parentId: template.folderId ?? null,
          item: {
            key: `local:${template.id}`,
            name: template.name,
            kind: 'image',
            childrenOf: null,
            meta: `${template.width}×${template.height}`,
            visible: template.visible,
            setVisible: (on) => setLocalVisible(template.id, on),
            canReparent: true,
            onDropAt: callbacks.onMoveLocal,
            onContextMenu: (event) => callbacks.onContextMenu(templateTarget, event),
            onRename: (value) => callbacks.onRename(templateTarget, value),
            actions: [
              { icon: 'search', label: 'Go to', run: () => callbacks.onGoTo(template.id) },
              {
                icon: 'uploadFile',
                label: 'Copy to a server',
                run: () => callbacks.onCopyToServer(template.id),
              },
            ],
          },
        })
      }
      const source = groupedSource(entries)
      const matches = matcherFor(source, needle)
      const hasMatches = source.children(null).some(matches)
      renderLevel(
        wrap,
        source,
        null,
        1,
        'local',
        rerender,
        needle,
        rank,
        matches,
        budget,
        callbacks.onError,
        siblingLevels,
      )
      if (needle !== '' && !hasMatches) wrap.appendChild(childText('No matches.', 0))
      else if (mine.length === 0) wrap.appendChild(childText('No local templates yet.', 0))
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
      wrap.appendChild(childText('No templates published yet.', 0))
    } else if (server.status === 'needs-token') {
      wrap.appendChild(childText('Needs an access token — add it in settings.', 0))
    } else {
      wrap.appendChild(childText(`Could not be reached. ${server.error ?? ''}`.trim(), 0))
    }
  }

  if (budget.truncated) {
    wrap.appendChild(
      childText(
        `Showing the first ${MAX_RENDERED_ROWS.toLocaleString()} rows. Refine the search to see others.`,
        0,
      ),
    )
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

  if (renaming !== null && wrap.querySelector('[data-caelestis-rename]') === null) {
    renaming = null
    renameDraft = null
  }

  const rows = [...wrap.querySelectorAll<HTMLElement>('[role="treeitem"][data-caelestis-key]')]
  const active = rows.find((row) => row.dataset.caelestisKey === activeTreeKey) ?? rows[0]
  const activate = (row: HTMLElement): void => {
    for (const candidate of rows) {
      candidate.tabIndex = candidate === row ? 0 : -1
      for (const control of candidate.querySelectorAll<HTMLElement>('button,input')) {
        control.tabIndex = candidate === row ? 0 : -1
      }
    }
    activeTreeKey = row.dataset.caelestisKey ?? null
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
        row.dataset.caelestisForceExpanded === undefined
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
