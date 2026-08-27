import type { ServerTemplate } from '../server-cache.js'
import type { TreeNode } from '../server-manifest.js'

/** Every template directly or indirectly contained by one server folder. */
export const templatesInFolderSubtree = (
  nodes: readonly TreeNode[],
  templates: readonly ServerTemplate[],
  rootId: string,
): readonly ServerTemplate[] => {
  const children = new Map<string, string[]>()
  for (const node of nodes) {
    if (node.parentId === null) continue
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node.id)
    children.set(node.parentId, siblings)
  }

  const within = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || within.has(id)) continue
    within.add(id)
    for (const child of children.get(id) ?? []) stack.push(child)
  }
  return templates.filter((template) => template.nodeId !== null && within.has(template.nodeId))
}

export interface FolderPublicationFailure {
  readonly template: ServerTemplate
  readonly message: string
}

export interface FolderPublicationResult {
  /** Templates that actually needed a change. */
  readonly requested: number
  readonly succeeded: number
  readonly failures: readonly FolderPublicationFailure[]
}

type PatchResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

/** Apply one publication state without opening an unbounded burst of template PATCH requests. */
export const setFolderTemplatesPublished = async (
  templates: readonly ServerTemplate[],
  published: boolean,
  patch: (template: ServerTemplate) => Promise<PatchResult>,
): Promise<FolderPublicationResult> => {
  const wanted = templates.filter((template) => template.published !== published)
  if (wanted.length === 0) return { requested: 0, succeeded: 0, failures: [] }

  const results = new Array<PatchResult>(wanted.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < wanted.length) {
      const index = cursor++
      const template = wanted[index]
      if (template !== undefined) results[index] = await patch(template)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, worker))

  const failures: FolderPublicationFailure[] = []
  for (let index = 0; index < wanted.length; index++) {
    const result = results[index]
    const template = wanted[index]
    if (template !== undefined && result?.ok === false)
      failures.push({ template, message: result.message })
  }
  return {
    requested: wanted.length,
    succeeded: wanted.length - failures.length,
    failures,
  }
}
