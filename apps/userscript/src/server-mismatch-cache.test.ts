// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

const deferred = (): Deferred => {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

afterEach(() => vi.unstubAllGlobals())

describe('persisted server mismatch ordering', () => {
  it('deletes an old write before a later read can observe it', async () => {
    const events: string[] = []
    const stored = new Map<string, Response>()
    const put = deferred()
    const cache = {
      async delete(request: Request): Promise<boolean> {
        events.push('delete')
        return stored.delete(request.url)
      },
      async keys(): Promise<readonly Request[]> {
        events.push('keys')
        return [...stored.keys()].map((url) => new Request(url))
      },
      async match(request: Request): Promise<Response | undefined> {
        events.push('match')
        return stored.get(request.url)
      },
      async put(request: Request, response: Response): Promise<void> {
        events.push('put:start')
        await put.promise
        stored.set(request.url, response)
        events.push('put:end')
      },
    } as unknown as Cache
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) })
    const { deleteCachedServerMismatchTile, readCachedServerMismatch, writeCachedServerMismatch } =
      await import('./server-mismatch-cache.js')
    const serverUrl = 'https://templates.example'
    const key = `${serverUrl}\u0000server\u00000\u0000template\u0000version\u00003/4`
    const write = writeCachedServerMismatch(key, new Uint8Array([1]))
    await vi.waitFor(() => expect(events).toContain('put:start'))

    const invalidation = deleteCachedServerMismatchTile(serverUrl, { x: 3, y: 4 })
    const read = readCachedServerMismatch(key)
    expect(events).not.toContain('keys')
    expect(events).not.toContain('match')

    put.resolve()
    await expect(Promise.all([write, invalidation, read])).resolves.toEqual([
      undefined,
      undefined,
      null,
    ])
    expect(events).toEqual(['delete', 'put:start', 'put:end', 'keys', 'delete', 'match'])
  })

  it('waits for old writes before deleting every mask for a server', async () => {
    const events: string[] = []
    const stored = new Map<string, Response>()
    const put = deferred()
    const cache = {
      async delete(request: Request): Promise<boolean> {
        events.push('delete')
        return stored.delete(request.url)
      },
      async keys(): Promise<readonly Request[]> {
        events.push('keys')
        return [...stored.keys()].map((url) => new Request(url))
      },
      async put(request: Request, response: Response): Promise<void> {
        events.push('put:start')
        await put.promise
        stored.set(request.url, response)
        events.push('put:end')
      },
    } as unknown as Cache
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) })
    const { deleteCachedServerMismatches, writeCachedServerMismatch } = await import(
      './server-mismatch-cache.js'
    )
    const serverUrl = 'https://templates.example'
    const key = `${serverUrl}\u0000server\u00000\u0000template\u0000version\u00003/4`
    const write = writeCachedServerMismatch(key, new Uint8Array([1]))
    await vi.waitFor(() => expect(events).toContain('put:start'))

    const invalidation = deleteCachedServerMismatches(serverUrl)
    expect(events).not.toContain('keys')

    put.resolve()
    await expect(Promise.all([write, invalidation])).resolves.toEqual([undefined, undefined])
    expect(stored).toHaveLength(0)
    expect(events).toEqual(['delete', 'put:start', 'put:end', 'keys', 'delete'])
  })
})
