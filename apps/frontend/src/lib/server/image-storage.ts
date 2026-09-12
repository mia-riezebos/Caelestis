import type { ObjectStorage } from '@caelestis/storage'
import { R2ObjectStorage } from '@caelestis/storage/r2'

/** Resolve image storage once at the hosting adapter, keeping routes provider-independent. */
export const imageStorageFor = (event: {
  locals?: App.Locals
  platform?: App.Platform
}): ObjectStorage | undefined => {
  if (event.locals?.objectStorage !== undefined) return event.locals.objectStorage
  const bucket = event.platform?.env.SOCIAL_IMAGES
  return bucket === undefined ? undefined : new R2ObjectStorage(bucket)
}
