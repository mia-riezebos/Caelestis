import { resolve } from 'node:path'
import { FilesystemObjectStorage } from './filesystem.js'
import { S3ObjectStorage } from './s3.js'

/** Configure filesystem or generic S3 storage from the portable server's environment. */
export const nodeObjectStorage = (env: Readonly<Record<string, string | undefined>>) => {
  const adapter = env.OBJECT_STORAGE ?? 'filesystem'
  if (adapter === 'filesystem')
    return new FilesystemObjectStorage(
      env.OBJECT_DIRECTORY ?? resolve(env.DATA_DIRECTORY ?? './data', 'objects'),
    )
  if (adapter !== 's3') throw new Error(`Unsupported OBJECT_STORAGE: ${adapter}`)
  if (!env.S3_BUCKET) throw new Error('S3_BUCKET is required for S3 storage')
  if (env.S3_FORCE_PATH_STYLE !== undefined && !['true', 'false'].includes(env.S3_FORCE_PATH_STYLE))
    throw new Error('S3_FORCE_PATH_STYLE must be true or false')
  return new S3ObjectStorage(env.S3_BUCKET, {
    region: env.S3_REGION ?? env.AWS_REGION ?? 'us-east-1',
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
  })
}
