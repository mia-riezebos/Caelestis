import {
  createWorkClient,
  isWorkIdentity,
  type TemplateSurface,
  WORLD_TEMPLATE_SURFACE,
  type WorkCollection,
} from '@caelestis/shared'
import type { PanelModel } from '@caelestis/ui/elements'
import { CaelestisWork, registerCaelestisUi } from '@caelestis/ui/elements'
import { allianceManifestFor, onAllianceManifestChange } from '../alliance-server-sync.js'
import { rowsForSurface } from '../application/tree-server-state.js'
import { requestServerTree } from '../server-transport.js'
import {
  activeServerToken,
  admittedServerContentsFor,
  type ConnectedServer,
  getState,
  isCurrentServerConnection,
  onServerContents,
  sameServerConnection,
  serverConnectionSignal,
  serverEndpoint,
} from '../state.js'
import { accountIdentity } from '../wplace-account.js'
import { applyWplaceTheme } from './theme.js'
import { toast } from './toast.js'
import type { TreeTarget } from './tree.js'

let closeWork: (() => void) | null = null

const workClient = (
  server: ConnectedServer,
  season: number,
  surface: TemplateSurface,
  signal: AbortSignal,
) =>
  createWorkClient(
    async (path, init) => {
      const headers = new Headers(init?.headers)
      const token = activeServerToken(server)
      if (token !== null) headers.set('authorization', `Bearer ${token}`)
      const { response, body } = await requestServerTree(serverEndpoint(server.url, path), {
        ...init,
        headers,
        signal,
      })
      return Response.json(body, { status: response.status })
    },
    season,
    surface,
  )

interface WorkPreview {
  readonly signal: AbortSignal
  revision: string
  collection: WorkCollection
  error: string
}
const previews = new Map<string, WorkPreview>()
const previewKey = (server: ConnectedServer, surface: TemplateSurface): string =>
  `${server.url}:${server.season}:${surface.kind}:${surface.allianceId}`

/** List active work below the tree, refreshed only when the admitted server revision changes. */
export const workSectionModel = (
  surface: TemplateSurface,
  changed: () => void,
): NonNullable<PanelModel['work']> =>
  getState().servers.flatMap((server) => {
    const contents =
      surface.kind === 'world'
        ? admittedServerContentsFor(server)
        : allianceManifestFor(server, surface)
    if (server.season === null || contents === null || contents.workRevision === undefined)
      return []
    const key = previewKey(server, surface)
    const signal = serverConnectionSignal(server)
    const revision = String(contents.workRevision ?? 0)
    let preview = previews.get(key)
    if (preview?.signal !== signal) {
      preview = {
        signal,
        revision: '',
        collection: { items: [], canPlan: false, canClaim: false },
        error: '',
      }
      previews.set(key, preview)
      signal.addEventListener(
        'abort',
        () => {
          if (previews.get(key)?.signal === signal) previews.delete(key)
        },
        { once: true },
      )
    }
    if (preview.revision !== revision) {
      preview.revision = revision
      const held = preview
      void workClient(server, server.season, surface, signal)
        .list()
        .then(
          (collection) => {
            if (signal.aborted || held.revision !== revision) return
            held.collection = collection
            held.error = ''
            changed()
          },
          (error: unknown) => {
            if (signal.aborted || held.revision !== revision) return
            held.error = error instanceof Error ? error.message : String(error)
            changed()
          },
        )
    }
    return [
      {
        key: server.url,
        name: server.info?.name ?? server.url,
        error: preview.error,
        items: preview.collection.items
          .filter((item) => item.status !== 'completed')
          .map((item) => ({
            id: item.id,
            title: item.title,
            status: item.status,
            claimant:
              item.claimant === null
                ? 'Unclaimed'
                : `${item.claimant.displayName} #${item.claimant.wplaceUserId}`,
          })),
      },
    ]
  })

/** Open a work row from the panel's server-scoped list. */
export const openPanelWork = (url: string, surface: TemplateSurface, itemId?: string): void => {
  const server = getState().servers.find((candidate) => candidate.url === url)
  if (server === undefined) return
  openWork(
    { key: url, name: server.info?.name ?? server.url, server, nodeId: null, surface },
    itemId,
  )
}

/** Claim a published template directly, creating its shared work record atomically when needed. */
export const claimTemplate = async (target: TreeTarget, changed: () => void): Promise<void> => {
  const server = target.server
  if (
    server === null ||
    server.season === null ||
    target.templateId === undefined ||
    !isCurrentServerConnection(server)
  )
    return
  const actor = accountIdentity()
  if (!isWorkIdentity(actor)) {
    toast('Sign in to Wplace before claiming a template.', 'warning')
    return
  }
  const surface = target.surface ?? WORLD_TEMPLATE_SURFACE
  const signal = serverConnectionSignal(server)
  const client = workClient(server, server.season, surface, signal)
  try {
    const collection = await client.list()
    if (signal.aborted) return
    const item = collection.items.find((candidate) => candidate.id === target.templateId)
    await client.mutate(target.templateId, {
      action: 'claim-template',
      actor,
      expectedRevision: item?.revision ?? 0,
    })
    if (signal.aborted) return
    const preview = previews.get(previewKey(server, surface))
    if (preview !== undefined) preview.revision = ''
    changed()
    toast(`Claimed “${target.name}”.`)
  } catch (error) {
    if (!signal.aborted) toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/** Open scoped coordination from the tree while keeping the painting rail unchanged. */
export const openWork = (target: TreeTarget, itemId?: string): void => {
  const server = target.server
  if (server === null || server.season === null || !isCurrentServerConnection(server)) return
  closeWork?.()
  registerCaelestisUi()
  const surface = target.surface ?? WORLD_TEMPLATE_SURFACE
  const controller = new AbortController()
  const connectionSignal = serverConnectionSignal(server)
  const client = workClient(
    server,
    server.season,
    surface,
    AbortSignal.any([controller.signal, connectionSignal]),
  )
  const dialog = document.createElement('dialog')
  dialog.setAttribute('aria-label', `Work · ${target.name}`)
  dialog.style.cssText =
    'box-sizing:border-box;position:fixed;inset:16px;margin:auto;width:min(960px,calc(100% - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:16px;border:1px solid var(--caelestis-border);border-radius:12px;background:var(--caelestis-surface);color:var(--caelestis-text);box-shadow:var(--caelestis-shadow);'
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
      ...(itemId === undefined ? {} : { itemId }),
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
