import { cacheServer, loadServerCache, type ServerTemplate } from '../server-cache.js'
import {
  MAX_MANIFEST_CHUNKS,
  MAX_MANIFEST_TEMPLATES,
  MAX_TREE_NODES,
  type TreeNode,
} from '../server-manifest.js'
import {
  admitServerContents,
  admittedServerContentsFor,
  type ConnectedServer,
  getState,
  isCurrentServerConnection,
  listServerContents,
  onServerContents,
  type ServerContents,
  takeProbedNodes,
} from '../state.js'
import { rememberNodes } from '../templates/server-nodes.js'
import { rejectServerContentsForSync, syncServerTemplates } from '../templates/server-sync.js'

/** @internal Arithmetic seam for the aggregate cost of all connected manifest rows. */
const manifestAggregateWithinBudget = (
  retainedTemplates: number,
  retainedChunks: number,
  nextTemplates: number,
  nextChunks: number,
): boolean =>
  retainedTemplates + nextTemplates <= MAX_MANIFEST_TEMPLATES &&
  retainedChunks + nextChunks <= MAX_MANIFEST_CHUNKS

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

export const renderedParent = (key: string, serverParent: string | null): string | null => {
  const optimistic = optimisticParents.get(key)
  return optimistic === undefined ? serverParent : optimistic.parentId
}

const serverIdentity = (server: ConnectedServer): string | null => {
  if (server.info !== null && server.season !== null) return `${server.info.id}:${server.season}`
  return server.lastVerified == null
    ? null
    : `${server.lastVerified.serverId}:${server.lastVerified.season}`
}

export const rowsFor = (
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

export const isSameServerPlacement = (draggedKey: string, parentKey: string | null): boolean => {
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

export const hasRefreshedServer = (server: ConnectedServer): boolean =>
  refreshedConnections.has(server)

export const serverSnapshotError = (server: ConnectedServer): string | undefined =>
  nodeErrors.get(server)

export const isServerRefreshing = (server: ConnectedServer): boolean => refreshing.has(server)
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
