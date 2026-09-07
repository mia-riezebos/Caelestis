import {
  TAG_MANAGER_TAG,
  type TagManagerIntent,
  type TagManagerModel,
} from '@caelestis/ui/elements'
import { refreshAllianceManifest } from '../alliance-server-sync.js'
import { refreshServerSnapshot } from '../application/tree-server-state.js'
import {
  isCurrentServerConnection,
  listServerTags,
  mutateServerTag,
  onServerContents,
} from '../state.js'
import { mutateLocalTag, readLocalTags } from '../templates/tags.js'
import { applyWplaceTheme } from './theme.js'
import type { TreeTarget } from './tree.js'

let closeManager: (() => void) | undefined

/** Open the same tag workflow for browser-owned and server-owned templates or catalogs. */
export const openTagManager = (target: TreeTarget, rerender: () => void): void => {
  closeManager?.()
  const manager = document.createElement(TAG_MANAGER_TAG)
  const server = target.server
  const templateId =
    server === null && target.key.startsWith('local:')
      ? target.key.slice('local:'.length)
      : target.templateId
  const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  let refreshPending = false
  let model: TagManagerModel = {
    owner: server === null ? 'Local · This browser' : `${server.info?.name ?? server.url} · Server`,
    ...(templateId === undefined ? {} : { templateName: target.name }),
    tags: [],
    selected: [],
    loading: true,
    ready: false,
    busy: false,
    revision: 0,
  }
  const update = (patch: Partial<TagManagerModel>): void => {
    model = { ...model, ...patch }
    manager.model = model
  }
  const checkConnection = (): void => {
    if (server !== null && !isCurrentServerConnection(server))
      throw new Error('The server connection changed. Close and reopen tags.')
  }
  const read = async (): Promise<void> => {
    checkConnection()
    if (server === null) {
      const tags = await readLocalTags()
      update({
        tags,
        selected: tags
          .filter((tag) => templateId !== undefined && tag.templateIds.includes(templateId))
          .map((tag) => tag.id),
        ready: true,
      })
      rerender()
      return
    }
    const result = await listServerTags(server, templateId)
    checkConnection()
    if (!result.ok) throw new Error(result.message)
    update({ tags: result.tags, selected: result.selected, ready: true })
  }
  const failure = (error: unknown): string => {
    if (server !== null && navigator.onLine === false)
      return 'You are offline. Reconnect and reload tags.'
    const message = error instanceof Error ? error.message : String(error)
    return /failed to fetch|network|timed out/i.test(message)
      ? 'Could not reach the server. Check your connection and reload tags.'
      : message
  }
  const refreshTemplates = async (): Promise<void> => {
    if (server === null) return
    checkConnection()
    if (target.surface?.kind !== undefined && target.surface.kind !== 'world')
      await refreshAllianceManifest(server, target.surface)
    const result = await refreshServerSnapshot(server, rerender, true)
    if (result.status !== 'admitted')
      throw new Error('The template list could not refresh. Reload tags to retry.')
    refreshPending = false
  }
  const reload = async (): Promise<void> => {
    update({ loading: true, error: undefined })
    try {
      await read()
      if (refreshPending) await refreshTemplates()
    } catch (error) {
      update({ error: failure(error) })
    } finally {
      update({ loading: false })
    }
  }
  const unsubscribe = onServerContents((owner) => {
    if (server !== null && owner.url === server.url && !model.busy && !model.loading) void reload()
  })
  const close = (): void => {
    unsubscribe()
    manager.remove()
    if (restoreFocus?.isConnected) restoreFocus.focus()
    if (closeManager === close) closeManager = undefined
  }
  closeManager = close
  const mutate = async (
    intent: Exclude<TagManagerIntent, { type: 'close' | 'retry' }>,
  ): Promise<void> => {
    if (model.busy || model.loading || !model.ready) return
    update({ busy: true, error: undefined })
    let committed = false
    try {
      checkConnection()
      if (intent.type === 'assign' && templateId === undefined)
        throw new Error('Select a template to assign tags.')
      const mutation =
        intent.type === 'assign' ? { ...intent, templateId: templateId ?? '' } : intent
      if (server === null) await mutateLocalTag(mutation)
      else {
        const result = await mutateServerTag(server, mutation)
        if (!result.ok) throw new Error(result.message)
      }
      committed = true
      refreshPending = server !== null
      update({ revision: model.revision + 1 })
      await read()
      await refreshTemplates()
    } catch (error) {
      update({ error: `${committed ? 'Saved. ' : ''}${failure(error)}` })
    } finally {
      update({ busy: false })
      rerender()
    }
  }
  manager.model = model
  applyWplaceTheme(manager)
  manager.addEventListener('caelestis-tag-manager-intent', (event) => {
    const intent = (event as CustomEvent<TagManagerIntent>).detail
    if (intent.type === 'close') {
      close()
      return
    }
    if (intent.type === 'retry') {
      if (!model.busy && !model.loading) void reload()
      return
    }
    void mutate(intent)
  })
  document.body.appendChild(manager)
  void reload()
}
