import { type ConnectedServer, getState } from '../state.js'
import { icon } from './icons.js'

/**
 * The tree: one root per source, plus `Local`.
 *
 * `Local` is always first and always present. It is not a server, never appears in a manifest, and
 * exists so the product does something useful before anyone has typed a URL — import a file, place
 * it against the live canvas, look at it. Connecting to a server is the biggest step here, and
 * making it the *first* step is what turns people away.
 *
 * Row anatomy, left to right: **disclosure caret, name, meta, checkbox**. The caret leads because
 * it is what makes a list read as a tree, and the checkbox trails because it is the thing you act on
 * once you have found the row — put it first and every row starts with a control instead of a name.
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
 * default hold for templates that appear later, without having to touch them as they arrive.
 */
const disabled = new Set<string>()

const isExpanded = (key: string): boolean => !collapsed.has(key)
const isEnabled = (key: string): boolean => !disabled.has(key)

type RowOptions = {
  readonly key: string
  readonly name: string
  readonly depth: number
  readonly meta?: string
  readonly badge?: HTMLElement
  readonly expandable: boolean
  readonly onToggleExpand?: () => void
  readonly onToggleEnabled?: () => void
}

const treeRow = (options: RowOptions): HTMLElement => {
  const row = document.createElement('div')
  row.className = 'flex items-center gap-1'
  row.style.padding = '0.25rem 0.75rem'
  row.style.paddingLeft = `${0.5 + options.depth * 1}rem`
  row.style.minHeight = '2rem'

  if (options.expandable) {
    const caret = document.createElement('button')
    caret.className = 'btn btn-ghost btn-xs btn-circle'
    caret.style.flex = '0 0 auto'
    caret.setAttribute('aria-expanded', String(isExpanded(options.key)))
    caret.setAttribute('aria-label', isExpanded(options.key) ? 'Collapse' : 'Expand')
    const glyph = icon('caret', 'size-4')
    glyph.style.transition = 'transform 120ms ease-out'
    glyph.style.transform = isExpanded(options.key) ? 'rotate(90deg)' : 'rotate(0deg)'
    caret.appendChild(glyph)
    caret.addEventListener('click', () => options.onToggleExpand?.())
    row.appendChild(caret)
  } else {
    // A leaf still needs the caret's width, or its name hangs left of every sibling's.
    const spacer = document.createElement('span')
    spacer.style.flex = '0 0 auto'
    spacer.style.width = '1.5rem'
    row.appendChild(spacer)
  }

  const name = document.createElement('span')
  name.className = 'text-sm'
  name.style.flex = '1'
  name.style.overflow = 'hidden'
  name.style.textOverflow = 'ellipsis'
  name.style.whiteSpace = 'nowrap'
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
  check.addEventListener('change', () => options.onToggleEnabled?.())
  row.appendChild(check)

  return row
}

const childText = (text: string, depth: number): HTMLElement => {
  const el = document.createElement('p')
  el.className = 'text-xs opacity-60'
  el.style.padding = '0 0.75rem 0.5rem'
  el.style.paddingLeft = `${2 + depth}rem`
  el.textContent = text
  return el
}

export const treeContents = (callbacks: TreeCallbacks, rerender: () => void): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.style.paddingBottom = '0.5rem'

  wrap.appendChild(
    treeRow({
      key: 'local',
      name: 'Local',
      depth: 0,
      meta: 'empty',
      expandable: true,
      onToggleExpand: () => {
        collapsed.has('local') ? collapsed.delete('local') : collapsed.add('local')
        rerender()
      },
      onToggleEnabled: () => {
        disabled.has('local') ? disabled.delete('local') : disabled.add('local')
        rerender()
      },
    }),
  )
  if (isExpanded('local')) {
    wrap.appendChild(childText('No local templates yet.', 0))
    const actions = document.createElement('div')
    actions.style.padding = '0 0.75rem 0.75rem 2rem'
    const importButton = document.createElement('button')
    importButton.className = 'btn btn-xs'
    importButton.textContent = 'Import a template'
    importButton.title = 'Import a .wplace file, or a Blue Marble export'
    importButton.addEventListener('click', callbacks.onImportLocal)
    actions.appendChild(importButton)
    wrap.appendChild(actions)
  }

  for (const server of getState().servers) {
    const key = `server:${server.url}`
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
        depth: 0,
        badge,
        expandable: true,
        onToggleExpand: () => {
          collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key)
          rerender()
        },
        onToggleEnabled: () => {
          disabled.has(key) ? disabled.delete(key) : disabled.add(key)
          rerender()
        },
      }),
    )
    if (isExpanded(key)) {
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
  addText.textContent = getState().servers.length === 0 ? 'Add a server' : 'Add another server'
  add.appendChild(addText)
  add.addEventListener('click', callbacks.onAddServer)
  addWrap.appendChild(add)
  wrap.appendChild(addWrap)

  return wrap
}
