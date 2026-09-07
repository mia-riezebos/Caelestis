import { encodeIndexedPng, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { allianceManifestFor, refreshAllianceManifest } from '../alliance-server-sync.js'
import {
  admittedServerContentsFor,
  getState,
  isCurrentServerConnection,
  listServerContents,
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
import { toast } from '../ui/toast.js'

const pending = new Set<string>()

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
      if (server === undefined || !server.isAdmin || !isCurrentServerConnection(server))
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
    if (!result.ok) throw new Error(result.message)
    if (surface.kind === 'world') await listServerContents(server)
    else await refreshAllianceManifest(server, surface)
  } finally {
    pending.delete(id)
  }
}

/** Shared menu entry point with pending, success and recoverable failure feedback. */
export const requestTemplateArtworkUpdate = (id: string, rerender: () => void): void => {
  const update = updateTemplateArtwork(id)
  rerender()
  void update
    .then(
      () => toast('Saved a new template version from the committed artwork.'),
      (error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error'),
    )
    .finally(rerender)
}
