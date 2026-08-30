// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  current: { servers: [] as object[] },
  listener: null as null | (() => void),
}))

vi.mock('./state.js', () => ({
  getState: () => state.current,
  isCurrentServerConnection: (server: object) => state.current.servers.includes(server),
  serverConnectionIdentity: (server: object) => server,
  onStateChange: (listener: () => void) => {
    state.listener = listener
    return () => undefined
  },
}))

const server = {
  url: 'https://example.test',
  info: { id: 'server', name: 'Example', auth: 'none' as const },
  token: null,
  status: 'connected' as const,
  isAdmin: false,
  season: 0,
}

const setVisibility = (value: 'visible' | 'hidden'): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value })
}

const setOnline = (value: boolean): void => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value })
}

describe('server sync coordinator', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    state.current = { servers: [server] }
    state.listener = null
    setVisibility('visible')
    setOnline(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('backs an unchanged compatibility resource off to at least five minutes', async () => {
    const { adaptiveServerSyncDelay, installServerSyncCoordinator, registerServerSyncResource } =
      await import('./server-sync-coordinator.js')
    const refresh = vi.fn(async () => ({ status: 'unchanged' as const, revision: 'v1' }))
    registerServerSyncResource({ id: 'manifest', scope: () => 'world', refresh })
    installServerSyncCoordinator()

    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(refresh).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(240_000)
    expect(refresh).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(299_999)
    expect(refresh).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(5)
    expect(adaptiveServerSyncDelay(3, 0)).toBe(300_000)
  })

  it('pauses while hidden or offline and coalesces recovery events into one sweep', async () => {
    setVisibility('hidden')
    const { installServerSyncCoordinator, registerServerSyncResource } = await import(
      './server-sync-coordinator.js'
    )
    const refresh = vi.fn(async () => ({ status: 'unchanged' as const }))
    registerServerSyncResource({ id: 'status', scope: () => 'world', refresh })
    installServerSyncCoordinator()

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(refresh).not.toHaveBeenCalled()

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledOnce()

    setOnline(false)
    window.dispatchEvent(new Event('offline'))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(refresh).toHaveBeenCalledOnce()

    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('applies authoritative revisions without immediately rereading the resource', async () => {
    const { applyServerSyncRevision, installServerSyncCoordinator, registerServerSyncResource } =
      await import('./server-sync-coordinator.js')
    const refresh = vi.fn(async () => ({ status: 'unchanged' as const, revision: 'v1' }))
    registerServerSyncResource({ id: 'manifest', scope: () => 'world', refresh })
    installServerSyncCoordinator()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledOnce()

    applyServerSyncRevision(server, 'world', 'manifest', 'v2')
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('runs one follow-up when an event arrives during the resource read', async () => {
    const { installServerSyncCoordinator, registerServerSyncResource, requestServerSync } =
      await import('./server-sync-coordinator.js')
    let release!: () => void
    const refresh = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          await new Promise<{ status: 'unchanged' }>((resolve) => {
            release = () => resolve({ status: 'unchanged' })
          }),
      )
      .mockResolvedValue({ status: 'unchanged' })
    registerServerSyncResource({ id: 'status', scope: () => 'world', refresh })
    installServerSyncCoordinator()
    vi.advanceTimersByTime(0)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())

    requestServerSync('post-offer', 'status')
    requestServerSync('post-offer', 'status')
    release()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
  })

  it('keeps the concurrency bound across work requested during an active sweep', async () => {
    const { installServerSyncCoordinator, registerServerSyncResource } = await import(
      './server-sync-coordinator.js'
    )
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []
    const blockedRefresh = async (): Promise<{ status: 'unchanged' }> => {
      active++
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => {
        releases.push(resolve)
      })
      active--
      return { status: 'unchanged' }
    }
    for (let index = 0; index < 4; index++) {
      registerServerSyncResource({
        id: `initial-${index}`,
        scope: () => 'world',
        refresh: blockedRefresh,
      })
    }
    installServerSyncCoordinator()
    vi.advanceTimersByTime(0)
    await vi.waitFor(() => expect(active).toBe(4))

    registerServerSyncResource({ id: 'later', scope: () => 'world', refresh: blockedRefresh })
    await Promise.resolve()
    expect(active).toBe(4)
    expect(peak).toBe(4)

    for (const release of releases.splice(0)) release()
    await vi.waitFor(() => expect(active).toBe(1))
    expect(peak).toBe(4)
    releases.shift()?.()
    await vi.waitFor(() => expect(active).toBe(0))
  })
})
