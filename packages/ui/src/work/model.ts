import type { PainterIdentity, WorkClient } from '@caelestis/shared'

/** One server drawing scope, provided by the frontend page or userscript connection. */
export interface WorkModel {
  readonly client: WorkClient
  readonly revision: string
  readonly nodes: readonly {
    readonly id: string
    readonly name: string
    readonly parentId: string | null
  }[]
  readonly templates: readonly {
    readonly id: string
    readonly name: string
    readonly nodeId: string | null
  }[]
  readonly identity?: PainterIdentity | null
  readonly rememberIdentity?: (identity: PainterIdentity | null) => void
  readonly nodeId?: string
  readonly templateId?: string
  readonly itemId?: string
}
