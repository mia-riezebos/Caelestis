import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import {
  type ObjectInfo,
  type ObjectStorage,
  type PutOptions,
  validateObjectKey,
  validateObjectPage,
} from './index.js'

const status = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) return undefined
  const metadata = error.$metadata
  return typeof metadata === 'object' &&
    metadata !== null &&
    'httpStatusCode' in metadata &&
    typeof metadata.httpStatusCode === 'number'
    ? metadata.httpStatusCode
    : undefined
}

const info = (
  object: Pick<
    HeadObjectCommandOutput,
    'ContentLength' | 'ETag' | 'LastModified' | 'ContentType' | 'Metadata'
  >,
): ObjectInfo => {
  if (
    object.ContentLength === undefined ||
    object.ETag === undefined ||
    object.LastModified === undefined
  )
    throw new Error('S3 response is missing object metadata')
  return {
    size: object.ContentLength,
    etag: object.ETag.replace(/^"|"$/g, ''),
    uploadedAt: object.LastModified.getTime(),
    metadata:
      object.Metadata?.caelestis === undefined
        ? {}
        : (JSON.parse(
            Buffer.from(object.Metadata.caelestis, 'base64url').toString('utf8'),
          ) as Record<string, string>),
    ...(object.ContentType === undefined ? {} : { contentType: object.ContentType }),
  }
}

/** S3-compatible endpoints use standard object operations and conditional PUT, without provider SDKs. */
export class S3ObjectStorage implements ObjectStorage {
  readonly client: S3Client
  constructor(
    readonly bucket: string,
    config: S3ClientConfig,
  ) {
    this.client = new S3Client(config)
  }

  async head(key: string): Promise<ObjectInfo | null> {
    validateObjectKey(key)
    try {
      return info(await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })))
    } catch (error) {
      if (status(error) === 404) return null
      throw error
    }
  }
  async get(key: string) {
    validateObjectKey(key)
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      if (object.Body === undefined) throw new Error('S3 response is missing object bytes')
      return { ...info(object), bytes: await object.Body.transformToByteArray() }
    } catch (error) {
      if (status(error) === 404) return null
      throw error
    }
  }
  async put(key: string, bytes: Uint8Array, options: PutOptions = {}) {
    validateObjectKey(key)
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ...(options.ifAbsent ? { IfNoneMatch: '*' } : {}),
          ...(options.contentType === undefined ? {} : { ContentType: options.contentType }),
          Metadata: {
            caelestis: Buffer.from(JSON.stringify(options.metadata ?? {})).toString('base64url'),
          },
        }),
      )
      const stored = await this.head(key)
      if (stored === null) throw new Error('S3 object disappeared after upload')
      return stored
    } catch (error) {
      if (options.ifAbsent && status(error) === 412) return null
      throw error
    }
  }
  async delete(keys: readonly string[]) {
    keys.forEach(validateObjectKey)
    const unique = [...new Set(keys)]
    for (let start = 0; start < unique.length; start += 1000) {
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: unique.slice(start, start + 1000).map((Key) => ({ Key })) },
        }),
      )
      if (result.Errors?.length)
        throw new Error(
          `S3 failed to delete ${result.Errors.length} objects: ${result.Errors.map((error) => error.Code).join(', ')}`,
        )
    }
  }
  async list(prefix: string, options: { cursor?: string; limit: number }) {
    validateObjectPage(prefix, options.limit)
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: options.limit,
        ...(options.cursor === undefined ? {} : { ContinuationToken: options.cursor }),
      }),
    )
    return {
      keys: (result.Contents ?? []).flatMap((object) =>
        object.Key === undefined ? [] : [object.Key],
      ),
      ...(result.IsTruncated && result.NextContinuationToken !== undefined
        ? { cursor: result.NextContinuationToken }
        : {}),
    }
  }
  close(): void {
    this.client.destroy()
  }
}
