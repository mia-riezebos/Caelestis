import {
  type TemplateSurface,
  TRANSPARENT_INDEX,
  templateSurfaceBounds,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { activeAllianceSurface } from '../alliance-surface.js'
import { viewportCentre } from '../main.js'
import { claimedHiddenFor } from './colour-filter.js'
import {
  appearanceOf,
  displayTemplatesForSurface,
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

interface FocusContext {
  readonly surface: TemplateSurface
  readonly centre: { readonly x: number; readonly y: number }
}

/** Surface coordinate at the centre of the currently visible canvas, including artboard pan/zoom. */
const focusContext = (): FocusContext | null => {
  const alliance = activeAllianceSurface()
  if (alliance === null) {
    const centre = viewportCentre()
    return centre === null ? null : { surface: WORLD_TEMPLATE_SURFACE, centre }
  }
  const bounds = alliance.bounds ?? templateSurfaceBounds(alliance.surface)
  if (bounds === null) return null
  const frame = alliance.frame.getBoundingClientRect()
  const stage = alliance.stage.getBoundingClientRect()
  const visibleLeft = Math.max(frame.left, stage.left)
  const visibleTop = Math.max(frame.top, stage.top)
  const visibleRight = Math.min(frame.right, stage.right)
  const visibleBottom = Math.min(frame.bottom, stage.bottom)
  if (
    frame.width <= 0 ||
    frame.height <= 0 ||
    visibleRight <= visibleLeft ||
    visibleBottom <= visibleTop
  )
    return null
  const screenX = (visibleLeft + visibleRight) / 2
  const screenY = (visibleTop + visibleBottom) / 2
  return {
    surface: alliance.surface,
    centre: {
      x: bounds.minX + ((screenX - frame.left) / frame.width) * (bounds.maxX - bounds.minX),
      y: bounds.minY + ((screenY - frame.top) / frame.height) * (bounds.maxY - bounds.minY),
    },
  }
}

export const focusedTemplate = (options: FocusedTemplateOptions = {}): PlacedTemplate | null => {
  const context = focusContext()
  if (context === null) return null
  const { centre, surface } = context
  let containingVisible: PlacedTemplate | null = null
  let containingHidden: PlacedTemplate | null = null
  let nearestVisible: { template: PlacedTemplate; distance: number } | null = null
  for (const template of displayTemplatesForSurface(surface)) {
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
    const dx =
      surface.kind === 'world'
        ? wrappedDeltaX(centre.x, horizontalCentre(template))
        : template.originX + template.width / 2 - centre.x
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
