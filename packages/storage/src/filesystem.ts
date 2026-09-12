import { createHash, randomUUID } from 'node:crypto'
import {
  type FileHandle,
  link,
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import {
  type ObjectInfo,
  type ObjectStorage,
  type PutOptions,
  validateObjectKey,
  validateObjectPage,
} from './index.js'

const MAGIC = Buffer.from('CAELOB1\n')
const HEADER_BYTES = MAGIC.length + 4
const MAX_METADATA_BYTES = 1024 * 1024
const SUFFIX = '.object'
const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'
const compareKeys = (left: string, right: string) =>
  Buffer.compare(Buffer.from(left), Buffer.from(right))

const syncDirectory = async (directory: string) => {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const readExactly = async (handle: FileHandle, bytes: Buffer): Promise<void> => {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
    if (bytesRead === 0) throw new Error('Truncated filesystem object')
    offset += bytesRead
  }
}

const metadataSize = (prefix: Buffer): number => {
  if (prefix.length < HEADER_BYTES || !prefix.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error('Unsupported or corrupt filesystem object')
  const size = prefix.readUInt32BE(MAGIC.length)
  if (size > MAX_METADATA_BYTES) throw new Error('Filesystem object metadata is too large')
  return size
}

/** Objects are atomic files containing a versioned metadata header followed by the original bytes. */
export class FilesystemObjectStorage implements ObjectStorage {
  readonly root: string
  constructor(directory: string) {
    this.root = resolve(directory)
  }

  private filename(key: string): string {
    validateObjectKey(key)
    return join(this.root, `${key}${SUFFIX}`)
  }

  private async prepareDirectory(directory: string): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await syncDirectory(dirname(this.root))
    let parent = this.root
    for (const segment of relative(this.root, directory).split('/').filter(Boolean)) {
      const child = join(parent, segment)
      await mkdir(child, { recursive: true, mode: 0o700 })
      await syncDirectory(parent)
      parent = child
    }
  }

  private decode(bytes: Buffer): { info: ObjectInfo; offset: number } {
    const offset = HEADER_BYTES + metadataSize(bytes)
    if (offset > bytes.length) throw new Error('Truncated filesystem object')
    return {
      info: JSON.parse(bytes.subarray(HEADER_BYTES, offset).toString('utf8')) as ObjectInfo,
      offset,
    }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const handle = await open(this.filename(key), 'r')
      try {
        const prefix = Buffer.alloc(HEADER_BYTES)
        await readExactly(handle, prefix)
        const size = metadataSize(prefix)
        const header = Buffer.alloc(HEADER_BYTES + size)
        await readExactly(handle, header)
        return this.decode(header).info
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async get(key: string) {
    try {
      const file = await readFile(this.filename(key))
      const { info, offset } = this.decode(file)
      const bytes = new Uint8Array(file.subarray(offset))
      if (bytes.byteLength !== info.size) throw new Error('Truncated filesystem object')
      return { ...info, bytes }
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async put(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<ObjectInfo | null> {
    const filename = this.filename(key)
    await this.prepareDirectory(dirname(filename))
    const temporary = `${filename}.${randomUUID()}.tmp`
    const info: ObjectInfo = {
      size: bytes.byteLength,
      etag: createHash('sha256').update(bytes).digest('hex'),
      uploadedAt: Date.now(),
      metadata: options.metadata ?? {},
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    }
    const metadata = Buffer.from(JSON.stringify(info))
    if (metadata.length > MAX_METADATA_BYTES)
      throw new Error('Filesystem object metadata is too large')
    const prefix = Buffer.alloc(HEADER_BYTES)
    MAGIC.copy(prefix)
    prefix.writeUInt32BE(metadata.byteLength, MAGIC.length)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(Buffer.concat([prefix, metadata, bytes]))
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (options.ifAbsent) await link(temporary, filename)
      else await rename(temporary, filename)
      await syncDirectory(dirname(filename))
      return info
    } catch (error) {
      if (options.ifAbsent && error instanceof Error && 'code' in error && error.code === 'EEXIST')
        return null
      throw error
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async delete(keys: readonly string[]): Promise<void> {
    const directories = new Set<string>()
    for (const key of new Set(keys)) {
      const filename = this.filename(key)
      try {
        await unlink(filename)
        directories.add(dirname(filename))
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    for (const directory of directories) await syncDirectory(directory)
  }

  async list(prefix: string, options: { cursor?: string; limit: number }) {
    validateObjectPage(prefix, options.limit)
    const keys: string[] = []
    let more = false
    const visit = async (directory: string): Promise<void> => {
      let entries: Awaited<ReturnType<typeof opendir>>
      try {
        entries = await opendir(directory)
      } catch (error) {
        if (isMissing(error)) return
        throw error
      }
      for await (const entry of entries) {
        const filename = join(directory, entry.name)
        if (entry.isDirectory()) {
          await visit(filename)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith(SUFFIX)) continue
        const key = relative(this.root, filename).slice(0, -SUFFIX.length)
        if (
          !key.startsWith(prefix) ||
          (options.cursor !== undefined && compareKeys(key, options.cursor) <= 0)
        )
          continue
        if (keys.length === options.limit && compareKeys(key, keys[keys.length - 1] ?? '') >= 0) {
          more = true
          continue
        }
        keys.push(key)
        keys.sort(compareKeys)
        if (keys.length > options.limit) {
          keys.pop()
          more = true
        }
      }
    }
    await visit(this.root)
    return { keys, ...(more ? { cursor: keys[keys.length - 1] } : {}) }
  }
}
