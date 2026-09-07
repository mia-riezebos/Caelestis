import { createWorkClient, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { CaelestisWork, registerCaelestisUi } from '@caelestis/ui/elements'
import { allianceManifestFor, onAllianceManifestChange } from '../alliance-server-sync.js'
import { rowsForSurface } from '../application/tree-server-state.js'
import { requestServerTree } from '../server-transport.js'
import {
  activeServerToken,
  admittedServerContentsFor,
  isCurrentServerConnection,
  onServerContents,
  sameServerConnection,
  serverConnectionSignal,
  serverEndpoint,
} from '../state.js'
import { accountIdentity } from '../wplace-account.js'
import { applyWplaceTheme } from './theme.js'
import type { TreeTarget } from './tree.js'

let closeWork: (() => void) | null = null

/** Open scoped coordination from the tree while keeping the painting rail unchanged. */
export const openWork = (target: TreeTarget): void => {
  const server = target.server
  if (server === null || server.season === null || !isCurrentServerConnection(server)) return
  closeWork?.()
  registerCaelestisUi()
  const surface = target.surface ?? WORLD_TEMPLATE_SURFACE
  const controller = new AbortController()
  const connectionSignal = serverConnectionSignal(server)
  const client = createWorkClient(
    async (path, init) => {
      const headers = new Headers(init?.headers)
      const token = activeServerToken(server)
      if (token !== null) headers.set('authorization', `Bearer ${token}`)
      const { response, body } = await requestServerTree(serverEndpoint(server.url, path), {
        ...init,
        headers,
        signal: AbortSignal.any([controller.signal, connectionSignal]),
      })
      return Response.json(body, { status: response.status })
    },
    server.season,
    surface,
  )
  const dialog = document.createElement('dialog')
  dialog.setAttribute('aria-label', `Work · ${target.name}`)
  dialog.style.cssText =
    'position:fixed;inset:16px;margin:auto;width:min(960px,calc(100% - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:16px;border:1px solid var(--caelestis-border);border-radius:12px;background:var(--caelestis-surface);color:var(--caelestis-text);box-shadow:var(--caelestis-shadow);'
  applyWplaceTheme(dialog)
  const header = document.createElement('div')
  header.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;font:600 14px system-ui;'
  const title = document.createElement('span')
  title.textContent = target.name
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = 'Close'
  close.setAttribute('aria-label', 'Close work')
  close.style.cssText =
    'padding:6px 10px;border:1px solid var(--caelestis-border);border-radius:6px;background:var(--caelestis-surface);color:inherit;cursor:pointer;font:inherit;'
  close.onclick = () => dialog.close()
  header.append(title, close)
  const board = new CaelestisWork()
  const initial = rowsForSurface(server, surface)
  const setModel = (revision: string, rows = rowsForSurface(server, surface)): void => {
    board.model = {
      client,
      revision,
      identity: accountIdentity(),
      nodes: rows?.nodes ?? [],
      templates: rows?.templates ?? [],
      ...(target.templateId === undefined ? {} : { templateId: target.templateId }),
      ...(target.templateId !== undefined || target.nodeId === null
        ? {}
        : { nodeId: target.nodeId }),
    }
  }
  setModel('initial', initial)
  const stopWorld = onServerContents((owner, contents) => {
    if (surface.kind === 'world' && sameServerConnection(owner, server))
      setModel(contents.revision ?? '', contents)
  })
  const stopAlliance = onAllianceManifestChange(() => {
    if (surface.kind !== 'world') {
      const manifest = allianceManifestFor(server, surface)
      if (manifest !== null) setModel(manifest.version, manifest)
    }
  })
  const cleanup = (): void => {
    stopWorld()
    stopAlliance()
    connectionSignal.removeEventListener('abort', disconnect)
    controller.abort()
    dialog.remove()
    if (closeWork === disconnect) closeWork = null
  }
  const disconnect = (): void => {
    dialog.close()
    cleanup()
  }
  closeWork = disconnect
  connectionSignal.addEventListener('abort', disconnect, { once: true })
  dialog.addEventListener('close', cleanup, { once: true })
  dialog.append(header, board)
  ;(document.fullscreenElement ?? document.body).append(dialog)
  dialog.showModal()
  const current =
    surface.kind === 'world'
      ? admittedServerContentsFor(server)
      : allianceManifestFor(server, surface)
  if (current !== null) setModel('opened', current)
}
