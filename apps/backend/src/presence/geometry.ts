import {
  type PresenceRect,
  type TemplateSurface,
  templateSurfaceBounds,
  WORLD_PIXELS,
} from '@caelestis/shared'

/** World coordinates use the shared canvas limit; alliance bounds are surface-specific. */
export const presenceRectWithinSurface = (
  rect: PresenceRect,
  surface: TemplateSurface,
): boolean => {
  const bounds = templateSurfaceBounds(surface) ?? {
    minX: 0,
    minY: 0,
    maxX: WORLD_PIXELS,
    maxY: WORLD_PIXELS,
  }
  return (
    rect.x >= bounds.minX &&
    rect.y >= bounds.minY &&
    rect.x + rect.w <= bounds.maxX &&
    rect.y + rect.h <= bounds.maxY
  )
}
