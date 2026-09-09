import type { Template } from '@caelestis/shared'

export const SOCIAL_IMAGE_WIDTH = 640
export const SOCIAL_IMAGE_HEIGHT = 360
export const DEFAULT_SOCIAL_IMAGE = '/social/site.png'

/** Keep one replaceable preview per season and artwork version. */
export const socialImageKey = (
  season: number,
  template: Pick<Template, 'id' | 'version'>,
): string =>
  `social/v1/${season}/${encodeURIComponent(template.id)}/${encodeURIComponent(template.version)}.gif`
