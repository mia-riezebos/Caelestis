import type { ConnectedServer } from '../state.js'
import { isCurrentServerConnection, uploadTemplate } from '../state.js'
import type { ImportedTemplate } from '../templates/import.js'
import {
  addLocalTemplate,
  isCurrentTemplate,
  removeLocalTemplate,
  templateAsPng,
  templateById,
} from '../templates/local-store.js'
import type { MoveReservation } from '../templates/move.js'
import { movingId } from '../templates/move.js'
import { toast } from './toast.js'

type RefreshServer = (server: ConnectedServer, rerender: () => void) => Promise<void>

const uploadAdmitted = async (
  server: ConnectedServer,
  nodeId: string | null,
  templateIds: readonly string[],
  rerender: () => void,
  refreshServer: RefreshServer,
): Promise<void> => {
  let uploaded = 0
  const failures: string[] = []

  for (const templateId of templateIds) {
    const template = templateById(templateId)
    if (template === undefined) continue
    if (movingId() === template.id) {
      failures.push(`${template.name}: placement is still open`)
      continue
    }

    const png = await templateAsPng(template)
    if (png === null) {
      failures.push(`${template.name}: could not encode the template`)
      continue
    }
    if (!isCurrentTemplate(template) || movingId() === template.id) {
      failures.push(`${template.name}: changed while it was being encoded`)
      continue
    }
    if (!isCurrentServerConnection(server)) {
      failures.push(`${template.name}: the server connection changed`)
      continue
    }

    const result = await uploadTemplate(server, {
      nodeId,
      name: template.name,
      originX: template.originX,
      originY: template.originY,
      png,
    })
    if (!result.ok) {
      failures.push(`${template.name}: ${result.message}`)
      continue
    }

    uploaded++
    if (!(await removeLocalTemplate(template.id))) {
      failures.push(`${template.name}: uploaded, but its temporary Local copy could not be removed`)
    }
  }

  if (uploaded > 0) await refreshServer(server, rerender)
  rerender()

  const serverName = server.info?.name ?? server.url
  if (uploaded > 0) {
    toast(
      uploaded === 1
        ? `Imported template into ${serverName}.`
        : `Imported ${uploaded} templates into ${serverName}.`,
    )
  }
  if (failures.length > 0) {
    toast(`Kept in Local: ${failures.join('. ')}`, 'error')
  }
}

/** Stage file imports locally only long enough to place and upload them to their chosen server. */
export const importTemplatesToServer = async (
  imported: readonly ImportedTemplate[],
  server: ConnectedServer,
  nodeId: string | null,
  reservation: MoveReservation | null,
  rerender: () => void,
  refreshServer: RefreshServer,
): Promise<void> => {
  if (!server.isAdmin) {
    reservation?.release()
    toast('This server needs an admin code before it can accept templates.', 'warning')
    return
  }

  const first = imported[0]
  if (first === undefined) {
    reservation?.release()
    return
  }
  if (first.source === 'image' && reservation === null) {
    toast('Finish the current placement, then import this image again.', 'warning')
    return
  }

  const admitted: string[] = []
  const failures: string[] = []
  try {
    for (const template of imported) {
      try {
        await addLocalTemplate(template)
        admitted.push(template.id)
      } catch (error) {
        failures.push(`${template.name}: ${String(error)}`)
      }
    }
    rerender()
    if (failures.length > 0) toast(failures.join('. '), 'error')
    if (!admitted.includes(first.id)) return

    if (first.source === 'image') {
      const started = reservation?.start(first.id, () => {
        rerender()
        void uploadAdmitted(server, nodeId, admitted, rerender, refreshServer)
      })
      if (started !== true) {
        for (const templateId of admitted) await removeLocalTemplate(templateId)
        rerender()
        toast('Another placement started. Import the image again when it is finished.', 'warning')
        return
      }
      toast(`Place “${first.name}”, then Apply to upload it.`)
      return
    }

    await uploadAdmitted(server, nodeId, admitted, rerender, refreshServer)
  } finally {
    reservation?.release()
  }
}
