import type { ServerTemplate } from '../server-cache.js'
import { previewOriginFor, templateById } from '../templates/local-store.js'
import { centreOf, centreOfBounds, navigateTo } from '../templates/navigate.js'
import { toast } from './toast.js'

/** Frame one manifest row even when its pixels have not reached the local catalog yet. */
export const goToServerTemplate = (bbox: ServerTemplate['bbox']): void => {
  navigateTo(centreOfBounds(bbox))
}

/** Frame the current placement of one catalog template, including its live placement preview. */
export const goToLocalTemplate = (templateId: string): void => {
  const template = templateById(templateId)
  if (template === undefined) return
  const preview = previewOriginFor(templateId)
  if (preview !== null) {
    navigateTo(centreOf({ ...template, originX: preview.x, originY: preview.y }))
    return
  }
  if (template.source === 'image' && !template.everPlaced) {
    toast(`“${template.name}” has not been placed yet.`, 'warning')
    return
  }
  navigateTo(centreOf(template))
}
