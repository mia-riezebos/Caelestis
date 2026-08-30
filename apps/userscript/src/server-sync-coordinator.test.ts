// @vitest-environment happy-dom
import type { SyncRequestMetadata } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  contentsListener: null as ((server: MockServer, contents: MockContents) => void) | null,
  stateListeners: [] as Array<() => void>,
  state: { servers: [] as MockServer[] },
}))

interface MockServer {
  readonly url: string
  readonly token: string | null
  readonly status: 'connected' | 'needs-token' | 'unreachable'
  readonly isAdmin: boolean
  readonly season: number | null
  readonly info: { readonly id: string; readonly name: string; readonly auth: 'none' } | null
}

interface MockContents {
  readonly nodes: readonly unknown[]
  readonly templates: readonly { readonly id: string; readonly version: string }[]
}

const sameConnection = (left: MockServer, right: MockServer): boolean =>
  left.url === right.url &&
  left.token === right.token &&
  left.status === right.status &&
  left.isAdmin === right.isAdmin &&
  left.season === right.season &&
  left.info?.id === right.info?.id &&
  left.info?.auth === right.info?.auth

vi.mock('./state.js', () => ({
  getState: () => harness.state,
  isCurrentServerConnection: (server: MockServer) =>
    harness.state.servers.some((candidate) => sameConnection(candidate, server)),
  onServerContents: (listener: (server: MockServer, contents: MockContents) => void) => {
    harness.contentsListener = listener
    return vi.fn()
  },
  onStateChange: (listener: () => void) => {
    harness.stateListeners.push(listener)
    return vi.fn()
  },
  sameServerConnection: sameConnection,
}))

const server: MockServer = {
  url: 'https://templates.example',
  info: { id: 'server', name: 'Templates', auth: 'none' },
  token: null,
  status: 'connected',
  isAdmin: false,
  season: 0,
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  harness.contentsListener = null
  harness.stateListeners = []
  harness.state = { servers: [server] }
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
})

describe('server sync coordinator', () => {
  it('refreshes both resources once on connect and backs unchanged servers off for five minutes', async () => {
    const manifest = vi.fn(async () => null)
    const status = vi.fn(async () => 'status-v1')
    const coordinator = await import('./server-sync-coordinator.js')
    coordinator.registerServerSyncResource('manifest', manifest)
    coordinator.registerServerSyncResource('status', status)

    coordinator.installServerSyncCoordinator()
    await flush()

    expect(manifest).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledOnce()
    expect(manifest).toHaveBeenCalledWith(server, { mode: 'recovery', reason: 'connect' })

    await vi.advanceTimersByTimeAsync(299_999)
    expect(manifest).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(manifest).toHaveBeenCalledTimes(2)
    expect(status).toHaveBeenCalledTimes(2)
    expect(manifest).toHaveBeenLastCalledWith(server, {
      mode: 'compatibility-poll',
      reason: 'interval',
    })
  })

  it('coalesces matching in-flight reads while keeping resources independent', async () => {
    let releaseManifest: (() => void) | undefined
    const manifest = vi.fn(
      async () =>
        await new Promise<null>((resolve) => {
          releaseManifest = () => resolve(null)
        }),
    )
    const status = vi.fn(async () => 'status-v1')
    const coordinator = await import('./server-sync-coordinator.js')
    coordinator.registerServerSyncResource('manifest', manifest)
    coordinator.registerServerSyncResource('status', status)
    coordinator.installServerSyncCoordinator()
    await flush()

    const metadata: SyncRequestMetadata = { mode: 'recovery', reason: 'state-change' }
    const duplicate = coordinator.requestServerSync(server, ['manifest'], metadata)
    const separate = coordinator.requestServerSync(server, ['status'], metadata)
    await separate

    expect(manifest).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledTimes(2)
    releaseManifest?.()
    await duplicate
  })

  it('queues one bounded follow-up for authoritative events that land during a read', async () => {
    let releaseManifest: (() => void) | undefined
    const manifest = vi.fn(
      async () =>
        await new Promise<null>((resolve) => {
          releaseManifest = () => resolve(null)
        }),
    )
    const coordinator = await import('./server-sync-coordinator.js')
    coordinator.registerServerSyncResource('manifest', manifest)
    coordinator.installServerSyncCoordinator()
    await flush()

    const metadata: SyncRequestMetadata = { mode: 'response-applied', reason: 'manifest-applied' }
    const first = coordinator.requestServerSyncAfterCurrent(server, ['manifest'], metadata)
    const second = coordinator.requestServerSyncAfterCurrent(server, ['manifest'], metadata)
    releaseManifest?.()
    await flush()

    expect(manifest).toHaveBeenCalledTimes(2)
    releaseManifest?.()
    await Promise.all([first, second])
  })

  it('suspends while hidden or offline and performs one bounded recovery when active again', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const manifest = vi.fn(async () => null)
    const status = vi.fn(async () => 'status-v1')
    const coordinator = await import('./server-sync-coordinator.js')
    coordinator.registerServerSyncResource('manifest', manifest)
    coordinator.registerServerSyncResource('status', status)
    coordinator.installServerSyncCoordinator()
    await flush()

    expect(manifest).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(manifest).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(manifest).not.toHaveBeenCalled()

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    window.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()

    expect(manifest).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledOnce()
    expect(manifest).toHaveBeenCalledWith(server, { mode: 'recovery', reason: 'online' })
  })

  it('runs recovery after a request that began before suspension', async () => {
    let first = true
    let releaseStatus: (() => void) | undefined
    const status = vi.fn(async () => {
      if (!first) return 'status-v1'
      first = false
      return await new Promise<string>((resolve) => {
        releaseStatus = () => resolve('status-v0')
      })
    })
    const coordinator = await import('./server-sync-coordinator.js')
    coordinator.registerServerSyncResource('status', status)
    coordinator.installServerSyncCoordinator()
    await flush()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(status).toHaveBeenCalledOnce()

    releaseStatus?.()
    await flush()
    expect(status).toHaveBeenCalledTimes(2)
    expect(status).toHaveBeenLastCalledWith(server, {
      mode: 'recovery',
      reason: 'visibility',
    })
  })

  it('allows response-driven follow-ups while hidden without restarting fallback polling', async () => {
    const status = vi.fn(async () => 'status-v1')
    const coordinator = await import('./server-sync-coordinator.js')
    coordinator.registerServerSyncResource('status', status)
    coordinator.installServerSyncCoordinator()
    await flush()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    await coordinator.requestServerSyncAfterCurrent(server, ['status'], {
      mode: 'response-applied',
      reason: 'post-offer',
    })

    expect(status).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('treats a new season or scope as a new connection lifetime', async () => {
    let release: (() => void) | undefined
    const manifest = vi.fn(
      async () =>
        await new Promise<null>((resolve) => {
          release = () => resolve(null)
        }),
    )
    const coordinator = await import('./server-sync-coordinator.js')
    coordinator.registerServerSyncResource('manifest', manifest)
    coordinator.installServerSyncCoordinator()
    await flush()

    const replacement = { ...server, season: 1, token: 'different-scope' }
    harness.state = { servers: [replacement] }
    harness.stateListeners[0]?.()
    await flush()

    expect(manifest).toHaveBeenCalledTimes(2)
    release?.()
  })

  it('postpones only the resource supplied by a successful authoritative response', async () => {
    const manifest = vi.fn(async () => null)
    const status = vi.fn(async () => 'status-v1')
    const coordinator = await import('./server-sync-coordinator.js')
    coordinator.registerServerSyncResource('manifest', manifest)
    coordinator.registerServerSyncResource('status', status)
    coordinator.installServerSyncCoordinator()
    await flush()
    expect(manifest).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(240_000)
    harness.contentsListener?.(server, {
      nodes: [],
      templates: [{ id: 'template', version: 'v1' }],
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(manifest).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(240_000)
    expect(manifest).toHaveBeenCalledTimes(2)
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('checks a changed revision once quickly, then returns to the five-minute floor', async () => {
    let revision = 'status-v1'
    const status = vi.fn(async () => revision)
    const coordinator = await import('./server-sync-coordinator.js')
    coordinator.registerServerSyncResource('status', status)
    coordinator.installServerSyncCoordinator()
    await flush()

    revision = 'status-v2'
    await vi.advanceTimersByTimeAsync(300_000)
    expect(status).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(status).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(299_999)
    expect(status).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(status).toHaveBeenCalledTimes(4)
  })

  it('preserves a future fallback when a deadline expires during a long refresh', async () => {
    let releaseManifest: (() => void) | undefined
    const manifest = vi.fn(
      async () =>
        await new Promise<null>((resolve) => {
          harness.contentsListener?.(server, { nodes: [], templates: [] })
          releaseManifest = () => resolve(null)
        }),
    )
    const coordinator = await import('./server-sync-coordinator.js')
    coordinator.registerServerSyncResource('manifest', manifest)
    coordinator.installServerSyncCoordinator()
    await flush()

    await vi.advanceTimersByTimeAsync(300_000)
    expect(manifest).toHaveBeenCalledOnce()
    releaseManifest?.()
    await flush()

    await vi.advanceTimersByTimeAsync(299_999)
    expect(manifest).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(manifest).toHaveBeenCalledTimes(2)
  })
})
