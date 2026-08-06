import { getState, setState } from '../state.js'
import { type IconName, icon } from './icons.js'
import { isReorderable } from './sort.js'

/**
 * The tree: one root per source, plus `Local`.
 *
 * `Local` is always first in a fresh install and always present. It is not a server, never appears
 * in a manifest, and exists so the product does something useful before anyone has typed a URL.
 *
 * Row anatomy, left to right: **caret, kind icon, name, meta, checkbox**. The caret leads because it
 * is what makes a list read as a tree; the checkbox trails because it is what you act on once you
 * have found the row, and putting it first means every row opens with a control instead of a name.
 *
 * The whole row is the expand target — a caret is a 24px hit area on a 300px row, and everything
 * between them is dead space otherwise. The checkbox stops the click from propagating, because it
 * is the one part of the row that means something else.
 */

export interface TreeCallbacks {
  readonly onAddServer: () => void
  readonly onImportLocal: () => void
}

/** Expansion is view state, not settings — it does not survive a reload and does not need to. */
const collapsed = new Set<string>()

/**
 * Everything is on unless it has been turned off.
 *
 * A tree that arrives switched off shows a connected server as an empty canvas, which reads as
 * broken rather than as opt-in. Tracking the *off* set rather than the on set is what makes that
 * default hold for rows that appear later, without having to touch them as they arrive.
 */
const disabled = new Set<string>()

const isExpanded = (key: string): boolean => !collapsed.has(key)
const isEnabled = (key: string): boolean => !disabled.has(key)

const toggle = (set: Set<string>, key: string): void => {
  if (set.has(key)) set.delete(key)
  else set.add(key)
}

/**
 * The user's own order, by row key.
 *
 * Stored client-side and never sent anywhere — it is a presentation preference, and it is also the
 * draw order. Keys not in the list sort after those that are, most recently seen first, so a server
 * publishing a batch surfaces what arrived instead of burying it.
 */
const orderedKeys = (keys: readonly string[]): readonly string[] => {
  const custom = getState().customOrder
  const rank = new Map(custom.map((key, index) => [key, index]))
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

interface RowOptions {
  readonly key: string
  readonly name: string
  readonly kind: IconName
  readonly depth: number
  readonly meta?: string
  readonly badge?: HTMLElement
  readonly siblings: readonly string[]
  readonly rerender: () => void
}

const treeRow = (options: RowOptions): HTMLElement => {
  const draggable = isReorderable(getState().sort)
  const row = document.createElement('div')
  row.className = 'wts-row flex items-center gap-1'
  row.dataset.wtsKey = options.key
  row.style.padding = '0.25rem 0.5rem'
  row.style.marginLeft = `${0.25 + options.depth}rem`
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
  name.title = options.name
  row.appendChild(name)

  if (options.meta !== undefined) {
    const meta = document.createElement('span')
    meta.className = 'text-xs opacity-50'
    meta.style.flex = '0 0 auto'
    meta.textContent = options.meta
    row.appendChild(meta)
  }
  if (options.badge !== undefined) row.appendChild(options.badge)

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
  row.addEventListener('dragend', () => row.classList.remove('wts-dragging'))
  row.addEventListener('dragover', (event) => {
    event.preventDefault()
    const box = row.getBoundingClientRect()
    const after = event.clientY > box.top + box.height / 2
    row.classList.toggle('wts-drop-before', !after)
    row.classList.toggle('wts-drop-after', after)
  })
  row.addEventListener('dragleave', () => {
    row.classList.remove('wts-drop-before', 'wts-drop-after')
  })
  row.addEventListener('drop', (event) => {
    event.preventDefault()
    const from = event.dataTransfer?.getData('text/plain')
    row.classList.remove('wts-drop-before', 'wts-drop-after')
    if (from === undefined || from === '' || from === options.key) return
    const box = row.getBoundingClientRect()
    moveKey(options.siblings, from, options.key, event.clientY > box.top + box.height / 2)
    options.rerender()
  })

  return row
}

const childText = (text: string, depth: number): HTMLElement => {
  const el = document.createElement('p')
  el.className = 'text-xs opacity-60'
  el.style.padding = '0.125rem 0.75rem 0.5rem'
  el.style.paddingLeft = `${2.25 + depth}rem`
  el.textContent = text
  return el
}

export const treeContents = (callbacks: TreeCallbacks, rerender: () => void): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.setAttribute('role', 'tree')
  wrap.style.paddingBottom = '0.5rem'

  const servers = getState().servers
  const keys = ['local', ...servers.map((server) => `server:${server.url}`)]
  const ordered = orderedKeys(keys)

  for (const key of ordered) {
    if (key === 'local') {
      wrap.appendChild(
        treeRow({
          key,
          name: 'Local',
          kind: 'folder',
          depth: 0,
          siblings: ordered,
          rerender,
        }),
      )
      if (!isExpanded(key)) continue
      wrap.appendChild(childText('No local templates yet.', 0))
      const actions = document.createElement('div')
      actions.style.padding = '0 0.75rem 0.75rem 2.25rem'
      const importButton = document.createElement('button')
      importButton.className = 'btn btn-xs'
      importButton.textContent = 'Import a template'
      importButton.title = 'Import a .wplace file, or a Blue Marble export'
      importButton.addEventListener('click', callbacks.onImportLocal)
      actions.appendChild(importButton)
      wrap.appendChild(actions)
      continue
    }

    const server = servers.find((candidate) => `server:${candidate.url}` === key)
    if (server === undefined) continue
    const badge = document.createElement('span')
    badge.className =
      server.status === 'connected'
        ? 'badge badge-xs badge-success'
        : server.status === 'needs-token'
          ? 'badge badge-xs badge-warning'
          : 'badge badge-xs badge-error'
    badge.textContent =
      server.status === 'connected' ? 'ok' : server.status === 'needs-token' ? 'code' : 'off'
    badge.title = server.error ?? server.status
    badge.style.flex = '0 0 auto'

    wrap.appendChild(
      treeRow({
        key,
        name: server.info?.name ?? server.url,
        kind: 'folder',
        depth: 0,
        badge,
        siblings: ordered,
        rerender,
      }),
    )
    if (!isExpanded(key)) continue
    wrap.appendChild(
      childText(
        server.status === 'connected'
          ? 'No templates published yet.'
          : server.status === 'needs-token'
            ? 'Needs an access code — add it in settings.'
            : `Could not reach this server. ${server.error ?? ''}`.trim(),
        0,
      ),
    )
  }

  // Kept even when only Local is showing. Local is a starting point, not a destination, and hiding
  // the way onward would quietly make it one.
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
