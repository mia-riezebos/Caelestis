import { viewportCentre } from '../main.js'
import { displayTemplates, isTemplateVisible, type PlacedTemplate } from './local-store.js'
import { horizontalCentre, sourceXAt, wrappedDeltaX } from './placement.js'

/**
 * Which template a keybind means.
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
 * Hidden templates are not candidates. Toggling something invisible looks exactly like the key not
 * working, and the visible one behind it is what was meant.
 *
 * This is deliberately its own module: every keybind that acts on "the template I am looking at"
 * has to answer the same question, and they must all answer it identically — a rule that differs
 * between two shortcuts is worse than either rule alone.
 */
export const templateAtCentre = (): PlacedTemplate | null => {
  const centre = viewportCentre()
  if (centre === null) return null
  let containing: PlacedTemplate | null = null
  let best: { template: PlacedTemplate; distance: number } | null = null
  for (const template of displayTemplates()) {
    if (!isTemplateVisible(template)) continue
    if (
      sourceXAt(template, centre.x) !== null &&
      centre.y >= template.originY &&
      centre.y < template.originY + template.height
    )
      containing = template
    const dx = wrappedDeltaX(centre.x, horizontalCentre(template))
    const dy = template.originY + template.height / 2 - centre.y
    // Squared, because only the ordering matters and a square root per template does not change it.
    const distance = dx * dx + dy * dy
    if (best === null || distance < best.distance) best = { template, distance }
  }
  return containing ?? best?.template ?? null
}
