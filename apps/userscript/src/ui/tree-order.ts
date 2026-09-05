import { getState, setState } from '../state.js'
import type { TemplateProgress } from '../templates/mismatch.js'
import { completionRatio } from './progress.js'

export const MAX_RENDERED_ROWS = 2_000

export interface OrderedTreeItem {
  readonly key: string
  readonly name: string
  readonly createdAt?: number
  readonly updatedAt?: number | undefined
  readonly totalPixels?: number | undefined
  readonly mismatched?: number | undefined
  /** Absent for structural rows; progress sorting leaves those in their durable slots. */
  readonly progress?: TemplateProgress | undefined
  /** Only template leaves move under metric sorts; structural rows keep their custom slots. */
  readonly progressSortable?: true | undefined
}

const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })

/** Apply the user's tree ordering without sorting more rows than the renderer can display. */
export const orderedTreeItems = <T extends OrderedTreeItem>(
  items: readonly T[],
  rank: ReadonlyMap<string, number>,
  limit = Number.POSITIVE_INFINITY,
): readonly T[] => {
  const bounded = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : items.length
  if (bounded === 0) return []
  const takeFirst = (compare: (a: T, b: T) => number): readonly T[] => {
    if (bounded >= items.length) return [...items].sort(compare)
    const heap: T[] = []
    const siftUp = (start: number): void => {
      let index = start
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2)
        const item = heap[index]
        const parentItem = heap[parent]
        if (item === undefined || parentItem === undefined || compare(item, parentItem) <= 0) break
        ;[heap[index], heap[parent]] = [parentItem, item]
        index = parent
      }
    }
    const siftDown = (): void => {
      let index = 0
      while (true) {
        const left = index * 2 + 1
        const right = left + 1
        let worst = index
        const leftItem = heap[left]
        const currentWorst = heap[worst]
        if (
          leftItem !== undefined &&
          currentWorst !== undefined &&
          compare(leftItem, currentWorst) > 0
        )
          worst = left
        const rightItem = heap[right]
        const nextWorst = heap[worst]
        if (rightItem !== undefined && nextWorst !== undefined && compare(rightItem, nextWorst) > 0)
          worst = right
        if (worst === index) return
        const current = heap[index]
        const replacement = heap[worst]
        if (current === undefined || replacement === undefined) return
        ;[heap[index], heap[worst]] = [replacement, current]
        index = worst
      }
    }
    for (const item of items) {
      if (heap.length < bounded) {
        heap.push(item)
        siftUp(heap.length - 1)
      } else if (heap[0] !== undefined && compare(item, heap[0]) < 0) {
        heap[0] = item
        siftDown()
      }
    }
    return heap.sort(compare)
  }
  if (getState().sort.field === 'name') {
    const direction = getState().sort.direction === 'desc' ? -1 : 1
    return takeFirst(
      (a, b) => direction * NAME_COLLATOR.compare(a.name, b.name) || a.key.localeCompare(b.key),
    )
  }
  const ranked: Array<{ readonly item: T; readonly rank: number }> = []
  const unranked: T[] = []
  for (const item of items) {
    const itemRank = rank.get(item.key)
    if (itemRank === undefined) unranked.push(item)
    else ranked.push({ item, rank: itemRank })
  }
  ranked.sort((a, b) => a.rank - b.rank)
  unranked.sort(
    (a, b) => (b.createdAt ?? Number.NEGATIVE_INFINITY) - (a.createdAt ?? Number.NEGATIVE_INFINITY),
  )
  const custom = [...ranked.map(({ item }) => item), ...unranked]
  const { field, direction: sortDirection } = getState().sort
  if (field === 'custom') return custom.slice(0, bounded)

  // A folder is a place, not a score. Preserve every structural slot from the user's own order and
  // sort only template rows among the slots templates already occupy. That keeps the hierarchy
  // legible while still bringing the least/most complete work together at every sibling level.
  const direction = sortDirection === 'desc' ? -1 : 1
  const value = (item: T): number | undefined => {
    switch (field) {
      case 'recent':
        return item.updatedAt
      case 'size':
        return item.totalPixels
      case 'mismatched':
        return item.mismatched
      case 'progress':
        return item.progress === undefined ? undefined : completionRatio(item.progress)
      default:
        return undefined
    }
  }
  const templates = custom
    .filter((item) => item.progressSortable === true)
    .sort((a, b) => {
      const av = value(a)
      const bv = value(b)
      // Unknown measurements stay last in both directions; ties never reverse.
      return (
        (av === undefined
          ? bv === undefined
            ? 0
            : 1
          : bv === undefined
            ? -1
            : direction * (av - bv)) ||
        NAME_COLLATOR.compare(a.name, b.name) ||
        a.key.localeCompare(b.key)
      )
    })
  let templateAt = 0
  return custom
    .map((item) => (item.progressSortable !== true ? item : (templates[templateAt++] ?? item)))
    .slice(0, bounded)
}

const reorderedSiblings = (
  keys: readonly string[],
  from: string,
  to: string,
  after: boolean,
): readonly string[] | null => {
  if (!keys.includes(from)) return null
  const next = keys.filter((key) => key !== from)
  const index = next.indexOf(to)
  if (index === -1) return null
  next.splice(after ? index + 1 : index, 0, from)
  return next
}

const reorderedVisibleSiblings = (
  allKeys: readonly string[],
  visibleKeys: readonly string[],
  from: string,
  to: string,
  after: boolean,
): readonly string[] | null => {
  if (!allKeys.includes(from)) {
    // An inserted row owns no full-list slot yet. Translate its visible boundary directly into the
    // complete order instead of inventing a shared slot that would displace a hidden sibling.
    if (visibleKeys.length === 0) return [from, ...allKeys]
    if (!visibleKeys.includes(to)) return null
    const index = allKeys.indexOf(to)
    if (index === -1) return null
    const next = [...allKeys]
    next.splice(after ? index + 1 : index, 0, from)
    return next
  }
  const visible = reorderedSiblings(visibleKeys, from, to, after)
  if (visible === null) return null
  const visibleSet = new Set(visibleKeys)
  let cursor = 0
  return allKeys.map((key) => (visibleSet.has(key) ? (visible[cursor++] ?? key) : key))
}

const replaceSiblingOrder = (
  current: readonly string[],
  siblings: readonly string[],
  next: readonly string[],
): readonly string[] => {
  const siblingSet = new Set(siblings)
  const first = current.findIndex((key) => siblingSet.has(key))
  const retained = current.filter((key) => !siblingSet.has(key))
  const at = first === -1 ? retained.length : first
  return [...retained.slice(0, at), ...next, ...retained.slice(at)]
}

/**
 * Reorder one row among its siblings without disturbing the rank slots belonging to other levels.
 *
 * `customOrder` spans all levels; only ever edit it, never replace it with one sibling list.
 */
export const moveTreeKey = (
  keys: readonly string[],
  from: string,
  to: string,
  after: boolean,
  allKeys: readonly string[] = keys,
  allowInsert = false,
): 'moved' | 'unchanged' | 'too-many' => {
  const inserting = !allKeys.includes(from)
  if (inserting && !allowInsert) return 'unchanged'
  const affectedKeys = inserting ? [...allKeys, from] : allKeys
  // Preserving a filtered sibling order requires writing every sibling. Bound that synchronous GM
  // storage write to the same number of rows the UI can render.
  if (affectedKeys.length > MAX_RENDERED_ROWS) return 'too-many'
  const next =
    allKeys === keys && !inserting
      ? reorderedSiblings(keys, from, to, after)
      : reorderedVisibleSiblings(allKeys, keys, from, to, after)
  if (next === null || (!inserting && next.every((key, index) => key === allKeys[index])))
    return 'unchanged'
  setState({
    customOrder: replaceSiblingOrder(getState().customOrder, affectedKeys, next),
  })
  return 'moved'
}

export const placeTreeKey = (
  visibleKeys: readonly string[],
  allKeys: readonly string[],
  from: string,
  beforeKey: string | null,
  allowInsert = false,
): 'moved' | 'unchanged' | 'too-many' => {
  const without = visibleKeys.filter((key) => key !== from)
  const target = beforeKey ?? without.at(-1) ?? from
  return moveTreeKey(visibleKeys, from, target, beforeKey === null, allKeys, allowInsert)
}
