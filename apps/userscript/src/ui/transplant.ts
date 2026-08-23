import { warn } from '../debug.js'
import {
  addLocalFolders,
  type ConnectedServer,
  createNode,
  deleteNode as deleteNodeOnServer,
  deleteTemplate as deleteTemplateOnServer,
  getState,
  type LocalFolder,
  listServerNodes,
  MAX_LOCAL_FOLDERS,
  nextLocalFolderId,
  removeLocalFolder,
  type TreeNode,
  uploadTemplate,
} from '../state.js'
import {
  canCopyAsLocalTemplate,
  copyAsLocalTemplate,
  localTemplates,
  type PlacedTemplate,
  removeLocalTemplate,
  setTemplateFolder,
  templateAsPng,
} from '../templates/local-store.js'
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
  readonly folders: ReadonlyArray<{ id: string; parentId: string | null; name: string }>
  readonly templates: ReadonlyArray<{
    folderId: string
    template: PlacedTemplate
    sourceId: string
  }>
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
const drawnFor = (serverUrl: string, templateId: string): PlacedTemplate | undefined =>
  localTemplates().find((candidate) => candidate.id === serverTemplateKey(serverUrl, templateId))

const serverBranch = async (
  server: ConnectedServer,
  rootId: string,
  templatesOf: (nodeId: string) => ReadonlyArray<{ id: string; name: string }>,
): Promise<Branch | null> => {
  const nodes = await listServerNodes(server)
  if (nodes === null) return null
  const root = nodes.find((node) => node.id === rootId)
  if (root === undefined) return null

  // Descendants by materialized path, which is the one question that shape answers cheaply.
  const prefix = `${root.path}/`
  const within = nodes.filter((node) => node.id === rootId || node.path.startsWith(prefix))
  const folders = within.map((node: TreeNode) => ({
    id: node.id,
    parentId: node.id === rootId ? null : node.parentId,
    name: node.name,
  }))

  const templates: Array<{ folderId: string; template: PlacedTemplate; sourceId: string }> = []
  for (const node of within) {
    for (const published of templatesOf(node.id)) {
      const drawn = drawnFor(server.url, published.id)
      if (drawn === undefined) return null
      templates.push({ folderId: node.id, template: drawn, sourceId: published.id })
    }
  }
  return { name: root.name, folders, templates }
}

const localBranch = (rootId: string): Branch | null => {
  const all = getState().localFolders
  const root = all.find((folder) => folder.id === rootId)
  if (root === undefined) return null

  const within = new Set<string>([rootId])
  // Repeated passes rather than recursion: the list is small and a cycle cannot loop this.
  for (let pass = 0; pass < all.length; pass++) {
    for (const folder of all) {
      if (folder.parentId !== null && within.has(folder.parentId)) within.add(folder.id)
    }
  }

  const folders = all
    .filter((folder) => within.has(folder.id))
    .map((folder) => ({
      id: folder.id,
      parentId: folder.id === rootId ? null : folder.parentId,
      name: folder.name,
    }))
  const templates = localTemplates()
    .filter((template) => template.folderId !== null && within.has(template.folderId))
    .map((template) => ({
      folderId: template.folderId as string,
      template,
      sourceId: template.id,
    }))
  return { name: root.name, folders, templates }
}

/** Folders first, parents before children, so a destination parent always exists when needed. */
const inCreationOrder = (branch: Branch): Branch['folders'] => {
  const done = new Set<string>()
  const out: Array<{ id: string; parentId: string | null; name: string }> = []
  let guard = branch.folders.length + 1
  while (out.length < branch.folders.length && guard-- > 0) {
    for (const folder of branch.folders) {
      if (done.has(folder.id)) continue
      if (folder.parentId !== null && !done.has(folder.parentId)) continue
      done.add(folder.id)
      out.push(folder)
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
export const transplant = async (
  source: Source,
  destination: Destination,
  templatesOf: (
    server: ConnectedServer,
    nodeId: string,
  ) => ReadonlyArray<{ id: string; name: string }>,
): Promise<TransplantResult> => {
  const branch =
    source.kind === 'local'
      ? localBranch(source.folderId)
      : await serverBranch(source.server, source.nodeId, (nodeId) =>
          templatesOf(source.server, nodeId),
        )
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

  // Local folders are built in memory and written once. `setState` serialises the whole state, so
  // one write per folder costs the square of the branch: a server branch of any real size locked
  // the tab up before any of it appeared.
  const madeLocally: LocalFolder[] = []

  for (const folder of inCreationOrder(branch)) {
    const parent =
      folder.parentId === null
        ? destination.kind === 'server'
          ? destination.nodeId
          : destination.folderId
        : (mapped.get(folder.parentId) ?? null)

    if (destination.kind === 'server') {
      const created = await createNode(destination.server, folder.name, parent)
      if (!created.ok) return { ok: false, nodes, templates, message: created.message }
      mapped.set(folder.id, created.node.id)
    } else {
      const id = nextLocalFolderId()
      madeLocally.push({ id, parentId: parent, name: folder.name, visible: true })
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

  for (const carried of branch.templates) {
    const target = mapped.get(carried.folderId)
    if (target === undefined) continue
    if (destination.kind === 'server') {
      const png = await templateAsPng(carried.template)
      if (png === null) {
        return {
          ok: false,
          nodes,
          templates,
          message: `Could not encode “${carried.template.name}”.`,
        }
      }
      const uploaded = await uploadTemplate(destination.server, {
        nodeId: target,
        name: carried.template.name,
        originX: carried.template.originX,
        originY: carried.template.originY,
        png,
      })
      if (!uploaded.ok) return { ok: false, nodes, templates, message: uploaded.message }
    } else {
      const copied = await copyAsLocalTemplate(carried.template, localId())
      if (!(await setTemplateFolder(copied.id, target))) {
        return {
          ok: false,
          nodes,
          templates,
          message: `Copied “${carried.template.name}”, but could not put it in its Local folder.`,
        }
      }
    }
    templates++
  }

  // Everything arrived. Only now is the source touched.
  if (source.kind === 'server') {
    for (const carried of branch.templates) {
      const removed = await deleteTemplateOnServer(source.server, carried.sourceId)
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
      const removed = await deleteNodeOnServer(source.server, folder.id)
      if (!removed.ok) warn('install', 'could not remove a source folder', removed.message)
    }
  } else {
    for (const carried of branch.templates) {
      if (!(await removeLocalTemplate(carried.sourceId))) {
        return {
          ok: false,
          nodes,
          templates,
          message: `Copied, but could not remove “${carried.template.name}” from Local.`,
        }
      }
    }
    for (const folder of [...inCreationOrder(branch)].reverse()) removeLocalFolder(folder.id)
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
