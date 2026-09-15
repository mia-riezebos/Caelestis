import { describe, expect, it } from 'vitest'
import { FilesystemObjectStorage } from '../filesystem.js'
import { nodeObjectStorage } from '../node.js'
import { S3ObjectStorage } from '../s3.js'

describe('node storage selection', () => {
  it('uses the filesystem default and honours its directory inputs', () => {
    expect(nodeObjectStorage({})).toBeInstanceOf(FilesystemObjectStorage)
    expect(nodeObjectStorage({ OBJECT_DIRECTORY: '/tmp/objects' })).toMatchObject({
      root: '/tmp/objects',
    })
  })

  it('constructs S3 with validated environment settings', () => {
    const storage = nodeObjectStorage({
      OBJECT_STORAGE: 's3',
      S3_BUCKET: 'bucket',
      S3_REGION: 'eu-west-1',
      S3_FORCE_PATH_STYLE: 'true',
    })
    expect(storage).toBeInstanceOf(S3ObjectStorage)
    expect(() => nodeObjectStorage({ OBJECT_STORAGE: 's3' })).toThrow('S3_BUCKET')
    expect(() =>
      nodeObjectStorage({ OBJECT_STORAGE: 's3', S3_BUCKET: 'bucket', S3_FORCE_PATH_STYLE: 'yes' }),
    ).toThrow('S3_FORCE_PATH_STYLE')
    expect(() => nodeObjectStorage({ OBJECT_STORAGE: 'unknown' })).toThrow('Unsupported')
    ;(storage as S3ObjectStorage).close()
  })
})
