import { LIVE_PROTOCOL_V1, LIVE_PROTOCOL_V2 } from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'

const SERVER_ID = '018f4f2a-1234-7abc-8def-0123456789ab'
const MANIFEST_VERSION = 'a'.repeat(64)

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readonly protocols: readonly string[]
  readonly sent: string[] = []
  protocol = ''
  readyState = FakeWebSocket.CONNECTING

  constructor(url: string | URL, protocols?: string | string[]) {
    super()
    this.url = String(url)
    this.protocols =
      protocols === undefined ? [] : typeof protocols === 'string' ? [protocols] : protocols
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket is not open')
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState >= FakeWebSocket.CLOSING) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  open(protocol: string): void {
    this.protocol = protocol
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(event: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
  }

  closeFromServer(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.clearAllTimers()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
  FakeWebSocket.instances = []
})

it('resumes live sync without accepting retired frames and reconciles a divergent fallback', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWebSocket)

  const state = await import('../src/state.js')
  const sync = await import('../src/server-sync-coordinator.js')
  const server = {
    url: 'https://live.test',
    info: {
      id: SERVER_ID,
      name: 'Live test server',
      auth: 'none' as const,
      liveSync: 1 as const,
      liveSyncMax: 2 as const,
    },
    token: null,
    status: 'connected' as const,
    isAdmin: false,
    season: 1,
  }
  const refreshes: Array<{ reason: string; transport: string }> = []

  dispose = () => state.removeServer(server.url)
  state.upsertServer(server)
  sync.registerServerSyncResource({
    id: 'world-manifest',
    live: true,
    reconcileOnManifestEvent: true,
    scope: () => 'world',
    refresh: async (_server, reason, transport) => {
      refreshes.push({ reason, transport })
      return { status: 'unchanged', revision: MANIFEST_VERSION }
    },
  })
  sync.installServerSyncCoordinator()

  const first = FakeWebSocket.instances[0]
  if (first === undefined) throw new Error('coordinator did not open a live socket')
  const endpoint = new URL(first.url)
  expect(endpoint.protocol).toBe('wss:')
  expect(endpoint.pathname).toBe('/backend/v1/telemetry/live')
  expect(endpoint.searchParams.get('season')).toBe('1')
  expect(endpoint.searchParams.get('scope')).toBe('public')
  expect(endpoint.searchParams.get('stateVector')).toBe('1')
  expect(first.protocols).toEqual([LIVE_PROTOCOL_V2, LIVE_PROTOCOL_V1])

  first.open(LIVE_PROTOCOL_V2)
  const initialVector = JSON.parse(first.sent[0] ?? 'null')
  expect(initialVector).toMatchObject({
    type: 'state-vector',
    revision: null,
    projections: [{ resource: 'world-manifest', scope: 'world', version: null }],
  })
  first.receive({
    type: 'state-correction',
    requestId: initialVector.requestId,
    mode: 'correction',
    revision: 1,
    projections: [{ resource: 'world-manifest', scope: 'world', version: null }],
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(sync.serverLiveSyncHealthy(server)).toBe(true)
  expect(sync.serverLiveSyncVersion(server)).toBe(2)
  expect(refreshes).toEqual([])

  first.closeFromServer()
  await vi.advanceTimersByTimeAsync(1_000)
  const second = FakeWebSocket.instances[1]
  if (second === undefined) throw new Error('coordinator did not reconnect')
  second.open(LIVE_PROTOCOL_V1)
  const fallbackVector = JSON.parse(second.sent[0] ?? 'null')

  first.receive({ type: 'manifest-reconcile', revision: 2 })
  await vi.advanceTimersByTimeAsync(0)
  expect(refreshes).toEqual([])

  second.receive({
    type: 'state-correction',
    requestId: fallbackVector.requestId,
    mode: 'correction',
    revision: 2,
    projections: [{ resource: 'world-manifest', scope: 'world', version: MANIFEST_VERSION }],
  })
  await vi.advanceTimersByTimeAsync(0)

  expect(sync.serverLiveSyncHealthy(server)).toBe(true)
  expect(sync.serverLiveSyncVersion(server)).toBe(1)
  expect(refreshes).toEqual([{ reason: 'reconnect', transport: 'recovery' }])

  dispose()
  dispose = undefined
  expect(vi.getTimerCount()).toBe(0)
})
