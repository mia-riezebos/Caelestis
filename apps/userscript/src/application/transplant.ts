import { type TemplateSurface, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import {
  addLocalFolders,
  leaseLocalFolder,
  nextLocalFolderId,
  removeLocalFolders,
} from '../local-folders.js'
import type { TreeNode } from '../server-manifest.js'
import {
  admittedServerContentsFor,
  type ConnectedServer,
  createNode,
  deleteNode as deleteNodeOnServer,
  deleteTemplate as deleteTemplateOnServer,
  getState,
  isCurrentServerConnection,
  type LocalFolder,
  listServerContents,
  listServerNodes,
  MAX_LOCAL_FOLDERS,
  patchTemplate,
  uploadTemplate,
} from '../state.js'
import {
  canCopyAsLocalTemplate,
  copyAsLocalTemplate,
  isCurrentTemplate,
  leaseLocalTemplate,
  localTemplates,
  type PlacedTemplate,
  removeLocalTemplate,
  setTemplateFolder,
  templateAsPng,
  templateById,
} from '../templates/local-store.js'
import { movingId } from '../templates/move.js'
import { serverTemplateKey } from '../templates/server-sync.js'

/**
 * Moving a whole branch of the tree somewhere else — to another server, or into Local.
 *
 * A template on its own is a single call either way. A folder is not: it is a structure plus
 * everything hanging off it, the two sides describe that structure differently (a server has nodes
 * addressed by materialized path, Local has folders addressed by parent), and the pixels have to be
 * re-uploaded because content addressing is per server.
 *
 * **Copy everything, verify, then remove.** The source is only touched once the destination holds
 * the whole branch. A move that fails half way leaves the original intact and a partial copy at the
 * destination, which is recoverable by hand; the reverse — a deleted original and a partial copy —
 * is not.
 */

/** Where a branch is going. */
export type Destination =
  | { readonly kind: 'server'; readonly server: ConnectedServer; readonly nodeId: string | null }
  | { readonly kind: 'local'; readonly folderId: string | null }

/** Where it came from. */
export type Source =
  | { readonly kind: 'server'; readonly server: ConnectedServer; readonly nodeId: string }
  | { readonly kind: 'local'; readonly folderId: string }

interface DestinationAdmission {
  readonly nodes: readonly TreeNode[]
  readonly templates: ReadonlyArray<{
    readonly id: string
    readonly nodeId: string | null
    readonly name: string
    readonly version: string
    readonly published: boolean
  }>
}

const destinationAdmissionControllers = new Map<string, Set<AbortController>>()

export const cancelDestinationAdmissions = (serverUrl: string): void => {
  const controllers = destinationAdmissionControllers.get(serverUrl)
  if (controllers === undefined) return
  for (const controller of controllers) controller.abort(new Error('destination disconnected'))
  destinationAdmissionControllers.delete(serverUrl)
}

const destinationIsAdmitted = async (
  server: ConnectedServer,
  expected: DestinationAdmission,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
  currentTemplate?: CurrentServerTemplate,
): Promise<boolean> => {
  const controller = new AbortController()
  const controllers = destinationAdmissionControllers.get(server.url) ?? new Set<AbortController>()
  controllers.add(controller)
  destinationAdmissionControllers.set(server.url, controllers)
  try {
    if (surface.kind !== 'world') {
      const listed = await listServerNodes(server, controller.signal, surface)
      if (listed.status !== 'ok') return false
      const nodes = new Map(listed.nodes.map((node) => [node.id, node]))
      for (const expectedNode of expected.nodes) {
        const node = nodes.get(expectedNode.id)
        if (
          node === undefined ||
          node.parentId !== expectedNode.parentId ||
          node.path !== expectedNode.path ||
          node.name !== expectedNode.name ||
          node.description !== expectedNode.description ||
          node.createdAt !== expectedNode.createdAt
        )
          return false
      }
      if (currentTemplate === undefined) return expected.templates.length === 0
      for (const expectedTemplate of expected.templates) {
        const template = currentTemplate(server, expectedTemplate.id)
        if (
          template === null ||
          template.nodeId !== expectedTemplate.nodeId ||
          template.name !== expectedTemplate.name ||
          template.version !== expectedTemplate.version ||
          template.published !== expectedTemplate.published
        )
          return false
      }
      return true
    }
    if ((await listServerContents(server, controller.signal)) === null) return false
    const admitted = admittedServerContentsFor(server)
    if (admitted === null) return false
    const nodes = new Map(admitted.nodes.map((node) => [node.id, node]))
    for (const expectedNode of expected.nodes) {
      const node = nodes.get(expectedNode.id)
      if (
        node === undefined ||
        node.parentId !== expectedNode.parentId ||
        node.path !== expectedNode.path ||
        node.name !== expectedNode.name ||
        node.description !== expectedNode.description ||
        node.createdAt !== expectedNode.createdAt
      )
        return false
    }
    const templates = new Map(admitted.templates.map((template) => [template.id, template]))
    for (const expectedTemplate of expected.templates) {
      const template = templates.get(expectedTemplate.id)
      if (
        template === undefined ||
        template.nodeId !== expectedTemplate.nodeId ||
        template.name !== expectedTemplate.name ||
        template.version !== expectedTemplate.version ||
        template.published !== expectedTemplate.published
      )
        return false
    }
    return true
  } finally {
    controllers.delete(controller)
    if (controllers.size === 0 && destinationAdmissionControllers.get(server.url) === controllers) {
      destinationAdmissionControllers.delete(server.url)
    }
  }
}

export interface TransplantResult {
  readonly ok: boolean
  readonly message: string
  /** Folders and templates that reached the destination, whether or not the whole move finished. */
  readonly nodes: number
  readonly templates: number
  /** The root folder's new identity, available only after the whole move succeeds. */
  readonly destinationRootId?: string
}

/** One branch, flattened: each folder with the templates directly inside it. */
interface Branch {
  readonly name: string
  readonly folders: ReadonlyArray<{
    id: string
    parentId: string | null
    sourceParentId: string | null
    name: string
    description?: string
  }>
  readonly templates: ReadonlyArray<{
    folderId: string
    template: PlacedTemplate
    sourceId: string
    sourceRevision: {
      readonly version: string
      readonly name: string
      readonly published: boolean
      readonly updatedAt: number
    } | null
  }>
}

interface PublishedTemplate {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly published?: boolean
  readonly updatedAt?: number
}

interface LocatedPublishedTemplate extends PublishedTemplate {
  readonly nodeId: string | null
  readonly published: boolean
  readonly updatedAt: number
}

const localId = (): string =>
  `local-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

/**
 * The drawn copy of a server template, which is where its pixels are.
 *
 * A server template that has not finished syncing has no pixels here, and re-downloading its chunks
 * to move it would be a second copy of something already in memory. Missing means "not yet", and
 * the move is refused rather than half-made.
 */
const drawnFor = (
  serverUrl: string,
  template: { id: string; version: string },
): PlacedTemplate | undefined => {
  const drawn = templateById(serverTemplateKey(serverUrl, template.id))
  return drawn?.serverVersion === template.version ? drawn : undefined
}

export interface TemplateTransferResult {
  readonly ok: boolean
  readonly message: string
  readonly tone: 'success' | 'warning' | 'error'
  /** Present once a destination copy exists, even if source cleanup was refused. */
  readonly destinationId?: string
}

export type LocalTemplateCopyResult =
  | { readonly ok: true; readonly id: string; readonly version: string }
  | {
      readonly ok: false
      readonly message: string
      readonly ambiguous?: true
      readonly cancelled?: true
      readonly missing?: true
      readonly retryable?: true
    }

type CurrentServerTemplate = (
  server: ConnectedServer,
  templateId: string,
) => LocatedPublishedTemplate | null

type ReconcileServer = (server: ConnectedServer) => Promise<void>

/** Encode and upload one Local template while its placement and destination stay current. */
export const copyLocalTemplateToServer = async (
  template: PlacedTemplate,
  destination: ConnectedServer,
  nodeId: string | null,
  reconcileServer: ReconcileServer,
  options: {
    readonly beforeUpload?: (png: Blob) => boolean
  },
): Promise<LocalTemplateCopyResult> => {
  const png = await templateAsPng(template)
  if (png === null) return { ok: false, message: 'Could not encode that template.' }
  if (!isCurrentTemplate(template) || movingId() === template.id) {
    return {
      ok: false,
      message: `“${template.name}” changed while it was being encoded — try again.`,
      retryable: true,
    }
  }
  if (options.beforeUpload?.(png) === false) {
    return { ok: false, message: '', cancelled: true }
  }
  if (!isCurrentServerConnection(destination)) {
    return {
      ok: false,
      message: 'That destination server was disconnected or replaced.',
    }
  }
  const uploaded = await uploadTemplate(destination, {
    nodeId,
    name: template.name,
    originX: template.originX,
    originY: template.originY,
    png,
    surface: template.surface ?? WORLD_TEMPLATE_SURFACE,
  })
  // The write result is useful immediately. Reconciliation still belongs to this transaction, but
  // a slow manifest must not keep a completed upload looking stuck behind its 120-second timeout.
  void reconcileServer(destination)
  return uploaded
}

/** Resolve the installed Local snapshot at the start of each user-visible copy attempt. */
export const copyCurrentLocalTemplateToServer = async (
  templateId: string,
  templateName: string,
  destination: ConnectedServer,
  nodeId: string | null,
  reconcileServer: ReconcileServer,
  options: {
    readonly beforeUpload?: (png: Blob) => boolean
  },
): Promise<LocalTemplateCopyResult> => {
  const template = templateById(templateId)
  if (template === undefined) {
    return { ok: false, message: `“${templateName}” is no longer here.`, missing: true }
  }
  return copyLocalTemplateToServer(template, destination, nodeId, reconcileServer, options)
}

const sameServerTemplateRevision = (
  left: LocatedPublishedTemplate,
  right: LocatedPublishedTemplate,
): boolean =>
  left.id === right.id &&
  left.nodeId === right.nodeId &&
  left.name === right.name &&
  left.version === right.version &&
  left.published === right.published &&
  left.updatedAt === right.updatedAt

/** Copy one server template into Local, verify its source revision, then remove the source. */
export const moveServerTemplateToLocal = async (
  source: ConnectedServer,
  published: LocatedPublishedTemplate,
  drawn: PlacedTemplate,
  folderId: string | null,
  currentServerTemplate: CurrentServerTemplate,
  reconcileServer: ReconcileServer,
): Promise<TemplateTransferResult> => {
  if (!isCurrentServerConnection(source)) {
    return {
      ok: false,
      tone: 'warning',
      message: 'That server connection changed before the move began.',
    }
  }
  const current = currentServerTemplate(source, published.id)
  if (current === null || drawn.serverVersion !== current.version) {
    return {
      ok: false,
      tone: 'warning',
      message: 'That template has not finished loading its current version yet.',
    }
  }
  let copied: PlacedTemplate
  try {
    copied = await copyAsLocalTemplate(drawn, localId())
  } catch (error) {
    return {
      ok: false,
      tone: 'error',
      message: `Could not copy “${current.name}” into Local: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!(await setTemplateFolder(copied.id, folderId))) {
    return {
      ok: false,
      tone: 'error',
      message: 'Copied into Local, but could not put it in that folder.',
    }
  }
  const releaseCopied = leaseLocalTemplate(copied.id)
  if (releaseCopied === null) {
    return {
      ok: false,
      tone: 'error',
      message: 'Copied into Local, but could not keep the new copy for the move.',
    }
  }
  try {
    const latest = currentServerTemplate(source, published.id)
    if (latest === null || !sameServerTemplateRevision(current, latest)) {
      return {
        ok: false,
        tone: 'warning',
        destinationId: copied.id,
        message: 'Copied into Local, but the source changed and was kept.',
      }
    }
    if (!isCurrentServerConnection(source)) {
      return {
        ok: false,
        tone: 'warning',
        destinationId: copied.id,
        message: 'Copied into Local, but the source connection changed and was kept.',
      }
    }
    const removed = await deleteTemplateOnServer(source, published.id, {
      version: current.version,
      updatedAt: current.updatedAt,
    })
    void reconcileServer(source)
    return removed.ok
      ? {
          ok: true,
          tone: 'success',
          destinationId: copied.id,
          message: `Moved “${published.name}” into Local.`,
        }
      : {
          ok: false,
          tone: 'error',
          destinationId: copied.id,
          message: `Copied into Local, but ${removed.message}`,
        }
  } finally {
    releaseCopied()
  }
}

/** Copy one server template across servers, verify admission, then remove its source revision. */
export const moveServerTemplateToServer = async (
  source: ConnectedServer,
  destination: ConnectedServer,
  nodeId: string | null,
  published: LocatedPublishedTemplate,
  drawn: PlacedTemplate,
  currentServerTemplate: CurrentServerTemplate,
  reconcileServer: ReconcileServer,
): Promise<TemplateTransferResult> => {
  const sourceName = source.info?.name ?? source.url
  const destinationName = destination.info?.name ?? destination.url
  const partial = (
    message: string,
    tone: TemplateTransferResult['tone'],
    destinationId: string,
  ): TemplateTransferResult => ({ ok: false, tone, destinationId, message })
  if (!isCurrentServerConnection(source) || !isCurrentServerConnection(destination)) {
    return {
      ok: false,
      tone: 'warning',
      message: 'A server connection changed before the move began.',
    }
  }
  const current = currentServerTemplate(source, published.id)
  if (current === null || drawn.serverVersion !== current.version) {
    return {
      ok: false,
      tone: 'warning',
      message: 'That template has not finished loading yet — try again in a moment.',
    }
  }
  const png = await templateAsPng(drawn)
  if (png === null) return { ok: false, tone: 'error', message: 'Could not encode that template.' }
  const ready = currentServerTemplate(source, published.id)
  if (ready === null || !sameServerTemplateRevision(current, ready)) {
    return {
      ok: false,
      tone: 'warning',
      message: 'That template changed while it was being prepared.',
    }
  }
  if (!isCurrentServerConnection(source) || !isCurrentServerConnection(destination)) {
    return {
      ok: false,
      tone: 'warning',
      message: 'A server connection changed while the template was being prepared.',
    }
  }
  const uploaded = await uploadTemplate(destination, {
    nodeId,
    name: ready.name,
    originX: drawn.originX,
    originY: drawn.originY,
    png,
    surface: drawn.surface ?? WORLD_TEMPLATE_SURFACE,
  })
  if (!uploaded.ok) {
    void reconcileServer(destination)
    return { ok: false, tone: 'error', message: uploaded.message }
  }
  const copied = uploaded.id
  if (!isCurrentServerConnection(source) || !isCurrentServerConnection(destination)) {
    void reconcileServer(destination)
    return partial(
      `Copied to ${destinationName}, but a server connection changed and the source was kept.`,
      'warning',
      copied,
    )
  }
  const beforePublish = currentServerTemplate(source, published.id)
  if (beforePublish === null || !sameServerTemplateRevision(ready, beforePublish)) {
    void reconcileServer(destination)
    return partial(
      `Copied to ${destinationName} as a draft, but the source changed and was kept.`,
      'warning',
      copied,
    )
  }
  if (beforePublish.published) {
    const publishedAtDestination = await patchTemplate(destination, copied, { published: true })
    if (!publishedAtDestination.ok) {
      void reconcileServer(destination)
      return partial(
        `Copied to ${destinationName} as a draft, but could not publish it; the source was kept.`,
        'error',
        copied,
      )
    }
  }
  if (!isCurrentServerConnection(source) || !isCurrentServerConnection(destination)) {
    void reconcileServer(destination)
    return partial(
      `Copied to ${destinationName}, but a server connection changed and the source was kept.`,
      'warning',
      copied,
    )
  }
  const surface = drawn.surface ?? WORLD_TEMPLATE_SURFACE
  if (surface.kind !== 'world') await reconcileServer(destination)
  if (
    !(await destinationIsAdmitted(
      destination,
      {
        nodes: [],
        templates: [
          {
            id: copied,
            nodeId,
            name: ready.name,
            version: uploaded.version,
            published: beforePublish.published,
          },
        ],
      },
      surface,
      currentServerTemplate,
    ))
  ) {
    void reconcileServer(destination)
    return partial(
      `Copied to ${destinationName}, but its destination could not be admitted; the source was kept.`,
      'warning',
      copied,
    )
  }
  if (!isCurrentServerConnection(source) || !isCurrentServerConnection(destination)) {
    return partial(
      `Copied to ${destinationName}, but a server connection changed and the source was kept.`,
      'warning',
      copied,
    )
  }
  const latest = currentServerTemplate(source, published.id)
  if (latest === null || !sameServerTemplateRevision(beforePublish, latest)) {
    void reconcileServer(destination)
    return partial(
      `Copied to ${destinationName}, but the source changed and was kept.`,
      'warning',
      copied,
    )
  }
  const removed = await deleteTemplateOnServer(source, published.id, {
    version: beforePublish.version,
    updatedAt: beforePublish.updatedAt,
  })
  void Promise.all([reconcileServer(source), reconcileServer(destination)])
  return removed.ok
    ? {
        ok: true,
        tone: 'success',
        destinationId: copied,
        message: `Moved “${published.name}” to ${destinationName}.`,
      }
    : partial(
        `Copied to ${destinationName}, but could not remove it from ${sourceName}.`,
        'error',
        copied,
      )
}

interface BranchReadFailure {
  readonly error: string
}

const serverBranch = async (
  server: ConnectedServer,
  rootId: string,
  templatesOf: (nodeId: string) => readonly PublishedTemplate[],
  templatesForServer?: () => readonly LocatedPublishedTemplate[],
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<Branch | BranchReadFailure | null> => {
  const listed = await listServerNodes(server, undefined, surface)
  if (listed.status !== 'ok') {
    return {
      error:
        listed.status === 'unreachable'
          ? 'Could not ask the source server for its current folders.'
          : 'Cannot use the source folders while connected server data exceeds the client safety limits.',
    }
  }
  const { nodes } = listed
  const root = nodes.find((node) => node.id === rootId)
  if (root === undefined) return null

  // Follow the hierarchy the manifest validated and the tree renders. Paths are compared with
  // SQLite's ASCII case fold on the wire, so a compatible server may spell a child prefix with
  // different ASCII case from its parent; a raw startsWith would silently leave that branch behind.
  const children = new Map<string, TreeNode[]>()
  for (const node of nodes) {
    if (node.parentId === null) continue
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  const within: TreeNode[] = []
  const seen = new Set<string>()
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined || seen.has(node.id)) continue
    seen.add(node.id)
    within.push(node)
    stack.push(...[...(children.get(node.id) ?? [])].reverse())
  }
  const folders = within.map((node: TreeNode) => ({
    id: node.id,
    parentId: node.id === rootId ? null : node.parentId,
    sourceParentId: node.parentId,
    name: node.name,
    ...(node.description === undefined ? {} : { description: node.description }),
  }))

  let templatesByNode: ReadonlyMap<string, readonly PublishedTemplate[]> | null = null
  if (templatesForServer !== undefined) {
    const grouped = new Map<string, PublishedTemplate[]>()
    for (const template of templatesForServer()) {
      if (template.nodeId === null) continue
      const siblings = grouped.get(template.nodeId) ?? []
      siblings.push(template)
      grouped.set(template.nodeId, siblings)
    }
    templatesByNode = grouped
  }
  const templates: Array<Branch['templates'][number]> = []
  for (const node of within) {
    const publishedInNode =
      templatesByNode === null ? templatesOf(node.id) : (templatesByNode.get(node.id) ?? [])
    for (const published of publishedInNode) {
      const drawn = drawnFor(server.url, published)
      if (drawn === undefined) return null
      templates.push({
        folderId: node.id,
        template: drawn,
        sourceId: published.id,
        sourceRevision:
          typeof published.published === 'boolean' && typeof published.updatedAt === 'number'
            ? {
                version: published.version,
                name: published.name,
                published: published.published,
                updatedAt: published.updatedAt,
              }
            : null,
      })
    }
  }
  return { name: root.name, folders, templates }
}

const localBranch = (rootId: string): Branch | null => {
  const all = getState().localFolders
  const root = all.find((folder) => folder.id === rootId)
  if (root === undefined) return null

  const children = new Map<string, string[]>()
  for (const folder of all) {
    if (folder.parentId === null) continue
    const siblings = children.get(folder.parentId) ?? []
    siblings.push(folder.id)
    children.set(folder.parentId, siblings)
  }
  const within = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || within.has(id)) continue
    within.add(id)
    for (const child of children.get(id) ?? []) stack.push(child)
  }

  const folders = all
    .filter((folder) => within.has(folder.id))
    .map((folder) => ({
      id: folder.id,
      parentId: folder.id === rootId ? null : folder.parentId,
      sourceParentId: folder.parentId,
      name: folder.name,
    }))
  const templates = localTemplates()
    .filter((template) => template.folderId !== null && within.has(template.folderId))
    .map((template) => ({
      folderId: template.folderId as string,
      template,
      sourceId: template.id,
      sourceRevision: null,
    }))
  return { name: root.name, folders, templates }
}

/** Folders first, parents before children, so a destination parent always exists when needed. */
const inCreationOrder = (branch: Branch): Branch['folders'] => {
  const children = new Map<string | null, Array<Branch['folders'][number]>>()
  for (const folder of branch.folders) {
    const siblings = children.get(folder.parentId) ?? []
    siblings.push(folder)
    children.set(folder.parentId, siblings)
  }
  const out: Array<Branch['folders'][number]> = []
  const seen = new Set<string>()
  const stack = [...(children.get(null) ?? [])].reverse()
  while (stack.length > 0) {
    const folder = stack.pop()
    if (folder === undefined || seen.has(folder.id)) continue
    seen.add(folder.id)
    out.push(folder)
    const descendants = children.get(folder.id) ?? []
    for (let at = descendants.length - 1; at >= 0; at--) {
      const child = descendants[at]
      if (child !== undefined) stack.push(child)
    }
  }
  return out
}

/**
 * Copy a branch to its destination, then take it off the source.
 *
 * Returns what happened rather than throwing, because every failure here is one a person needs told
 * in a sentence: a server refused a name, a template has not finished loading, a token turned out not
 * to be admin after all.
 */
const transplantWhileDestinationHeld = async (
  source: Source,
  destination: Destination,
  templatesOf: (server: ConnectedServer, nodeId: string) => readonly PublishedTemplate[],
  templatesForServer:
    | ((server: ConnectedServer) => readonly LocatedPublishedTemplate[])
    | undefined,
  destinationLeases: Array<() => void>,
  destinationTemplateLeases: Array<() => void>,
  reconcileServer: ReconcileServer | undefined,
  surface: TemplateSurface,
): Promise<TransplantResult> => {
  const branch =
    source.kind === 'local'
      ? localBranch(source.folderId)
      : await serverBranch(
          source.server,
          source.nodeId,
          (nodeId) => templatesOf(source.server, nodeId),
          templatesForServer === undefined ? undefined : () => templatesForServer(source.server),
          surface,
        )
  if (branch !== null && 'error' in branch) {
    return { ok: false, nodes: 0, templates: 0, message: branch.error }
  }
  if (branch === null) {
    return {
      ok: false,
      nodes: 0,
      templates: 0,
      message:
        'Some templates in that folder have not finished loading yet — try again in a moment.',
    }
  }
  if (destination.kind === 'local') {
    const described = branch.folders.find((folder) => folder.description !== undefined)
    if (described !== undefined) {
      return {
        ok: false,
        nodes: 0,
        templates: 0,
        message: `“${described.name}” has a server description that Local folders cannot preserve.`,
      }
    }
    const wrapped = branch.templates.find(({ template }) => !canCopyAsLocalTemplate(template))
    if (wrapped !== undefined) {
      return {
        ok: false,
        nodes: 0,
        templates: 0,
        message: `“${wrapped.template.name}” wraps across the world edge and cannot be moved into Local yet.`,
      }
    }
  }

  /** Source folder id to the id it now has at the destination. */
  const mapped = new Map<string, string>()
  let nodes = 0
  let templates = 0
  const createdNodes: TreeNode[] = []
  const uploadedTemplates: DestinationAdmission['templates'][number][] = []

  const connectionsAreCurrent = (): boolean =>
    (source.kind === 'local' || isCurrentServerConnection(source.server)) &&
    (destination.kind === 'local' || isCurrentServerConnection(destination.server))
  const connectionChanged = (): TransplantResult => ({
    ok: false,
    nodes,
    templates,
    message: 'A server connection changed during the move, so it stopped before the next write.',
  })
  let indexedServerTemplates: readonly LocatedPublishedTemplate[] | null = null
  let serverTemplateById = new Map<string, LocatedPublishedTemplate>()
  const currentServerTemplate = (id: string): LocatedPublishedTemplate | undefined => {
    if (source.kind === 'local' || templatesForServer === undefined) return undefined
    const current = templatesForServer(source.server)
    if (current !== indexedServerTemplates) {
      indexedServerTemplates = current
      serverTemplateById = new Map(current.map((template) => [template.id, template]))
    }
    return serverTemplateById.get(id)
  }
  const sourceTemplateIsCurrent = (carried: Branch['templates'][number]): boolean => {
    if (source.kind === 'local') {
      return isCurrentTemplate(carried.template) && movingId() !== carried.template.id
    }
    if (templatesForServer === undefined) {
      return templatesOf(source.server, carried.folderId).some(
        (candidate) =>
          candidate.id === carried.sourceId && candidate.version === carried.template.serverVersion,
      )
    }
    const current = currentServerTemplate(carried.sourceId)
    const revision = carried.sourceRevision
    return (
      current !== undefined &&
      current.nodeId === carried.folderId &&
      current.version === carried.template.serverVersion &&
      (revision === null ||
        (current.name === revision.name &&
          current.published === revision.published &&
          current.updatedAt === revision.updatedAt))
    )
  }
  const sourceTemplateChanged = (carried: Branch['templates'][number]): TransplantResult => ({
    ok: false,
    nodes,
    templates,
    message: `The source version of “${carried.template.name}” changed, so the move stopped before the next write.`,
  })
  const sourceFolderIds = new Set(branch.folders.map((folder) => folder.id))
  const sourceTemplateIds = new Set(branch.templates.map((carried) => carried.sourceId))
  let checkedLocalFolders: readonly LocalFolder[] | null = null
  let checkedLocalFoldersAreCurrent = false
  const sourceFoldersAreCurrent = (): boolean => {
    const folders = getState().localFolders
    if (folders === checkedLocalFolders) return checkedLocalFoldersAreCurrent
    checkedLocalFolders = folders
    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    checkedLocalFoldersAreCurrent =
      branch.folders.every((folder) => {
        const current = byId.get(folder.id)
        return (
          current !== undefined &&
          current.parentId === folder.sourceParentId &&
          current.name === folder.name
        )
      }) &&
      !folders.some(
        (folder) =>
          folder.parentId !== null &&
          sourceFolderIds.has(folder.parentId) &&
          !sourceFolderIds.has(folder.id),
      )
    return checkedLocalFoldersAreCurrent
  }
  const sourceBranchIsCurrent = (): boolean => {
    if (source.kind === 'server') return branch.templates.every(sourceTemplateIsCurrent)
    return (
      sourceFoldersAreCurrent() &&
      branch.templates.every(sourceTemplateIsCurrent) &&
      !localTemplates().some(
        (template) =>
          template.folderId !== null &&
          sourceFolderIds.has(template.folderId) &&
          !sourceTemplateIds.has(template.id),
      )
    )
  }
  const sourceBranchChanged = (): TransplantResult => ({
    ok: false,
    nodes,
    templates,
    message: `The source branch “${branch.name}” changed, so the move stopped before the next write.`,
  })

  // Local folders are built in memory and written once. `setState` serialises the whole state, so
  // one write per folder costs the square of the branch: a server branch of any real size locked
  // the tab up before any of it appeared.
  const madeLocally: LocalFolder[] = []

  // A Local destination is built synchronously below. Nothing can change the server source during
  // that batch, so one check protects the whole loop without rescanning a large manifest per folder.
  if (destination.kind === 'local' && !sourceBranchIsCurrent()) return sourceBranchChanged()
  for (const folder of inCreationOrder(branch)) {
    if (destination.kind === 'server' && !sourceBranchIsCurrent()) return sourceBranchChanged()
    const parent =
      folder.parentId === null
        ? destination.kind === 'server'
          ? destination.nodeId
          : destination.folderId
        : (mapped.get(folder.parentId) ?? null)

    if (destination.kind === 'server') {
      if (!connectionsAreCurrent()) return connectionChanged()
      const created = await createNode(
        destination.server,
        folder.name,
        parent,
        folder.description,
        surface,
      )
      if (!created.ok) return { ok: false, nodes, templates, message: created.message }
      if (!sourceBranchIsCurrent()) return sourceBranchChanged()
      mapped.set(folder.id, created.node.id)
      createdNodes.push(created.node)
    } else {
      const id = nextLocalFolderId()
      madeLocally.push({ id, parentId: parent, name: folder.name, visible: true, surface })
      mapped.set(folder.id, id)
    }
    nodes++
  }

  if (!addLocalFolders(madeLocally)) {
    return {
      ok: false,
      nodes: 0,
      templates: 0,
      message: `That branch has more folders than Local can hold (${MAX_LOCAL_FOLDERS}).`,
    }
  }
  // `addLocalFolders` notifies the tree, which makes this new skeleton visible while templates are
  // copied one at a time. Pin every new folder synchronously before the first await, so deleting a
  // row mid-copy cannot invalidate a later assignment. No user event can run between the batch and
  // these leases.
  for (const folder of madeLocally) {
    const release = leaseLocalFolder(folder.id)
    if (release === null) {
      return {
        ok: false,
        nodes,
        templates: 0,
        message: `The new Local folder “${folder.name}” could not be kept for the move.`,
      }
    }
    destinationLeases.push(release)
  }

  for (const carried of branch.templates) {
    const target = mapped.get(carried.folderId)
    if (target === undefined) continue
    if (!sourceBranchIsCurrent()) return sourceBranchChanged()
    if (destination.kind === 'server') {
      if (!connectionsAreCurrent()) return connectionChanged()
      const png = await templateAsPng(carried.template)
      if (png === null) {
        return {
          ok: false,
          nodes,
          templates,
          message: `Could not encode “${carried.template.name}”.`,
        }
      }
      if (!isCurrentTemplate(carried.template) || movingId() === carried.template.id) {
        return {
          ok: false,
          nodes,
          templates,
          message: `“${carried.template.name}” changed while it was being copied.`,
        }
      }
      if (!sourceTemplateIsCurrent(carried)) return sourceTemplateChanged(carried)
      if (!connectionsAreCurrent()) return connectionChanged()
      const uploadedName = carried.sourceRevision?.name ?? carried.template.name
      const uploaded = await uploadTemplate(destination.server, {
        nodeId: target,
        name: uploadedName,
        originX: carried.template.originX,
        originY: carried.template.originY,
        png,
        surface: carried.template.surface ?? WORLD_TEMPLATE_SURFACE,
      })
      if (!uploaded.ok) return { ok: false, nodes, templates, message: uploaded.message }
      if (carried.sourceRevision?.published === true) {
        if (!sourceBranchIsCurrent()) return sourceBranchChanged()
        if (!connectionsAreCurrent()) return connectionChanged()
        const published = await patchTemplate(destination.server, uploaded.id, { published: true })
        if (!published.ok) {
          return {
            ok: false,
            nodes,
            templates,
            message: `Copied “${carried.template.name}” as a draft, but could not publish it at the destination.`,
          }
        }
      }
      uploadedTemplates.push({
        id: uploaded.id,
        nodeId: target,
        name: uploadedName,
        version: uploaded.version,
        published: carried.sourceRevision?.published === true,
      })
    } else {
      let copied: PlacedTemplate
      try {
        copied = await copyAsLocalTemplate(carried.template, localId())
      } catch (error) {
        return {
          ok: false,
          nodes,
          templates,
          message: `Could not copy “${carried.template.name}” into Local: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      const releaseCopied = leaseLocalTemplate(copied.id)
      if (releaseCopied === null) {
        return {
          ok: false,
          nodes,
          templates,
          message: `Copied “${carried.template.name}”, but could not keep the new Local copy.`,
        }
      }
      destinationTemplateLeases.push(releaseCopied)
      if (!(await setTemplateFolder(copied.id, target))) {
        return {
          ok: false,
          nodes,
          templates,
          message: `Copied “${carried.template.name}”, but could not put it in its Local folder.`,
        }
      }
    }
    // The source can advance while the destination write itself awaits. Stop before beginning the
    // next template rather than discovering the changed earlier row only during final cleanup.
    if (!sourceBranchIsCurrent()) return sourceBranchChanged()
    templates++
  }

  if (destination.kind === 'server') {
    if (!connectionsAreCurrent()) return connectionChanged()
    await reconcileServer?.(destination.server)
    const admitted = await destinationIsAdmitted(
      destination.server,
      {
        nodes: createdNodes,
        templates: uploadedTemplates,
      },
      surface,
      templatesForServer === undefined
        ? undefined
        : (server, templateId) =>
            templatesForServer(server).find((template) => template.id === templateId) ?? null,
    )
    if (!admitted) {
      return {
        ok: false,
        nodes,
        templates,
        message:
          'Copied the branch, but its destination could not be admitted, so the source was kept.',
      }
    }
    if (!sourceBranchIsCurrent()) return sourceBranchChanged()
    if (!connectionsAreCurrent()) return connectionChanged()
  }

  // Everything arrived. Only now is the source touched.
  if (source.kind === 'server') {
    for (const carried of branch.templates) {
      if (!connectionsAreCurrent()) return connectionChanged()
      if (!sourceTemplateIsCurrent(carried)) return sourceTemplateChanged(carried)
      const revision = carried.sourceRevision
      if (revision === null) return sourceTemplateChanged(carried)
      const removed = await deleteTemplateOnServer(source.server, carried.sourceId, {
        version: revision.version,
        updatedAt: revision.updatedAt,
      })
      if (!removed.ok) {
        return {
          ok: false,
          nodes,
          templates,
          message: `Copied, but could not remove “${carried.template.name}” from the source.`,
        }
      }
    }
    // Deepest first, because a server refuses to delete a node that still holds anything.
    for (const folder of [...inCreationOrder(branch)].reverse()) {
      if (!connectionsAreCurrent()) return connectionChanged()
      const removed = await deleteNodeOnServer(source.server, folder.id)
      if (!removed.ok) {
        return {
          ok: false,
          nodes,
          templates,
          message: `Moved the templates, but could not remove source folder “${folder.name}”: ${removed.message}`,
        }
      }
    }
  } else {
    if (!connectionsAreCurrent()) return connectionChanged()
    const sourceFoldersChanged = (): TransplantResult => ({
      ok: false,
      nodes,
      templates,
      message: `Copied, but Local source folder “${branch.name}” changed and was kept.`,
    })
    if (!sourceFoldersAreCurrent()) return sourceFoldersChanged()
    for (const carried of branch.templates) {
      if (!sourceFoldersAreCurrent()) return sourceFoldersChanged()
      if (!sourceTemplateIsCurrent(carried)) {
        return {
          ok: false,
          nodes,
          templates,
          message: `Copied, but “${carried.template.name}” changed at the source and was kept.`,
        }
      }
      if (!(await removeLocalTemplate(carried.sourceId))) {
        return {
          ok: false,
          nodes,
          templates,
          message: `Copied, but could not remove “${carried.template.name}” from Local.`,
        }
      }
    }
    if (!sourceFoldersAreCurrent()) return sourceFoldersChanged()
    if (
      localTemplates().some(
        (template) => template.folderId !== null && sourceFolderIds.has(template.folderId),
      )
    ) {
      return {
        ok: false,
        nodes,
        templates,
        message: `Moved the original templates, but Local source folder “${branch.name}” received new content and was kept.`,
      }
    }
    if (!removeLocalFolders(sourceFolderIds)) {
      return {
        ok: false,
        nodes,
        templates,
        message: `Moved the templates, but could not remove Local source folder “${branch.name}”.`,
      }
    }
  }

  const destinationRootId = mapped.get(source.kind === 'local' ? source.folderId : source.nodeId)
  if (destinationRootId === undefined) {
    return { ok: false, nodes, templates, message: 'The moved folder has no destination identity.' }
  }
  return {
    ok: true,
    nodes,
    templates,
    destinationRootId,
    message: `Moved “${branch.name}” — ${nodes} folder${nodes === 1 ? '' : 's'}, ${templates} template${templates === 1 ? '' : 's'}.`,
  }
}

const activeSources = new Set<string>()

const sourceKey = (source: Source): string =>
  source.kind === 'local'
    ? `local:${source.folderId}`
    : `server:${source.server.url}:${source.nodeId}`

/** Keep a Local destination present from the source read through the final source deletion. */
export const transplant = async (
  source: Source,
  destination: Destination,
  templatesOf: (server: ConnectedServer, nodeId: string) => readonly PublishedTemplate[],
  templatesForServer?: (server: ConnectedServer) => readonly LocatedPublishedTemplate[],
  reconcileServer?: ReconcileServer,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<TransplantResult> => {
  const activeSource = sourceKey(source)
  if (activeSources.has(activeSource)) {
    return {
      ok: false,
      nodes: 0,
      templates: 0,
      message: 'That folder is already being moved.',
    }
  }
  activeSources.add(activeSource)
  const releaseDestination =
    destination.kind === 'local' && destination.folderId !== null
      ? leaseLocalFolder(destination.folderId)
      : null
  if (
    destination.kind === 'local' &&
    destination.folderId !== null &&
    releaseDestination === null
  ) {
    activeSources.delete(activeSource)
    return {
      ok: false,
      nodes: 0,
      templates: 0,
      message: 'The destination Local folder no longer exists.',
    }
  }
  const destinationLeases = releaseDestination === null ? [] : [releaseDestination]
  const destinationTemplateLeases: Array<() => void> = []
  try {
    const result = await transplantWhileDestinationHeld(
      source,
      destination,
      templatesOf,
      templatesForServer,
      destinationLeases,
      destinationTemplateLeases,
      reconcileServer,
      surface,
    )
    if (reconcileServer !== undefined) {
      const servers = new Map<string, ConnectedServer>()
      if (source.kind === 'server') servers.set(source.server.url, source.server)
      if (destination.kind === 'server') servers.set(destination.server.url, destination.server)
      void Promise.all([...servers.values()].map(reconcileServer))
    }
    return result
  } finally {
    for (const release of destinationTemplateLeases.reverse()) release()
    for (const release of destinationLeases.reverse()) release()
    activeSources.delete(activeSource)
  }
}
