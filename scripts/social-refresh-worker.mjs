import { workerData } from 'node:worker_threads'
import { nodeObjectStorage } from '../packages/storage/dist/node.js'
import { S3ObjectStorage } from '../packages/storage/dist/s3.js'
import { buildSocialImages } from './social-images.mjs'

const storage = nodeObjectStorage(process.env)
try {
  await buildSocialImages({ ...workerData, publish: true, storage })
} finally {
  if (storage instanceof S3ObjectStorage) storage.close()
}
