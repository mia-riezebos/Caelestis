import type { Template } from '@caelestis/shared'

export const SOCIAL_IMAGE_WIDTH = 640
export const SOCIAL_IMAGE_HEIGHT = 360
export const DEFAULT_SOCIAL_IMAGE = '/social/site.png'

/** Keep one replaceable preview per template and season, including across artwork updates. */
export const socialImageKey = (
  season: number,
  template: Pick<Template, 'id'>,
): string =>
  `social/v2/${season}/${encodeURIComponent(template.id)}.gif`
