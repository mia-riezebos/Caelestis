import { cacheServer, loadServerCache, type ServerTemplate } from '../server-cache.js'
import {
  type ConnectedServer,
  getState,
  isScopeVisible,
  listServerContents,
  setLocalFolderVisible,
  setScopeVisible,
  setState,
  type TreeNode,
} from '../state.js'
import { isServerTemplate, localTemplates, setLocalVisible } from '../templates/local-store.js'
import { nodeScopeKey, rememberNodes } from '../templates/server-nodes.js'
import { serverTemplateKey, syncServerTemplates } from '../templates/server-sync.js'
import { type IconName, icon } from './icons.js'
import { isReorderable } from './sort.js'

/**
 * The tree: one root per source, plus `Local`.
 *
 * Row anatomy, left to right: **caret, kind icon, name, meta, row actions, checkbox**. The caret
 * leads because it is what makes a list read as a tree; the checkbox trails because it is what you
 * act on once you have found the row. Row actions sit just inside it and appear on hover, so a
 * quiet list stays quiet.
 *
 * The whole row is the expand target — a caret is a 24px hit area on a 300px row, and everything
 * between them is dead space otherwise.
 */

export interface TreeTarget {
  readonly server: ConnectedServer | null
  readonly nodeId: string | null
  readonly key: string
  readonly name: string
  /**
   * Set when the row is a template published on a server, rather than a folder.
   *
   * The two need telling apart because every action means something different on each: renaming a
   * folder rewrites the paths of everything beneath it, renaming a template is one column. Before
   * this, `server !== null` was enough to mean "a folder on a server", and adding template rows is
   * what stopped that being true.
   */
  readonly templateId?: string
}

export interface TreeCallbacks {
  readonly onAddServer: () => void
  readonly onCreateFolder: (target: TreeTarget) => void
  readonly onImportTemplate: (target: TreeTarget) => void
  readonly onRename: (target: TreeTarget, name: string) => void
  readonly onDelete: (target: TreeTarget) => void
  readonly onContextMenu: (target: TreeTarget, event: MouseEvent) => void
  /** Frame a local template on the map. */
  readonly onGoTo: (templateId: string) => void
  readonly onPlace: (templateId: string) => void
  readonly onCopyToServer: (templateId: string) => void
  /** Move a dragged Local row to a place in the tree: a container, and the key it goes before. */
  readonly onMoveLocal: (
    draggedKey: string,
    parentKey: string | null,
    beforeKey: string | null,
  ) => void
  /**
   * Something was dropped at a place in a server's tree: which folder, and what it lands before.
   *
   * One callback for every journey, because they are one gesture. What happens comes from the
   * dragged key rather than from the caller: a Local template lands as an upload, a template
   * already here is refiled, one from elsewhere crosses over, a folder is re-parented. `null` for
   * the folder means the server's top level, which only a folder may occupy.
   */
  readonly onDropInServer: (
    server: ConnectedServer,
    nodeId: string | null,
    draggedKey: string,
    beforeKey: string | null,
  ) => void
}

const collapsed = new Set<string>()
/** The row currently being renamed, if any. Inline editing beats a modal for a one-field change. */
let renaming: string | null = null

/**
 * Nodes per server, fetched once and refreshed on demand.
 *
 * Rendering happens synchronously, so the tree draws what it has and fills in when the fetch lands.
 * A server with no nodes yet and a server whose nodes have not arrived look the same for a moment,
 * which is the right trade against blocking the whole panel on a network call.
 */
const nodesByServer = new Map<string, readonly TreeNode[]>()

/** Templates per server, from the manifest, on the same terms as the nodes above. */
const templatesByServer = new Map<string, readonly ServerTemplate[]>()

/**
 * Which server holds a template, given only its id.
 *
 * A drag carries one string, and a template row's key is `st:<id>` — so a drop has the template but
 * not where it came from, and a cross-server move needs both ends. Ids are UUIDv7 and unique across
 * servers in practice, so the first match is the right one.
 */
export const findServerTemplate = (
  id: string,
): { serverUrl: string; template: ServerTemplate } | null => {
  for (const [serverUrl, templates] of templatesByServer) {
    const template = templates.find((candidate) => candidate.id === id)
    if (template !== undefined) return { serverUrl, template }
  }
  return null
}

/**
 * What a server last said about one template, for whoever is acting on a row.
 *
 * Read from the same cache the row was drawn from, so a menu can never offer "Unpublish" on a row
 * drawn as unpublished — the two would otherwise be answering from different copies.
 */
export const serverTemplateAt = (serverUrl: string, id: string): ServerTemplate | null =>
  templatesByServer.get(serverUrl)?.find((template) => template.id === id) ?? null

/** Which server holds a folder, given only its id — the same problem `findServerTemplate` solves. */
export const findServerNode = (id: string): { serverUrl: string; node: TreeNode } | null => {
  for (const [serverUrl, nodes] of nodesByServer) {
    const node = nodes.find((candidate) => candidate.id === id)
    if (node !== undefined) return { serverUrl, node }
  }
  return null
}

/** What a server publishes directly inside one folder. */
export const templatesOfNode = (
  serverUrl: string,
  nodeId: string,
): ReadonlyArray<{ id: string; name: string }> =>
  (templatesByServer.get(serverUrl) ?? []).filter((template) => template.nodeId === nodeId)

/**
 * Re-read what a server publishes: its folders and the templates under them.
 *
 * **Not gated on admin.** The tree is what a read token is for — seeing what the alliance is
 * building. Only *changing* it is privileged, and that boundary is drawn per row by `canEdit`.
 * Refusing to fetch here left every member looking at a connected server with nothing under it.
 *
 * Both in one call, from the manifest, which is also the only way they can agree: a template row is
 * drawn under its folder, so fetching one without the other puts templates under folders that are
 * not there, or leaves a folder claiming to be empty a moment after something landed in it.
 *
 * One at a time per server. The render pass calls this for any connected server it has nothing for,
 * and a render pass is cheap to provoke — so a server that is slow, unreachable, or refusing the
 * token got a fresh manifest request on *every* re-render, because a failure leaves the map empty
 * and the next pass sees the same gap. Sharing the in-flight promise makes that one request.
 */
const refreshing = new Map<string, Promise<void>>()

export const refreshNodes = async (
  server: ConnectedServer,
  rerender: () => void,
): Promise<void> => {
  const pending = refreshing.get(server.url)
  if (pending !== undefined) return pending
  const run = refreshOnce(server, rerender).finally(() => refreshing.delete(server.url))
  refreshing.set(server.url, run)
  return run
}

const refreshOnce = async (server: ConnectedServer, rerender: () => void): Promise<void> => {
  const contents = await listServerContents(server)
  // Unreachable, so nothing is known. The tree keeps drawing what the cache says rather than
  // emptying itself — a server that blinks should not take its folders off your screen.
  if (contents === null) return
  const { nodes, templates } = contents
  nodesByServer.set(server.url, nodes)
  rememberNodes(server.url, nodes)
  templatesByServer.set(server.url, templates)
  void cacheServer({ url: server.url, nodes, templates, fetchedAt: Date.now() })
  rerender()
  // Every caller of this is a mutation that just landed — a publish, an upload, a delete. Waiting
  // out the poll to see it on the canvas would make each of those feel like it had not worked.
  //
  // Handing over the manifest we just read, rather than letting the sync fetch its own: they are the
  // same document, requested a millisecond apart, and the second one can only disagree with the
  // first by being newer than the tree that is already on screen.
  void syncServerTemplates(server, templates)
}

/**
 * Draw what a server said last time, immediately, before anything is fetched.
 *
 * Without it the tree is empty on every page load until each server answers, which is the wrong
 * first impression and gets worse the more servers are connected.
 */
export const primeFromCache = async (rerender: () => void): Promise<void> => {
  for (const entry of await loadServerCache()) {
    if (!nodesByServer.has(entry.url)) nodesByServer.set(entry.url, entry.nodes)
    // The renderer needs the folder tree too, and it needs it now rather than after the first
    // fetch: a template restored from cache into a folder switched off last session would
    // otherwise draw until the manifest came back and said which folder it was in.
    rememberNodes(entry.url, entry.nodes)
    if (!templatesByServer.has(entry.url) && entry.templates !== undefined) {
      templatesByServer.set(entry.url, entry.templates)
    }
  }
  rerender()
}

/**
 * Forget a server's folders and templates, and say which chunks they were made of.
 *
 * The hashes come back because the chunk cache is content-addressed and cannot tell whose bytes are
 * whose — this map is the last thing that knows, so it answers on the way out.
 */
export const forgetServerRows = (serverUrl: string): readonly string[] => {
  const hashes = (templatesByServer.get(serverUrl) ?? []).flatMap((template) =>
    template.chunks.map((chunk) => chunk.hash),
  )
  nodesByServer.delete(serverUrl)
  templatesByServer.delete(serverUrl)
  refreshing.delete(serverUrl)
  return hashes
}

export const startRenaming = (key: string): void => {
  renaming = key
}
const disabled = new Set<string>()

const isExpanded = (key: string): boolean => !collapsed.has(key)
const isEnabled = (key: string): boolean => !disabled.has(key)
const toggle = (set: Set<string>, key: string): void => {
  if (set.has(key)) set.delete(key)
  else set.add(key)
}

const orderedKeys = (keys: readonly string[]): readonly string[] => {
  const rank = new Map(getState().customOrder.map((key, index) => [key, index]))
  return [...keys].sort(
    (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
  )
}

/**
 * Put `key` immediately before `beforeKey` in the custom order, or last when that is null.
 *
 * One flat list across the whole tree, because each level only ever sorts among its own children —
 * a key's rank is meaningless outside its parent, so the lists cannot interfere.
 */
export const placeKey = (key: string, beforeKey: string | null): void => {
  const next = getState().customOrder.filter((candidate) => candidate !== key)
  const index = beforeKey === null ? -1 : next.indexOf(beforeKey)
  if (index === -1) next.push(key)
  else next.splice(index, 0, key)
  setState({ customOrder: next })
}

/**
 * Reorder one row among its siblings, expressed as "before this one" so it goes through `placeKey`.
 *
 * It used to build the new order from the sibling list alone and store *that* as the whole custom
 * order — so reordering two categories replaced the flat list with two keys and threw away the
 * arrangement of every folder and template in the tree. `customOrder` spans all levels; only ever
 * edit it, never rewrite it.
 */
const moveKey = (keys: readonly string[], from: string, to: string, after: boolean): void => {
  const siblings = keys.filter((key) => key !== from)
  const index = siblings.indexOf(to)
  if (index === -1) return
  // Land before whichever sibling now follows the target; null means last among these siblings.
  placeKey(from, after ? (siblings[index + 1] ?? null) : to)
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
let dragging: { key: string; parentKey: string | null } | null = null

let dropTarget: {
  readonly parentKey: string | null
  readonly beforeKey: string | null
  readonly apply: (draggedKey: string, parentKey: string | null, beforeKey: string | null) => void
  readonly rerender: () => void
} | null = null

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
  while (next instanceof HTMLElement && next.dataset.caelestisKey !== undefined) {
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
  el.style.marginLeft = `${0.25 + depth * 1.125}rem`
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
    event.preventDefault()
    event.stopPropagation()
    const target = dropTarget
    const from = event.dataTransfer?.getData('text/plain')
    clearDropMarks(el.parentElement ?? document)
    dropTarget = null
    dragging = null
    if (target === null || from === undefined || from === '' || from === target.beforeKey) return
    target.apply(from, target.parentKey, target.beforeKey)
    target.rerender()
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
 * Above the midpoint means "before this row", at this row's own level. Below means "after", and
 * after is where the interesting case is: the row following an **expanded** container is its first
 * child, so landing after it means landing *inside* it, while after a **collapsed** container means
 * beside it. That is what the rows look like on screen, so it is what the drop does — no separate
 * "middle third means into" gesture to discover, and no way to aim at a gap and be refused.
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

  if (above) return { parentKey, beforeKey: key, depth, before: row }

  const isContainer = row.dataset.caelestisContainer !== undefined
  const expanded = key !== null && isExpanded(key)
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

interface RowOptions {
  readonly key: string
  readonly name: string
  readonly kind: IconName
  readonly depth: number
  readonly meta?: string
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
  /** Dimmed, for a row that exists but is not doing anything yet — an unpublished template. */
  readonly muted?: boolean | undefined
  readonly actions?: ReadonlyArray<{ icon: IconName; label: string; run: () => void }> | undefined
  /** Present only where the user can actually change things; absent means no rename affordance. */
  readonly onRename?: ((name: string) => void) | undefined
  readonly onContextMenu?: ((event: MouseEvent) => void) | undefined
  readonly siblings: readonly string[]
  readonly rerender: () => void
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
    | ((draggedKey: string, parentKey: string | null, beforeKey: string | null) => void)
    | undefined
  /** When present, the row reflects this instead of the tree's own disabled set. */
  readonly checked?: boolean | undefined
  readonly onToggleChecked?: ((on: boolean) => void) | undefined
}

const treeRow = (options: RowOptions): HTMLElement => {
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
  // One indent step per level, on top of the fixed gutter.
  row.style.marginLeft = `${0.25 + options.depth * 1.125}rem`
  row.style.marginRight = '0.5rem'
  row.style.minHeight = '2rem'
  if (options.muted === true) row.style.opacity = '0.55'
  row.draggable = draggable
  row.tabIndex = 0
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-expanded', String(isExpanded(options.key)))

  if (options.container) {
    const glyph = icon('caret', 'size-4 opacity-60')
    glyph.style.flex = '0 0 auto'
    glyph.style.transition = 'transform 120ms ease-out'
    glyph.style.transform = isExpanded(options.key) ? 'rotate(90deg)' : 'rotate(0deg)'
    row.appendChild(glyph)
  } else {
    // A leaf still needs the caret's width, or its name hangs left of every sibling's.
    const spacer = document.createElement('span')
    spacer.style.flex = '0 0 auto'
    spacer.style.width = '1rem'
    row.appendChild(spacer)
  }

  const kind = icon(options.kind, 'size-4 opacity-60')
  kind.style.flex = '0 0 auto'
  row.appendChild(kind)

  const editing = renaming === options.key && options.onRename !== undefined
  const input = document.createElement('input')
  const name = document.createElement('span')
  if (editing) {
    input.type = 'text'
    input.className = 'input input-xs input-bordered'
    input.value = options.name
    input.style.flex = '1'
    input.style.minWidth = '0'
    input.addEventListener('click', (event) => event.stopPropagation())
    row.appendChild(input)
    requestAnimationFrame(() => {
      input.focus()
      input.select()
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
    meta.className = 'text-xs opacity-50'
    meta.style.flex = '0 0 auto'
    meta.textContent = options.meta
    row.appendChild(meta)
  }

  if (editing) {
    // Confirm and cancel take the place of the row's own actions while renaming, so the row never
    // offers two different things to do with the same click.
    const group = document.createElement('span')
    group.className = 'flex items-center gap-0.5'
    group.style.flex = '0 0 auto'
    const commit = (): void => {
      const value = input.value.trim()
      renaming = null
      if (value !== '' && value !== options.name) options.onRename?.(value)
      else options.rerender()
    }
    const cancel = (): void => {
      renaming = null
      options.rerender()
    }
    for (const [glyphName, label, run] of [
      ['check', 'Save', commit],
      ['close', 'Cancel', cancel],
    ] as ReadonlyArray<readonly [IconName, string, () => void]>) {
      const button = document.createElement('button')
      button.className = 'btn btn-ghost btn-xs btn-circle'
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
    row.appendChild(group)
  } else if (options.actions !== undefined && options.actions.length > 0) {
    const group = document.createElement('span')
    group.className = 'caelestis-actions flex items-center gap-0.5'
    group.style.flex = '0 0 auto'
    for (const action of options.actions) {
      const button = document.createElement('button')
      button.className = 'btn btn-ghost btn-xs btn-circle'
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

  /**
   * An eye, not a tick.
   *
   * A tick answers "is this selected", and nothing here is being selected — every one of these rows
   * is either on the map or not, which is a thing you can *see*. The eye says which, and its absence
   * says the other, so a column of these reads as what is drawn rather than as a form to fill in.
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
  box.appendChild(icon('eye', 'size-4'))
  eye.append(check, box)
  row.appendChild(eye)

  const expand = (): void => {
    toggle(collapsed, options.key)
    options.rerender()
  }
  if (!editing) row.addEventListener('click', expand)
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      expand()
    }
  })

  if (options.onContextMenu !== undefined) {
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      options.onContextMenu?.(event)
    })
  }

  if (!draggable || editing) return row

  row.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData('text/plain', options.key)
    dragging = { key: options.key, parentKey: options.parentKey ?? null }
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
    const parent = row.parentElement
    if (parent === null) return
    clearDropMarks(parent)

    const place = options.onDropAt
    if (place === undefined) {
      // Rows without a position handler still reorder among their own siblings.
      const box = row.getBoundingClientRect()
      parent.insertBefore(
        placeholder(options.depth),
        event.clientY < box.top + box.height / 2 ? row : row.nextSibling,
      )
      return
    }

    const resolved = resolveDrop(row, event.clientY)
    // Reordering is ours to do — it is a client-side preference. Changing a row's *parent* is a
    // change to the shared structure, so without the right to make it the drop is simply not
    // offered: no outline appears, which reads as "not there" without needing to say so.
    if (
      options.canReparent !== true &&
      dragging !== null &&
      resolved.parentKey !== dragging.parentKey
    ) {
      return
    }
    dropTarget = {
      parentKey: resolved.parentKey,
      beforeKey: resolved.beforeKey,
      apply: place,
      rerender: options.rerender,
    }
    parent.insertBefore(placeholder(resolved.depth), resolved.before)
  })
  row.addEventListener('drop', (event) => {
    event.preventDefault()
    const parent = row.parentElement
    const from = event.dataTransfer?.getData('text/plain')
    const target = dropTarget
    if (parent !== null) clearDropMarks(parent)
    dropTarget = null
    if (from === undefined || from === '') return

    if (target !== null) {
      // Whatever the outline showed, including a drop that landed on the outline itself.
      if (from === target.beforeKey) return
      target.apply(from, target.parentKey, target.beforeKey)
      target.rerender()
      return
    }
    if (from === options.key) return
    const box = row.getBoundingClientRect()
    moveKey(options.siblings, from, options.key, event.clientY > box.top + box.height / 2)
    options.rerender()
  })

  return row
}

/**
 * One row, as the thing supplying it sees it.
 *
 * Everything a row needs that depends on *what* it is, and nothing that depends on where it sits.
 * Depth, siblings, ordering, expansion and recursion belong to the renderer below, which is the
 * whole point: they were the parts that had drifted.
 */
interface TreeItem {
  readonly key: string
  readonly name: string
  readonly kind: IconName
  /** Its id as a container, so the renderer can ask for its children. Null for a leaf. */
  readonly childrenOf: string | null
  readonly meta?: string | undefined
  readonly muted?: boolean | undefined
  readonly visible: boolean
  readonly setVisible: (on: boolean) => void
  readonly canReparent: boolean
  readonly actions?: ReadonlyArray<{ icon: IconName; label: string; run: () => void }> | undefined
  readonly onRename?: ((name: string) => void) | undefined
  readonly onContextMenu?: ((event: MouseEvent) => void) | undefined
  readonly onDropAt?:
    | ((draggedKey: string, parentKey: string | null, beforeKey: string | null) => void)
    | undefined
}

/**
 * Where a level of the tree comes from.
 *
 * Local templates and a server's published ones are the same thing from two places, and they were
 * drawn by two recursive functions written months apart. The second never caught up: server folders
 * ignored the custom order entirely, could not be interleaved with templates, and their visibility
 * switch reached nothing. Three bugs, one cause — so there is one renderer now, and a source is the
 * three things that genuinely differ.
 *
 * What is genuinely different, and all that is: mutations here go over HTTP and can be refused,
 * a row can exist before its pixels do, and order is this browser's preference while structure is
 * the server's. None of that is the shape of a tree.
 */
interface TreeSource {
  readonly children: (parentId: string | null) => readonly TreeItem[]
}

const childText = (text: string, depth: number): HTMLElement => {
  const el = document.createElement('p')
  el.className = 'text-xs opacity-60'
  el.style.padding = '0.125rem 0.75rem 0.375rem'
  el.style.paddingLeft = `${2.5 + depth * 1.125}rem`
  el.textContent = text
  return el
}

/**
 * One level of a tree, and every level below it.
 *
 * Ordered and interleaved: folders and templates go into one list and come out in whatever order
 * the user dragged them into. Not folders-first — sorting by kind means a template can never be put
 * above a folder, and a rule that quietly overrides a custom order makes the drag look broken
 * rather than constrained. This used to be true of Local only.
 */
const renderLevel = (
  into: HTMLElement,
  source: TreeSource,
  parentId: string | null,
  depth: number,
  parentKey: string,
  rerender: () => void,
): void => {
  const byKey = new Map(source.children(parentId).map((item) => [item.key, item]))
  const keys = orderedKeys([...byKey.keys()])

  for (const key of keys) {
    const item = byKey.get(key)
    if (item === undefined) continue
    into.appendChild(
      treeRow({
        key,
        name: item.name,
        kind: item.kind,
        depth,
        container: item.childrenOf !== null,
        siblings: keys,
        parentKey,
        canReparent: item.canReparent,
        rerender,
        checked: item.visible,
        onToggleChecked: (on) => {
          item.setVisible(on)
          rerender()
        },
        ...(item.meta === undefined ? {} : { meta: item.meta }),
        ...(item.muted === undefined ? {} : { muted: item.muted }),
        ...(item.actions === undefined ? {} : { actions: item.actions }),
        ...(item.onRename === undefined ? {} : { onRename: item.onRename }),
        ...(item.onContextMenu === undefined ? {} : { onContextMenu: item.onContextMenu }),
        ...(item.onDropAt === undefined ? {} : { onDropAt: item.onDropAt }),
      }),
    )
    if (item.childrenOf === null || !isExpanded(key)) continue
    renderLevel(into, source, item.childrenOf, depth + 1, key, rerender)
  }

  // Only inside something. "Nothing here" is worth saying about a folder you have just opened; at
  // the top of a source it is the source's own empty state, which says more than this can.
  if (parentId !== null && keys.length === 0) into.appendChild(childText('Empty.', depth))
}

export const treeContents = (callbacks: TreeCallbacks, rerender: () => void): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.setAttribute('role', 'tree')
  wrap.className = 'flex flex-col'
  // Breathing room between rows, and between the first row and the search field above it.
  wrap.style.gap = '0.125rem'
  wrap.style.paddingTop = '0.5rem'
  wrap.style.paddingBottom = '0.5rem'

  const servers = getState().servers
  const keys = ['local', ...servers.map((server) => `server:${server.url}`)]
  const ordered = orderedKeys(keys)

  for (const key of ordered) {
    const server = servers.find((candidate) => `server:${candidate.url}` === key)
    const isLocal = key === 'local'
    if (!isLocal && server === undefined) continue

    const target: TreeTarget = {
      server: server ?? null,
      nodeId: null,
      key,
      name: isLocal ? 'Local' : (server?.info?.name ?? server?.url ?? ''),
    }
    // Only where the code can actually act. Offering create to someone who will only ever get a
    // 403 is worse than not offering it — Local always can, since nothing gates it.
    const canEdit = isLocal || (server?.isAdmin ?? false)

    wrap.appendChild(
      treeRow({
        key,
        name: target.name,
        // A rack and a folder are different things and read differently at a glance.
        kind: isLocal ? 'folder' : 'server',
        depth: 0,
        container: true,
        siblings: ordered,
        parentKey: null,
        rerender,
        /**
         * Categories reorder among themselves, and only among themselves.
         *
         * Without a position handler a category could only be dropped *onto* another row, so the
         * one place you cannot aim — the gap above the first row — was the only way to reach first
         * place, and it silently did nothing. Reordering was therefore one-way: a category could be
         * moved down past its neighbour and never brought back up.
         *
         * `canReparent` stays off, so nothing can be filed *inside* a category by dragging.
         */
        onDropAt: (draggedKey, parentKey, beforeKey) => {
          // Another category, reordering among its own kind.
          if (parentKey === null && keys.includes(draggedKey)) {
            placeKey(draggedKey, beforeKey)
            return
          }
          // Landing just under a server's own row means its top level, which is otherwise
          // unreachable: every other destination is a folder, and "no folder" has no other row.
          if (parentKey === key && server !== undefined && canEdit) {
            callbacks.onDropInServer(server, null, draggedKey, beforeKey)
          }
        },
        canReparent: canEdit && !isLocal,
        // A category is a group like a folder is: switching it off takes everything under it off
        // the canvas, and leaves every row inside saying exactly what it said before.
        checked: isScopeVisible(key),
        onToggleChecked: (on) => {
          setScopeVisible(key, on)
          rerender()
        },
        onContextMenu: canEdit ? (event) => callbacks.onContextMenu(target, event) : undefined,
        onRename: canEdit ? (value) => callbacks.onRename(target, value) : undefined,
        actions: canEdit
          ? [
              {
                icon: 'createFolder',
                label: 'New folder',
                run: () => callbacks.onCreateFolder(target),
              },
              {
                icon: 'uploadFile',
                label: 'Import template',
                run: () => callbacks.onImportTemplate(target),
              },
            ]
          : undefined,
      }),
    )
    if (!isExpanded(key)) continue

    if (server !== undefined && server.status === 'connected') {
      const known = nodesByServer.get(server.url)
      if (known === undefined) {
        // First sight of this server: kick off the fetch, draw nothing extra this pass.
        void refreshNodes(server, rerender)
      } else {
        const published = templatesByServer.get(server.url) ?? []

        /**
         * A drop anywhere in this server's tree, resolved to a folder.
         *
         * One handler for folder rows and template rows alike. Both used to carry their own, and
         * they disagreed: the template one refused a drop at the server's top level, which is a rule
         * about the thing being *dragged* rather than about the row it landed near. `dropOnServerNode`
         * already enforces it from the dragged key, which is the only place that knows.
         */
        const intoServer = (
          draggedKey: string,
          dropParent: string | null,
          beforeKey: string | null,
        ): void => {
          const into =
            dropParent === null || dropParent === key
              ? null
              : dropParent.startsWith('node:')
                ? dropParent.slice('node:'.length)
                : undefined
          if (into === undefined) return
          callbacks.onDropInServer(server, into, draggedKey, beforeKey)
        }

        /**
         * A server's folders and the templates hanging off them.
         *
         * The three things that make this different from Local live here and nowhere else: renaming
         * and re-parenting go over HTTP and are refused without admin scope, a template row is drawn
         * from the manifest before its pixels have finished downloading, and the switch is this
         * browser's own record rather than anything the server said.
         */
        const source: TreeSource = {
          children: (parentId) => {
            const folders: TreeItem[] = known
              .filter((node) => node.parentId === parentId)
              .map((node) => {
                const nodeTarget: TreeTarget = {
                  server,
                  nodeId: node.id,
                  key: `node:${node.id}`,
                  name: node.name,
                }
                return {
                  key: `node:${node.id}`,
                  name: node.name,
                  kind: 'folder' as const,
                  childrenOf: node.id,
                  // Whether someone else's folder is on your canvas is your decision, so this is
                  // kept here and never sent anywhere. Switching it off takes its templates and its
                  // subfolders off the map while every row inside keeps saying what it said.
                  visible: isScopeVisible(nodeScopeKey(node.id)),
                  setVisible: (on: boolean) => setScopeVisible(nodeScopeKey(node.id), on),
                  canReparent: canEdit,
                  onDropAt: canEdit ? intoServer : undefined,
                  onContextMenu: canEdit
                    ? (event: MouseEvent) => callbacks.onContextMenu(nodeTarget, event)
                    : undefined,
                  onRename: canEdit
                    ? (value: string) => callbacks.onRename(nodeTarget, value)
                    : undefined,
                  actions: canEdit
                    ? [
                        {
                          icon: 'createFolder' as const,
                          label: 'New folder',
                          run: () => callbacks.onCreateFolder(nodeTarget),
                        },
                        {
                          icon: 'uploadFile' as const,
                          label: 'Import template',
                          run: () => callbacks.onImportTemplate(nodeTarget),
                        },
                      ]
                    : undefined,
                }
              })

            // Templates hang off a folder, never off the server's own row: the top level of a
            // server holds folders only, which is what `parentId === null` means here.
            const templates: TreeItem[] =
              parentId === null
                ? []
                : published
                    .filter((template) => template.nodeId === parentId)
                    .map((template) => {
                      // The copy on the canvas, if the sync has fetched it yet. Absent means the row
                      // is drawn from the manifest alone — the right first frame, since the manifest
                      // arrives long before the chunks do.
                      const drawn = localTemplates().find(
                        (candidate) => candidate.id === serverTemplateKey(server.url, template.id),
                      )
                      const templateTarget: TreeTarget = {
                        server,
                        nodeId: parentId,
                        key: `st:${template.id}`,
                        name: template.name,
                        templateId: template.id,
                      }
                      return {
                        key: `st:${template.id}`,
                        name: template.name,
                        // The same glyph a Local template row wears: it is the same kind of thing,
                        // and where it lives is said by the tree rather than by the icon.
                        kind: 'image' as const,
                        childrenOf: null,
                        // Unpublished ones are visible to an admin and nobody else, so they have to
                        // look different — otherwise the tree shows a template members cannot see
                        // and gives no hint why.
                        muted: !template.published,
                        meta: template.published ? undefined : 'unpublished',
                        visible: drawn?.visible ?? false,
                        setVisible: (on: boolean) => {
                          if (drawn !== undefined) setLocalVisible(drawn.id, on)
                        },
                        canReparent: canEdit,
                        onDropAt: canEdit ? intoServer : undefined,
                        onContextMenu: canEdit
                          ? (event: MouseEvent) => callbacks.onContextMenu(templateTarget, event)
                          : undefined,
                        onRename: canEdit
                          ? (value: string) => callbacks.onRename(templateTarget, value)
                          : undefined,
                      }
                    })

            return [...folders, ...templates]
          },
        }

        renderLevel(wrap, source, null, 1, key, rerender)
        if (known.length === 0) wrap.appendChild(childText('No templates published yet.', 0))
        continue
      }
    }

    if (isLocal) {
      // Local means "only in this browser". Server templates share the store — everything that
      // draws them takes a `PlacedTemplate` and does not care where it came from — but they are
      // listed under the server publishing them, not here.
      const mine = localTemplates().filter((template) => !isServerTemplate(template))

      const source: TreeSource = {
        children: (parentId) => {
          const folders: TreeItem[] = getState()
            .localFolders.filter((folder) => folder.parentId === parentId)
            .map((folder) => {
              const folderTarget: TreeTarget = {
                server: null,
                nodeId: null,
                key: `lf:${folder.id}`,
                name: folder.name,
              }
              return {
                key: `lf:${folder.id}`,
                name: folder.name,
                kind: 'folder' as const,
                childrenOf: folder.id,
                visible: folder.visible,
                setVisible: (on: boolean) => setLocalFolderVisible(folder.id, on),
                canReparent: true,
                onDropAt: callbacks.onMoveLocal,
                onContextMenu: (event: MouseEvent) => callbacks.onContextMenu(folderTarget, event),
                onRename: (value: string) => callbacks.onRename(folderTarget, value),
                actions: [
                  {
                    icon: 'createFolder' as const,
                    label: 'New folder',
                    run: () => callbacks.onCreateFolder(folderTarget),
                  },
                  {
                    icon: 'uploadFile' as const,
                    label: 'Import template',
                    run: () => callbacks.onImportTemplate(folderTarget),
                  },
                ],
              }
            })

          const templates: TreeItem[] = mine
            .filter((template) => (template.folderId ?? null) === parentId)
            .map((template) => {
              const templateTarget: TreeTarget = {
                server: null,
                nodeId: null,
                key: `local:${template.id}`,
                name: template.name,
              }
              return {
                key: `local:${template.id}`,
                name: template.name,
                kind: 'image' as const,
                childrenOf: null,
                meta: `${template.width}×${template.height}`,
                visible: template.visible,
                setVisible: (on: boolean) => setLocalVisible(template.id, on),
                canReparent: true,
                onDropAt: callbacks.onMoveLocal,
                onContextMenu: (event: MouseEvent) =>
                  callbacks.onContextMenu(templateTarget, event),
                onRename: (value: string) => callbacks.onRename(templateTarget, value),
                // Only the two that are safe to hit by accident on a hover target. Move takes over
                // the canvas and Remove destroys the template, so both live in the right-click menu
                // and in the template's own menu on the canvas, where reaching them is deliberate.
                actions: [
                  {
                    icon: 'search' as const,
                    label: 'Go to',
                    run: () => callbacks.onGoTo(template.id),
                  },
                  {
                    icon: 'uploadFile' as const,
                    label: 'Copy to a server',
                    run: () => callbacks.onCopyToServer(template.id),
                  },
                ],
              }
            })

          return [...folders, ...templates]
        },
      }

      renderLevel(wrap, source, null, 1, 'local', rerender)
      if (mine.length === 0) wrap.appendChild(childText('No local templates yet.', 0))
      // The hover action exists too, but an empty state is where someone is actually looking for
      // the way in, so it gets a visible button.
      const actions = document.createElement('div')
      actions.style.padding = '0 0.75rem 0.5rem 2.25rem'
      const importButton = document.createElement('button')
      importButton.className = 'btn btn-xs'
      importButton.textContent = 'Import a template'
      importButton.title = 'A .wplace file, a Blue Marble export, or an image'
      importButton.addEventListener('click', () =>
        callbacks.onImportTemplate({ server: null, nodeId: null, key: 'local', name: 'Local' }),
      )
      actions.appendChild(importButton)
      wrap.appendChild(actions)
      continue
    }
    if (server === undefined) continue
    // No badge for a healthy server: if it is in the list at all, it is connected. Only trouble
    // needs saying, and it says it in words where there is room for them.
    if (server.status === 'connected') {
      wrap.appendChild(childText('No templates published yet.', 0))
    } else if (server.status === 'needs-token') {
      wrap.appendChild(childText('Needs an access token — add it in settings.', 0))
    } else {
      wrap.appendChild(childText(`Could not be reached. ${server.error ?? ''}`.trim(), 0))
    }
  }

  const addWrap = document.createElement('div')
  addWrap.className = 'flex justify-center'
  addWrap.style.padding = '0.5rem 0.75rem 0'
  const add = document.createElement('button')
  add.className = 'btn btn-sm btn-ghost'
  add.appendChild(icon('extension', 'size-4 opacity-60'))
  const addText = document.createElement('span')
  addText.textContent = servers.length === 0 ? 'Add a server' : 'Add another server'
  add.appendChild(addText)
  add.addEventListener('click', callbacks.onAddServer)
  addWrap.appendChild(add)
  wrap.appendChild(addWrap)

  return wrap
}
