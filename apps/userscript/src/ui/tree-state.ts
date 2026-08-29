import type { TreeIcon } from '@caelestis/ui/elements'
import { getState } from '../state.js'
import type { TemplateColourProgress, TemplateProgress } from '../templates/mismatch.js'

export interface SiblingLevel {
  readonly visible: readonly string[]
  readonly all: () => readonly string[]
}

export interface RowAction {
  readonly icon: TreeIcon
  readonly label: string
  readonly run: () => void
}

export interface TreeRowOptions {
  readonly key: string
  readonly name: string
  readonly kind: Extract<TreeIcon, 'folder' | 'image' | 'server'>
  readonly depth: number
  readonly branches?: readonly boolean[] | undefined
  readonly meta?: string | undefined
  readonly lifecycle?:
    | { readonly finished: boolean; readonly frozen: boolean; readonly griefed: boolean }
    | undefined
  readonly progress?: TemplateProgress | undefined
  readonly progressReader?: (() => TemplateProgress) | undefined
  readonly colourProgress?: (() => readonly TemplateColourProgress[] | undefined) | undefined
  readonly leadingActions?:
    | ReadonlyArray<{ icon: TreeIcon; label: string; run: () => void }>
    | undefined
  readonly container: boolean
  readonly parentKey?: string | null | undefined
  readonly canReparent?: boolean | undefined
  readonly forceExpanded?: boolean | undefined
  readonly muted?: boolean | undefined
  readonly actions?: readonly RowAction[] | undefined
  readonly onRename?: ((name: string) => void) | undefined
  readonly onContextMenu?: ((event: MouseEvent) => void) | undefined
  readonly siblings: readonly string[]
  readonly orderingSiblings?: (() => readonly string[]) | undefined
  readonly destinationSiblings?:
    | ((parentKey: string | null) => SiblingLevel | undefined)
    | undefined
  readonly rerender: () => void
  readonly onError: (message: string) => void
  readonly onDropAt?:
    | ((
        draggedKey: string,
        parentKey: string | null,
        beforeKey: string | null,
      ) => Promise<string | null>)
    | undefined
  readonly checked?: boolean | undefined
  readonly onToggleChecked?: ((on: boolean) => void) | undefined
}

let renaming: string | null = null

export const startRenaming = (key: string): void => {
  renaming = key
}

export const currentRenamingKey = (): string | null => renaming

export const finishRenaming = (): void => {
  renaming = null
}

export const isTreeExpanded = (key: string): boolean => !getState().collapsed.includes(key)
