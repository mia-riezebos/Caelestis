import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { workerData } from 'node:worker_threads'
import { nodeObjectStorage } from '@caelestis/storage/node'
import { S3ObjectStorage } from '@caelestis/storage/s3'

const storage = nodeObjectStorage(process.env)
const options: { site: string; output: string } = workerData
try {
  const social: {
    buildSocialImages(options: {
      site: string
      output: string
      storage: typeof storage
      publish: boolean
    }): Promise<void>
  } = await import(pathToFileURL(resolve('scripts/social-images.mjs')).href)
  await social.buildSocialImages({ ...options, publish: true, storage })
} finally {
  if (storage instanceof S3ObjectStorage) storage.close()
}
