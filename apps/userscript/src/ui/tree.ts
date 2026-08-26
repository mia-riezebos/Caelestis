import { cacheServer, loadServerCache, type ServerTemplate } from '../server-cache.js'
import {
  admitServerContents,
  admittedServerContentsFor,
  type ConnectedServer,
  getState,
  isCurrentServerConnection,
  isScopeVisible,
  listServerContents,
  MAX_MANIFEST_CHUNKS,
  MAX_MANIFEST_TEMPLATES,
  MAX_TREE_NODES,
  onServerContents,
  type ServerContents,
  setLocalFolderVisible,
  setScopeVisible,
  setState,
  type TreeNode,
  takeProbedNodes,
} from '../state.js'
import { serverColourProgressFor, serverProgressFor } from '../telemetry.js'
import {
  isServerTemplate,
  localTemplates,
  type PlacedTemplate,
  setLocalVisible,
} from '../templates/local-store.js'
import {
  colourProgressFor,
  mismatchRevision,
  progressFor,
  type TemplateColourProgress,
  type TemplateProgress,
} from '../templates/mismatch.js'
import { nodeScopeKey, rememberNodes } from '../templates/server-nodes.js'
import {
  rejectServerContentsForSync,
  serverTemplateKey,
  syncServerTemplates,
} from '../templates/server-sync.js'
import { type IconName, icon } from './icons.js'
import {
  colourProgressDetails,
  completionRatio,
  emptyProgress,
  freshestColourProgress,
  freshestProgress,
  progressIndicator,
  sumColourProgress,
  sumProgress,
} from './progress.js'
import { isReorderable } from './sort.js'

/**
 * The tree: one root per source, plus `Local`.
 *
 * Row anatomy, left to right: **optional caret, kind icon, persistent navigation, name, meta, row
 * actions, checkbox**. Expandable rows earn the caret's space; leaves rely on their depth indent
 * rather than carrying an empty control slot. The checkbox trails because it is what you act on
 * once you have found the row. Secondary actions sit just inside it and appear on hover, while
 * navigation stays visible at the row's leading edge.
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

/** @internal Arithmetic seam for the aggregate cost of all connected manifest rows. */
export const manifestAggregateWithinBudget = (
  retainedTemplates: number,
  retainedChunks: number,
  nextTemplates: number,
  nextChunks: number,
): boolean =>
  retainedTemplates + nextTemplates <= MAX_MANIFEST_TEMPLATES &&
  retainedChunks + nextChunks <= MAX_MANIFEST_CHUNKS

export interface TreeCallbacks {
  readonly onAddServer: () => void
  readonly onCreateFolder: (target: TreeTarget) => void
  readonly onImportTemplate: (target: TreeTarget) => void
  readonly onRename: (target: TreeTarget, name: string) => void
  readonly onContextMenu: (target: TreeTarget, event: MouseEvent) => void
  /** Frame a local or not-yet-downloaded server template on the map. */
  readonly onGoTo: (target: TreeNavigationTarget) => void
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

export type TreeNavigationTarget =
  | { readonly kind: 'local'; readonly templateId: string }
  | { readonly kind: 'server'; readonly bbox: ServerTemplate['bbox'] }

let activeTreeKey: string | null = null
/** The row currently being renamed, if any. Inline editing beats a modal for a one-field change. */
let renaming: string | null = null
let renameDraft: {
  key: string
  value: string
  selectionStart: number
  selectionEnd: number
} | null = null
type ProgressDisclosure = 'expanded' | 'colours'
/** Per-row disclosure is session UI state, not an appearance preference. */
const progressDisclosure = new Map<string, ProgressDisclosure>()
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
const NO_SERVER_TEMPLATES: readonly ServerTemplate[] = []
/** Verified identity belonging to the rows cached at each URL. */
const rowIdentityByServer = new Map<string, string>()

interface OptimisticParent {
  readonly parentId: string | null
  readonly token: symbol
}

/**
 * Parent changes that the server has not answered yet.
 *
 * These are deliberately a render overlay rather than a rewrite of the manifest cache. A failed
 * request can therefore reveal the latest authoritative row again, while an unrelated manifest
 * refresh cannot make an in-flight drag visibly snap back.
 */
const optimisticParents = new Map<string, OptimisticParent>()

const renderedParent = (key: string, serverParent: string | null): string | null => {
  const optimistic = optimisticParents.get(key)
  return optimistic === undefined ? serverParent : optimistic.parentId
}

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

export interface OptimisticServerPlacement {
  /** Keep the eager position after the server confirms it. */
  readonly commit: () => void
  /** Reveal the latest server position after the final request attempt fails. */
  readonly rollback: () => void
}

/**
 * Put an existing row at its requested server parent before the PATCH makes a round trip.
 *
 * A token makes overlapping moves safe: a late answer for an older drag cannot commit or roll back
 * the newer one. Committing updates only the cached parent field; the normal manifest refresh then
 * supplies canonical paths and any other server-derived fields.
 */
export const optimisticallyPlaceServerRow = (
  server: ConnectedServer,
  key: string,
  parentId: string | null,
): OptimisticServerPlacement | null => {
  const rows = rowsFor(server)
  if (rows === undefined) return null
  const token = Symbol(key)
  const node = rows.nodes.find((candidate) => nodeTreeKey(server, candidate.id) === key)
  const template = rows.templates.find(
    (candidate) => serverTemplateTreeKey(server, candidate.id) === key,
  )
  if (node === undefined && template === undefined) return null
  optimisticParents.set(key, { parentId, token })

  const current = (): boolean => optimisticParents.get(key)?.token === token
  return {
    commit: () => {
      if (!current()) return
      if (node !== undefined) {
        const latest = nodesByServer.get(server.url)
        if (latest !== undefined) {
          const moved = latest.map((candidate) =>
            candidate.id === node.id ? { ...candidate, parentId } : candidate,
          )
          nodesByServer.set(server.url, moved)
          rememberNodes(server.url, moved)
        }
      } else if (template !== undefined) {
        const latest = templatesByServer.get(server.url)
        if (latest !== undefined) {
          templatesByServer.set(
            server.url,
            latest.map((candidate) =>
              candidate.id === template.id ? { ...candidate, nodeId: parentId } : candidate,
            ),
          )
        }
      }
      optimisticParents.delete(key)
    },
    rollback: () => {
      if (current()) optimisticParents.delete(key)
    },
  }
}

interface OrderedItem {
  readonly key: string
  readonly name: string
  readonly createdAt?: number
  /** Absent for structural rows; progress sorting leaves those in their durable slots. */
  readonly progress?: TemplateProgress | undefined
  /** Aggregated folder progress is display-only; only leaves move under progress sorting. */
  readonly progressSortable?: true | undefined
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
  const custom = [...ranked.map(({ item }) => item), ...unranked]
  if (getState().sort.field !== 'progress') return custom.slice(0, bounded)

  // A folder is a place, not a score. Preserve every structural slot from the user's own order and
  // sort only template rows among the slots templates already occupy. That keeps the hierarchy
  // legible while still bringing the least/most complete work together at every sibling level.
  const direction = getState().sort.direction === 'desc' ? -1 : 1
  const templates = custom
    .filter(
      (item): item is T & { readonly progress: TemplateProgress } =>
        item.progressSortable === true && item.progress !== undefined,
    )
    .sort(
      (a, b) =>
        direction * (completionRatio(a.progress) - completionRatio(b.progress)) ||
        NAME_COLLATOR.compare(a.name, b.name) ||
        a.key.localeCompare(b.key),
    )
  let templateAt = 0
  return custom
    .map((item) => (item.progressSortable !== true ? item : (templates[templateAt++] ?? item)))
    .slice(0, bounded)
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

/** The immutable manifest template array currently backing one server's tree rows. */
export const templatesForServer = (serverUrl: string): readonly ServerTemplate[] => {
  const server = getState().servers.find((candidate) => candidate.url === serverUrl)
  return server === undefined
    ? NO_SERVER_TEMPLATES
    : (rowsFor(server)?.templates ?? NO_SERVER_TEMPLATES)
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

const serverUrlForTreeParent = (key: string | null): string | null => {
  if (key === null) return null
  if (key.startsWith('server:')) return key.slice('server:'.length)
  return findServerNode(key)?.serverUrl ?? null
}

const isSameServerPlacement = (draggedKey: string, parentKey: string | null): boolean => {
  const sourceUrl = draggedKey.startsWith('st:')
    ? findServerTemplate(draggedKey)?.serverUrl
    : draggedKey.startsWith('node:')
      ? findServerNode(draggedKey)?.serverUrl
      : undefined
  return sourceUrl !== undefined && sourceUrl === serverUrlForTreeParent(parentKey)
}

/** What a server publishes directly inside one folder. */
export const templatesOfNode = (
  serverUrl: string,
  nodeId: string,
): ReadonlyArray<{ id: string; name: string; version: string }> => {
  return templatesForServer(serverUrl).filter((template) => template.nodeId === nodeId)
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
export type ServerSnapshotResult =
  | { readonly status: 'admitted'; readonly changed: boolean }
  | { readonly status: 'refused' | 'failed' | 'superseded'; readonly message: string }

const snapshotResults = new WeakMap<ServerContents, ServerSnapshotResult>()
const snapshotListeners = new Set<(server: ConnectedServer, result: ServerSnapshotResult) => void>()

export const onServerSnapshot = (
  listener: (server: ConnectedServer, result: ServerSnapshotResult) => void,
): (() => void) => {
  snapshotListeners.add(listener)
  return () => snapshotListeners.delete(listener)
}

type RememberResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly message: string; readonly superseded?: true }

const refreshing = new WeakMap<ConnectedServer, Promise<ServerSnapshotResult>>()
const refreshControllers = new Map<string, AbortController>()
const refreshedConnections = new WeakSet<ConnectedServer>()
const nodeErrors = new WeakMap<ConnectedServer, string>()
const refreshGeneration = new Map<string, number>()

export const refreshServerSnapshot = async (
  server: ConnectedServer,
  rerender: () => void,
  force = false,
): Promise<ServerSnapshotResult> => {
  if (!isCurrentServerConnection(server)) {
    return {
      status: 'superseded',
      message: 'The server connection changed before refresh.',
    }
  }
  const pending = refreshing.get(server)
  if (!force && pending !== undefined) {
    const result = await pending
    queueMicrotask(rerender)
    return result
  }
  const generation = (refreshGeneration.get(server.url) ?? 0) + 1
  refreshGeneration.set(server.url, generation)
  refreshControllers.get(server.url)?.abort(new Error('superseded by a newer refresh'))
  const controller = new AbortController()
  refreshControllers.set(server.url, controller)
  refreshedConnections.add(server)
  const run = refreshOnce(server, generation, controller.signal)
  refreshing.set(server, run)
  const result = await run
  if (refreshing.get(server) === run) refreshing.delete(server)
  if (refreshControllers.get(server.url) === controller) refreshControllers.delete(server.url)
  if (result.status === 'admitted') nodeErrors.delete(server)
  else if (result.status !== 'superseded') nodeErrors.set(server, result.message)
  queueMicrotask(rerender)
  return result
}

const refreshOnce = async (
  server: ConnectedServer,
  generation: number,
  signal: AbortSignal,
): Promise<ServerSnapshotResult> => {
  const contents = await listServerContents(server, signal)
  const current = getState().servers.find((candidate) => candidate.url === server.url)
  if (current === undefined || !isCurrentServerConnection(server)) {
    return {
      status: 'superseded',
      message: 'The server connection changed during refresh.',
    }
  }
  if (refreshGeneration.get(server.url) !== generation) {
    return {
      status: 'superseded',
      message: 'A newer refresh replaced this one.',
    }
  }
  // Unreachable, so nothing is known. The tree keeps drawing what the cache says rather than
  // emptying itself — a server that blinks should not take its folders off your screen.
  if (contents === null) return { status: 'failed', message: 'Could not refresh this server.' }
  return acceptServerSnapshot(server, contents)
}

const sameNode = (left: TreeNode, right: TreeNode): boolean =>
  left.id === right.id &&
  left.parentId === right.parentId &&
  left.path === right.path &&
  left.name === right.name &&
  left.createdAt === right.createdAt

const sameTemplate = (left: ServerTemplate, right: ServerTemplate): boolean =>
  left.id === right.id &&
  left.nodeId === right.nodeId &&
  left.name === right.name &&
  left.version === right.version &&
  left.totalPixels === right.totalPixels &&
  left.published === right.published &&
  left.updatedAt === right.updatedAt &&
  left.bbox.minX === right.bbox.minX &&
  left.bbox.minY === right.bbox.minY &&
  left.bbox.maxX === right.bbox.maxX &&
  left.bbox.maxY === right.bbox.maxY &&
  left.chunks.length === right.chunks.length &&
  left.chunks.every(
    (chunk, index) =>
      chunk.tile === right.chunks[index]?.tile && chunk.hash === right.chunks[index]?.hash,
  )

const sameRows = <T>(
  left: readonly T[],
  right: readonly T[],
  same: (left: T, right: T) => boolean,
): boolean =>
  left.length === right.length && left.every((entry, index) => same(entry, right[index] as T))

/** Retain one live manifest for the tree, irrespective of which consumer requested it. */
const rememberServerContents = (
  server: ConnectedServer,
  contents: ServerContents,
): RememberResult => {
  const current = getState().servers.find((candidate) => candidate.url === server.url)
  if (current === undefined || !isCurrentServerConnection(server)) {
    return {
      ok: false,
      message: 'The server connection changed during refresh.',
      superseded: true,
    }
  }
  const { nodes, templates } = contents
  const identity = serverIdentity(server)
  if (identity === null) return { ok: false, message: 'The server identity is unavailable.' }
  // The public manifest is now the authoritative snapshot. Retaining the connect-time copy lets a
  // later admin-only consumer resurrect older folders after this refresh has already succeeded.
  takeProbedNodes(server)
  let retainedNodes = 0
  let retainedTemplates = 0
  let retainedChunks = 0
  for (const candidate of getState().servers) {
    if (candidate.url === server.url) continue
    const retained = rowsFor(candidate)
    retainedNodes += retained?.nodes.length ?? 0
    retainedTemplates += retained?.templates.length ?? 0
    retainedChunks +=
      retained?.templates.reduce((total, template) => total + template.chunks.length, 0) ?? 0
  }
  if (retainedNodes + nodes.length > MAX_TREE_NODES) {
    return {
      ok: false,
      message: `Connected server folders exceed the ${MAX_TREE_NODES.toLocaleString()}-node client limit.`,
    }
  }
  const nextChunks = templates.reduce((total, template) => total + template.chunks.length, 0)
  if (
    !manifestAggregateWithinBudget(retainedTemplates, retainedChunks, templates.length, nextChunks)
  ) {
    return {
      ok: false,
      message: 'Connected server templates exceed the client manifest memory budget.',
    }
  }
  const previous = rowsFor(server)
  if (
    previous !== undefined &&
    sameRows(previous.nodes, nodes, sameNode) &&
    sameRows(previous.templates, templates, sameTemplate)
  ) {
    // Keep the newest parsed arrays as the shared tree/canvas authority without paying for a redraw.
    // The equivalent prior arrays can then be collected instead of living beside the sync baton.
    nodesByServer.set(server.url, nodes)
    templatesByServer.set(server.url, templates)
    rowIdentityByServer.set(server.url, identity)
    return { ok: true, changed: false }
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
  return { ok: true, changed: true }
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
  const nodePrefix = `node:${encodeURIComponent(serverUrl)}:`
  const templatePrefix = `st:${encodeURIComponent(serverUrl)}:`
  for (const key of optimisticParents.keys()) {
    if (key.startsWith(nodePrefix) || key.startsWith(templatePrefix)) optimisticParents.delete(key)
  }
  refreshControllers.get(serverUrl)?.abort(new Error('server disconnected'))
  refreshControllers.delete(serverUrl)
  refreshGeneration.delete(serverUrl)
  return hashes
}

/**
 * Admit one fetched manifest as the shared tree and canvas authority.
 *
 * Refused snapshots never displace the last admitted rows. If admission becomes stale after row
 * publication, the previous snapshot is restored before its canvas reconciliation is queued.
 */
export const acceptServerSnapshot = (
  server: ConnectedServer,
  contents: ServerContents,
): ServerSnapshotResult => {
  const cached = snapshotResults.get(contents)
  if (cached !== undefined) return cached
  const accepted = admittedServerContentsFor(server)
  const remembered = rememberServerContents(server, contents)
  let result: ServerSnapshotResult
  if (!remembered.ok) {
    rejectServerContentsForSync(contents)
    if (accepted !== null) {
      void syncServerTemplates(
        server,
        accepted.templates,
        () => admittedServerContentsFor(server) === accepted,
      )
    }
    result = remembered.superseded
      ? { status: 'superseded', message: remembered.message }
      : { status: 'refused', message: remembered.message }
  } else if (!admitServerContents(server, contents)) {
    rejectServerContentsForSync(contents)
    if (accepted === null) forgetServerRows(server.url)
    else {
      rememberServerContents(server, accepted)
      void syncServerTemplates(
        server,
        accepted.templates,
        () => admittedServerContentsFor(server) === accepted,
      )
    }
    result = { status: 'superseded', message: 'A newer manifest replaced this one.' }
  } else {
    void syncServerTemplates(
      server,
      contents.templates,
      () => admittedServerContentsFor(server) === contents,
    )
    result = { status: 'admitted', changed: remembered.changed }
  }
  snapshotResults.set(contents, result)
  for (const listener of snapshotListeners) listener(server, result)
  return result
}

// Every successful manifest crosses the same authority, irrespective of which poll or UI action
// requested it. The listener runs before listServerContents resolves to its caller.
onServerContents(acceptServerSnapshot)

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
  setState({
    customOrder: replaceSiblingOrder(getState().customOrder, affectedKeys, next),
  })
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
let dragging: {
  key: string
  parentKey: string | null
  canReparent: boolean
} | null = null

/** Keep server or local refreshes from replacing a row while the browser is dragging it. */
export const isTreeDragActive = (): boolean => dragging !== null

let dropTarget: {
  readonly parentKey: string | null
  readonly beforeKey: string | null
  readonly apply: (draggedKey: string, parentKey: string | null, beforeKey: string | null) => void
  readonly rerender: () => void
} | null = null

/** Apply the placement represented by the visible portal, regardless of which pixel receives drop. */
const applyArmedDrop = (event: DragEvent, root: ParentNode): boolean => {
  const target = dropTarget
  if (target === null) return false
  event.preventDefault()
  event.stopPropagation()
  const from = event.dataTransfer?.getData('text/plain')
  clearDropMarks(root)
  dropTarget = null
  dragging = null
  if (from === undefined || from === '' || from === target.beforeKey) return true
  target.apply(from, target.parentKey, target.beforeKey)
  target.rerender()
  return true
}

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
    applyArmedDrop(event, el.parentElement ?? document)
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
 * Above or below a row means "before" or "after" at its own level. The middle of a container means
 * "inside" even when it is collapsed. Without that target, dropping a Local template on a server
 * folder resolved beside the folder at the server root, where templates are invalid; it then
 * snapped back without making a request.
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
  const isContainer = row.dataset.caelestisContainer !== undefined
  const offset = box.height <= 0 ? (clientY < box.top ? 0 : 1) : (clientY - box.top) / box.height

  if (isContainer && key !== null && offset >= 0.3 && offset <= 0.7) {
    const next = row.nextElementSibling
    const firstChild =
      next instanceof HTMLElement && Number(next.dataset.caelestisDepth ?? 0) > depth
        ? (next.dataset.caelestisKey ?? null)
        : null
    return {
      parentKey: key,
      beforeKey: firstChild,
      depth: depth + 1,
      before: next,
    }
  }

  if (above) return { parentKey, beforeKey: key, depth, before: row }

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

interface RowAction {
  readonly icon: IconName
  readonly label: string
  readonly run: () => void
}

interface RowOptions {
  readonly key: string
  readonly name: string
  readonly kind: IconName
  readonly depth: number
  /** One continuation flag per visible tree column, ending with this row's sibling branch. */
  readonly branches?: readonly boolean[] | undefined
  readonly meta?: string
  readonly progress?: TemplateProgress
  readonly progressReader?: (() => TemplateProgress) | undefined
  readonly colourProgress?: (() => readonly TemplateColourProgress[] | undefined) | undefined
  readonly leadingActions?:
    | ReadonlyArray<{ icon: IconName; label: string; run: () => void }>
    | undefined
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
  readonly actions?: readonly RowAction[] | undefined
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

const TREE_COLUMN = 18
const DISCLOSURE_SLOT_WIDTH = 20
const CONNECTOR_MIDPOINT = 18

/** TUI-style tree pipes, drawn as vectors so an absent disclosure control reads as hierarchy. */
const treeConnector = (
  branches: readonly boolean[],
  leaf: boolean,
): { element: SVGSVGElement; width: number } | null => {
  if (branches.length === 0) return null
  const width = branches.length * TREE_COLUMN + (leaf ? DISCLOSURE_SLOT_WIDTH : 0)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('caelestis-tree-connector')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('width', String(width))
  svg.style.width = `${width}px`

  const line = (x1: number, y1: string, x2: number, y2: string): void => {
    const segment = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    segment.setAttribute('x1', String(x1))
    segment.setAttribute('y1', y1)
    segment.setAttribute('x2', String(x2))
    segment.setAttribute('y2', y2)
    segment.setAttribute('vector-effect', 'non-scaling-stroke')
    svg.appendChild(segment)
  }

  for (let index = 0; index < branches.length - 1; index++) {
    if (branches[index] === true) {
      const x = index * TREE_COLUMN + TREE_COLUMN / 2
      line(x, '0', x, '100%')
    }
  }
  const current = branches.length - 1
  const x = current * TREE_COLUMN + TREE_COLUMN / 2
  line(x, '0', x, branches[current] === true ? '100%' : String(CONNECTOR_MIDPOINT))
  line(x, String(CONNECTOR_MIDPOINT), width - 4, String(CONNECTOR_MIDPOINT))
  return { element: svg, width }
}

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
  row.style.marginInline = '0.25rem 0.5rem'
  const connector = treeConnector(options.branches ?? [], !options.container)
  if (connector !== null) {
    row.style.paddingInlineStart = `calc(0.5rem + ${connector.width}px)`
    row.appendChild(connector.element)
  }
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
  }

  const kind = icon(options.kind, 'size-4 opacity-60')
  kind.style.flex = '0 0 auto'
  row.appendChild(kind)

  if (options.leadingActions !== undefined) {
    const group = document.createElement('span')
    group.className = 'caelestis-leading-actions flex items-center'
    group.style.flex = '0 0 auto'
    for (const action of options.leadingActions) {
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

  const requestedDisclosure = progressDisclosure.get(options.key)
  const hasProgress = options.progress !== undefined
  const canShowExpandedProgress = hasProgress && (!options.container || expanded)
  const resolvedColourProgress =
    canShowExpandedProgress && requestedDisclosure === 'colours'
      ? options.colourProgress?.()
      : undefined
  const disclosure: 'inline' | ProgressDisclosure =
    !canShowExpandedProgress || requestedDisclosure === undefined
      ? 'inline'
      : requestedDisclosure === 'colours' && (resolvedColourProgress?.length ?? 0) === 0
        ? 'expanded'
        : requestedDisclosure
  const progressPlacement = disclosure === 'inline' ? 'inline' : 'expanded'
  const alignExpandedDetail = (element: HTMLElement): HTMLElement => {
    if (!options.container) return element
    // The header consumes a real caret here. Expanded details do not, so carry the slot into their
    // own inline start rather than making container details appear one level shallower than leaves.
    const width = `calc(100% - ${DISCLOSURE_SLOT_WIDTH}px)`
    element.style.flexBasis = width
    element.style.width = width
    element.style.marginInlineStart = `${DISCLOSURE_SLOT_WIDTH}px`
    return element
  }
  let progressElement: HTMLElement | null = null
  if (options.progress !== undefined) {
    if (progressPlacement === 'expanded') {
      row.classList.add('caelestis-row--expanded-progress')
    }
    progressElement = progressIndicator(options.progress, progressPlacement, options.progressReader)
  }

  const progressActions: RowAction[] = []
  let colourProgressAction: RowAction | null = null
  if (hasProgress) {
    if (disclosure === 'inline') {
      progressActions.push({
        icon: 'expandMore',
        label: 'Expand progress',
        run: () => {
          if (options.container && !expanded) {
            setState({ collapsed: getState().collapsed.filter((key) => key !== options.key) })
          }
          progressDisclosure.set(options.key, 'expanded')
          options.rerender()
        },
      })
    } else {
      progressActions.push({
        icon: 'expandLess',
        label: 'Collapse progress',
        run: () => {
          progressDisclosure.delete(options.key)
          options.rerender()
        },
      })
      if (options.colourProgress !== undefined) {
        colourProgressAction = {
          icon: 'palette',
          label: disclosure === 'colours' ? 'Hide colour progress' : 'Show colour progress',
          run: () => {
            progressDisclosure.set(options.key, disclosure === 'colours' ? 'expanded' : 'colours')
            options.rerender()
          },
        }
      }
    }
  }

  const actionButton = (action: RowAction): HTMLButtonElement => {
    const button = document.createElement('button')
    button.className = 'btn btn-ghost btn-xs btn-circle'
    button.title = action.label
    button.setAttribute('aria-label', action.label)
    button.appendChild(icon(action.icon, 'size-4'))
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      action.run()
    })
    return button
  }

  let actionElement: HTMLElement | null = null
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
    actionElement = group
  } else {
    const actions = [...(options.actions ?? []), ...progressActions]
    if (actions.length === 0) {
      actionElement = null
    } else {
      const group = document.createElement('span')
      group.className = 'caelestis-actions flex items-center gap-0.5'
      group.style.flex = '0 0 auto'
      for (const action of actions) group.appendChild(actionButton(action))
      actionElement = group
    }
  }

  let renderedProgressElement = progressElement
  if (progressPlacement === 'expanded' && progressElement !== null) {
    let expandedDetail: HTMLElement = progressElement
    if (!editing && colourProgressAction !== null) {
      const line = document.createElement('span')
      line.className = 'caelestis-progress-disclosure'
      const detailActions = document.createElement('span')
      detailActions.className = 'caelestis-progress-detail-actions'
      detailActions.appendChild(actionButton(colourProgressAction))
      line.append(progressElement, detailActions)
      expandedDetail = line
    }
    renderedProgressElement = alignExpandedDetail(expandedDetail)
  }

  if (
    progressPlacement === 'inline' &&
    renderedProgressElement !== null &&
    actionElement?.classList.contains('caelestis-actions') === true
  ) {
    const tail = document.createElement('span')
    tail.className = 'caelestis-row-tail'
    tail.append(renderedProgressElement, actionElement)
    row.appendChild(tail)
  } else {
    if (renderedProgressElement !== null) row.appendChild(renderedProgressElement)
    if (actionElement !== null) row.appendChild(actionElement)
  }
  if (disclosure === 'colours' && resolvedColourProgress !== undefined) {
    row.appendChild(
      alignExpandedDetail(colourProgressDetails(resolvedColourProgress, options.colourProgress)),
    )
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
          const previousOrder = getState().customOrder
          let optimisticOrder: readonly string[] | null = null
          if (isSameServerPlacement(draggedKey, parentKey)) {
            const result = placeAmongVisibleSiblings(
              destination.visible,
              destination.all(),
              draggedKey,
              beforeKey,
              true,
            )
            if (result === 'too-many') {
              options.onError(
                'The row was moved, but this level has too many rows to save a custom order safely.',
              )
            } else {
              optimisticOrder = getState().customOrder
            }
          }
          const rollBackOrder = (): void => {
            if (
              optimisticOrder !== null &&
              getState().customOrder.length === optimisticOrder.length &&
              getState().customOrder.every((key, index) => key === optimisticOrder?.[index])
            ) {
              setState({ customOrder: previousOrder })
            }
          }
          void place(draggedKey, parentKey, beforeKey).then(
            (destinationKey) => {
              if (destinationKey === null) {
                rollBackOrder()
                options.rerender()
                return
              }
              if (optimisticOrder !== null && destinationKey === draggedKey) return
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
              rollBackOrder()
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
    event.stopPropagation()
    const parent = row.parentElement
    if (applyArmedDrop(event, parent ?? document)) return
    const from = event.dataTransfer?.getData('text/plain')
    if (parent !== null) clearDropMarks(parent)
    dropTarget = null
    if (from === undefined || from === '') return
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
  readonly progress?: TemplateProgress
  readonly progressReader?: (() => TemplateProgress) | undefined
  readonly colourProgress?: (() => readonly TemplateColourProgress[]) | undefined
  /**
   * Kept out of every ancestor rollup while still showing its own meter — an unpublished template
   * is visible to the admin looking at it, but a draft must not drag a folder's aggregate down
   * before the template exists for anyone else.
   */
  readonly excludeFromRollup?: true
  readonly progressSortable?: true
  readonly muted?: boolean | undefined
  readonly visible: boolean
  readonly setVisible: (on: boolean) => boolean | Promise<boolean>
  readonly canReparent: boolean
  readonly actions?: ReadonlyArray<{ icon: IconName; label: string; run: () => void }> | undefined
  readonly leadingActions?:
    | ReadonlyArray<{ icon: IconName; label: string; run: () => void }>
    | undefined
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
  readonly progress: (parentId: string | null) => TemplateProgress | undefined
  readonly colourProgress: (
    parentId: string | null,
  ) => readonly TemplateColourProgress[] | undefined
}

const groupedSource = (
  entries: ReadonlyArray<{
    readonly parentId: string | null
    readonly item: TreeItem
  }>,
): TreeSource => {
  const byParent = new Map<string | null, TreeItem[]>()
  for (const { parentId, item } of entries) {
    const siblings = byParent.get(parentId) ?? []
    siblings.push(item)
    byParent.set(parentId, siblings)
  }
  const totals = new Map<string | null, TemplateProgress | undefined>()
  const colourTotals = new Map<string | null, readonly TemplateColourProgress[] | undefined>()
  const colourAvailability = new Map<string | null, boolean>()
  const visiting = new Set<string | null>()
  const colourVisiting = new Set<string | null>()
  let revision = mismatchRevision()
  const ensureCurrentRevision = (): void => {
    const current = mismatchRevision()
    if (current === revision) return
    revision = current
    totals.clear()
    colourTotals.clear()
  }
  const progress = (parentId: string | null): TemplateProgress | undefined => {
    ensureCurrentRevision()
    if (totals.has(parentId)) return totals.get(parentId)
    if (visiting.has(parentId)) return undefined
    visiting.add(parentId)
    const descendants: TemplateProgress[] = []
    for (const item of byParent.get(parentId) ?? []) {
      if (item.excludeFromRollup === true) continue
      const itemProgress =
        item.childrenOf === null
          ? (item.progressReader?.() ?? item.progress)
          : progress(item.childrenOf)
      if (itemProgress !== undefined) descendants.push(itemProgress)
    }
    visiting.delete(parentId)
    const total = sumProgress(descendants)
    totals.set(parentId, total)
    return total
  }
  const hasColourProgress = (parentId: string | null): boolean => {
    const cached = colourAvailability.get(parentId)
    if (cached !== undefined) return cached
    if (colourVisiting.has(parentId)) return false
    colourVisiting.add(parentId)
    let found = false
    let available = true
    for (const item of byParent.get(parentId) ?? []) {
      if (item.excludeFromRollup === true) continue
      const overall = item.childrenOf === null ? item.progress : progress(item.childrenOf)
      if (overall === undefined) continue
      found = true
      const itemAvailable =
        item.childrenOf === null
          ? item.colourProgress !== undefined
          : hasColourProgress(item.childrenOf)
      if (!itemAvailable) {
        available = false
        break
      }
    }
    colourVisiting.delete(parentId)
    const result = found && available
    colourAvailability.set(parentId, result)
    return result
  }
  const colourProgress = (
    parentId: string | null,
  ): readonly TemplateColourProgress[] | undefined => {
    ensureCurrentRevision()
    if (colourTotals.has(parentId)) return colourTotals.get(parentId)
    if (!hasColourProgress(parentId)) return undefined
    if (colourVisiting.has(parentId)) return undefined
    colourVisiting.add(parentId)
    const descendants: Array<readonly TemplateColourProgress[]> = []
    for (const item of byParent.get(parentId) ?? []) {
      if (item.excludeFromRollup === true) continue
      const itemProgress =
        item.childrenOf === null ? item.colourProgress?.() : colourProgress(item.childrenOf)
      if (itemProgress !== undefined) descendants.push(itemProgress)
    }
    colourVisiting.delete(parentId)
    const total = sumColourProgress(descendants)
    const overall = progress(parentId)
    const complete =
      total !== undefined &&
      overall !== undefined &&
      total.reduce((sum, entry) => sum + entry.total, 0) === overall.total
        ? total
        : undefined
    colourTotals.set(parentId, complete)
    return complete
  }
  return {
    children: (parentId) =>
      (byParent.get(parentId) ?? []).map((item) => {
        if (item.childrenOf === null) return item
        const total = progress(item.childrenOf)
        const hasColours = hasColourProgress(item.childrenOf)
        return {
          ...item,
          ...(total === undefined
            ? {}
            : { progress: total, progressReader: () => progress(item.childrenOf) ?? total }),
          ...(hasColours ? { colourProgress: () => colourProgress(item.childrenOf) ?? [] } : {}),
        }
      }),
    progress,
    colourProgress,
  }
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

const childText = (text: string, depth: number, branches: readonly boolean[] = []): HTMLElement => {
  const el = document.createElement('p')
  el.setAttribute('role', 'treeitem')
  el.setAttribute('aria-level', String(depth + 2))
  el.setAttribute('aria-disabled', 'true')
  el.className = 'text-xs opacity-60'
  el.style.padding = '0.125rem 0.75rem 0.375rem'
  el.dataset.caelestisDepth = String(depth)
  const connector = treeConnector(branches, true)
  if (connector === null) {
    el.style.paddingInlineStart = `${2.5 + depth * 1.125}rem`
    el.textContent = text
  } else {
    el.style.position = 'relative'
    el.style.marginInline = '0.25rem 0.5rem'
    el.style.paddingInlineStart = `calc(0.5rem + ${connector.width}px)`
    const label = document.createElement('span')
    label.textContent = text
    el.append(connector.element, label)
  }
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
  ancestorBranches: readonly boolean[],
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

  for (const [index, item] of items.entries()) {
    if (budget.remaining <= 0) {
      budget.truncated = true
      break
    }
    const key = item.key
    const branches = [...ancestorBranches, index < items.length - 1]
    into.appendChild(
      treeRow({
        key,
        name: item.name,
        kind: item.kind,
        depth,
        branches,
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
        ...(item.progress === undefined ? {} : { progress: item.progress }),
        ...(item.progressReader === undefined ? {} : { progressReader: item.progressReader }),
        ...(item.colourProgress === undefined ? {} : { colourProgress: item.colourProgress }),
        ...(item.leadingActions === undefined ? {} : { leadingActions: item.leadingActions }),
        ...(item.muted === undefined ? {} : { muted: item.muted }),
        ...(item.actions === undefined ? {} : { actions: item.actions }),
        ...(item.onRename === undefined ? {} : { onRename: item.onRename }),
        ...(item.onContextMenu === undefined ? {} : { onContextMenu: item.onContextMenu }),
        ...(item.onDropAt === undefined ? {} : { onDropAt: item.onDropAt }),
      }),
    )
    budget.remaining--
    if (item.childrenOf === null) continue
    if (needle === '' && !isExpanded(key)) {
      const childSiblings = source.children(item.childrenOf)
      const visibleChildren = orderedItems(childSiblings.filter(matches), rank).map(
        (child) => child.key,
      )
      siblingLevels.set(key, {
        visible: visibleChildren,
        all: () => orderedItems(childSiblings, rank).map((child) => child.key),
      })
      continue
    }
    renderLevel(
      into,
      source,
      item.childrenOf,
      depth + 1,
      key,
      branches,
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
  if (parentId !== null && matching.length === 0) {
    into.appendChild(childText('Empty.', depth, [...ancestorBranches, false]))
  }
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
  // CSS `gap` paints real pixels between the row and the portal. The portal remains the visible
  // promise across those pixels, so the tree owns the final drop whenever a placement is armed.
  wrap.addEventListener('dragover', (event) => {
    if (dropTarget !== null) event.preventDefault()
  })
  wrap.addEventListener('drop', (event) => {
    applyArmedDrop(event, wrap)
  })

  const servers = getState().servers
  const drawnTemplates = localTemplates()
  const localOnly = drawnTemplates.filter((template) => !isServerTemplate(template))
  const drawnByServer = new Map<string, Map<string, PlacedTemplate>>()
  for (const template of drawnTemplates) {
    if (template.serverUrl === undefined || template.serverTemplateId === undefined) continue
    const templates = drawnByServer.get(template.serverUrl) ?? new Map<string, PlacedTemplate>()
    templates.set(template.serverTemplateId, template)
    drawnByServer.set(template.serverUrl, templates)
  }
  const serverTemplateProgress = (
    server: ConnectedServer,
    template: ServerTemplate,
  ): TemplateProgress => {
    const serverProgress = serverProgressFor(server, template)
    const baseline = serverProgress ?? emptyProgress(template.totalPixels ?? 0)
    const drawn = drawnByServer.get(server.url)?.get(template.id)
    if (drawn === undefined) return baseline
    const serverColours = serverColourProgressFor(server, template)
    if (serverColours !== null) {
      return (
        sumProgress(freshestColourProgress(serverColours, colourProgressFor(drawn))) ?? baseline
      )
    }
    return freshestProgress(baseline, progressFor(drawn))
  }
  const serverTemplateColourProgress = (
    server: ConnectedServer,
    template: ServerTemplate,
  ): readonly TemplateColourProgress[] | undefined => {
    const serverProgress = serverColourProgressFor(server, template)
    if (serverProgress === null) return undefined
    const drawn = drawnByServer.get(server.url)?.get(template.id)
    return drawn === undefined
      ? serverProgress
      : freshestColourProgress(serverProgress, colourProgressFor(drawn))
  }
  const completeColourProgress = (
    overall: TemplateProgress | undefined,
    groups: ReadonlyArray<readonly TemplateColourProgress[]>,
  ): readonly TemplateColourProgress[] | undefined => {
    const colours = sumColourProgress(groups)
    return colours !== undefined &&
      overall !== undefined &&
      colours.reduce((sum, entry) => sum + entry.total, 0) === overall.total
      ? colours
      : undefined
  }
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
  const budget: RenderBudget = {
    remaining: MAX_RENDERED_ROWS,
    truncated: false,
  }
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
    // Published only, same as every folder rollup below: an admin's unpublished drafts are listed
    // and metered individually, but never counted into the server's aggregate.
    const serverTemplates =
      server === undefined
        ? []
        : (rowsFor(server)?.templates ?? []).filter((template) => template.published)
    const readParentProgress = (): TemplateProgress | undefined =>
      isLocal
        ? sumProgress(localOnly.map(progressFor))
        : server === undefined
          ? undefined
          : sumProgress(serverTemplates.map((template) => serverTemplateProgress(server, template)))
    const parentProgress = readParentProgress()
    const parentColourProgress: (() => readonly TemplateColourProgress[] | undefined) | undefined =
      isLocal
        ? localOnly.length === 0
          ? undefined
          : () => completeColourProgress(readParentProgress(), localOnly.map(colourProgressFor))
        : server === undefined ||
            serverTemplates.length === 0 ||
            !serverTemplates.every(
              (template) => serverTemplateColourProgress(server, template) !== undefined,
            )
          ? undefined
          : () =>
              completeColourProgress(
                readParentProgress(),
                serverTemplates.flatMap((template) => {
                  const colours = serverTemplateColourProgress(server, template)
                  return colours === undefined ? [] : [colours]
                }),
              )

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
        ...(parentProgress === undefined ? {} : { progress: parentProgress }),
        ...(parentProgress === undefined
          ? {}
          : { progressReader: () => readParentProgress() ?? parentProgress }),
        ...(parentColourProgress === undefined ? {} : { colourProgress: parentColourProgress }),
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
          if (!setScopeVisible(key, on)) {
            callbacks.onError(`Could not change visibility for “${target.name}”.`)
          }
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
          void refreshServerSnapshot(server, rerender)
        }
        if (refreshing.has(server)) {
          wrap.appendChild(childText('Loading folders…', 0))
        } else {
          const message = nodeErrors.get(server) ?? 'Could not load this server.'
          wrap.appendChild(
            childRetry(message, 0, () => {
              void refreshServerSnapshot(server, rerender, true)
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
          const nodeKey = nodeTreeKey(server, node.id)
          const nodeTarget: TreeTarget = {
            server,
            nodeId: node.id,
            key: nodeKey,
            name: node.name,
          }
          entries.push({
            parentId: renderedParent(nodeKey, node.parentId),
            item: {
              key: nodeKey,
              name: node.name,
              kind: 'folder',
              childrenOf: node.id,
              createdAt: node.createdAt,
              visible: isScopeVisible(nodeScopeKey(server.url, node.id)),
              setVisible: (on) => setScopeVisible(nodeScopeKey(server.url, node.id), on),
              canReparent: canEdit,
              ...(canEdit ? { onDropAt: intoServer } : {}),
              ...(canEdit
                ? {
                    onContextMenu: (event: MouseEvent) =>
                      callbacks.onContextMenu(nodeTarget, event),
                  }
                : {}),
              ...(canEdit
                ? {
                    onRename: (value: string) => callbacks.onRename(nodeTarget, value),
                  }
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
        const drawnById = drawnByServer.get(server.url) ?? new Map<string, PlacedTemplate>()
        for (const template of published) {
          const templateKey = serverTemplateTreeKey(server, template.id)
          const drawn = drawnById.get(template.id)
          const colourProgress = serverTemplateColourProgress(server, template)
          const visibilityKey = serverTemplateKey(server.url, template.id)
          const templateTarget: TreeTarget = {
            server,
            nodeId: template.nodeId,
            key: templateKey,
            name: template.name,
            templateId: template.id,
          }
          entries.push({
            parentId: renderedParent(templateKey, template.nodeId),
            item: {
              key: templateKey,
              name: template.name,
              kind: 'image',
              childrenOf: null,
              createdAt: template.updatedAt,
              muted: !template.published,
              ...(template.published ? {} : { excludeFromRollup: true as const }),
              progress: serverTemplateProgress(server, template),
              progressReader: () => serverTemplateProgress(server, template),
              ...(colourProgress === undefined
                ? {}
                : {
                    colourProgress: () =>
                      serverTemplateColourProgress(server, template) ?? colourProgress,
                  }),
              progressSortable: true,
              leadingActions: [
                {
                  icon: 'search',
                  label: 'Go to',
                  run: () => callbacks.onGoTo({ kind: 'server', bbox: template.bbox }),
                },
              ],
              visible: drawn?.visible ?? isScopeVisible(visibilityKey),
              setVisible: async (on) => {
                // A drawn server row owns the dual commit: live bitmaps and the durable scope either
                // both move or neither does. Before its pixels arrive there is only the scope.
                return drawn === undefined
                  ? setScopeVisible(visibilityKey, on)
                  : await setLocalVisible(drawn.id, on)
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
                ? {
                    onRename: (value: string) => callbacks.onRename(templateTarget, value),
                  }
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
          [],
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
              void refreshServerSnapshot(server, rerender, true)
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
      const mine = localOnly
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
            setVisible: (on) => setLocalFolderVisible(folder.id, on),
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
            progress: progressFor(template),
            progressReader: () => progressFor(template),
            colourProgress: () => colourProgressFor(template),
            progressSortable: true,
            visible: template.visible,
            setVisible: (on) => setLocalVisible(template.id, on),
            canReparent: true,
            onDropAt: callbacks.onMoveLocal,
            onContextMenu: (event) => callbacks.onContextMenu(templateTarget, event),
            onRename: (value) => callbacks.onRename(templateTarget, value),
            leadingActions: [
              {
                icon: 'search',
                label: 'Go to',
                run: () => callbacks.onGoTo({ kind: 'local', templateId: template.id }),
              },
            ],
            actions: [
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
        [],
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
        callbacks.onImportTemplate({
          server: null,
          nodeId: null,
          key: 'local',
          name: 'Local',
        }),
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
