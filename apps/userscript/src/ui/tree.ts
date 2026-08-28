import { moveLocalFolder, renameLocalFolder, setLocalFolderVisible } from '../local-folders.js'
import type { ServerTemplate } from '../server-cache.js'
import {
  type ConnectedServer,
  getState,
  isScopeVisible,
  patchTemplate,
  renameNode as renameNodeOnServer,
  renameServer as renameServerOnServer,
  setScopeVisible,
} from '../state.js'
import { serverColourProgressFor, serverProgressFor } from '../telemetry.js'
import {
  isServerTemplate,
  localTemplates,
  type PlacedTemplate,
  renameLocalTemplate,
  setLocalVisible,
  setTemplateFolder,
} from '../templates/local-store.js'
import {
  colourProgressFor,
  progressFor,
  type TemplateColourProgress,
  type TemplateProgress,
} from '../templates/mismatch.js'
import { nodeScopeKey } from '../templates/server-nodes.js'
import { serverTemplateKey } from '../templates/server-sync.js'
import { icon } from './icons.js'
import {
  emptyProgress,
  freshestColourProgress,
  freshestProgress,
  sumColourProgress,
  sumProgress,
} from './progress.js'
import { toast } from './toast.js'
import { goToLocalTemplate, goToServerTemplate } from './tree-navigation.js'
import { MAX_RENDERED_ROWS, orderedTreeItems as orderedItems } from './tree-order.js'
import {
  bindTreeDropRoot,
  finishTreeRoot,
  isTreeExpanded as isExpanded,
  type SiblingLevel,
  treeConnector,
  treeRow,
} from './tree-row.js'
import {
  hasRefreshedServer,
  isServerRefreshing,
  nodeTreeKey,
  refreshServerSnapshot,
  renderedParent,
  rowsFor,
  serverSnapshotError,
  serverTemplateTreeKey,
} from './tree-server-state.js'
import {
  groupedTreeSource as groupedSource,
  treeMatcher as matcherFor,
  type TreeItem,
  type TreeSource,
} from './tree-source.js'

export { isTreeDragActive, startRenaming } from './tree-row.js'

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
  /** Revision shown when this destructive action became available. */
  readonly templateVersion?: string
  readonly templateUpdatedAt?: number
}

export interface TreeCallbacks {
  readonly onAddServer: () => void
  readonly onCreateFolder: (target: TreeTarget) => void
  readonly onImportTemplate: (target: TreeTarget) => void
  readonly onContextMenu: (target: TreeTarget, event: MouseEvent) => void
  readonly onCopyToServer: (templateId: string) => void
  /** Move one server-owned row into a Local folder. Local reparenting stays inside the tree. */
  readonly onDropInLocal: (draggedKey: string, folderId: string | null) => Promise<string | null>
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

const reportTreeError = (message: string): void => toast(message, 'error')

const localTemplateId = (target: TreeTarget): string | null =>
  target.key.startsWith('local:') ? target.key.slice('local:'.length) : null

const localFolderId = (target: TreeTarget): string | null =>
  target.server === null && target.key.startsWith('lf:') ? target.key.slice('lf:'.length) : null

const refreshCurrentSnapshot = async (
  server: ConnectedServer,
  rerender: () => void,
): Promise<void> => {
  let current = getState().servers.find((candidate) => candidate.url === server.url)
  if (current === undefined) return
  let result = await refreshServerSnapshot(current, rerender, true)
  while (result.status === 'superseded') {
    current = getState().servers.find((candidate) => candidate.url === server.url)
    if (current === undefined) return
    result = await refreshServerSnapshot(current, rerender)
  }
}

const renameTarget = async (
  target: TreeTarget,
  name: string,
  rerender: () => void,
): Promise<void> => {
  const templateId = localTemplateId(target)
  if (templateId !== null) {
    if (!(await renameLocalTemplate(templateId, name))) {
      reportTreeError('Could not save that name. The old one is still there.')
    }
    rerender()
    return
  }
  const folderId = localFolderId(target)
  if (folderId !== null) {
    if (!renameLocalFolder(folderId, name)) {
      reportTreeError('Could not save that folder name. Use between 1 and 256 characters.')
    }
    rerender()
    return
  }
  if (target.server !== null && target.templateId !== undefined) {
    const result = await patchTemplate(target.server, target.templateId, { name })
    if (!result.ok) reportTreeError(result.message)
    await refreshCurrentSnapshot(target.server, rerender)
    return
  }
  if (target.server !== null && target.nodeId === null) {
    const result = await renameServerOnServer(target.server, name)
    if (!result.ok) reportTreeError(result.message)
    rerender()
    return
  }
  if (target.server === null || target.nodeId === null) {
    toast('There is nothing to rename here.', 'warning')
    rerender()
    return
  }
  const result = await renameNodeOnServer(target.server, target.nodeId, name)
  if (!result.ok) reportTreeError(result.message)
  await refreshCurrentSnapshot(target.server, rerender)
}

interface RenderBudget {
  remaining: number
  truncated: boolean
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
  const dropInLocal = async (
    draggedKey: string,
    parentKey: string | null,
    _beforeKey: string | null,
  ): Promise<string | null> => {
    const folderId = parentKey?.startsWith('lf:') === true ? parentKey.slice('lf:'.length) : null
    if (draggedKey.startsWith('node:') || draggedKey.startsWith('st:')) {
      return await callbacks.onDropInLocal(draggedKey, folderId)
    }
    if (draggedKey.startsWith('local:')) {
      if (!(await setTemplateFolder(draggedKey.slice('local:'.length), folderId))) {
        reportTreeError('Could not move that template into the folder.')
        rerender()
        return null
      }
      rerender()
      return draggedKey
    }
    if (draggedKey.startsWith('lf:')) {
      if (!moveLocalFolder(draggedKey.slice('lf:'.length), folderId)) {
        reportTreeError('Could not save that folder move.')
        return null
      }
      return draggedKey
    }
    return null
  }
  const wrap = document.createElement('div')
  wrap.setAttribute('role', 'tree')
  wrap.className = 'flex flex-col'
  // Breathing room between rows, and between the first row and the search field above it.
  wrap.style.gap = '0.125rem'
  wrap.style.paddingTop = '0.5rem'
  wrap.style.paddingBottom = '0.5rem'
  bindTreeDropRoot(wrap)

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
        onError: reportTreeError,
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
            reportTreeError(`Could not change visibility for “${target.name}”.`)
          }
          rerender()
        },
        onContextMenu: canEdit ? (event) => callbacks.onContextMenu(target, event) : undefined,
        onRename: canEdit ? (value) => void renameTarget(target, value, rerender) : undefined,
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
        if (!hasRefreshedServer(server)) {
          // Exactly one automatic attempt per verified connection. A failed request records an
          // error and waits for the explicit Retry button instead of scheduling itself forever.
          void refreshServerSnapshot(server, rerender)
        }
        if (isServerRefreshing(server)) {
          wrap.appendChild(childText('Loading folders…', 0))
        } else {
          const message = serverSnapshotError(server) ?? 'Could not load this server.'
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
                    onRename: (value: string) => void renameTarget(nodeTarget, value, rerender),
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
            templateVersion: template.version,
            templateUpdatedAt: template.updatedAt,
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
                  run: () => goToServerTemplate(template.bbox),
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
              onContextMenu: (event: MouseEvent) => callbacks.onContextMenu(templateTarget, event),
              ...(canEdit
                ? {
                    onRename: (value: string) => void renameTarget(templateTarget, value, rerender),
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
          reportTreeError,
          siblingLevels,
        )
        if (needle !== '' && !hasMatches) wrap.appendChild(childText('No matches.', 0))
        else if (known.length === 0 && published.length === 0)
          wrap.appendChild(childText('No templates published yet.', 0))
        const refreshError = serverSnapshotError(server)
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
            onDropAt: dropInLocal,
            onContextMenu: (event) => callbacks.onContextMenu(folderTarget, event),
            onRename: (value) => void renameTarget(folderTarget, value, rerender),
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
            onDropAt: dropInLocal,
            onContextMenu: (event) => callbacks.onContextMenu(templateTarget, event),
            onRename: (value) => void renameTarget(templateTarget, value, rerender),
            leadingActions: [
              {
                icon: 'search',
                label: 'Go to',
                run: () => goToLocalTemplate(template.id),
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
        reportTreeError,
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

  finishTreeRoot(wrap)

  return wrap
}
