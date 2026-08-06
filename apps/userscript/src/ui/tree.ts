import { type ConnectedServer, getState } from '../state.js'
import { icon } from './icons.js'

/**
 * The tree: one root per source, plus `Local`.
 *
 * `Local` is always first and always present. It is not a server, never appears in a manifest, and
 * exists so the product does something useful before anyone has typed a URL — import a file, place
 * it against the live canvas, look at it. Connecting to a server is the biggest step here, and
 * making it the *first* step is what turns people away.
 */

export interface TreeCallbacks {
  readonly onAddServer: () => void
  readonly onImportLocal: () => void
}

const row = (depth: number): HTMLElement => {
  const el = document.createElement('div')
  el.className = 'flex items-center gap-2 px-3 py-1.5'
  el.style.paddingLeft = `${0.75 + depth * 1.25}rem`
  el.style.minHeight = '2.25rem'
  return el
}

const checkbox = (state: 'on' | 'off' | 'mixed'): HTMLInputElement => {
  const el = document.createElement('input')
  el.type = 'checkbox'
  el.className = 'checkbox checkbox-sm'
  el.checked = state === 'on'
  el.indeterminate = state === 'mixed'
  return el
}

const label = (text: string, muted = false): HTMLElement => {
  const el = document.createElement('span')
  el.className = muted ? 'text-sm opacity-60' : 'text-sm'
  el.style.flex = '1'
  el.style.overflow = 'hidden'
  el.style.textOverflow = 'ellipsis'
  el.style.whiteSpace = 'nowrap'
  el.textContent = text
  return el
}

const localSection = (callbacks: TreeCallbacks): HTMLElement => {
  const section = document.createElement('div')

  const header = row(0)
  header.append(checkbox('off'), label('Local'))
  const count = document.createElement('span')
  count.className = 'text-xs opacity-50'
  count.textContent = 'empty'
  header.appendChild(count)
  section.appendChild(header)

  const hint = document.createElement('p')
  hint.className = 'text-xs opacity-60'
  hint.style.padding = '0 0.75rem 0.5rem 2rem'
  hint.textContent = 'Templates you keep on this machine. No server needed.'
  section.appendChild(hint)

  const actions = document.createElement('div')
  actions.className = 'flex gap-2'
  actions.style.padding = '0 0.75rem 0.75rem 2rem'
  const importButton = document.createElement('button')
  importButton.className = 'btn btn-xs'
  importButton.textContent = 'Import a template'
  importButton.title = 'Import a .wplace file, or a Blue Marble export'
  importButton.addEventListener('click', callbacks.onImportLocal)
  actions.appendChild(importButton)
  section.appendChild(actions)

  return section
}

const serverSection = (server: ConnectedServer): HTMLElement => {
  const section = document.createElement('div')
  const header = row(0)
  header.append(checkbox('off'), label(server.info?.name ?? server.url))

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
  header.appendChild(badge)
  section.appendChild(header)

  const note = document.createElement('p')
  note.className = 'text-xs opacity-60'
  note.style.padding = '0 0.75rem 0.5rem 2rem'
  note.textContent =
    server.status === 'connected'
      ? 'No templates published yet.'
      : server.status === 'needs-token'
        ? 'This server needs an access code.'
        : `Could not reach this server. ${server.error ?? ''}`.trim()
  section.appendChild(note)
  return section
}

export const treeContents = (callbacks: TreeCallbacks): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.style.paddingBottom = '0.5rem'
  wrap.appendChild(localSection(callbacks))

  for (const server of getState().servers) wrap.appendChild(serverSection(server))

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
