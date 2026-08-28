import { getState, setState } from '../state.js'
import type { TemplateColourProgress, TemplateProgress } from '../templates/mismatch.js'
import { type IconName, icon } from './icons.js'
import { colourProgressDetails, progressIndicator } from './progress.js'
import { isReorderable } from './sort.js'
import { moveTreeKey as moveKey, placeTreeKey as placeAmongVisibleSiblings } from './tree-order.js'
import { isSameServerPlacement } from './tree-server-state.js'

export interface SiblingLevel {
  readonly visible: readonly string[]
  readonly all: () => readonly string[]
}

let activeTreeKey: string | null = null
/** The row currently being renamed, if any. Inline editing beats a modal for a one-field change. */
let renaming: string | null = null
let renameDraft: {
  key: string
  value: string
  selectionStart: number
  selectionEnd: number
} | null = null
type ProgressDisclosure = 'expanded' | 'colours'
/** Per-row disclosure is session UI state, not an appearance preference. */
const progressDisclosure = new Map<string, ProgressDisclosure>()

export const startRenaming = (key: string): void => {
  renaming = key
  renameDraft = null
}
const disabled = new Set<string>()

export const isTreeExpanded = (key: string): boolean => !getState().collapsed.includes(key)
const isEnabled = (key: string): boolean => !disabled.has(key)
const toggle = (set: Set<string>, key: string): void => {
  if (set.has(key)) set.delete(key)
  else set.add(key)
}

/**
 * Where a drop would land: a container and the key it goes before, `null` meaning last.
 *
 * Held at module level rather than recomputed on `drop`, because the drop may not land on the row
 * that computed it — the placeholder itself is a drop target, and it sits *between* rows. The rule
 * is that whatever the outline shows is what happens, so the outline's own position is the answer
 * and the drop only has to read it.
 */
/** The row being dragged, and the container it came from — needed to police reparenting. */
let dragging: {
  key: string
  parentKey: string | null
  canReparent: boolean
} | null = null

/** Keep server or local refreshes from replacing a row while the browser is dragging it. */
export const isTreeDragActive = (): boolean => dragging !== null

let dropTarget: {
  readonly parentKey: string | null
  readonly beforeKey: string | null
  readonly apply: (draggedKey: string, parentKey: string | null, beforeKey: string | null) => void
  readonly rerender: () => void
} | null = null

/** Apply the placement represented by the visible portal, regardless of which pixel receives drop. */
const applyArmedDrop = (event: DragEvent, root: ParentNode): boolean => {
  const target = dropTarget
  if (target === null) return false
  event.preventDefault()
  event.stopPropagation()
  const from = event.dataTransfer?.getData('text/plain')
  clearDropMarks(root)
  dropTarget = null
  dragging = null
  if (from === undefined || from === '' || from === target.beforeKey) return true
  target.apply(from, target.parentKey, target.beforeKey)
  target.rerender()
  return true
}

/** Held open where the dragged row would land — a hole says "here"; a line only says "near here". */
/**
 * The rows a drag is carrying: the one grabbed, and everything nested under it.
 *
 * Read off the rendered list rather than the model, because the model would have to be asked three
 * different ways — a Local folder holds folders and templates, a server node holds nodes and
 * templates — while the DOM already states it once, as depth. The subtree is the run of rows after
 * this one that are deeper than it, which is exactly what a depth-first render produces.
 */
const draggedRows = (row: HTMLElement): HTMLElement[] => {
  const depth = Number(row.dataset.caelestisDepth ?? 0)
  const rows = [row]
  let next = row.nextElementSibling
  while (next instanceof HTMLElement) {
    if (Number(next.dataset.caelestisDepth ?? 0) <= depth) break
    rows.push(next)
    next = next.nextElementSibling
  }
  return rows
}

/** How tall the hole should be: everything in flight, plus the gaps between those rows. */
const draggedHeight = (rows: readonly HTMLElement[]): number => {
  const first = rows[0]
  const last = rows[rows.length - 1]
  if (first === undefined || last === undefined) return 0
  return last.getBoundingClientRect().bottom - first.getBoundingClientRect().top
}

/** Set while a drag is in flight, so every placeholder is cut to the size of what is being moved. */
let draggedPixels = 0

const placeholder = (depth: number): HTMLElement => {
  const el = document.createElement('div')
  el.className = 'caelestis-placeholder'
  el.dataset.caelestisPlaceholder = ''
  // Indented to the level it would land at, so the outline says *where* and not merely *between
  // which two rows* — the two differ exactly when the drop would change a row's parent.
  el.style.marginInlineStart = `${0.25 + depth * 1.125}rem`
  // The hole is the shape of what would fill it. A folder carrying nine templates leaves a
  // one-row gap otherwise, which reads as "this lands here alone" and makes the list jump on drop.
  if (draggedPixels > 0) el.style.height = `${draggedPixels}px`
  // The outline accepts the drop itself. Aiming at a gap and having to hit a row instead is the
  // thing that made filing into a folder feel like a trick — and a `dragover` alone was not enough,
  // since a drop landing here bubbled past every row's handler and was simply lost.
  el.addEventListener('dragover', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  el.addEventListener('drop', (event) => {
    applyArmedDrop(event, el.parentElement ?? document)
  })
  return el
}

/** Rows in document order, ignoring the one being dragged and the placeholder. */
const _visibleRows = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('[data-caelestis-key]')].filter(
    (row) => !row.classList.contains('caelestis-dragging'),
  )

/**
 * Resolve a pointer position over one row into a place in the tree.
 *
 * Above or below a row means "before" or "after" at its own level. The middle of a container means
 * "inside" even when it is collapsed. Without that target, dropping a Local template on a server
 * folder resolved beside the folder at the server root, where templates are invalid; it then
 * snapped back without making a request.
 */
const resolveDrop = (
  row: HTMLElement,
  clientY: number,
): {
  parentKey: string | null
  beforeKey: string | null
  depth: number
  /** Where to insert the outline. Null appends, which is what "last in this list" means. */
  before: Element | null
} => {
  const box = row.getBoundingClientRect()
  const above = clientY < box.top + box.height / 2
  const depth = Number(row.dataset.caelestisDepth ?? 0)
  const parentKey = row.dataset.caelestisParent ?? null
  const key = row.dataset.caelestisKey ?? null
  const isContainer = row.dataset.caelestisContainer !== undefined
  const offset = box.height <= 0 ? (clientY < box.top ? 0 : 1) : (clientY - box.top) / box.height

  if (isContainer && key !== null && offset >= 0.3 && offset <= 0.7) {
    const next = row.nextElementSibling
    const firstChild =
      next instanceof HTMLElement && Number(next.dataset.caelestisDepth ?? 0) > depth
        ? (next.dataset.caelestisKey ?? null)
        : null
    return {
      parentKey: key,
      beforeKey: firstChild,
      depth: depth + 1,
      before: next,
    }
  }

  if (above) return { parentKey, beforeKey: key, depth, before: row }

  const expanded = key !== null && isTreeExpanded(key)
  const next = row.nextElementSibling
  if (isContainer && expanded) {
    // Into it, ahead of whatever it already holds.
    const firstChild = next instanceof HTMLElement ? (next.dataset.caelestisKey ?? null) : null
    return {
      parentKey: key,
      beforeKey: firstChild,
      depth: depth + 1,
      before: next,
    }
  }
  // Beside it. Skip over anything nested under this row so "after" means after its whole subtree.
  let cursor: Element | null = next
  while (cursor instanceof HTMLElement && Number(cursor.dataset.caelestisDepth ?? 0) > depth) {
    cursor = cursor.nextElementSibling
  }
  const beforeKey = cursor instanceof HTMLElement ? (cursor.dataset.caelestisKey ?? null) : null
  return { parentKey, beforeKey, depth, before: cursor }
}

const clearDropMarks = (root: ParentNode): void => {
  for (const el of root.querySelectorAll('[data-caelestis-placeholder]')) el.remove()
}

interface RowAction {
  readonly icon: IconName
  readonly label: string
  readonly run: () => void
}

export interface TreeRowOptions {
  readonly key: string
  readonly name: string
  readonly kind: IconName
  readonly depth: number
  /** One continuation flag per visible tree column, ending with this row's sibling branch. */
  readonly branches?: readonly boolean[] | undefined
  readonly meta?: string
  readonly progress?: TemplateProgress
  readonly progressReader?: (() => TemplateProgress) | undefined
  readonly colourProgress?: (() => readonly TemplateColourProgress[] | undefined) | undefined
  readonly leadingActions?:
    | ReadonlyArray<{ icon: IconName; label: string; run: () => void }>
    | undefined
  /** Containers accept a drop *into* them; leaves only reorder between siblings. */
  readonly container: boolean
  /** The row this one sits under, so a drop can resolve to a place in the tree rather than a row. */
  readonly parentKey?: string | null | undefined
  /**
   * Whether a drop here may change the dragged row's parent.
   *
   * False leaves reordering intact but refuses any move that would file something somewhere else.
   * Order is a local preference and always the user's to set; where a template *lives* is shared
   * structure, and only an admin may rearrange that.
   */
  readonly canReparent?: boolean | undefined
  /** Search exposes descendants without changing the user's stored collapsed state. */
  readonly forceExpanded?: boolean | undefined
  /** Dimmed, for a row that exists but is not doing anything yet — an unpublished template. */
  readonly muted?: boolean | undefined
  readonly actions?: readonly RowAction[] | undefined
  /** Present only where the user can actually change things; absent means no rename affordance. */
  readonly onRename?: ((name: string) => void) | undefined
  readonly onContextMenu?: ((event: MouseEvent) => void) | undefined
  readonly siblings: readonly string[]
  /** Full sibling order, computed only if a filtered or capped view is actually reordered. */
  readonly orderingSiblings?: (() => readonly string[]) | undefined
  /** Resolve the sibling order for the destination level returned by `resolveDrop`. */
  readonly destinationSiblings?:
    | ((parentKey: string | null) =>
        | {
            readonly visible: readonly string[]
            readonly all: () => readonly string[]
          }
        | undefined)
    | undefined
  readonly rerender: () => void
  readonly onError: (message: string) => void
  /**
   * Drop resolved to a position: which container it lands in, and which key it lands before.
   *
   * The only drop there is. There used to be a second one — hovering the middle of a folder
   * highlighted it and dropped *into* it — and it was worse in both directions: it was a gesture
   * you had to already know about, and it ate the middle of every folder row, leaving thin edges as
   * the only way to reorder anything. A position already says which folder something lands in, so
   * the highlight was answering a question the placeholder had answered better.
   */
  readonly onDropAt?:
    | ((
        draggedKey: string,
        parentKey: string | null,
        beforeKey: string | null,
      ) => Promise<string | null>)
    | undefined
  /** When present, the row reflects this instead of the tree's own disabled set. */
  readonly checked?: boolean | undefined
  readonly onToggleChecked?: ((on: boolean) => void) | undefined
}

/** The one sibling level a resolved placement belongs to, whether or not it is the hovered row's. */
const destinationLevel = (
  options: TreeRowOptions,
  parentKey: string | null,
): SiblingLevel | undefined =>
  parentKey === (options.parentKey ?? null)
    ? {
        visible: options.siblings,
        all: options.orderingSiblings ?? (() => options.siblings),
      }
    : options.destinationSiblings?.(parentKey)

const TREE_COLUMN = 18
const DISCLOSURE_SLOT_WIDTH = 20
const CONNECTOR_MIDPOINT = 18

/** TUI-style tree pipes, drawn as vectors so an absent disclosure control reads as hierarchy. */
export const treeConnector = (
  branches: readonly boolean[],
  leaf: boolean,
): { element: SVGSVGElement; width: number } | null => {
  if (branches.length === 0) return null
  const width = branches.length * TREE_COLUMN + (leaf ? DISCLOSURE_SLOT_WIDTH : 0)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('caelestis-tree-connector')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('width', String(width))
  svg.style.width = `${width}px`

  const line = (x1: number, y1: string, x2: number, y2: string): void => {
    const segment = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    segment.setAttribute('x1', String(x1))
    segment.setAttribute('y1', y1)
    segment.setAttribute('x2', String(x2))
    segment.setAttribute('y2', y2)
    segment.setAttribute('vector-effect', 'non-scaling-stroke')
    svg.appendChild(segment)
  }

  for (let index = 0; index < branches.length - 1; index++) {
    if (branches[index] === true) {
      const x = index * TREE_COLUMN + TREE_COLUMN / 2
      line(x, '0', x, '100%')
    }
  }
  const current = branches.length - 1
  const x = current * TREE_COLUMN + TREE_COLUMN / 2
  line(x, '0', x, branches[current] === true ? '100%' : String(CONNECTOR_MIDPOINT))
  line(x, String(CONNECTOR_MIDPOINT), width - 4, String(CONNECTOR_MIDPOINT))
  return { element: svg, width }
}

export const treeRow = (options: TreeRowOptions): HTMLElement => {
  const draggable = isReorderable(getState().sort)
  const row = document.createElement('div')
  row.className = 'caelestis-row flex items-center gap-1'
  row.dataset.caelestisKey = options.key
  if (options.parentKey !== undefined && options.parentKey !== null) {
    row.dataset.caelestisParent = options.parentKey
  }
  row.dataset.caelestisDepth = String(options.depth)
  if (options.container) row.dataset.caelestisContainer = ''
  row.style.padding = '0.25rem 0.5rem'
  row.style.marginInline = '0.25rem 0.5rem'
  const connector = treeConnector(options.branches ?? [], !options.container)
  if (connector !== null) {
    row.style.paddingInlineStart = `calc(0.5rem + ${connector.width}px)`
    row.appendChild(connector.element)
  }
  row.style.minHeight = '2rem'
  if (options.muted === true) row.classList.add('caelestis-muted')
  row.draggable = draggable
  row.tabIndex = -1
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-level', String(options.depth + 1))
  const expanded = options.forceExpanded === true || isTreeExpanded(options.key)
  if (options.forceExpanded === true) row.dataset.caelestisForceExpanded = ''
  if (options.container) row.setAttribute('aria-expanded', String(expanded))

  if (options.container) {
    const glyph = icon('caret', 'size-4 opacity-60')
    glyph.style.flex = '0 0 auto'
    glyph.style.transition = 'transform 120ms ease-out'
    glyph.style.transform = expanded ? 'rotate(90deg)' : 'rotate(0deg)'
    row.appendChild(glyph)
  }

  const kind = icon(options.kind, 'size-4 opacity-60')
  kind.style.flex = '0 0 auto'
  row.appendChild(kind)

  if (options.leadingActions !== undefined) {
    const group = document.createElement('span')
    group.className = 'caelestis-leading-actions flex items-center'
    group.style.flex = '0 0 auto'
    for (const action of options.leadingActions) {
      const button = document.createElement('button')
      button.className = 'btn btn-ghost btn-xs btn-circle caelestis-row-action'
      button.title = action.label
      button.setAttribute('aria-label', action.label)
      button.appendChild(icon(action.icon, 'size-4'))
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        action.run()
      })
      group.appendChild(button)
    }
    row.appendChild(group)
  }

  const editing = renaming === options.key && options.onRename !== undefined
  const input = document.createElement('input')
  const name = document.createElement('span')
  if (editing) {
    const startingRename = renameDraft?.key !== options.key
    if (startingRename) {
      renameDraft = {
        key: options.key,
        value: options.name,
        selectionStart: 0,
        selectionEnd: options.name.length,
      }
    }
    input.type = 'text'
    input.dataset.caelestisRename = ''
    input.className = 'input input-xs input-bordered'
    input.value = renameDraft?.value ?? options.name
    input.style.flex = '1'
    input.style.minWidth = '0'
    input.addEventListener('click', (event) => event.stopPropagation())
    const retainRenameDraft = (): void => {
      const draft = renameDraft
      if (draft?.key !== options.key) return
      draft.value = input.value
      draft.selectionStart = input.selectionStart ?? input.value.length
      draft.selectionEnd = input.selectionEnd ?? input.value.length
    }
    input.addEventListener('input', retainRenameDraft)
    input.addEventListener('select', retainRenameDraft)
    row.appendChild(input)
    requestAnimationFrame(() => {
      input.focus()
      if (startingRename) {
        input.select()
      } else {
        input.setSelectionRange(
          renameDraft?.selectionStart ?? input.value.length,
          renameDraft?.selectionEnd ?? input.value.length,
        )
      }
    })
  } else {
    name.className = 'caelestis-name text-sm'
    name.textContent = options.name
    row.appendChild(name)
    // A tooltip that repeats fully visible text is noise; only label what is actually clipped.
    requestAnimationFrame(() => {
      if (name.scrollWidth > name.clientWidth) name.title = options.name
    })
  }

  if (options.meta !== undefined) {
    const meta = document.createElement('span')
    meta.className = 'caelestis-meta text-xs opacity-50'
    meta.style.flex = '0 0 auto'
    meta.textContent = options.meta
    row.appendChild(meta)
  }

  const requestedDisclosure = progressDisclosure.get(options.key)
  const hasProgress = options.progress !== undefined
  const canShowExpandedProgress = hasProgress && (!options.container || expanded)
  const resolvedColourProgress =
    canShowExpandedProgress && requestedDisclosure === 'colours'
      ? options.colourProgress?.()
      : undefined
  const disclosure: 'inline' | ProgressDisclosure =
    !canShowExpandedProgress || requestedDisclosure === undefined
      ? 'inline'
      : requestedDisclosure === 'colours' && (resolvedColourProgress?.length ?? 0) === 0
        ? 'expanded'
        : requestedDisclosure
  const progressPlacement = disclosure === 'inline' ? 'inline' : 'expanded'
  const alignExpandedDetail = (element: HTMLElement): HTMLElement => {
    if (!options.container) return element
    // The header consumes a real caret here. Expanded details do not, so carry the slot into their
    // own inline start rather than making container details appear one level shallower than leaves.
    const width = `calc(100% - ${DISCLOSURE_SLOT_WIDTH}px)`
    element.style.flexBasis = width
    element.style.width = width
    element.style.marginInlineStart = `${DISCLOSURE_SLOT_WIDTH}px`
    return element
  }
  let progressElement: HTMLElement | null = null
  if (options.progress !== undefined) {
    if (progressPlacement === 'expanded') {
      row.classList.add('caelestis-row--expanded-progress')
    }
    progressElement = progressIndicator(options.progress, progressPlacement, options.progressReader)
  }

  const progressActions: RowAction[] = []
  let colourProgressAction: RowAction | null = null
  if (hasProgress) {
    if (disclosure === 'inline') {
      progressActions.push({
        icon: 'expandMore',
        label: 'Expand progress',
        run: () => {
          if (options.container && !expanded) {
            setState({ collapsed: getState().collapsed.filter((key) => key !== options.key) })
          }
          progressDisclosure.set(options.key, 'expanded')
          options.rerender()
        },
      })
    } else {
      progressActions.push({
        icon: 'expandLess',
        label: 'Collapse progress',
        run: () => {
          progressDisclosure.delete(options.key)
          options.rerender()
        },
      })
      if (options.colourProgress !== undefined) {
        colourProgressAction = {
          icon: 'palette',
          label: disclosure === 'colours' ? 'Hide colour progress' : 'Show colour progress',
          run: () => {
            progressDisclosure.set(options.key, disclosure === 'colours' ? 'expanded' : 'colours')
            options.rerender()
          },
        }
      }
    }
  }

  const actionButton = (action: RowAction): HTMLButtonElement => {
    const button = document.createElement('button')
    button.className = 'btn btn-ghost btn-xs btn-circle caelestis-row-action'
    button.title = action.label
    button.setAttribute('aria-label', action.label)
    button.appendChild(icon(action.icon, 'size-4'))
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      action.run()
    })
    return button
  }

  let actionElement: HTMLElement | null = null
  if (editing) {
    // Confirm and cancel take the place of the row's own actions while renaming, so the row never
    // offers two different things to do with the same click.
    const group = document.createElement('span')
    group.className = 'flex items-center gap-0.5'
    group.style.flex = '0 0 auto'
    const commit = (): void => {
      const value = input.value.trim()
      renaming = null
      renameDraft = null
      if (value !== '' && value !== options.name) options.onRename?.(value)
      else options.rerender()
    }
    const cancel = (): void => {
      renaming = null
      renameDraft = null
      options.rerender()
    }
    for (const [glyphName, label, run] of [
      ['check', 'Save', commit],
      ['close', 'Cancel', cancel],
    ] as ReadonlyArray<readonly [IconName, string, () => void]>) {
      const button = document.createElement('button')
      button.className = 'btn btn-ghost btn-xs btn-circle caelestis-row-action'
      button.title = label
      button.setAttribute('aria-label', label)
      button.appendChild(icon(glyphName, 'size-4'))
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        run()
      })
      group.appendChild(button)
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') commit()
      if (event.key === 'Escape') cancel()
    })
    actionElement = group
  } else {
    const actions = [...(options.actions ?? []), ...progressActions]
    if (actions.length === 0) {
      actionElement = null
    } else {
      const group = document.createElement('span')
      group.className = 'caelestis-actions flex items-center gap-0.5'
      group.style.flex = '0 0 auto'
      for (const action of actions) group.appendChild(actionButton(action))
      actionElement = group
    }
  }

  let renderedProgressElement = progressElement
  if (progressPlacement === 'expanded' && progressElement !== null) {
    let expandedDetail: HTMLElement = progressElement
    if (!editing && colourProgressAction !== null) {
      const line = document.createElement('span')
      line.className = 'caelestis-progress-disclosure'
      const detailActions = document.createElement('span')
      detailActions.className = 'caelestis-progress-detail-actions'
      detailActions.appendChild(actionButton(colourProgressAction))
      line.append(progressElement, detailActions)
      expandedDetail = line
    }
    renderedProgressElement = alignExpandedDetail(expandedDetail)
  }

  if (
    progressPlacement === 'inline' &&
    renderedProgressElement !== null &&
    actionElement?.classList.contains('caelestis-actions') === true
  ) {
    const tail = document.createElement('span')
    tail.className = 'caelestis-row-tail'
    tail.append(renderedProgressElement, actionElement)
    row.appendChild(tail)
  } else {
    if (renderedProgressElement !== null) row.appendChild(renderedProgressElement)
    if (actionElement !== null) row.appendChild(actionElement)
  }
  if (disclosure === 'colours' && resolvedColourProgress !== undefined) {
    row.appendChild(
      alignExpandedDetail(colourProgressDetails(resolvedColourProgress, options.colourProgress)),
    )
  }

  /**
   * An eye, not a tick.
   *
   * A tick answers "is this selected", and nothing here is being selected — every one of these rows
   * is either on the map or not, which is a thing you can *see*. The open and crossed-out eyes make
   * both states explicit, so the column reads as what is drawn rather than as a form to fill in.
   *
   * Still a checkbox underneath. It is the one element that already means "two states, toggled",
   * and hand-rolling a button in its place would owe the whole contract — the label association, the
   * space key, `aria-checked`, the focus ring — for a change that is entirely about what it looks
   * like.
   */
  const check = document.createElement('input')
  check.type = 'checkbox'
  check.checked = options.checked ?? isEnabled(options.key)
  check.setAttribute('aria-label', `Show ${options.name}`)
  check.addEventListener('click', (event) => event.stopPropagation())
  check.addEventListener('change', () => {
    if (options.onToggleChecked !== undefined) {
      options.onToggleChecked(check.checked)
      return
    }
    toggle(disabled, options.key)
    options.rerender()
  })
  const eye = document.createElement('label')
  eye.className = 'caelestis-eye'
  eye.addEventListener('click', (event) => event.stopPropagation())
  const box = document.createElement('span')
  box.append(icon('eyeOff', 'size-4 caelestis-eye-off'), icon('eye', 'size-4 caelestis-eye-on'))
  eye.append(check, box)
  row.appendChild(eye)

  const expand = (): void => {
    if (!options.container || options.forceExpanded === true) return
    const next = new Set(getState().collapsed)
    toggle(next, options.key)
    setState({ collapsed: [...next] })
    options.rerender()
  }
  if (options.container) {
    if (!editing) row.addEventListener('click', expand)
    row.addEventListener('keydown', (event) => {
      if (event.target !== row) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        expand()
      }
    })
  }

  if (options.onContextMenu !== undefined) {
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      options.onContextMenu?.(event)
    })
  }

  if (draggable && !editing) {
    row.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown')
    row.addEventListener('keydown', (event) => {
      if (event.target !== row || !event.altKey) return
      const index = options.siblings.indexOf(options.key)
      const target =
        event.key === 'ArrowUp'
          ? options.siblings[index - 1]
          : event.key === 'ArrowDown'
            ? options.siblings[index + 1]
            : undefined
      if (target === undefined) return
      event.preventDefault()
      event.stopPropagation()
      const result = moveKey(
        options.siblings,
        options.key,
        target,
        event.key === 'ArrowDown',
        options.orderingSiblings?.() ?? options.siblings,
      )
      if (result === 'too-many') {
        options.onError('This level has too many rows to save a custom order safely.')
      }
      options.rerender()
    })
  }

  if (!draggable || editing) return row

  row.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData('text/plain', options.key)
    dragging = {
      key: options.key,
      parentKey: options.parentKey ?? null,
      canReparent: options.canReparent === true,
    }
    // A folder travels with what is inside it. Measured before anything is hidden, because a hidden
    // row has no height and the hole has to be the size of what left it.
    const moving = draggedRows(row)
    draggedPixels = draggedHeight(moving)
    // Take the rows out of the flow, so what is on screen is the drag image plus the hole they will
    // land in — nothing else. Leaving them in place at reduced opacity reads as a duplicate, and
    // every row below shifts as the placeholder is inserted.
    //
    // Deferred by a tick because the browser captures the drag image *after* dragstart returns;
    // hiding it synchronously would drag an invisible ghost.
    setTimeout(() => {
      for (const moved of moving) moved.classList.add('caelestis-dragging')
    }, 0)
  })
  row.addEventListener('dragend', () => {
    const parent = row.parentElement ?? document
    for (const moved of parent.querySelectorAll('.caelestis-dragging')) {
      moved.classList.remove('caelestis-dragging')
    }
    draggedPixels = 0
    clearDropMarks(parent)
    dropTarget = null
    dragging = null
  })
  row.addEventListener('dragover', (event) => {
    event.preventDefault()
    // A hover owns the only armed placement. If this row cannot offer one, releasing here must do
    // nothing rather than applying whichever row happened to be hovered previously.
    dropTarget = null
    const parent = row.parentElement
    if (parent === null) return
    clearDropMarks(parent)

    const place = options.onDropAt
    if (place === undefined) {
      // Rows without a position handler still reorder among their own siblings when dropped on the
      // row below, but cannot arm the between-row placeholder: that placeholder accepts the drop
      // itself and therefore needs a `dropTarget` describing what it will do.
      return
    }

    const resolved = resolveDrop(row, event.clientY)
    // Reordering is ours to do — it is a client-side preference. Changing a row's *parent* is a
    // change to the shared structure, so without the right to make it the drop is simply not
    // offered: no outline appears, which reads as "not there" without needing to say so.
    if (
      dragging !== null &&
      (options.canReparent !== true || !dragging.canReparent) &&
      resolved.parentKey !== dragging.parentKey
    ) {
      return
    }
    const destination = destinationLevel(options, resolved.parentKey)
    if (destination === undefined) return
    const reparenting = dragging !== null && resolved.parentKey !== dragging.parentKey
    dropTarget = {
      parentKey: resolved.parentKey,
      beforeKey: resolved.beforeKey,
      apply: (draggedKey, parentKey, beforeKey) => {
        if (reparenting) {
          const previousOrder = getState().customOrder
          let optimisticOrder: readonly string[] | null = null
          if (isSameServerPlacement(draggedKey, parentKey)) {
            const result = placeAmongVisibleSiblings(
              destination.visible,
              destination.all(),
              draggedKey,
              beforeKey,
              true,
            )
            if (result === 'too-many') {
              options.onError(
                'The row was moved, but this level has too many rows to save a custom order safely.',
              )
            } else {
              optimisticOrder = getState().customOrder
            }
          }
          const rollBackOrder = (): void => {
            if (
              optimisticOrder !== null &&
              getState().customOrder.length === optimisticOrder.length &&
              getState().customOrder.every((key, index) => key === optimisticOrder?.[index])
            ) {
              setState({ customOrder: previousOrder })
            }
          }
          void place(draggedKey, parentKey, beforeKey).then(
            (destinationKey) => {
              if (destinationKey === null) {
                rollBackOrder()
                options.rerender()
                return
              }
              if (optimisticOrder !== null && destinationKey === draggedKey) return
              const result = placeAmongVisibleSiblings(
                destination.visible,
                destination.all(),
                destinationKey,
                beforeKey,
                true,
              )
              if (result === 'too-many') {
                options.onError(
                  'The row was moved, but this level has too many rows to save a custom order safely.',
                )
              }
              options.rerender()
            },
            (error: unknown) => {
              rollBackOrder()
              options.onError(`Could not move that row. ${String(error)}`)
              options.rerender()
            },
          )
        } else {
          const result = placeAmongVisibleSiblings(
            destination.visible,
            destination.all(),
            draggedKey,
            beforeKey,
          )
          if (result === 'too-many') {
            options.onError('This level has too many rows to save a custom order safely.')
            return
          }
        }
        if (!reparenting) void place(draggedKey, parentKey, beforeKey)
      },
      rerender: options.rerender,
    }
    parent.insertBefore(placeholder(resolved.depth), resolved.before)
  })
  row.addEventListener('drop', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const parent = row.parentElement
    if (applyArmedDrop(event, parent ?? document)) return
    const from = event.dataTransfer?.getData('text/plain')
    if (parent !== null) clearDropMarks(parent)
    dropTarget = null
    if (from === undefined || from === '') return
    if (from === options.key) return
    const box = row.getBoundingClientRect()
    const result = moveKey(
      options.siblings,
      from,
      options.key,
      event.clientY > box.top + box.height / 2,
      options.orderingSiblings?.() ?? options.siblings,
    )
    if (result === 'too-many') {
      options.onError('This level has too many rows to save a custom order safely.')
    }
    options.rerender()
  })

  return row
}

/** Let the visible between-row portal own drops that land in the tree's CSS gaps. */
export const bindTreeDropRoot = (root: HTMLElement): void => {
  root.addEventListener('dragover', (event) => {
    if (dropTarget !== null) event.preventDefault()
  })
  root.addEventListener('drop', (event) => {
    applyArmedDrop(event, root)
  })
}

/** Restore persistent rename and roving-focus state after a complete tree render. */
export const finishTreeRoot = (root: HTMLElement): void => {
  if (renaming !== null && root.querySelector('[data-caelestis-rename]') === null) {
    renaming = null
    renameDraft = null
  }

  const rows = [...root.querySelectorAll<HTMLElement>('[role="treeitem"][data-caelestis-key]')]
  const siblingGroups = new Map<string, HTMLElement[]>()
  for (const row of rows) {
    const parent = row.dataset.caelestisParent ?? '__root__'
    const siblings = siblingGroups.get(parent) ?? []
    siblings.push(row)
    siblingGroups.set(parent, siblings)
  }
  for (const siblings of siblingGroups.values()) {
    siblings.forEach((row, index) => {
      row.setAttribute('aria-setsize', String(siblings.length))
      row.setAttribute('aria-posinset', String(index + 1))
    })
  }
  const active = rows.find((row) => row.dataset.caelestisKey === activeTreeKey) ?? rows[0]
  const activate = (row: HTMLElement): void => {
    for (const candidate of rows) {
      candidate.tabIndex = candidate === row ? 0 : -1
      for (const control of candidate.querySelectorAll<HTMLElement>('button,input')) {
        control.tabIndex = candidate === row ? 0 : -1
      }
    }
    activeTreeKey = row.dataset.caelestisKey ?? null
  }
  if (active !== undefined) activate(active)
  root.addEventListener('focusin', (event) => {
    const row = (event.target as Element | null)?.closest<HTMLElement>('[role="treeitem"]')
    if (row === null || row === undefined || !root.contains(row)) return
    activate(row)
  })
  root.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return
    const row = (event.target as Element | null)?.closest<HTMLElement>('[role="treeitem"]')
    if (row === null || row === undefined || event.target !== row) return
    const index = rows.indexOf(row)
    let next: HTMLElement | undefined
    if (event.key === 'ArrowDown') next = rows[index + 1]
    else if (event.key === 'ArrowUp') next = rows[index - 1]
    else if (event.key === 'Home') next = rows[0]
    else if (event.key === 'End') next = rows.at(-1)
    else if (event.key === 'ArrowRight') {
      if (row.getAttribute('aria-expanded') === 'false') {
        event.preventDefault()
        row.click()
        return
      }
      const child = rows[index + 1]
      if (
        child !== undefined &&
        Number(child.getAttribute('aria-level')) > Number(row.getAttribute('aria-level'))
      ) {
        next = child
      }
    } else if (event.key === 'ArrowLeft') {
      if (
        row.getAttribute('aria-expanded') === 'true' &&
        row.dataset.caelestisForceExpanded === undefined
      ) {
        event.preventDefault()
        row.click()
        return
      }
      const level = Number(row.getAttribute('aria-level'))
      for (let candidate = index - 1; candidate >= 0; candidate--) {
        const parent = rows[candidate]
        if (parent !== undefined && Number(parent.getAttribute('aria-level')) < level) {
          next = parent
          break
        }
      }
    }
    if (next === undefined) return
    event.preventDefault()
    next.focus()
  })
}
