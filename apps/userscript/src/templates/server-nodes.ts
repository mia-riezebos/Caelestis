import { type TemplateSurface, templateSurfaceKey, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { isScopeVisible } from '../state.js'

/**
 * Which folder each of a server's templates sits under, and what sits above that.
 *
 * A server's folders are a tree, and a switch on a folder has to reach everything beneath it — the
 * templates directly inside, and every template inside every folder inside it. Answering that needs
 * the parent chain, which lives in the manifest and nowhere else.
 *
 * Kept here rather than in the tree that draws it. The renderer held these in a map of its own, so
 * "is this template drawn" — a question the GL layer asks sixty times a second — could only have
 * been answered by the panel reaching down into the store, or the store reaching up into the panel.
 * Both are wrong; the shape belongs to neither.
 *
 * Not persisted. It is a copy of what the server said, refreshed on every manifest fetch, and the
 * cache already stores the manifest itself — a second copy would only be a way for the two to
 * disagree. What *is* persisted is the switch, keyed by node id, exactly as a Local folder's is.
 */

/** Parent of each node, per server and drawing surface. Null means the surface's top level. */
const parents = new Map<string, Map<string, string | null>>()
let revision = 0

const parentMapKey = (serverUrl: string, surface: TemplateSurface): string =>
  `${serverUrl}\n${templateSurfaceKey(surface)}`

export const serverNodesRevision = (): number => revision

/** Parent rows in manifest order, for consumers that need to reproduce the server tree. */
export const serverNodeParents = (
  serverUrl: string,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): readonly (readonly [id: string, parentId: string | null])[] => [
  ...(parents.get(parentMapKey(serverUrl, surface))?.entries() ?? []),
]

export const rememberNodes = (
  serverUrl: string,
  nodes: readonly { id: string; parentId: string | null }[],
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): void => {
  parents.set(
    parentMapKey(serverUrl, surface),
    new Map(nodes.map((node) => [node.id, node.parentId])),
  )
  revision++
}

/** The scope key a folder's switch writes to, isolated from equal ids on another server. */
export const nodeScopeKey = (serverUrl: string, nodeId: string): string =>
  `node:${encodeURIComponent(serverUrl)}:${nodeId}`

/**
 * Whether every folder from this one up to the server's root is switched on.
 *
 * A folder that is off keeps saying its contents are on, because they are — inside a group that is
 * not — and that is what makes switching the group back on restore the arrangement instead of
 * flattening it.
 *
 * Bounded by the number of nodes rather than trusting the tree to be one: a manifest is data from
 * somewhere else, and a parent cycle in it would otherwise be an infinite loop in the render path.
 */
export const nodeChainVisible = (
  serverUrl: string,
  nodeId: string | null,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): boolean => {
  const byId = parents.get(parentMapKey(serverUrl, surface))
  if (byId === undefined) return true
  let at = nodeId
  for (let depth = 0; at !== null && depth <= byId.size; depth++) {
    if (!isScopeVisible(nodeScopeKey(serverUrl, at))) return false
    at = byId.get(at) ?? null
  }
  return true
}

/**
 * Drop one server's folders, and report which they were.
 *
 * The ids come back because their visibility switches are stored by node id, and once this map is
 * gone there is nothing left that could work out which stored keys belonged to this server.
 */
export const forgetNodes = (serverUrl: string): readonly string[] => {
  const ids = new Set<string>()
  for (const [key, byId] of parents) {
    if (!key.startsWith(`${serverUrl}\n`)) continue
    parents.delete(key)
    for (const id of byId.keys()) ids.add(id)
  }
  revision++
  return [...ids]
}
