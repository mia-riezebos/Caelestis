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

  it('applies only an exact-base delta and coalesces stale or out-of-order gaps', async () => {
    const { applyServerSyncDelta, installServerSyncCoordinator, registerServerSyncResource } =
      await import('./server-sync-coordinator.js')
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({ status: 'unchanged' as const, revision: '1' })
      .mockResolvedValue({ status: 'unchanged' as const, revision: '2' })
    registerServerSyncResource({ id: 'status', scope: () => 'world', refresh })
    installServerSyncCoordinator()
    await vi.advanceTimersByTimeAsync(0)

    const apply = vi.fn()
    expect(applyServerSyncDelta(server, 'world', 'status', '1', '2', apply)).toBe('applied')
    expect(applyServerSyncDelta(server, 'world', 'status', '1', '2', apply)).toBe('duplicate')
    expect(applyServerSyncDelta(server, 'world', 'status', '0', '1', apply)).toBe('reconcile')
    expect(applyServerSyncDelta(server, 'world', 'status', '3', '4', apply)).toBe('reconcile')
    expect(apply).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('discards a full snapshot when a delta advances its in-flight base revision', async () => {
    const {
      applyServerSyncDelta,
      applyServerSyncSnapshot,
      installServerSyncCoordinator,
      registerServerSyncResource,
      serverSyncRevision,
    } = await import('./server-sync-coordinator.js')
    registerServerSyncResource({
      id: 'status',
      scope: () => 'world',
      refresh: vi.fn(async () => ({ status: 'unchanged' as const, revision: '1' })),
    })
    installServerSyncCoordinator()
    await vi.advanceTimersByTimeAsync(0)
    const started = serverSyncRevision(server, 'world', 'status')
    expect(started).toBe('1')
    expect(applyServerSyncDelta(server, 'world', 'status', '1', '2', vi.fn())).toBe('applied')
    const apply = vi.fn()

    expect(
      applyServerSyncSnapshot(
        server,
        'world',
        'status',
        started,
        { status: 'changed', revision: '1' },
        apply,
      ),
    ).toBe('stale')
    expect(apply).not.toHaveBeenCalled()
    expect(serverSyncRevision(server, 'world', 'status')).toBe('2')
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

  it('keeps targeted resources on their server and reconciliation reason', async () => {
    const second = { ...server, url: 'https://second.example.test' }
    state.current = { servers: [server, second] }
    const { installServerSyncCoordinator, registerServerSyncResource, requestServerSync } =
      await import('./server-sync-coordinator.js')
    const status = vi.fn(async () => ({ status: 'unchanged' as const }))
    const alarms = vi.fn(async () => ({ status: 'unchanged' as const }))
    registerServerSyncResource({ id: 'status', scope: () => 'world', refresh: status })
    registerServerSyncResource({ id: 'alarms', scope: () => 'world', refresh: alarms })
    installServerSyncCoordinator()
    await vi.advanceTimersByTimeAsync(0)
    status.mockClear()
    alarms.mockClear()

    requestServerSync('post-offer', 'status', server)
    requestServerSync('manifest-applied', 'alarms', server)
    await vi.advanceTimersByTimeAsync(0)

    expect(status).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledWith(server, 'post-offer')
    expect(alarms).toHaveBeenCalledOnce()
    expect(alarms).toHaveBeenCalledWith(server, 'manifest-applied')
  })
})
