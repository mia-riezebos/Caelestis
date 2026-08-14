import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('wplace account state', () => {
  it('notifies an already-rendered consumer when owned colours arrive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ extraColorsBitmap: 1 }), { status: 200 })),
      ),
    )
    const { ownedColours, refreshAccount } = await import('./wplace-account.js')
    const changed = vi.fn()
    refreshAccount(changed)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())

    expect(ownedColours()?.size).toBe(1)
  })

  it('isolates a throwing ownership observer from later listeners', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ extraColorsBitmap: 1 }), { status: 200 })),
      ),
    )
    const { ownedColours, refreshAccount } = await import('./wplace-account.js')
    refreshAccount(() => {
      throw new Error('broken observer')
    })
    await vi.waitFor(() => expect(ownedColours()?.size).toBe(1))
  })

  it('times out a stuck account request and allows a later retry', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            })
          }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ extraColorsBitmap: 1 }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { loadAccount, ownedColours } = await import('./wplace-account.js')

    const first = loadAccount()
    await vi.advanceTimersByTimeAsync(10_000)
    await first
    expect(ownedColours()).toBeNull()

    await loadAccount()
    expect(fetchMock).toHaveBeenCalledOnce()
    await loadAccount(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(ownedColours()?.size).toBe(1)
  })

  it('rejects oversized and non-integral account bitmaps', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{}', { headers: { 'content-length': String(16 * 1024 + 1) } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ extraColorsBitmap: 1.5 }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { loadAccount, ownedColours } = await import('./wplace-account.js')

    await loadAccount()
    await loadAccount(0)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(ownedColours()).toBeNull()
  })

  it('negative-caches an unavailable account instead of refetching on every settings render', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const { loadAccount } = await import('./wplace-account.js')

    await loadAccount()
    await loadAccount()

    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('clears the previous account when the session becomes unauthorised', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ extraColorsBitmap: 1 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const { loadAccount, ownedColours } = await import('./wplace-account.js')

    await loadAccount()
    expect(ownedColours()?.size).toBe(1)
    await loadAccount(0)

    expect(ownedColours()).toBeNull()
  })
})
