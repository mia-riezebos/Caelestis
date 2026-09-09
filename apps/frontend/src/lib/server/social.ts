import type { Manifest, ServerInfo, Template, TemplateStatus } from '@caelestis/shared'
import {
  DEFAULT_SOCIAL_IMAGE,
  SOCIAL_IMAGE_HEIGHT,
  SOCIAL_IMAGE_WIDTH,
  socialImageKey,
} from '$lib/social-image.js'

interface SocialContext {
  server: ServerInfo | null
  manifest: Manifest | null
  statuses: readonly TemplateStatus[]
}

/** Build public, crawler-readable metadata without depending on browser credentials or state. */
export const socialMetadata = async (
  url: URL,
  context: SocialContext,
  images?: Pick<NonNullable<App.Platform['env']['SOCIAL_IMAGES']>, 'head'>,
  ensureImage?: (
    template: Template,
  ) => ReturnType<NonNullable<App.Platform['env']['SOCIAL_IMAGES']>['head']>,
) => {
  const { server, manifest, statuses } = context
  const siteName = server?.name ?? 'Caelestis'
  const metadata = {
    title: siteName === 'Caelestis' ? siteName : `${siteName} · Caelestis`,
    description:
      'Follow Wplace pixel art, track template progress, and watch timelapses on Caelestis.',
    siteName,
    url: new URL(url.pathname, url.origin).href,
    image: new URL(DEFAULT_SOCIAL_IMAGE, url.origin).href,
    imageType: 'image/png',
    imageWidth: 1200,
    imageHeight: 630,
    imageAlt: 'Caelestis · Wplace templates, progress and timelapses',
  }
  const [kind, encodedId] = url.pathname.split('/').filter(Boolean)
  let id: string | undefined
  try {
    id = encodedId === undefined ? undefined : decodeURIComponent(encodedId)
  } catch {
    return metadata
  }
  if (kind === 'folder') {
    const folder = manifest?.nodes.find((node) => node.id === id)
    if (folder !== undefined) {
      metadata.title = `${folder.name} · ${siteName}`
      metadata.description =
        folder.description || `Follow the Wplace templates and painting progress in ${folder.name}.`
    }
  }
  if (kind !== 'template') return metadata
  const template = manifest?.templates.find((entry) => entry.id === id && entry.published)
  if (template === undefined || manifest === null) return metadata
  metadata.title = `${template.name} · ${siteName}`
  const status = statuses.find((entry) => entry.templateId === template.id)
  const progress =
    status === undefined || status.total === 0
      ? ''
      : ` ${Math.round((status.correct / status.total) * 100)}% painted correctly.`
  metadata.description = `${template.totalPixels.toLocaleString('en-US')} pixels on Wplace.${progress} Watch the timelapse and follow its progress.`
  const image = ensureImage
    ? await ensureImage(template)
    : await images?.head(socialImageKey(manifest.season, template))
  if (image != null) {
    const imageUrl = new URL(`/social/template/${encodeURIComponent(template.id)}.gif`, url.origin)
    imageUrl.searchParams.set('v', image.etag)
    metadata.image = imageUrl.href
    metadata.imageType = 'image/gif'
    metadata.imageWidth = SOCIAL_IMAGE_WIDTH
    metadata.imageHeight = SOCIAL_IMAGE_HEIGHT
    metadata.imageAlt = `Painting timelapse of ${template.name} on Wplace`
  }
  return metadata
}
