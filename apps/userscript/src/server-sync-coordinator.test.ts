// @vitest-environment happy-dom

import { seconds } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  current: { servers: [] as object[] },
  identities: new WeakMap<object, object>(),
  listener: null as null | (() => void),
}))

vi.mock('./state.js', () => ({
  getState: () => state.current,
  isCurrentServerConnection: (server: object) =>
    state.current.servers.some(
      (candidate) =>
        candidate === server ||
        (state.identities.get(candidate) !== undefined &&
          state.identities.get(candidate) === state.identities.get(server)),
    ),
  serverConnectionIdentity: (server: object) => state.identities.get(server) ?? server,
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

class FakeWebSocket extends EventTarget {
  static readonly instances: FakeWebSocket[] = []
  readonly url: string
  readonly protocols: string[]
  readonly sent: string[] = []
  readyState = 0

  constructor(url: string | URL, protocols: string | string[]) {
    super()
    this.url = String(url)
    this.protocols = typeof protocols === 'string' ? [protocols] : protocols
    FakeWebSocket.instances.push(this)
  }

  open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
  }

  receiveRaw(value: string): void {
    this.dispatchEvent(new MessageEvent('message', { data: value }))
  }

  send(value: string): void {
    this.sent.push(value)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
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
    state.identities = new WeakMap()
    state.listener = null
    setVisibility('visible')
    setOnline(true)
    FakeWebSocket.instances.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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
    expect(status).toHaveBeenCalledWith(server, 'post-offer', 'compatibility-poll')
    expect(alarms).toHaveBeenCalledOnce()
    expect(alarms).toHaveBeenCalledWith(server, 'manifest-applied', 'compatibility-poll')
  })

  it('uses one authenticated live connection and suppresses healthy interval polls', async () => {
    const liveServer = {
      ...server,
      info: { ...server.info, liveSync: 1 as const },
      token: 'ABCDEFGHJKMNPQRSTVWXYZ2345',
    }
    state.current = { servers: [liveServer] }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { installServerSyncCoordinator, registerServerSyncResource } = await import(
      './server-sync-coordinator.js'
    )
    const status = vi.fn(async () => ({ status: 'unchanged' as const, revision: '7' }))
    const manifest = vi.fn(async () => ({ status: 'unchanged' as const }))
    const alarms = vi.fn(async () => ({ status: 'unchanged' as const }))
    registerServerSyncResource({
      id: 'telemetry-status',
      scope: () => 'world',
      refresh: status,
      live: true,
      applyLiveEvent: () => true,
    })
    registerServerSyncResource({
      id: 'world-manifest',
      scope: () => 'world',
      refresh: manifest,
      live: true,
      reconcileOnManifestEvent: true,
    })
    registerServerSyncResource({
      id: 'telemetry-alarms',
      scope: () => 'world',
      refresh: alarms,
      live: true,
    })

    installServerSyncCoordinator()
    expect(FakeWebSocket.instances).toHaveLength(1)
    const socket = FakeWebSocket.instances[0]
    if (socket === undefined) throw new Error('live socket was not created')
    expect(socket.url).toContain('wss://example.test/backend/telemetry/live?')
    expect(socket.url).toContain('season=0')
    expect(socket.url).toContain('scope=public')
    expect(socket.url).toContain('client=userscript')
    expect(socket.url).toContain('clientVersion=development')
    expect(socket.url).not.toContain(liveServer.token)
    expect(socket.protocols).toEqual([
      'caelestis.live.v1',
      `caelestis.auth.b64.${btoa(liveServer.token).replace(/=+$/, '')}`,
    ])

    await vi.advanceTimersByTimeAsync(0)
    expect(status).not.toHaveBeenCalled()
    expect(manifest).not.toHaveBeenCalled()
    expect(alarms).not.toHaveBeenCalled()

    socket.open()
    socket.receive({ type: 'ready', revision: 7 })
    await vi.advanceTimersByTimeAsync(0)
    expect(status).toHaveBeenCalledOnce()
    expect(manifest).toHaveBeenCalledOnce()
    expect(alarms).toHaveBeenCalledOnce()
    expect(status).toHaveBeenLastCalledWith(liveServer, 'revision-gap', 'recovery')
    expect(manifest).toHaveBeenLastCalledWith(liveServer, 'connect', 'recovery')
    status.mockClear()
    manifest.mockClear()
    alarms.mockClear()

    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(status).not.toHaveBeenCalled()
    expect(manifest).not.toHaveBeenCalled()
    expect(alarms).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(status).not.toHaveBeenCalled()
    expect(manifest).not.toHaveBeenCalled()
    expect(alarms).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(socket.sent).toEqual(['ping'])
    expect(status).not.toHaveBeenCalled()
    expect(manifest).not.toHaveBeenCalled()
    expect(alarms).not.toHaveBeenCalled()
    socket.receiveRaw('pong')

    for (let heartbeat = 2; heartbeat <= 4; heartbeat++) {
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      expect(socket.sent).toHaveLength(heartbeat)
      socket.receiveRaw('pong')
    }

    expect(status).toHaveBeenCalledOnce()
    expect(manifest).toHaveBeenCalledOnce()
    expect(alarms).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledWith(liveServer, 'interval', 'recovery')
    expect(manifest).toHaveBeenCalledWith(liveServer, 'interval', 'recovery')
    expect(alarms).toHaveBeenCalledWith(liveServer, 'interval', 'recovery')
  })

  it('correlates a live tile cache acknowledgement without an HTTP request', async () => {
    const liveServer = {
      ...server,
      info: { ...server.info, liveSync: 1 as const, liveTileOffers: 1 as const },
      token: 'ABCDEFGHJKMNPQRSTVWXYZ2345',
    }
    state.current = { servers: [liveServer] }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { installServerSyncCoordinator, requestLiveTileOfferCache } = await import(
      './server-sync-coordinator.js'
    )
    installServerSyncCoordinator()
    const socket = FakeWebSocket.instances[0]
    if (socket === undefined) throw new Error('live socket was not created')
    socket.open()

    const pending = requestLiveTileOfferCache(liveServer, {
      wplaceUserId: 42,
      displayName: 'Mia',
      season: 0,
      offers: [
        {
          deliveryId: '01890f3e-7b2c-7abc-8def-000000000001',
          tile: '1/2',
          sha256: 'a'.repeat(64),
          ts: seconds(1_800_000_000),
        },
      ],
    })
    const command = JSON.parse(socket.sent.at(-1) ?? '{}') as { requestId?: string }
    expect(command.requestId).toBeTypeOf('string')
    socket.receive({
      type: 'tile-offer-cache-result',
      requestId: command.requestId,
      response: {
        acknowledgedDeliveryIds: ['01890f3e-7b2c-7abc-8def-000000000001'],
        unresolvedDeliveryIds: [],
      },
    })

    await expect(pending).resolves.toEqual({
      acknowledgedDeliveryIds: ['01890f3e-7b2c-7abc-8def-000000000001'],
      unresolvedDeliveryIds: [],
    })
  })

  it('coalesces malformed, out-of-order, and reconnect recovery into bounded reads', async () => {
    const liveServer = { ...server, info: { ...server.info, liveSync: 1 as const } }
    state.current = { servers: [liveServer] }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { installServerSyncCoordinator, registerServerSyncResource } = await import(
      './server-sync-coordinator.js'
    )
    const status = vi.fn(async () => ({ status: 'unchanged' as const, revision: '7' }))
    const manifest = vi.fn(async () => ({ status: 'unchanged' as const }))
    const allianceManifest = vi.fn(async () => ({ status: 'unchanged' as const }))
    const alarms = vi.fn(async () => ({ status: 'unchanged' as const }))
    const applyLiveEvent = vi.fn(() => false)
    registerServerSyncResource({
      id: 'telemetry-status',
      scope: () => 'world',
      refresh: status,
      live: true,
      applyLiveEvent,
    })
    registerServerSyncResource({
      id: 'world-manifest',
      scope: () => 'world',
      refresh: manifest,
      live: true,
      reconcileOnManifestEvent: true,
    })
    registerServerSyncResource({
      id: 'alliance-manifest',
      scope: () => 'banner:1',
      refresh: allianceManifest,
      reconcileOnManifestEvent: true,
    })
    registerServerSyncResource({
      id: 'telemetry-alarms',
      scope: () => 'world',
      refresh: alarms,
      live: true,
    })
    installServerSyncCoordinator()
    const socket = FakeWebSocket.instances[0]
    if (socket === undefined) throw new Error('live socket was not created')
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.instances).toHaveLength(1)
    status.mockClear()
    manifest.mockClear()
    allianceManifest.mockClear()
    alarms.mockClear()

    socket.receive({ type: 'status-delta', delta: { baseRevision: 5, revision: 6 } })
    socket.receive({ type: 'status-reconcile', revision: 9 })
    // Older servers omitted the revision; that event remains an unconditional manifest reconcile.
    socket.receive({ type: 'manifest-reconcile' })
    socket.receive({ type: 'manifest-reconcile', revision: 4 })
    socket.receive({ type: 'alarms-reconcile' })
    await vi.advanceTimersByTimeAsync(0)
    expect(applyLiveEvent).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledOnce()
    expect(manifest).toHaveBeenCalledOnce()
    expect(allianceManifest).toHaveBeenCalledOnce()
    expect(alarms).toHaveBeenCalledOnce()

    status.mockClear()
    manifest.mockClear()
    allianceManifest.mockClear()
    alarms.mockClear()
    socket.receive({ type: 'manifest-reconcile', revision: 4 })
    socket.receive({ type: 'manifest-reconcile', revision: 3 })
    await vi.advanceTimersByTimeAsync(0)
    expect(status).not.toHaveBeenCalled()
    expect(manifest).not.toHaveBeenCalled()
    expect(allianceManifest).not.toHaveBeenCalled()
    expect(alarms).not.toHaveBeenCalled()

    status.mockClear()
    manifest.mockClear()
    allianceManifest.mockClear()
    alarms.mockClear()
    socket.close()
    await vi.advanceTimersByTimeAsync(0)
    expect(status).not.toHaveBeenCalled()
    expect(manifest).not.toHaveBeenCalled()
    expect(allianceManifest).not.toHaveBeenCalled()
    expect(alarms).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    const replacement = FakeWebSocket.instances[1]
    if (replacement === undefined) throw new Error('replacement live socket was not created')
    replacement.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(status).toHaveBeenCalledOnce()
    expect(manifest).toHaveBeenCalledOnce()
    expect(allianceManifest).not.toHaveBeenCalled()
    expect(alarms).toHaveBeenCalledOnce()
  })

  it('lets an in-flight bootstrap satisfy the socket ready revision', async () => {
    const liveServer = { ...server, info: { ...server.info, liveSync: 1 as const } }
    state.current = { servers: [liveServer] }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { installServerSyncCoordinator, registerServerSyncResource } = await import(
      './server-sync-coordinator.js'
    )
    let finishBootstrap!: () => void
    const refresh = vi.fn(
      async () =>
        await new Promise<{ status: 'unchanged'; revision: string }>((resolve) => {
          finishBootstrap = () => resolve({ status: 'unchanged', revision: '7' })
        }),
    )
    registerServerSyncResource({
      id: 'telemetry-status',
      scope: () => 'world',
      refresh,
      live: true,
    })
    installServerSyncCoordinator()
    const socket = FakeWebSocket.instances[0]
    if (socket === undefined) throw new Error('live socket was not created')
    socket.open()
    vi.advanceTimersByTime(0)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    socket.receive({ type: 'status-reconcile', revision: 7 })
    finishBootstrap()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(0)

    expect(refresh).toHaveBeenCalledOnce()
  })

  it('retries a failed initial live snapshot before the long recovery cadence', async () => {
    const liveServer = { ...server, info: { ...server.info, liveSync: 1 as const } }
    state.current = { servers: [liveServer] }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { installServerSyncCoordinator, registerServerSyncResource } = await import(
      './server-sync-coordinator.js'
    )
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({ status: 'failed' as const })
      .mockResolvedValue({ status: 'unchanged' as const, revision: '1' })
    registerServerSyncResource({
      id: 'telemetry-status',
      scope: () => 'world',
      refresh,
      live: true,
    })
    installServerSyncCoordinator()
    const socket = FakeWebSocket.instances[0]
    if (socket === undefined) throw new Error('live socket was not created')
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('expires a half-open socket and preserves backoff until server traffic confirms it', async () => {
    const liveServer = { ...server, info: { ...server.info, liveSync: 1 as const } }
    state.current = { servers: [liveServer] }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { installServerSyncCoordinator } = await import('./server-sync-coordinator.js')
    installServerSyncCoordinator()
    const first = FakeWebSocket.instances[0]
    if (first === undefined) throw new Error('live socket was not created')
    first.open()

    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(first.sent).toEqual(['ping'])
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeWebSocket.instances).toHaveLength(2)

    const second = FakeWebSocket.instances[1]
    if (second === undefined) throw new Error('replacement live socket was not created')
    second.open()
    second.close()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('keeps non-live focus recovery while a healthy socket protects live resources', async () => {
    const liveServer = { ...server, info: { ...server.info, liveSync: 1 as const } }
    state.current = { servers: [liveServer] }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { installServerSyncCoordinator, registerServerSyncResource } = await import(
      './server-sync-coordinator.js'
    )
    const status = vi.fn(async () => ({ status: 'unchanged' as const, revision: '1' }))
    const compatibility = vi.fn(async () => ({ status: 'unchanged' as const }))
    registerServerSyncResource({
      id: 'telemetry-status',
      scope: () => 'world',
      refresh: status,
      live: true,
    })
    registerServerSyncResource({
      id: 'alliance-manifest',
      scope: () => 'alliance:1',
      refresh: compatibility,
    })
    installServerSyncCoordinator()
    await vi.advanceTimersByTimeAsync(0)
    expect(compatibility).toHaveBeenCalledOnce()
    expect(status).not.toHaveBeenCalled()

    const socket = FakeWebSocket.instances[0]
    if (socket === undefined) throw new Error('live socket was not created')
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    status.mockClear()
    compatibility.mockClear()

    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(status).not.toHaveBeenCalled()
    expect(compatibility).toHaveBeenCalledOnce()
    expect(compatibility).toHaveBeenCalledWith(liveServer, 'focus', 'compatibility-poll')
  })

  it('keeps a healthy socket across a same-lifetime server replacement', async () => {
    const liveServer = { ...server, info: { ...server.info, liveSync: 1 as const } }
    const lifetime = {}
    state.identities.set(liveServer, lifetime)
    state.current = { servers: [liveServer] }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { installServerSyncCoordinator, registerServerSyncResource, serverLiveSyncHealthy } =
      await import('./server-sync-coordinator.js')
    const status = vi.fn(async () => ({ status: 'unchanged' as const, revision: '1' }))
    registerServerSyncResource({
      id: 'telemetry-status',
      scope: () => 'world',
      refresh: status,
      live: true,
    })
    installServerSyncCoordinator()
    const socket = FakeWebSocket.instances[0]
    if (socket === undefined) throw new Error('live socket was not created')
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    status.mockClear()

    const renamed = {
      ...liveServer,
      info: { ...liveServer.info, name: 'Renamed' },
    }
    state.identities.set(renamed, lifetime)
    state.current = { servers: [renamed] }
    state.listener?.()
    expect(FakeWebSocket.instances).toHaveLength(1)

    expect(serverLiveSyncHealthy(renamed)).toBe(true)
    expect(status).not.toHaveBeenCalled()

    const capabilityWithdrawn = {
      ...renamed,
      info: {
        id: renamed.info.id,
        name: renamed.info.name,
        auth: renamed.info.auth,
      },
    }
    state.identities.set(capabilityWithdrawn, lifetime)
    state.current = { servers: [capabilityWithdrawn] }
    state.listener?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(serverLiveSyncHealthy(capabilityWithdrawn)).toBe(false)
    expect(socket.readyState).toBe(3)
    expect(status).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledWith(capabilityWithdrawn, 'state-change', 'compatibility-poll')
  })

  it('falls back once when an advertised live socket never opens', async () => {
    const liveServer = { ...server, info: { ...server.info, liveSync: 1 as const } }
    state.current = { servers: [liveServer] }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { installServerSyncCoordinator, registerServerSyncResource } = await import(
      './server-sync-coordinator.js'
    )
    const refresh = vi.fn(async () => ({ status: 'unchanged' as const, revision: '1' }))
    registerServerSyncResource({
      id: 'telemetry-status',
      scope: () => 'world',
      refresh,
      live: true,
    })
    installServerSyncCoordinator()

    await vi.advanceTimersByTimeAsync(999)
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledWith(liveServer, 'reconnect', 'compatibility-poll')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('keeps compatibility polling and opens no socket when capability is absent', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { installServerSyncCoordinator, registerServerSyncResource } = await import(
      './server-sync-coordinator.js'
    )
    const refresh = vi.fn(async () => ({ status: 'unchanged' as const, revision: '1' }))
    registerServerSyncResource({
      id: 'telemetry-status',
      scope: () => 'world',
      refresh,
      live: true,
    })
    installServerSyncCoordinator()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
