import {
  mismatchRevision,
  type TemplateColourProgress,
  type TemplateProgress,
} from '../templates/mismatch.js'
import type { IconName } from './icons.js'
import { sumColourProgress, sumProgress } from './progress.js'

/** One row, as the domain supplying it sees it. Placement and recursion belong to the renderer. */
export interface TreeItem {
  readonly key: string
  readonly name: string
  readonly kind: IconName
  /** Its id as a container, so the renderer can ask for its children. Null for a leaf. */
  readonly childrenOf: string | null
  readonly createdAt?: number
  readonly meta?: string | undefined
  readonly progress?: TemplateProgress
  readonly progressReader?: (() => TemplateProgress) | undefined
  readonly colourProgress?: (() => readonly TemplateColourProgress[]) | undefined
  /** Show the row, but keep an unpublished template out of every ancestor rollup. */
  readonly excludeFromRollup?: true
  readonly progressSortable?: true
  readonly muted?: boolean | undefined
  readonly visible: boolean
  readonly setVisible: (on: boolean) => boolean | Promise<boolean>
  readonly canReparent: boolean
  readonly actions?: ReadonlyArray<{ icon: IconName; label: string; run: () => void }> | undefined
  readonly leadingActions?:
    | ReadonlyArray<{ icon: IconName; label: string; run: () => void }>
    | undefined
  readonly onRename?: ((name: string) => void) | undefined
  readonly onContextMenu?: ((event: MouseEvent) => void) | undefined
  readonly onDropAt?:
    | ((
        draggedKey: string,
        parentKey: string | null,
        beforeKey: string | null,
      ) => Promise<string | null>)
    | undefined
}

/**
 * A hierarchy independent of where its rows came from.
 *
 * Local and server-backed trees differ in their mutations and loading, not in aggregation,
 * filtering, ordering, or traversal. This source is the boundary between those concerns.
 */
export interface TreeSource {
  readonly children: (parentId: string | null) => readonly TreeItem[]
  readonly progress: (parentId: string | null) => TemplateProgress | undefined
  readonly colourProgress: (
    parentId: string | null,
  ) => readonly TemplateColourProgress[] | undefined
}

export const groupedTreeSource = (
  entries: ReadonlyArray<{
    readonly parentId: string | null
    readonly item: TreeItem
  }>,
): TreeSource => {
  const byParent = new Map<string | null, TreeItem[]>()
  for (const { parentId, item } of entries) {
    const siblings = byParent.get(parentId) ?? []
    siblings.push(item)
    byParent.set(parentId, siblings)
  }
  const totals = new Map<string | null, TemplateProgress | undefined>()
  const colourTotals = new Map<string | null, readonly TemplateColourProgress[] | undefined>()
  const colourAvailability = new Map<string | null, boolean>()
  const visiting = new Set<string | null>()
  const colourVisiting = new Set<string | null>()
  let revision = mismatchRevision()
  const ensureCurrentRevision = (): void => {
    const current = mismatchRevision()
    if (current === revision) return
    revision = current
    totals.clear()
    colourTotals.clear()
  }
  const progress = (parentId: string | null): TemplateProgress | undefined => {
    ensureCurrentRevision()
    if (totals.has(parentId)) return totals.get(parentId)
    if (visiting.has(parentId)) return undefined
    visiting.add(parentId)
    const descendants: TemplateProgress[] = []
    for (const item of byParent.get(parentId) ?? []) {
      if (item.excludeFromRollup === true) continue
      const itemProgress =
        item.childrenOf === null
          ? (item.progressReader?.() ?? item.progress)
          : progress(item.childrenOf)
      if (itemProgress !== undefined) descendants.push(itemProgress)
    }
    visiting.delete(parentId)
    const total = sumProgress(descendants)
    totals.set(parentId, total)
    return total
  }
  const hasColourProgress = (parentId: string | null): boolean => {
    const cached = colourAvailability.get(parentId)
    if (cached !== undefined) return cached
    if (colourVisiting.has(parentId)) return false
    colourVisiting.add(parentId)
    let found = false
    let available = true
    for (const item of byParent.get(parentId) ?? []) {
      if (item.excludeFromRollup === true) continue
      const overall = item.childrenOf === null ? item.progress : progress(item.childrenOf)
      if (overall === undefined) continue
      found = true
      const itemAvailable =
        item.childrenOf === null
          ? item.colourProgress !== undefined
          : hasColourProgress(item.childrenOf)
      if (!itemAvailable) {
        available = false
        break
      }
    }
    colourVisiting.delete(parentId)
    const result = found && available
    colourAvailability.set(parentId, result)
    return result
  }
  const colourProgress = (
    parentId: string | null,
  ): readonly TemplateColourProgress[] | undefined => {
    ensureCurrentRevision()
    if (colourTotals.has(parentId)) return colourTotals.get(parentId)
    if (!hasColourProgress(parentId)) return undefined
    if (colourVisiting.has(parentId)) return undefined
    colourVisiting.add(parentId)
    const descendants: Array<readonly TemplateColourProgress[]> = []
    for (const item of byParent.get(parentId) ?? []) {
      if (item.excludeFromRollup === true) continue
      const itemProgress =
        item.childrenOf === null ? item.colourProgress?.() : colourProgress(item.childrenOf)
      if (itemProgress !== undefined) descendants.push(itemProgress)
    }
    colourVisiting.delete(parentId)
    const total = sumColourProgress(descendants)
    const overall = progress(parentId)
    const complete =
      total !== undefined &&
      overall !== undefined &&
      total.reduce((sum, entry) => sum + entry.total, 0) === overall.total
        ? total
        : undefined
    colourTotals.set(parentId, complete)
    return complete
  }
  return {
    children: (parentId) =>
      (byParent.get(parentId) ?? []).map((item) => {
        if (item.childrenOf === null) return item
        const total = progress(item.childrenOf)
        const hasColours = hasColourProgress(item.childrenOf)
        return {
          ...item,
          ...(total === undefined
            ? {}
            : { progress: total, progressReader: () => progress(item.childrenOf) ?? total }),
          ...(hasColours ? { colourProgress: () => colourProgress(item.childrenOf) ?? [] } : {}),
        }
      }),
    progress,
    colourProgress,
  }
}

export const treeMatcher = (source: TreeSource, needle: string): ((item: TreeItem) => boolean) => {
  if (needle === '') return () => true
  const matches = new Map<string, boolean>()
  const visiting = new Set<string>()
  const visit = (item: TreeItem): boolean => {
    const cached = matches.get(item.key)
    if (cached !== undefined) return cached
    if (item.name.toLocaleLowerCase().includes(needle)) {
      matches.set(item.key, true)
      return true
    }
    if (item.childrenOf === null || visiting.has(item.key)) {
      matches.set(item.key, false)
      return false
    }
    visiting.add(item.key)
    const result = source.children(item.childrenOf).some(visit)
    visiting.delete(item.key)
    matches.set(item.key, result)
    return result
  }
  return visit
}
