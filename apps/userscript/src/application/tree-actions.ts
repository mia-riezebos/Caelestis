import {
  nodeSlug,
  sameTemplateSurface,
  type TemplateSurface,
  templateSurfaceBounds,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type {
  TemplateTreeIntent,
  TreeContextMenuModel,
  TreeIcon,
  TreeOperationModel,
} from '@caelestis/ui/elements'
import { refreshAllianceManifest } from '../alliance-server-sync.js'
import { activeAllianceSurface } from '../alliance-surface.js'
import { warn } from '../debug.js'
import { createLocalFolder, removeLocalFolder } from '../local-folders.js'
import { viewportCentre } from '../main.js'
import type { ServerTemplate } from '../server-cache.js'
import {
  type ConnectedServer,
  countNodeSubtree,
  createNode,
  deleteNode as deleteNodeOnServer,
  deleteTemplate as deleteTemplateOnServer,
  getState,
  isCurrentServerConnection,
  listServerNodes,
  MAX_LOCAL_FOLDERS,
  moveNode as moveNodeOnServer,
  patchTemplate,
  removeTreeStateKeys,
  type ServerNodesResult,
  setState,
  uploadTemplateVersion,
} from '../state.js'
import { importFile } from '../templates/import.js'
import {
  addLocalTemplate,
  localTemplates as allLocal,
  canCopyAsLocalTemplate,
  isCurrentTemplate,
  removeLocalTemplate,
  setTemplateFolder,
  setTemplatesFolder,
  templateAsPng,
  templateById,
  templateIdsInLocalFolder,
} from '../templates/local-store.js'
import { beginMove, movingId, reserveMove, stopMoveForDeletion } from '../templates/move.js'
import { centreOf, navigateTo } from '../templates/navigate.js'
import { serverTemplateKey } from '../templates/server-sync.js'
import { templateAsWplace, wplaceFilename } from '../templates/wplace-export.js'
import { confirmDestructive } from '../ui/confirm.js'
import { toast } from '../ui/toast.js'
import type { TreeTarget } from '../ui/tree.js'
import { startRenaming } from '../ui/tree-state.js'
import {
  claimFolderPublication,
  setFolderTemplatesPublished,
  templatesInFolderSubtree,
} from './folder-publication.js'
import { importTemplatesToServer } from './import-to-server.js'
import { runWhileBusy } from './operation-lock.js'
import { serverDestinations } from './server-destinations.js'
import {
  copyCurrentLocalTemplateToServer,
  copyLocalTemplateToServer,
  type Destination,
  moveServerTemplateToLocal,
  moveServerTemplateToServer,
  type Source,
  transplant,
} from './transplant.js'
import { goToLocalTemplate } from './tree-navigation.js'
import {
  findServerNode,
  findServerTemplate,
  nodeTreeKey,
  optimisticallyPlaceServerRow,
  refreshServerSnapshot,
  rowsForSurface,
  type ServerSnapshotResult,
  serverTemplateAt,
  serverTemplateTreeKey,
  templatesForServer,
  templatesOfNode,
} from './tree-server-state.js'

type ContextAction = { readonly id: string; readonly run: () => void }
type OperationState = {
  model: TreeOperationModel
  readonly onConfirm?: (value: string) => void
  readonly onCancel?: () => void
  readonly rerender: () => void
}

let contextMenu: TreeContextMenuModel | undefined
let contextActions: readonly ContextAction[] = []
let contextRerender: (() => void) | undefined
let operation: OperationState | undefined
let presentationId = 0

export const treeActionPresentation = (): Pick<
  import('@caelestis/ui/elements').TemplateTreeModel,
  'contextMenu' | 'operation'
> => ({
  ...(contextMenu === undefined ? {} : { contextMenu }),
  ...(operation === undefined ? {} : { operation: operation.model }),
})

const closeContextMenu = (rerender = true): void => {
  const changed = contextMenu !== undefined
  const refresh = contextRerender
  contextMenu = undefined
  contextActions = []
  contextRerender = undefined
  if (changed && rerender) refresh?.()
}

const showOperation = (
  model: Omit<TreeOperationModel, 'id'>,
  rerender: () => void,
  handlers: { readonly onConfirm?: (value: string) => void; readonly onCancel?: () => void } = {},
): string => {
  operation?.onCancel?.()
  const id = `tree-operation-${++presentationId}`
  operation = { model: { ...model, id }, rerender, ...handlers }
  rerender()
  return id
}

const updateOperation = (id: string, patch: Partial<TreeOperationModel>): void => {
  if (operation?.model.id !== id) return
  operation.model = { ...operation.model, ...patch, id }
  operation.rerender()
}

const closeOperation = (id: string, rerender = true): void => {
  if (operation?.model.id !== id) return
  const refresh = operation.rerender
  operation = undefined
  if (rerender) refresh()
}

export const handleTreeActionPresentationIntent = (intent: TemplateTreeIntent): boolean => {
  if (intent.type === 'dismiss-context-menu') {
    if (contextMenu?.id !== intent.menuId) return true
    const refresh = contextRerender
    contextMenu = undefined
    contextActions = []
    contextRerender = undefined
    refresh?.()
    return true
  }
  if (intent.type === 'context-menu-action') {
    if (contextMenu?.id !== intent.menuId) return true
    const action = contextActions.find((candidate) => candidate.id === intent.actionId)
    const refresh = contextRerender
    contextMenu = undefined
    contextActions = []
    contextRerender = undefined
    refresh?.()
    action?.run()
    return true
  }
  if (intent.type === 'tree-operation-cancel') {
    if (operation?.model.id !== intent.operationId) return true
    const current = operation
    operation = undefined
    current.onCancel?.()
    current.rerender()
    return true
  }
  if (intent.type === 'tree-operation-confirm') {
    if (operation?.model.id !== intent.operationId || operation.model.pending === true) return true
    operation.onConfirm?.(intent.value)
    return true
  }
  return false
}

type RetriableMutationResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly message: string
      readonly retryable?: true
      readonly stop?: true
    }

const retryOptimisticMutation = async (
  mutate: () => Promise<RetriableMutationResult>,
): Promise<RetriableMutationResult> => {
  const delays = [120, 300] as const
  let result = await mutate()
  for (const delay of delays) {
    if (result.ok || result.retryable !== true) return result
    await new Promise((resolve) => setTimeout(resolve, delay))
    result = await mutate()
  }
  return result
}

/** A name nobody has to type: "New folder", then "New folder 2", and so on. */
/**
 * A name nobody has to type: "New folder", then "New folder 2", and so on.
 *
 * `key` is how the caller's world decides two names are the same one. Local folders compare
 * lowercased display names; a server compares the path segment it derives, so `New-folder` and
 * `New folder` collide there and do not here.
 */
const freeFolderName = (
  taken: ReadonlySet<string>,
  key: (name: string) => string = (name) => name.toLowerCase(),
): string => {
  const base = 'New folder'
  if (!taken.has(key(base))) return base
  for (let n = 2; n < 500; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(key(candidate))) return candidate
  }
  return `${base} ${Date.now()}`
}

/** `local:<id>` is a template; `local`, `server:<url>` and `node:<id>` are containers. */
const localTemplateId = (target: TreeTarget): string | null =>
  target.key.startsWith('local:') ? target.key.slice('local:'.length) : null

const surfaceOf = (target: TreeTarget): TemplateSurface => target.surface ?? WORLD_TEMPLATE_SURFACE

const exportTemplate = async (target: TreeTarget): Promise<void> => {
  const localId = localTemplateId(target)
  const id =
    localId ??
    (target.server !== null && target.templateId !== undefined
      ? serverTemplateKey(target.server.url, target.templateId)
      : null)
  const template = id === null ? undefined : templateById(id)
  if (template === undefined) {
    toast('That template has not finished loading yet.', 'warning')
    return
  }
  if (movingId() === template.id || !template.everPlaced) {
    toast(`Finish placing “${template.name}” before exporting it.`, 'warning')
    return
  }

  toast(`Preparing “${template.name}”…`)
  try {
    const file = await templateAsWplace(template)
    if (file === null) {
      toast(`“${template.name}” changed while it was being exported. Try again.`, 'warning')
      return
    }
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = wplaceFilename(template.name)
    link.hidden = true
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    toast(`Exported “${template.name}”.`)
  } catch (error) {
    warn('install', `could not export ${template.name}`, String(error))
    toast(`Could not export “${template.name}”.`, 'error')
  }
}

/**
 * Delete sits in a context menu one slip away from Rename, and a folder is not recoverable from the
 * client, so it always asks first.
 */
const askToDelete = (
  kind: string,
  name: string,
  note?: string,
  restoreFocusTo: HTMLElement | null = null,
): Promise<boolean> =>
  confirmDestructive({
    // Their shape: the heading asks, the body names the thing and says what happens to it.
    title: `Delete ${kind}?`,
    body: `${name} will be permanently removed.`,
    ...(note === undefined ? {} : { note }),
    confirmLabel: 'Delete',
    restoreFocusTo,
  })

const applyDelete = async (
  target: TreeTarget,
  rerender: () => void,
  restoreFocusTo: HTMLElement | null = null,
): Promise<void> => {
  const templateId = localTemplateId(target)
  if (templateId !== null) {
    if (
      !(await askToDelete(
        'template',
        target.name,
        'It is stored in this browser only.',
        restoreFocusTo,
      ))
    ) {
      return
    }
    // Join an existing delete in the store rather than returning early: every surface that asked
    // still receives the real outcome. If placement was active, reserve its slot until deletion is
    // known to have succeeded; a failed delete restores exactly the preview the user was moving.
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
  const folderId = localFolderIdOf(target)
  if (folderId !== null) {
    const confirmed = await confirmDestructive({
      title: `Delete “${target.name}”?`,
      body: 'The folder will be removed.',
      // Say where things go, because "delete" on a container reads as "delete what is inside it".
      note: 'Anything inside it moves up one level rather than being deleted.',
      confirmLabel: 'Delete',
      restoreFocusTo,
    })
    if (!confirmed) return
    // The folder goes only once everything inside it has somewhere else to be. A write that fails —
    // IndexedDB gone, or a compare-and-swap lost to another tab — leaves that template pointing at a
    // folder id, and the tree renders templates by matching their folder to one that exists, so
    // removing the folder anyway would take the template off screen for good.
    const parentId = getState().localFolders.find((f) => f.id === folderId)?.parentId ?? null
    const children = templateIdsInLocalFolder(folderId)
    if (!(await setTemplatesFolder(children, parentId))) {
      toast(`Could not move everything out of “${target.name}”, so the folder was kept.`, 'error')
      rerender()
      return
    }
    if (!removeLocalFolder(folderId)) {
      toast(`Everything was moved out, but “${target.name}” could not be deleted.`, 'error')
      rerender()
      return
    }
    removeTreeStateKeys(new Set([target.key]))
    rerender()
    return
  }
  if (target.server !== null && target.templateId !== undefined) {
    if (target.templateVersion === undefined || target.templateUpdatedAt === undefined) {
      toast('That template revision is no longer available. Refresh and try again.', 'warning')
      return
    }
    const confirmed = await askToDelete(
      'published template',
      target.name,
      // Said plainly because it is the one delete here that reaches other people: everyone
      // connected to this server loses it, not just this browser.
      'Everyone connected to this server will stop seeing it.',
      restoreFocusTo,
    )
    if (!confirmed) return
    const result = await deleteTemplateOnServer(target.server, target.templateId, {
      version: target.templateVersion,
      updatedAt: target.templateUpdatedAt,
    })
    if (!result.ok) toast(result.message, 'error')
    await refreshEditedSurface(target.server, surfaceOf(target), rerender)
    return
  }
  if (target.server === null || target.nodeId === null) {
    toast('Nothing to delete here yet.', 'warning')
    return
  }
  /**
   * A folder on a server, which is never only a folder.
   *
   * The count comes from the server rather than the tree, because the tree only knows what it has
   * fetched — a folder nobody has expanded has never been listed — and "delete 1 folder" for
   * something holding forty templates is the kind of wrong that only shows up afterwards.
   */
  const holding = await countNodeSubtree(target.server, target.nodeId)
  if (holding === null) {
    toast(`Could not count what is inside “${target.name}”, so the folder was kept.`, 'error')
    return
  }
  const inside =
    holding.nodes === 1 && holding.templates === 0
      ? null
      : { folders: holding.nodes - 1, templates: holding.templates }
  const contents =
    inside === null || (inside.folders === 0 && inside.templates === 0)
      ? null
      : [
          inside.folders > 0 ? `${inside.folders} subfolder${inside.folders === 1 ? '' : 's'}` : '',
          inside.templates > 0
            ? `${inside.templates} template${inside.templates === 1 ? '' : 's'}`
            : '',
        ]
          .filter((part) => part !== '')
          .join(' and ')

  const confirmed = await confirmDestructive({
    title: `Delete “${target.name}”?`,
    body:
      contents === null
        ? `${target.name} will be permanently removed.`
        : `${target.name} and everything in it — ${contents} — will be permanently removed.`,
    ...(contents === null
      ? {}
      : {
          note: 'Everyone connected to this server loses all of it, and it cannot be undone.',
        }),
    confirmLabel: 'Delete',
    restoreFocusTo,
  })
  if (!confirmed) return

  // Cascade only where there is something to cascade. An empty folder deletes as it always did, so
  // a server that does not know the flag still answers.
  const result = await deleteNodeOnServer(
    target.server,
    target.nodeId,
    inside === null ? null : holding,
  )
  if (!result.ok) toast(result.message, 'error')
  await refreshEditedSurface(target.server, surfaceOf(target), rerender)
}

/**
 * Move a published template into another folder on the same server.
 *
 * The context-menu alternative to dragging: useful when the destination is off-screen or a precise
 * pointer gesture is awkward.
 */
const moveServerTemplate = async (target: TreeTarget, rerender: () => void): Promise<void> => {
  const { server, templateId } = target
  if (server === null || templateId === undefined) return
  const surface = surfaceOf(target)
  const listed = await listServerNodes(server, undefined, surface)
  if (listed.status !== 'ok') {
    toast(serverNodesFailure(listed), 'error')
    return
  }
  const destinations = serverDestinations(listed.nodes).filter(
    (destination) => destination.nodeId !== target.nodeId,
  )
  if (destinations.length === 0) {
    toast('There is nowhere else to put it.', 'warning')
    return
  }

  let id = ''
  id = showOperation(
    {
      label: `Move “${target.name}” to:`,
      options: destinations.slice(0, MAX_DESTINATIONS).map((destination) => ({
        value: destination.nodeId ?? '',
        label: destination.label,
      })),
      ...(destinations.length > MAX_DESTINATIONS
        ? { note: `Showing the first ${MAX_DESTINATIONS} of ${destinations.length} folders.` }
        : {}),
      confirmLabel: 'Move',
    },
    rerender,
    {
      onConfirm: (value) => {
        updateOperation(id, { pending: true, cancellable: false })
        void runWhileBusy(`template:move:${templateId}`, async () => {
          const result = await patchTemplate(server, templateId, {
            nodeId: value === '' ? null : value,
          })
          closeOperation(id)
          if (!result.ok) toast(result.message, 'error')
          void refreshEditedSurface(server, surface, rerender)
        })
      },
    },
  )
}

/**
 * A template dropped onto a folder on a server.
 *
 * Three journeys behind one gesture, and which one it is comes from what was dragged:
 *
 * - **From Local** — an upload. The same thing "Copy to a server" does, with the destination
 *   already answered by where it was dropped.
 * - **Within one server** — a refile, which is a single column and touches no pixels.
 * - **Across servers** — a move: the artwork is uploaded to the destination and then removed from
 *   the source. Confirmed first, because the second half is destructive to something other people
 *   can see, and a drag is easy to make by accident.
 *
 * A drop that would change nothing is silently ignored rather than round-tripping to say so.
 */
/**
 * Move a whole folder — a server's node or a Local one — to wherever it was dropped.
 *
 * Confirmed first when it crosses a boundary, because the source end of it is a delete that other
 * people can see, and a drag is easy to make by accident. Nothing is removed until the destination
 * holds the entire branch; see `transplant`.
 */
export const moveBranch = async (
  draggedKey: string,
  destination: Destination,
  rerender: () => void,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<string | null> => {
  const fromServer = draggedKey.startsWith('node:')
  const found = fromServer ? findServerNode(draggedKey, surface) : null
  if (fromServer && found === null) return null
  const sourceId = found?.node.id ?? draggedKey.slice(draggedKey.indexOf(':') + 1)

  const sourceServer =
    found === null
      ? null
      : (getState().servers.find((candidate) => candidate.url === found.serverUrl) ?? null)
  if (fromServer && sourceServer === null) return null

  /**
   * Within one server, a move is one field: the node's parent.
   *
   * Nothing is copied and no pixels move — the templates hang off node ids that do not change — so
   * this is a different operation from crossing a boundary, and asking to confirm it would be
   * asking about a folder drag inside a single tree, which nobody expects.
   */
  if (
    destination.kind === 'server' &&
    sourceServer !== null &&
    destination.server.url === sourceServer.url
  ) {
    if (found !== null && destination.nodeId === found.node.parentId) return draggedKey
    const optimistic =
      surface.kind === 'world'
        ? optimisticallyPlaceServerRow(destination.server, draggedKey, destination.nodeId)
        : null
    const moved = await retryOptimisticMutation(() =>
      moveNodeOnServer(destination.server, sourceId, destination.nodeId),
    )
    if (!moved.ok) {
      optimistic?.rollback()
      toast(moved.message, 'error')
      rerender()
      return null
    }
    optimistic?.commit()
    rerender()
    void refreshEditedSurface(destination.server, surface, rerender)
    return draggedKey
  }

  const sourceName = sourceServer?.info?.name ?? sourceServer?.url ?? 'Local'
  const destinationName =
    destination.kind === 'local'
      ? 'Local'
      : (destination.server.info?.name ?? destination.server.url)
  const confirmed = await confirmDestructive({
    title: `Move this folder to ${destinationName}?`,
    body: `Everything inside it is copied to ${destinationName} first, and only then removed from ${sourceName}.`,
    ...(sourceServer === null
      ? {}
      : { note: `Everyone connected to ${sourceName} will stop seeing it.` }),
    confirmLabel: 'Move',
  })
  if (!confirmed) return null

  const source: Source =
    sourceServer === null
      ? { kind: 'local', folderId: sourceId }
      : { kind: 'server', server: sourceServer, nodeId: sourceId }

  toast('Moving…')
  const result = await transplant(
    source,
    destination,
    (server, nodeId) => templatesOfNode(server.url, nodeId, surface),
    (server) => templatesForServer(server.url, surface),
    (server) => refreshEditedSurface(server, surface, rerender),
    surface,
  )
  if (result.ok) toast(result.message)
  else toast(result.message, 'error')
  rerender()
  if (!result.ok || result.destinationRootId === undefined) return null
  return destination.kind === 'server'
    ? nodeTreeKey(destination.server, result.destinationRootId)
    : `lf:${result.destinationRootId}`
}

/**
 * Take a single published template into Local, and off the server.
 *
 * The pixels come from the copy already drawn, so nothing is downloaded twice — and if it has not
 * finished arriving there is nothing to move yet, which is worth saying rather than half-doing.
 */
export const copyServerTemplateToLocal = async (
  templateKey: string,
  folderId: string | null,
  rerender: () => void,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<string | null> => {
  const found = findServerTemplate(templateKey, surface)
  if (found === null) return null
  const templateId = found.template.id
  const source = getState().servers.find((candidate) => candidate.url === found.serverUrl)
  if (source === undefined) return null
  const drawn = templateById(serverTemplateKey(found.serverUrl, templateId, surface))
  if (drawn === undefined || drawn.serverVersion !== found.template.version) {
    toast('That template has not finished loading yet — try again in a moment.', 'warning')
    return null
  }
  if (!canCopyAsLocalTemplate(drawn)) {
    toast('Wrapped server templates cannot be moved into Local yet.', 'warning')
    return null
  }

  const sourceName = source.info?.name ?? source.url
  const confirmed = await confirmDestructive({
    title: `Move “${found.template.name}” into Local?`,
    body: `It is copied into this browser first, and only then removed from ${sourceName}.`,
    note: `Everyone connected to ${sourceName} will stop seeing it.`,
    confirmLabel: 'Move',
  })
  if (!confirmed) return null

  const result = await moveServerTemplateToLocal(
    source,
    found.template,
    drawn,
    folderId,
    (server, id) => serverTemplateAt(server.url, id, surface),
    (server) => refreshEditedSurface(server, surface, rerender),
  )
  toast(result.message, result.tone === 'success' ? undefined : result.tone)
  rerender()
  return result.destinationId === undefined ? null : `local:${result.destinationId}`
}

export const dropOnServerNode = async (
  server: ConnectedServer,
  nodeId: string | null,
  draggedKey: string,
  _beforeKey: string | null,
  rerender: () => void,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<string | null> => {
  // A folder is a branch, not a row: its structure and everything hanging off it must exist at the
  // destination before anything is taken off the source. `transplant` owns that ordering; this only
  // decides which end is which.
  //
  // This is also the one destination that may be the server itself rather than a folder on it —
  // dropping onto the server's own row means the top level for folders and templates alike.
  if (draggedKey.startsWith('node:') || draggedKey.startsWith('lf:')) {
    return await moveBranch(draggedKey, { kind: 'server', server, nodeId }, rerender, surface)
  }
  if (draggedKey.startsWith('local:')) {
    const local = templateById(draggedKey.slice('local:'.length))
    if (local === undefined) return null
    // The refusal the Copy dialog makes, for the same reason: while a placement is running the
    // stored origin is the position being dragged away from, so publishing it puts the template on
    // the server where nobody chose. A drag onto a server folder is the same upload by another
    // gesture, and it had no guard at all.
    if (movingId() === local.id) {
      toast(`Finish placing “${local.name}” before copying it.`, 'warning')
      return null
    }
    const result = await copyLocalTemplateToServer(
      local,
      server,
      nodeId,
      (connected) => refreshEditedSurface(connected, surface, rerender),
      {},
    )
    if (result.ok) toast(`Uploaded “${local.name}” to ${server.info?.name ?? server.url}.`)
    else toast(result.message, result.retryable === true ? 'warning' : 'error')
    return result.ok ? serverTemplateTreeKey(server, result.id) : null
  }

  if (!draggedKey.startsWith('st:')) return null
  const found = findServerTemplate(draggedKey, surface)
  if (found === null) return null
  const templateId = found.template.id

  if (found.serverUrl === server.url) {
    if (found.template.nodeId === nodeId) return draggedKey
    const optimistic =
      surface.kind === 'world' ? optimisticallyPlaceServerRow(server, draggedKey, nodeId) : null
    const result = await retryOptimisticMutation(() =>
      patchTemplate(server, templateId, { nodeId }),
    )
    if (!result.ok) {
      optimistic?.rollback()
      toast(result.message, 'error')
      rerender()
      return null
    }
    optimistic?.commit()
    rerender()
    void refreshEditedSurface(server, surface, rerender)
    return draggedKey
  }

  const source = getState().servers.find((candidate) => candidate.url === found.serverUrl)
  if (source === undefined) return null
  const sourceName = source.info?.name ?? source.url
  const destinationName = server.info?.name ?? server.url
  const confirmed = await confirmDestructive({
    title: `Move “${found.template.name}” to ${destinationName}?`,
    body: `It will be uploaded to ${destinationName} and removed from ${sourceName}.`,
    note: `Everyone connected to ${sourceName} will stop seeing it.`,
    confirmLabel: 'Move',
  })
  if (!confirmed) return null

  // The pixels come from the copy already on the canvas, which is the assembled result of that
  // server's own chunks — so a cross-server move needs no second download.
  const drawn = templateById(serverTemplateKey(found.serverUrl, templateId, surface))
  if (drawn === undefined) {
    toast('That template has not finished loading yet — try again in a moment.', 'warning')
    return null
  }
  const result = await moveServerTemplateToServer(
    source,
    server,
    nodeId,
    found.template,
    drawn,
    (connected, id) => serverTemplateAt(connected.url, id, surface),
    (connected) => refreshEditedSurface(connected, surface, rerender),
  )
  toast(result.message, result.tone === 'success' ? undefined : result.tone)
  return result.destinationId === undefined
    ? null
    : serverTemplateTreeKey(server, result.destinationId)
}

/** The template state from the same admitted snapshot that drew this row. */
const templateStateOf = (target: TreeTarget): ServerTemplate | null =>
  target.server !== null && target.templateId !== undefined
    ? serverTemplateAt(target.server.url, target.templateId, surfaceOf(target))
    : null

const publishedStateOf = (target: TreeTarget): boolean =>
  templateStateOf(target)?.published ?? false

/**
 * Replace a published template's artwork with a local template's.
 *
 * Deliberately sourced from Local rather than from a file picker: a raw image has no placement, and
 * the origin is half of what a version *is*. Getting a template positioned locally and then pushing
 * it up is the same path `copyToServer` already establishes — this is that path for artwork that
 * already exists on the server.
 */
const replaceServerArtwork = async (target: TreeTarget, rerender: () => void): Promise<void> => {
  const { server, templateId } = target
  if (server === null || templateId === undefined) return
  // A new version has to be the same size as the one it replaces; the server refuses anything else
  // and there is nothing the user can do about it after the fact. Offering every Local template
  // meant most choices were an unavoidable 409 presented as a valid option.
  const surface = surfaceOf(target)
  const current = serverTemplateAt(server.url, templateId, surface)
  const span = (min: number, max: number) => (max >= min ? max - min : WORLD_PIXELS - min + max)
  const wanted =
    current === null
      ? null
      : {
          width: span(current.bbox.minX, current.bbox.maxX),
          height: current.bbox.maxY - current.bbox.minY,
        }
  const localSources = allLocal().filter((candidate) =>
    sameTemplateSurface(candidate.surface ?? WORLD_TEMPLATE_SURFACE, surface),
  )
  const sources =
    wanted === null
      ? localSources
      : localSources.filter(
          (candidate) => candidate.width === wanted.width && candidate.height === wanted.height,
        )
  if (sources.length === 0) {
    toast(
      wanted === null
        ? 'Import the new artwork into Local first, and place it where it belongs.'
        : `Replacing this needs a Local template that is exactly ${wanted.width}x${wanted.height}.`,
      'warning',
    )
    return
  }

  let cancelled = false
  let id = ''
  id = showOperation(
    {
      label: `Replace “${target.name}” with:`,
      options: sources.map((candidate) => ({ value: candidate.id, label: candidate.name })),
      note: 'Its position travels with it — the server re-slices from where it sits now.',
      confirmLabel: 'Replace',
    },
    rerender,
    {
      onCancel: () => {
        cancelled = true
      },
      onConfirm: (value) => {
        // Read fresh rather than using the list captured when the dialog opened: it has been on screen
        // while the map was in use, and the template may have been moved, renamed or redrawn since.
        const source = templateById(value)
        if (source === undefined) {
          toast('That template is no longer here.', 'error')
          closeOperation(id)
          return
        }
        if (movingId() === source.id) {
          toast(`Finish placing “${source.name}” before replacing from it.`, 'warning')
          return
        }
        updateOperation(id, { label: 'Encoding…', pending: true })
        void runWhileBusy(`template:replace:${templateId}`, async () => {
          const png = await templateAsPng(source)
          if (png === null) {
            toast('Could not encode that template.', 'error')
            closeOperation(id)
            return
          }
          if (!isCurrentTemplate(source) || movingId() === source.id) {
            toast(`“${source.name}” changed while it was being encoded — try again.`, 'warning')
            return
          }
          // Closing the panel or opening another operation revokes this exact continuation.
          if (cancelled || operation?.model.id !== id) return
          if (!stillConnected(server)) {
            toast('That server was disconnected or replaced.', 'warning')
            closeOperation(id)
            return
          }
          updateOperation(id, {
            label: `Uploading ${Math.round(png.size / 1024)} KB…`,
            cancellable: false,
          })
          const result = await uploadTemplateVersion(server, templateId, {
            originX: source.originX,
            originY: source.originY,
            name: source.name,
            png,
          })
          closeOperation(id)
          if (result.ok) toast(`Replaced the artwork for “${target.name}”.`)
          else toast(result.message, 'error')
          const reconciliation = refreshEditedSurface(server, surface, rerender)
          if (!result.ok && result.ambiguous === true) await reconciliation
          else void reconciliation
        })
      },
    },
  )
}

/** Publish or unpublish, which is the difference between everyone seeing it and only admins. */
const setServerTemplatePublished = async (
  target: TreeTarget,
  published: boolean,
  rerender: () => void,
): Promise<void> => {
  const { server, templateId } = target
  if (server === null || templateId === undefined) return
  const result = await patchTemplate(server, templateId, { published })
  if (!result.ok) toast(result.message, 'error')
  await refreshEditedSurface(server, surfaceOf(target), rerender)
}

const setServerTemplateLifecycle = async (
  target: TreeTarget,
  patch: { readonly finished?: boolean; readonly timelapseFrozen?: boolean },
  rerender: () => void,
): Promise<void> => {
  const { server, templateId } = target
  if (server === null || templateId === undefined) return
  const result = await patchTemplate(server, templateId, patch)
  if (!result.ok) toast(result.message, 'error')
  await refreshEditedSurface(server, surfaceOf(target), rerender)
}

const folderTemplatesFor = (target: TreeTarget): readonly ServerTemplate[] | null => {
  if (target.server === null || target.nodeId === null || target.templateId !== undefined)
    return null
  const rows = rowsForSurface(target.server, surfaceOf(target))
  return rows === undefined
    ? null
    : templatesInFolderSubtree(rows.nodes, rows.templates, target.nodeId)
}

/** Publish or unpublish every template hanging anywhere below one server folder. */
const setServerFolderPublished = async (
  target: TreeTarget,
  published: boolean,
  rerender: () => void,
): Promise<void> => {
  const { server, nodeId } = target
  if (server === null || nodeId === null || target.templateId !== undefined) return
  const surface = surfaceOf(target)
  const releasePublication = claimFolderPublication(server.url)
  if (releasePublication === null) {
    toast('Another folder on that server is already changing publication state.', 'warning')
    return
  }
  try {
    if (surface.kind === 'world') {
      const refreshed = await refreshCurrentNodesResult(server, rerender, true)
      if (refreshed?.status !== 'admitted') {
        toast(
          refreshed?.message ?? 'That server was disconnected before the folder could change.',
          'error',
        )
        return
      }
    } else {
      await refreshAllianceManifest(server, surface)
      rerender()
    }
    const current = getState().servers.find((candidate) => candidate.url === server.url)
    if (current === undefined) {
      toast('That server was disconnected before the folder could change.', 'error')
      return
    }
    const rows = rowsForSurface(current, surface)
    const templates =
      rows === undefined ? null : templatesInFolderSubtree(rows.nodes, rows.templates, nodeId)
    if (templates === null) {
      toast(`Could not read what is inside “${target.name}”.`, 'error')
      return
    }
    const wanted = templates.filter((template) => template.published !== published).length
    if (wanted === 0) {
      toast(
        templates.length === 0
          ? `There are no templates in “${target.name}”.`
          : `Everything in “${target.name}” is already ${published ? 'published' : 'unpublished'}.`,
      )
      return
    }

    toast(
      `${published ? 'Publishing' : 'Unpublishing'} ${wanted} template${wanted === 1 ? '' : 's'}…`,
    )
    const result = await setFolderTemplatesPublished(templates, published, (template) =>
      retryOptimisticMutation(async () => {
        if (!stillConnected(current))
          return {
            ok: false,
            message: 'That server was disconnected or replaced.',
            stop: true,
          }
        return await patchTemplate(current, template.id, { published })
      }),
    )
    if (stillConnected(current)) await refreshEditedSurface(current, surface, rerender)
    else rerender()
    if (result.failures.length === 0) {
      toast(
        `${published ? 'Published' : 'Unpublished'} ${result.succeeded} template${result.succeeded === 1 ? '' : 's'} in “${target.name}”.`,
      )
      return
    }
    toast(
      `${result.succeeded} of ${result.requested} templates changed; ${result.failures.length} could not be ${published ? 'published' : 'unpublished'}.`,
      'error',
    )
  } finally {
    releasePublication()
  }
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
export const openContextMenu = (
  target: TreeTarget,
  event: MouseEvent,
  rerender: () => void,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): void => {
  const templateId = localTemplateId(target)
  const rename: readonly [TreeIcon, string, () => void] = [
    'rename',
    'Rename',
    () => {
      startRenaming(target.key)
      rerender()
    },
  ]
  const remove: readonly [TreeIcon, string, () => void] = [
    'trash',
    'Delete',
    () => void applyDelete(target, rerender),
  ]
  const published = publishedStateOf(target)
  const lifecycle = templateStateOf(target)
  const folderTemplates = folderTemplatesFor(target)
  const folderPublished =
    folderTemplates !== null &&
    folderTemplates.length > 0 &&
    folderTemplates.every((template) => template.published)
  const folderPublication: readonly [TreeIcon, string, () => void] | null =
    folderTemplates === null
      ? null
      : folderPublished
        ? [
            'eyeOff',
            'Unpublish folder',
            () => void setServerFolderPublished(target, false, rerender),
          ]
        : ['eye', 'Publish folder', () => void setServerFolderPublished(target, true, rerender)]
  const entries: ReadonlyArray<readonly [TreeIcon, string, () => void]> =
    // A template on a server, which is a different set of verbs from either a folder or a local
    // template: it can be moved between folders, published, and replaced with new artwork.
    target.templateId !== undefined
      ? target.server?.isAdmin === false
        ? [['download', 'Export .wplace', () => void exportTemplate(target)]]
        : [
            ['move', 'Move to folder', () => void moveServerTemplate(target, rerender)],
            ['download', 'Export .wplace', () => void exportTemplate(target)],
            published
              ? [
                  'eyeOff',
                  'Unpublish',
                  () => void setServerTemplatePublished(target, false, rerender),
                ]
              : ['eye', 'Publish', () => void setServerTemplatePublished(target, true, rerender)],
            lifecycle?.finished === true
              ? [
                  'reset',
                  'Reopen template',
                  () => void setServerTemplateLifecycle(target, { finished: false }, rerender),
                ]
              : [
                  'check',
                  'Mark finished',
                  () => void setServerTemplateLifecycle(target, { finished: true }, rerender),
                ],
            lifecycle?.timelapseFrozen === true
              ? [
                  'reset',
                  'Thaw timelapse',
                  () =>
                    void setServerTemplateLifecycle(target, { timelapseFrozen: false }, rerender),
                ]
              : [
                  'check',
                  'Freeze timelapse',
                  () =>
                    void setServerTemplateLifecycle(target, { timelapseFrozen: true }, rerender),
                ],
            ['uploadFile', 'Replace artwork', () => void replaceServerArtwork(target, rerender)],
            rename,
            remove,
          ]
      : templateId === null
        ? [
            ['createFolder', 'New folder', () => void createFolder(target, rerender, surface)],
            ['uploadFile', 'Import template', () => void importTemplate(target, rerender, surface)],
            ...(folderPublication === null ? [] : [folderPublication]),
            rename,
            remove,
          ]
        : [
            ...(surface.kind === 'world'
              ? ([['search', 'Go to', () => goToLocalTemplate(templateId)]] as const)
              : []),
            ['download', 'Export .wplace', () => void exportTemplate(target)],
            [
              'move',
              'Move',
              () => {
                // `beginMove` refuses while another placement is running, while the template is
                // mid-delete, and when it has gone. Dropping that answer made the menu entry do
                // nothing at all, with no placement and no explanation.
                if (!beginMove(templateId, rerender))
                  toast('Finish the placement already in progress, then move this one.', 'warning')
              },
            ],
            ['uploadFile', 'Copy to a server', () => void copyToServer(templateId, rerender)],
            rename,
            remove,
          ]
  closeContextMenu(false)
  const id = `tree-menu-${++presentationId}`
  contextMenu = {
    id,
    x: event.clientX,
    y: event.clientY,
    items: entries.map(([glyph, label], index) => ({
      id: `${id}-${index}`,
      label,
      icon: glyph,
      ...(label === 'Delete' ? { danger: true } : {}),
    })),
  }
  contextActions = entries.map(([, , run], index) => ({ id: `${id}-${index}`, run }))
  contextRerender = rerender
  rerender()
}

const importCentre = (surface: TemplateSurface): { x: number; y: number } => {
  if (surface.kind === 'world') return viewportCentre() ?? { x: 0, y: 0 }
  const active = activeAllianceSurface()
  const bounds =
    active !== null && sameTemplateSurface(active.surface, surface)
      ? (active.bounds ?? templateSurfaceBounds(surface))
      : templateSurfaceBounds(surface)
  return bounds === null
    ? { x: 0, y: 0 }
    : { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
}

const refreshEditedSurface = async (
  server: ConnectedServer,
  surface: TemplateSurface,
  rerender: () => void,
): Promise<void> => {
  if (surface.kind === 'world') {
    await refreshCurrentNodes(server, rerender, true)
    return
  }
  await refreshAllianceManifest(server, surface)
  rerender()
}

export const importTemplate = async (
  target: TreeTarget,
  rerender: () => void,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<void> => {
  const picker = document.createElement('input')
  picker.type = 'file'
  picker.accept = '.wplace,.json,image/png,image/*'
  picker.addEventListener('change', () => {
    void (async () => {
      const file = picker.files?.[0]
      if (file === undefined) return
      const centre = importCentre(surface)
      try {
        toast(`Reading ${file.name}…`)
        const imported = await importFile(file, centre)
        if (imported.length === 0) {
          toast('Nothing importable in that file.', 'error')
          return
        }
        const first = imported[0]
        if (first === undefined) return
        const reservation = first.source === 'image' ? reserveMove() : null
        if (first.source === 'image' && reservation === null) {
          toast('Finish the current placement, then import this image again.', 'warning')
          return
        }
        if (target.server !== null) {
          await importTemplatesToServer(
            imported,
            target.server,
            target.nodeId ?? null,
            reservation,
            rerender,
            (server, render) => refreshEditedSurface(server, surface, render),
            surface,
          )
          return
        }
        // Straight into whichever Local folder was clicked. Importing from a folder's own button
        // and then finding the result at the top level would make the button a lie.
        const folderId = localFolderIdOf(target)
        // Each record stands or falls on its own. Rolling the whole file back on one failure meant
        // importing two templates with one slot left admitted the first, hit the cap on the second,
        // and then deleted the first as well — a success thrown away to tidy up after a failure
        // that had nothing to do with it.
        const admitted: string[] = []
        const failed: string[] = []
        try {
          for (const template of imported) {
            try {
              await addLocalTemplate(template, surface)
              admitted.push(template.id)
              if (folderId !== null && !(await setTemplateFolder(template.id, folderId)))
                failed.push(`${template.name} was imported, but not into that folder`)
            } catch (error) {
              failed.push(`${template.name}: ${String(error)}`)
            }
          }
          rerender()
          if (failed.length > 0) toast(failed.join('. '), 'error')
          if (!admitted.includes(first.id)) return

          const moved = first.moved
          toast(
            `Imported ${first.name} — ${first.width}x${first.height}` +
              (moved > 0 ? `, ${moved.toLocaleString()} pixels quantised` : ''),
          )
          if (first.source === 'image') {
            // The reservation spans persistence, so another placement cannot strand this image in
            // volatile state between admission and `beginMove`.
            if (reservation === null || !reservation.start(first.id, rerender)) {
              for (const template of imported) await removeLocalTemplate(template.id)
              rerender()
              toast(
                'Another placement started. Finish it, then import this image again.',
                'warning',
              )
            }
          } else {
            // It already knows where it belongs, so go and look at it — centred on the template and
            // zoomed to fit it, in-game. Changing the URL would reload and throw the import away.
            if (surface.kind === 'world') navigateTo(centreOf(first))
          }
        } catch (error) {
          rerender()
          throw error
        } finally {
          reservation?.release()
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
 * Only servers where the code is admin can receive one. The placement travels with it — the whole
 * point of getting it right locally first is not having to do it again on the other side.
 */
let copySetupRunning = false
let copySetupController: AbortController | null = null
let copySetupTargets: ReadonlySet<string> | null = null
const COPY_SETUP_TIMEOUT_MS = 120_000

export const copyToServer = async (
  templateId: string,
  rerender: () => void,
  onlyServerUrl?: string,
): Promise<void> => {
  const template = templateById(templateId)
  if (template === undefined) return
  const surface = template.surface ?? WORLD_TEMPLATE_SURFACE
  if (copySetupRunning) return
  const targets = getState().servers.filter(
    (server) => server.isAdmin && (onlyServerUrl === undefined || server.url === onlyServerUrl),
  )
  if (targets.length === 0) {
    toast('No server here accepts uploads — you need an admin code on one.', 'warning')
    return
  }

  copySetupRunning = true
  const setupController = new AbortController()
  copySetupController = setupController
  copySetupTargets = new Set(targets.map((server) => server.url))
  let setupCancelled = false
  let setupTimedOut = false
  const setupId = showOperation(
    {
      label: `Finding destinations for “${template.name}”…`,
      pending: true,
      cancellable: true,
    },
    rerender,
    {
      onCancel: () => {
        setupCancelled = true
        setupController.abort(new Error('copy setup cancelled'))
      },
    },
  )
  const setupTimeout = setTimeout(() => {
    setupTimedOut = true
    setupController.abort(new Error('copy setup timed out'))
  }, COPY_SETUP_TIMEOUT_MS)
  let listed: Array<readonly [ConnectedServer, ServerNodesResult]>
  try {
    listed = await Promise.all(
      targets.map(
        async (server) =>
          [server, await listServerNodes(server, setupController.signal, surface)] as const,
      ),
    )
  } finally {
    clearTimeout(setupTimeout)
    if (copySetupController === setupController) copySetupController = null
    if (copySetupController === null) copySetupTargets = null
    copySetupRunning = false
  }
  if (setupController.signal.aborted) {
    if (!setupCancelled && operation?.model.id === setupId) {
      toast(
        setupTimedOut
          ? 'Finding server folders took too long. Try Copy again.'
          : 'Copy setup stopped because a server connection changed.',
        'warning',
      )
    }
    closeOperation(setupId)
    return
  }
  if (operation?.model.id !== setupId) return
  const unreachable = listed.filter(([, result]) => result.status === 'unreachable').length
  const notAdmitted = listed.filter(([, result]) => result.status === 'not-admitted').length
  let offered = 0
  let available = 0
  const options: Array<{ value: string; label: string }> = []
  for (const [server, result] of listed) {
    if (result.status !== 'ok') continue
    const destinations = serverDestinations(result.nodes)
    available += destinations.length
    for (const destination of destinations) {
      if (offered >= MAX_DESTINATIONS) break
      options.push({
        value: `${server.url}|${destination.nodeId ?? ''}`,
        label: `${server.info?.name ?? server.url} · ${destination.label}`,
      })
      offered++
    }
  }
  if (options.length === 0) {
    closeOperation(setupId)
    toast(
      unreachable > 0
        ? 'Could not ask any of those servers where their folders are.'
        : notAdmitted > 0
          ? 'Cannot use those folders while connected server data exceeds the client safety limits.'
          : 'No upload destination is available.',
      unreachable > 0 || notAdmitted > 0 ? 'error' : 'warning',
    )
    return
  }

  let note: string | undefined
  if (available > offered) {
    note = `Showing the first ${offered} of ${available} folders.`
  } else if (unreachable > 0) {
    note = `${unreachable} server${unreachable === 1 ? '' : 's'} could not be asked.`
  }

  let cancelled = false
  let id = ''
  id = showOperation(
    {
      label: `Copy “${template.name}” to:`,
      options,
      ...(note === undefined ? {} : { note }),
      confirmLabel: 'Copy',
    },
    rerender,
    {
      onCancel: () => {
        cancelled = true
      },
      onConfirm: (chosen) => {
        // Split at the last separator, not the first: a node id is a UUID and never contains one, but a
        // server URL legally can — `new URL` leaves `|` in a path exactly as typed.
        const cut = chosen.lastIndexOf('|')
        const url = cut === -1 ? '' : chosen.slice(0, cut)
        const encodedNodeId = cut === -1 ? undefined : chosen.slice(cut + 1)
        const server = targets.find((candidate) => candidate.url === url)
        if (server === undefined || encodedNodeId === undefined) return
        const nodeId = encodedNodeId === '' ? null : encodedNodeId
        // The same refusal Delete makes, for the same reason: this dialog stays open while the map is
        // used, and a placement in progress means the stored origin is the one being dragged away
        // from. Copying it would put the template on the server at a position nobody chose.
        if (movingId() === template.id) {
          toast(`Finish placing “${template.name}” before copying it.`, 'warning')
          return
        }
        updateOperation(id, { label: 'Encoding…', pending: true })
        void runWhileBusy(`template:copy:${templateId}`, async () => {
          const result = await copyCurrentLocalTemplateToServer(
            templateId,
            template.name,
            server,
            nodeId,
            (connected) =>
              refreshEditedSurface(connected, template.surface ?? WORLD_TEMPLATE_SURFACE, rerender),
            {
              beforeUpload: (png) => {
                if (cancelled || operation?.model.id !== id) return false
                updateOperation(id, {
                  label: `Uploading ${Math.round(png.size / 1024)} KB…`,
                  cancellable: false,
                })
                return true
              },
            },
          )
          if (!result.ok && result.cancelled === true) return
          if (!result.ok && result.missing === true) {
            closeOperation(id)
            toast(result.message, 'error')
            return
          }
          if (!result.ok && result.retryable === true) {
            updateOperation(id, {
              label: `Copy “${template.name}” to:`,
              pending: false,
              cancellable: true,
            })
            toast(result.message, 'warning')
            return
          }
          closeOperation(id)
          if (result.ok) toast(`Copied “${template.name}” to ${server.info?.name ?? server.url}.`)
          else toast(result.message, 'error')
        })
      },
    },
  )
}

/** `lf:<id>` is a Local folder; `local` is the Local root. */
const localFolderIdOf = (target: TreeTarget): string | null =>
  target.key.startsWith('lf:') ? target.key.slice('lf:'.length) : null

const isLocalTarget = (target: TreeTarget): boolean =>
  target.server === null && (target.key === 'local' || target.key.startsWith('lf:'))

/**
 * Make sure the row about to be created will be on screen.
 *
 * Creating inside a collapsed folder put the new child straight into rename mode, the tree never
 * rendered it, and the rename state was cleared by the next draw. The user saw nothing happen and
 * found a default-named folder later.
 */
const expandForNewChild = (key: string): void => {
  const collapsed = getState().collapsed
  if (!collapsed.includes(key)) return
  setState({ collapsed: collapsed.filter((one) => one !== key) })
}

export const createFolder = async (
  target: TreeTarget,
  rerender: () => void,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<void> => {
  const { server, nodeId } = target
  if (isLocalTarget(target)) {
    // Nested under whichever Local folder was clicked, or at the top when it was Local itself.
    const parentId = localFolderIdOf(target)
    expandForNewChild(target.key)
    const taken = new Set(
      getState()
        .localFolders.filter((folder) =>
          sameTemplateSurface(folder.surface ?? WORLD_TEMPLATE_SURFACE, surface),
        )
        .map((folder) => folder.name.toLowerCase()),
    )
    const folder = createLocalFolder(parentId, freeFolderName(taken), surface)
    if (folder === null) {
      toast(
        `Could not save that folder. Local supports up to ${MAX_LOCAL_FOLDERS.toLocaleString()}.`,
        'error',
      )
      return
    }
    startRenaming(`lf:${folder.id}`)
    rerender()
    return
  }
  if (server === null) {
    toast('Nothing to create a folder in here.', 'warning')
    return
  }
  // No dialog: pick a free name, create it, and drop straight into renaming it. Asking for a name
  // before the thing exists is a question with no context; renaming one that is on screen is not.
  const listed = await listServerNodes(server, undefined, surface)
  if (listed.status !== 'ok') {
    toast(serverNodesFailure(listed), 'error')
    return
  }
  const existing = listed.nodes
  // Asking took a round trip, and the panel was usable throughout it. Writing to a server the user
  // has since disconnected creates a folder in a place they can no longer see.
  if (!stillConnected(server)) return
  // Compared as the server will store them, and only against siblings. Matching display names
  // treated `New-folder` and `New folder` as different while the backend slugs both to
  // `new-folder`, so the chosen name came back as a path conflict instead of becoming "New folder 2".
  const siblings = existing.filter((node) => node.parentId === nodeId)
  const name = freeFolderName(new Set(siblings.map((node) => nodeSlug(node.name))), nodeSlug)
  expandForNewChild(target.key)
  const result = await createNode(server, name, nodeId, undefined, surface)
  if (!result.ok) {
    toast(result.message, 'error')
    await refreshEditedSurface(server, surface, rerender)
    return
  }
  // Refresh before rendering: the row we are about to put into rename mode does not exist in the
  // cached node list yet, so re-rendering first would draw a tree without it and drop the rename.
  startRenaming(nodeTreeKey(server, result.node.id))
  await refreshEditedSurface(server, surface, rerender)
}

const MAX_DESTINATIONS = 2_000

const serverNodesFailure = (result: Exclude<ServerNodesResult, { status: 'ok' }>): string =>
  result.status === 'unreachable'
    ? 'Could not ask that server for its current folders.'
    : 'Cannot use those folders while connected server data exceeds the client safety limits.'

const stillConnected = (server: ConnectedServer): boolean => isCurrentServerConnection(server)

/** Refresh with the connection that is configured now, never credentials captured before an await. */
const refreshCurrentNodesResult = async (
  server: ConnectedServer,
  rerender: () => void,
  force = false,
): Promise<ServerSnapshotResult | null> => {
  let current = getState().servers.find((candidate) => candidate.url === server.url)
  if (current === undefined) return null
  let result = await refreshServerSnapshot(current, rerender, force)
  while (result.status === 'superseded') {
    current = getState().servers.find((candidate) => candidate.url === server.url)
    if (current === undefined) return null
    result = await refreshServerSnapshot(current, rerender)
  }
  return result
}

const refreshCurrentNodes = async (
  server: ConnectedServer,
  rerender: () => void,
  force = false,
): Promise<void> => {
  await refreshCurrentNodesResult(server, rerender, force)
}

export const cancelTreeActionSetup = (reason: Error): void => {
  copySetupController?.abort(reason)
  operation?.onCancel?.()
  operation = undefined
  closeContextMenu(false)
}

export const treeActionUsesServer = (serverUrl: string): boolean =>
  copySetupTargets?.has(serverUrl) === true
