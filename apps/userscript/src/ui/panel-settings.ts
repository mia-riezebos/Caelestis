import { forgetServer } from '../server-cache.js'
import {
  type ConnectedServer,
  canonicalServerUrl,
  getState,
  MAX_CONNECTED_SERVERS,
  probeServer,
  removeServer,
  upsertServer,
} from '../state.js'
import { coloursSection } from './colours.js'
import { icon } from './icons.js'
import { PANEL_ID } from './panel-chrome.js'
import { announce } from './panel-notifications.js'
import { liveStatusTarget } from './panel-workflow.js'
import { forgetServerTree } from './tree.js'

export interface SettingsViewActions {
  readonly isSettingsView: () => boolean
  readonly panelRequest: () => { controller: AbortController; finish: () => void }
  readonly showSettings: () => void
}

let controlLabelSerial = 0
const connectionAttempts = new Map<string, number>()

const beginConnectionAttempt = (url: string): (() => boolean) => {
  const generation = (connectionAttempts.get(url) ?? 0) + 1
  connectionAttempts.set(url, generation)
  return () => connectionAttempts.get(url) === generation
}

const sectionHeader = (title: string): HTMLElement => {
  const h = document.createElement('h3')
  h.className = 'text-xs font-semibold opacity-60 uppercase tracking-wide px-3 pt-4 pb-1'
  h.textContent = title
  return h
}

const settingRow = (label: string, hint: string | null, control: HTMLElement): HTMLElement => {
  const row = document.createElement('div')
  row.className = 'flex items-center justify-between gap-4 px-3 py-2'
  row.style.minHeight = '3rem'
  const text = document.createElement('div')
  text.className = 'flex flex-col'
  const name = document.createElement('span')
  const labelId = `wts-setting-${++controlLabelSerial}`
  name.id = labelId
  name.className = 'text-sm'
  name.textContent = label
  text.append(name)
  if (hint !== null) {
    const sub = document.createElement('span')
    sub.className = 'text-xs opacity-60'
    sub.textContent = hint
    text.appendChild(sub)
  }
  control.setAttribute('aria-labelledby', labelId)
  row.append(text, control)
  return row
}

const currentDraftStatus = (
  key: string,
  original: HTMLElement,
  actions: SettingsViewActions,
): HTMLElement | null =>
  liveStatusTarget(original, () => {
    if (!actions.isSettingsView()) return null
    const panel = document.getElementById(PANEL_ID)
    if (panel === null) return null
    return (
      [...panel.querySelectorAll<HTMLElement>('[data-wts-draft-status]')].find(
        (candidate) => candidate.dataset.wtsDraftStatus === key,
      ) ?? null
    )
  })

const checkbox = (): HTMLInputElement => {
  const el = document.createElement('input')
  el.type = 'checkbox'
  el.className = 'checkbox checkbox-sm'
  return el
}

const retryServerButton = (
  server: ConnectedServer,
  label: string,
  actions: SettingsViewActions,
): HTMLButtonElement => {
  const button = document.createElement('button')
  button.className = 'btn btn-xs btn-ghost'
  button.textContent = label
  button.addEventListener('click', () => {
    if (button.disabled) return
    button.disabled = true
    void (async () => {
      const ownsAttempt = beginConnectionAttempt(server.url)
      const request = actions.panelRequest()
      try {
        const next = await probeServer(server.url, server.token, request.controller.signal)
        if (
          request.controller.signal.aborted ||
          !ownsAttempt() ||
          getState().servers.find((candidate) => candidate.url === server.url) !== server
        ) {
          return
        }
        upsertServer(next)
        actions.showSettings()
      } finally {
        request.finish()
        if (button.isConnected) button.disabled = false
      }
    })()
  })
  return button
}

/**
 * One connected server, and the single action its status implies.
 *
 * The code field only exists once the server has said it wants one. Asking up front is the fastest
 * way to lose someone whose server does not need a code at all, which most will not.
 */
const serverRow = (server: ConnectedServer, actions: SettingsViewActions): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'px-3 py-2'

  const top = document.createElement('div')
  top.className = 'flex items-center gap-2'
  const name = document.createElement('span')
  name.className = 'text-sm'
  name.style.flex = '1'
  name.style.overflow = 'hidden'
  name.style.textOverflow = 'ellipsis'
  name.style.whiteSpace = 'nowrap'
  name.textContent = server.info?.name ?? server.url
  name.title = server.url

  const badge = document.createElement('span')
  badge.className =
    server.status === 'connected'
      ? 'badge badge-xs badge-success'
      : server.status === 'needs-token'
        ? 'badge badge-xs badge-warning'
        : 'badge badge-xs badge-error'
  badge.textContent =
    server.status === 'connected'
      ? 'connected'
      : server.status === 'needs-token'
        ? 'code'
        : 'offline'

  const remove = document.createElement('button')
  remove.className = 'btn btn-ghost btn-xs btn-circle'
  remove.title = 'Disconnect'
  remove.setAttribute('aria-label', `Disconnect ${server.info?.name ?? server.url}`)
  remove.appendChild(icon('close', 'size-3'))
  remove.addEventListener('click', () => {
    // Invalidate only work owned by this connection. Requests and uploads for other servers must
    // survive an unrelated disconnect.
    beginConnectionAttempt(server.url)
    forgetServerTree(server.url)
    removeServer(server.url)
    void forgetServer(server.url)
    actions.showSettings()
  })

  top.append(name, badge, remove)
  wrap.appendChild(top)

  if (server.status !== 'needs-token') {
    if (server.status === 'unreachable') {
      const why = document.createElement('p')
      why.className = 'text-xs opacity-60'
      why.textContent = server.error ?? 'Could not be reached.'
      wrap.appendChild(why)
      wrap.appendChild(retryServerButton(server, 'Retry', actions))
    } else if (!server.isAdmin) {
      wrap.appendChild(retryServerButton(server, 'Recheck admin access', actions))
    }
    return wrap
  }

  const codeRow = document.createElement('div')
  codeRow.className = 'flex gap-2'
  codeRow.style.marginTop = '0.375rem'
  const code = document.createElement('input')
  code.type = 'password'
  code.dataset.wtsDraftCode = server.url
  code.autocomplete = 'off'
  code.className = 'input input-sm input-bordered'
  code.style.flex = '1'
  code.style.minWidth = '0'
  code.placeholder = 'Access code'
  code.setAttribute('aria-label', `Access code for ${server.info?.name ?? server.url}`)
  const submit = document.createElement('button')
  submit.className = 'btn btn-sm btn-primary'
  submit.textContent = 'Connect'

  const status = document.createElement('p')
  status.dataset.wtsDraftStatus = `server:${server.url}`
  status.className = 'text-xs opacity-60'
  status.style.marginTop = '0.25rem'
  announce(status, 'This server needs an access code from whoever runs it.')

  let checking = false
  const attempt = async (): Promise<void> => {
    if (checking) return
    const value = code.value.trim()
    if (value === '') return
    checking = true
    submit.disabled = true
    status.className = 'text-xs opacity-60'
    status.dataset.wtsStatusPending = ''
    announce(status, 'Checking…')
    const ownsAttempt = beginConnectionAttempt(server.url)
    const request = actions.panelRequest()
    const next = await probeServer(server.url, value, request.controller.signal)
    request.finish()
    checking = false
    submit.disabled = false
    delete status.dataset.wtsStatusPending
    if (request.controller.signal.aborted) return
    if (
      !ownsAttempt() ||
      getState().servers.find((candidate) => candidate.url === server.url) !== server
    )
      return
    if (next.status === 'connected') {
      upsertServer(next)
      code.value = ''
      actions.showSettings()
      return
    }
    const resultStatus = currentDraftStatus(`server:${server.url}`, status, actions)
    if (resultStatus === null) return
    // A wrong code and an unreachable server are different problems with different fixes, so they
    // must not share a message.
    resultStatus.className = 'text-xs text-error'
    announce(
      resultStatus,
      next.status === 'needs-token'
        ? 'That code was not accepted. Ask whoever runs the server for a current one.'
        : `Could not reach the server. ${next.error ?? ''}`.trim(),
      true,
    )
  }

  submit.addEventListener('click', () => void attempt())
  code.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void attempt()
  })

  codeRow.append(code, submit)
  wrap.append(codeRow, status)
  return wrap
}

export const settingsView = (actions: SettingsViewActions): HTMLElement => {
  const view = document.createElement('div')
  view.dataset.wtsSettingsScroll = ''
  Object.assign(view.style, { overflowY: 'auto', flex: '1', minHeight: '0' })

  view.appendChild(sectionHeader('Servers'))
  const addRow = document.createElement('div')
  addRow.className = 'px-3 pb-2 flex gap-2'
  const url = document.createElement('input')
  url.type = 'url'
  url.dataset.wtsDraftUrl = ''
  url.className = 'input input-sm input-bordered'
  url.style.flex = '1'
  url.style.minWidth = '0'
  url.placeholder = 'https://templates.example.org'
  url.setAttribute('aria-label', 'Template server URL')
  const add = document.createElement('button')
  add.className = 'btn btn-sm btn-primary'
  add.textContent = 'Add'
  const status = document.createElement('p')
  status.dataset.wtsDraftStatus = 'connect'
  status.className = 'text-xs px-3 pb-2'
  status.style.display = 'none'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')

  let connecting = false
  const connect = async (): Promise<void> => {
    if (connecting) return
    const value = url.value.trim()
    if (value === '') return
    let canonical: string
    try {
      canonical = canonicalServerUrl(value)
    } catch (error) {
      status.style.display = ''
      status.className = 'text-xs px-3 pb-2 text-error'
      announce(status, String(error), true)
      return
    }
    if (getState().servers.some((server) => server.url === canonical)) {
      status.style.display = ''
      status.className = 'text-xs px-3 pb-2 opacity-60'
      announce(status, 'That server is already connected.')
      return
    }
    if (getState().servers.length >= MAX_CONNECTED_SERVERS) {
      status.style.display = ''
      status.className = 'text-xs px-3 pb-2 text-error'
      announce(status, `You can connect at most ${MAX_CONNECTED_SERVERS} servers.`, true)
      return
    }
    connecting = true
    add.disabled = true
    status.style.display = ''
    status.className = 'text-xs px-3 pb-2 opacity-60'
    status.dataset.wtsStatusPending = ''
    announce(status, 'Connecting…')
    const ownsAttempt = beginConnectionAttempt(canonical)
    const request = actions.panelRequest()
    const server = await probeServer(canonical, null, request.controller.signal)
    request.finish()
    connecting = false
    add.disabled = false
    delete status.dataset.wtsStatusPending
    if (request.controller.signal.aborted) return
    if (!ownsAttempt()) return
    if (server.status === 'unreachable') {
      const resultStatus = currentDraftStatus('connect', status, actions)
      if (resultStatus === null) return
      resultStatus.style.display = ''
      resultStatus.className = 'text-xs px-3 pb-2 text-error'
      announce(
        resultStatus,
        `Could not reach ${server.url}. Check the address and that the server allows this origin.`,
        true,
      )
      return
    }
    if (!upsertServer(server)) {
      const resultStatus = currentDraftStatus('connect', status, actions)
      if (resultStatus === null) return
      resultStatus.style.display = ''
      resultStatus.className = 'text-xs px-3 pb-2 text-error'
      announce(resultStatus, `You can connect at most ${MAX_CONNECTED_SERVERS} servers.`, true)
      return
    }
    url.value = ''
    status.textContent = ''
    status.style.display = 'none'
    // Re-render so the new server's row appears — it is what carries the status badge and, when the
    // server wants one, the access-code field. Without this the panel reported "needs a code" and
    // then offered nowhere to type one.
    actions.showSettings()
  }

  add.addEventListener('click', () => void connect())
  url.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void connect()
  })
  addRow.append(url, add)
  view.appendChild(addRow)
  view.appendChild(status)

  for (const server of getState().servers) view.appendChild(serverRow(server, actions))

  view.appendChild(sectionHeader('Colours'))
  view.appendChild(coloursSection())

  view.appendChild(sectionHeader('Diagnostics'))
  const debugRow = settingRow('Debug logging', 'Verbose console output for bug reports', checkbox())
  view.appendChild(debugRow)
  return view
}
