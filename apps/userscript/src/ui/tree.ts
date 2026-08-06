import { type ConnectedServer, getState, setState } from '../state.js'
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

export interface TreeCallbacks {
  readonly onAddServer: () => void
  readonly onImportLocal: () => void
  readonly onCreateFolder: (parent: {
    server: ConnectedServer | null
    nodeId: string | null
  }) => void
  readonly onCreateTemplate: (parent: {
    server: ConnectedServer | null
    nodeId: string | null
  }) => void
}

const collapsed = new Set<string>()
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

const moveKey = (keys: readonly string[], from: string, to: string, after: boolean): void => {
  const next = keys.filter((key) => key !== from)
  const index = next.indexOf(to)
  if (index === -1) return
  next.splice(after ? index + 1 : index, 0, from)
  setState({ customOrder: next })
}

/** Held open where the dragged row would land — a hole says "here"; a line only says "near here". */
const placeholder = (): HTMLElement => {
  const el = document.createElement('div')
  el.className = 'wts-placeholder'
  el.dataset.wtsPlaceholder = ''
  return el
}

const clearDropMarks = (root: ParentNode): void => {
  for (const el of root.querySelectorAll('[data-wts-placeholder]')) el.remove()
  for (const el of root.querySelectorAll('.wts-drop-into')) el.classList.remove('wts-drop-into')
}

interface RowOptions {
  readonly key: string
  readonly name: string
  readonly kind: IconName
  readonly depth: number
  readonly meta?: string
  /** Containers accept a drop *into* them; leaves only reorder between siblings. */
  readonly container: boolean
  readonly actions?: ReadonlyArray<{ icon: IconName; label: string; run: () => void }>
  readonly siblings: readonly string[]
  readonly rerender: () => void
  readonly onDropInto?: (draggedKey: string) => void
}

const treeRow = (options: RowOptions): HTMLElement => {
  const draggable = isReorderable(getState().sort)
  const row = document.createElement('div')
  row.className = 'wts-row flex items-center gap-1'
  row.dataset.wtsKey = options.key
  row.style.padding = '0.25rem 0.5rem'
  // One indent step per level, on top of the fixed gutter.
  row.style.marginLeft = `${0.25 + options.depth * 1.125}rem`
  row.style.marginRight = '0.5rem'
  row.style.minHeight = '2rem'
  row.draggable = draggable
  row.tabIndex = 0
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-expanded', String(isExpanded(options.key)))

  const glyph = icon('caret', 'size-4 opacity-60')
  glyph.style.flex = '0 0 auto'
  glyph.style.transition = 'transform 120ms ease-out'
  glyph.style.transform = isExpanded(options.key) ? 'rotate(90deg)' : 'rotate(0deg)'
  row.appendChild(glyph)

  const kind = icon(options.kind, 'size-4 opacity-60')
  kind.style.flex = '0 0 auto'
  row.appendChild(kind)

  const name = document.createElement('span')
  name.className = 'wts-name text-sm'
  name.textContent = options.name
  row.appendChild(name)
  // A tooltip that repeats fully visible text is noise; only label what is actually clipped.
  requestAnimationFrame(() => {
    if (name.scrollWidth > name.clientWidth) name.title = options.name
  })

  if (options.meta !== undefined) {
    const meta = document.createElement('span')
    meta.className = 'text-xs opacity-50'
    meta.style.flex = '0 0 auto'
    meta.textContent = options.meta
    row.appendChild(meta)
  }

  if (options.actions !== undefined && options.actions.length > 0) {
    const group = document.createElement('span')
    group.className = 'wts-actions flex items-center gap-0.5'
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

  const check = document.createElement('input')
  check.type = 'checkbox'
  check.className = 'checkbox checkbox-sm'
  check.style.flex = '0 0 auto'
  check.checked = isEnabled(options.key)
  check.setAttribute('aria-label', `Show ${options.name}`)
  check.addEventListener('click', (event) => event.stopPropagation())
  check.addEventListener('change', () => {
    toggle(disabled, options.key)
    options.rerender()
  })
  row.appendChild(check)

  const expand = (): void => {
    toggle(collapsed, options.key)
    options.rerender()
  }
  row.addEventListener('click', expand)
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      expand()
    }
  })

  if (!draggable) return row

  row.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData('text/plain', options.key)
    row.classList.add('wts-dragging')
  })
  row.addEventListener('dragend', () => {
    row.classList.remove('wts-dragging')
    clearDropMarks(row.parentElement ?? document)
  })
  row.addEventListener('dragover', (event) => {
    event.preventDefault()
    const parent = row.parentElement
    if (parent === null) return
    const box = row.getBoundingClientRect()
    const offset = (event.clientY - box.top) / box.height
    // The middle third of a container means "into"; the outer thirds mean "between".
    const into =
      options.container && options.onDropInto !== undefined && offset > 0.3 && offset < 0.7
    clearDropMarks(parent)
    if (into) {
      row.classList.add('wts-drop-into')
      return
    }
    parent.insertBefore(placeholder(), offset < 0.5 ? row : row.nextSibling)
  })
  row.addEventListener('drop', (event) => {
    event.preventDefault()
    const parent = row.parentElement
    const from = event.dataTransfer?.getData('text/plain')
    const into = row.classList.contains('wts-drop-into')
    if (parent !== null) clearDropMarks(parent)
    if (from === undefined || from === '' || from === options.key) return
    if (into) {
      options.onDropInto?.(from)
      return
    }
    const box = row.getBoundingClientRect()
    moveKey(options.siblings, from, options.key, event.clientY > box.top + box.height / 2)
    options.rerender()
  })

  return row
}

const childText = (text: string, depth: number): HTMLElement => {
  const el = document.createElement('p')
  el.className = 'text-xs opacity-60'
  el.style.padding = '0.125rem 0.75rem 0.375rem'
  el.style.paddingLeft = `${2.5 + depth * 1.125}rem`
  el.textContent = text
  return el
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

    wrap.appendChild(
      treeRow({
        key,
        name: isLocal ? 'Local' : (server?.info?.name ?? server?.url ?? ''),
        // A rack and a folder are different things and read differently at a glance.
        kind: isLocal ? 'folder' : 'server',
        depth: 0,
        container: true,
        siblings: ordered,
        rerender,
        actions: [
          {
            icon: 'createFolder',
            label: 'New folder',
            run: () => callbacks.onCreateFolder({ server: server ?? null, nodeId: null }),
          },
          {
            icon: 'addPhoto',
            label: 'New template',
            run: () => callbacks.onCreateTemplate({ server: server ?? null, nodeId: null }),
          },
        ],
      }),
    )
    if (!isExpanded(key)) continue

    if (isLocal) {
      wrap.appendChild(childText('No local templates yet.', 0))
      continue
    }
    if (server === undefined) continue
    // No badge for a healthy server: if it is in the list at all, it is connected. Only trouble
    // needs saying, and it says it in words where there is room for them.
    if (server.status === 'connected') {
      wrap.appendChild(childText('No templates published yet.', 0))
    } else if (server.status === 'needs-token') {
      wrap.appendChild(childText('Needs an access code — add it in settings.', 0))
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
