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
    const { loadAccount, onAccountChange, ownedColours } = await import('./wplace-account.js')
    const changed = vi.fn()
    onAccountChange(changed)

    await loadAccount()

    expect(changed).toHaveBeenCalledOnce()
    expect(ownedColours()?.size).toBe(1)
  })
})
