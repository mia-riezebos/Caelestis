import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { viewportCentre } from '../main.js'
import { claimedHiddenFor } from './colour-filter.js'
import {
  appearanceOf,
  displayTemplates,
  isTemplateVisible,
  type PlacedTemplate,
} from './local-store.js'
import { horizontalCentre, sourceXAt, wrappedDeltaX } from './placement.js'

/**
 * Which template a template-local action means.
 *
 * A shortcut has no target. The pointer is busy painting, the panel may be shut, and nothing is
 * selected — so a key that acts on *a* template has to decide which one, and the only thing it has
 * to go on is what is being looked at. The middle of the viewport is that: it is where the eye is,
 * it is where wplace centres what you navigate to, and it needs no extra state to exist.
 *
 * Containment comes first. A large template can cover the point being looked at while its geometric
 * centre is thousands of pixels away; choosing only by centre distance then lets a small, unrelated
 * template steal focus from underneath the crosshair. When templates overlap, the last one in draw
 * order wins, matching the colour picker and the pixels actually visible on top.
 *
 * Nearest-centre distance remains the fallback when the viewport centre lands in a genuine gap, so
 * keyboard shortcuts do not become inert between adjacent templates.
 *
 * Hidden templates are excluded by default. One action may opt into a narrow exception: visibility
 * can restore the topmost hidden template that actually contains the crosshair when no visible
 * template contains it. Hidden templates never participate in nearest-distance fallback, so hiding
 * something in a gap cannot make every other template-local action silently change targets.
 *
 * This is deliberately its own module: every keybind that acts on "the template I am looking at"
 * has to answer the same question, and they must all answer it identically — a rule that differs
 * between two shortcuts is worse than either rule alone.
 */
export interface FocusedTemplateOptions {
  /** Restore a hidden template under the crosshair before falling back to a nearby visible one. */
  readonly restoreHiddenAtCentre?: boolean
}

export const focusedTemplate = (options: FocusedTemplateOptions = {}): PlacedTemplate | null => {
  const centre = viewportCentre()
  if (centre === null) return null
  let containingVisible: PlacedTemplate | null = null
  let containingHidden: PlacedTemplate | null = null
  let nearestVisible: { template: PlacedTemplate; distance: number } | null = null
  for (const template of displayTemplates()) {
    const visible = isTemplateVisible(template)
    const sourceX = sourceXAt(template, centre.x)
    const sourceY = centre.y - template.originY
    const cellX = sourceX === null ? -1 : Math.floor(sourceX)
    const cellY = Math.floor(sourceY)
    const centreIndex =
      sourceX !== null && sourceY >= 0 && sourceY < template.height
        ? template.indices[cellY * template.width + cellX]
        : undefined
    const containsClaimedPixel =
      centreIndex !== undefined &&
      centreIndex !== TRANSPARENT_INDEX &&
      !claimedHiddenFor(appearanceOf(template)).includes(centreIndex)
    if (containsClaimedPixel) {
      if (visible) containingVisible = template
      else if (!template.visible) containingHidden = template
    }
    if (!visible) continue
    const dx = wrappedDeltaX(centre.x, horizontalCentre(template))
    const dy = template.originY + template.height / 2 - centre.y
    // Squared, because only the ordering matters and a square root per template does not change it.
    const distance = dx * dx + dy * dy
    if (nearestVisible === null || distance < nearestVisible.distance)
      nearestVisible = { template, distance }
  }
  return (
    containingVisible ??
    (options.restoreHiddenAtCentre ? containingHidden : null) ??
    nearestVisible?.template ??
    null
  )
}
