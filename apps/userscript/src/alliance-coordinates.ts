import { templateSurfaceBounds } from '@caelestis/shared'
import type { ActiveAllianceSurface } from './alliance-surface.js'

export const allianceBounds = (active: ActiveAllianceSurface) =>
  active.surface.kind === 'alliance-headquarters'
    ? active.bounds
    : templateSurfaceBounds(active.surface)

/** Convert a pointer in the active transformed frame to its exact alliance canvas coordinate. */
export const alliancePointAt = (
  active: ActiveAllianceSurface,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null => {
  const bounds = allianceBounds(active)
  const rect = active.frame.getBoundingClientRect()
  if (
    bounds === null ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    clientX < rect.left ||
    clientX >= rect.right ||
    clientY < rect.top ||
    clientY >= rect.bottom
  )
    return null
  return {
    x: bounds.minX + ((clientX - rect.left) / rect.width) * (bounds.maxX - bounds.minX),
    y: bounds.minY + ((clientY - rect.top) / rect.height) * (bounds.maxY - bounds.minY),
  }
}
