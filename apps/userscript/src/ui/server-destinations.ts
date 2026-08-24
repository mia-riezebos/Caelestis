import type { TreeNode } from '../state.js'

export interface ServerDestinationChoice {
  readonly nodeId: string | null
  readonly label: string
}

/** Every place a server template may live. A folder is optional, not an admission requirement. */
export const serverDestinations = (
  nodes: readonly TreeNode[],
): readonly ServerDestinationChoice[] => [
  { nodeId: null, label: 'Server root' },
  ...nodes.map((node) => ({ nodeId: node.id, label: node.path })),
]
