import { encodeIndexedPng, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { allianceManifestFor, refreshAllianceManifest } from '../alliance-server-sync.js'
import { invalidateServerReads } from '../server-read-coalescer.js'
import {
  admittedServerContentsFor,
  getState,
  hasServerAdminToken,
  isCurrentServerConnection,
  listServerContents,
  serverConnectionIdentity,
  uploadTemplateVersion,
} from '../state.js'
import { captureCurrentArtwork } from '../templates/current-artwork.js'
import {
  isCurrentTemplate,
  isDeletingLocal,
  isServerTemplate,
  replaceLocalArtwork,
  templateById,
} from '../templates/local-store.js'
import { movingId } from '../templates/move.js'
import { confirmDestructive } from '../ui/confirm.js'
import { toast } from '../ui/toast.js'

const pending = new Set<string>()
const confirming = new Set<string>()

/** Whether either template menu is already capturing or saving this template. */
export const isUpdatingTemplateArtwork = (id: string): boolean => pending.has(id)

/** Save committed Wplace art as a new target version without submitting paint events. */
export const updateTemplateArtwork = async (id: string): Promise<void> => {
  if (pending.has(id)) throw new Error('This template is already being updated.')
  pending.add(id)
  try {
    const template = templateById(id)
    if (template === undefined)
      throw new Error('This template has not finished loading. Try again in a moment.')
    const surface = template.surface ?? WORLD_TEMPLATE_SURFACE
    const server = isServerTemplate(template)
      ? getState().servers.find((candidate) => candidate.url === template.serverUrl)
      : undefined
    const checkCurrent = (): void => {
      if (!isCurrentTemplate(template) || isDeletingLocal(id))
        throw new Error('That template changed during the update. Try again.')
      if (movingId() === id || (template.source === 'image' && !template.everPlaced))
        throw new Error('Finish placing this template before updating it.')
      if (!isServerTemplate(template)) return
      if (
        server === undefined ||
        !hasServerAdminToken(server) ||
        !isCurrentServerConnection(server)
      )
        throw new Error('Admin access to this server is required.')
      const manifest =
        surface.kind === 'world'
          ? admittedServerContentsFor(server)
          : allianceManifestFor(server, surface)
      const current = manifest?.templates.find(
        (candidate) => candidate.id === template.serverTemplateId,
      )
      if (current === undefined || current.version !== template.serverVersion)
        throw new Error(
          'The current template version has not finished loading. Try again in a moment.',
        )
    }
    checkCurrent()
    const indices = await captureCurrentArtwork(template)
    checkCurrent()
    if (server === undefined) {
      await replaceLocalArtwork(template, indices)
      return
    }
    const png = new Blob(
      [Uint8Array.from(await encodeIndexedPng(template.width, template.height, indices))],
      { type: 'image/png' },
    )
    checkCurrent()
    const templateId = template.serverTemplateId
    if (templateId === undefined) throw new Error('The server template is no longer available.')
    const result = await uploadTemplateVersion(server, templateId, {
      originX: template.originX,
      originY: template.originY,
      name: template.name,
      png,
    })
    if (result.ok || result.ambiguous === true) {
      invalidateServerReads(serverConnectionIdentity(server))
      // Upload uncertainty is connection-wide and cleared by an admitted world manifest.
      if (surface.kind === 'world' || !result.ok) await listServerContents(server)
      if (surface.kind !== 'world') await refreshAllianceManifest(server, surface)
    }
    if (!result.ok) throw new Error(result.message)
  } finally {
    pending.delete(id)
  }
}

/** Confirm the target change before either menu starts capturing or saving artwork. */
export const requestTemplateArtworkUpdate = (id: string, rerender: () => void): void => {
  if (confirming.has(id) || pending.has(id)) return
  const template = templateById(id)
  if (template === undefined) return
  let trigger = document.activeElement
  while (trigger?.shadowRoot?.activeElement) trigger = trigger.shadowRoot.activeElement
  confirming.add(id)
  void (async () => {
    const confirmed = await confirmDestructive({
      title: `Use canvas artwork for “${template.name}”?`,
      body: isServerTemplate(template)
        ? 'Save committed canvas artwork as the new target for everyone using this server template. Previous versions cannot currently be restored.'
        : 'Save committed canvas artwork as this local template’s new target. Previous versions cannot currently be restored.',
      note: '',
      confirmLabel: 'Use canvas artwork',
      restoreFocusTo: trigger instanceof HTMLElement ? trigger : null,
    })
    if (!confirmed) return
    if (!isCurrentTemplate(template))
      throw new Error('That template changed while confirmation was open. Try again.')
    const update = updateTemplateArtwork(id)
    rerender()
    await update
    toast('Saved a new template version from the committed artwork.')
  })()
    .catch((error: unknown) =>
      toast(error instanceof Error ? error.message : String(error), 'error'),
    )
    .finally(() => {
      confirming.delete(id)
      rerender()
    })
}
