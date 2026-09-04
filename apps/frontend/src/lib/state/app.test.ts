// @vitest-environment happy-dom
import { millis } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppState } from './app.svelte.js'

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly instances: FakeWebSocket[] = []
  readonly sent: string[] = []
  readyState = 0

  constructor(
    readonly url: URL,
    readonly protocols: readonly string[],
  ) {
    super()
    FakeWebSocket.instances.push(this)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
  }

  send(value: string): void {
    this.sent.push(value)
  }

  close(): void {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  })
})

describe('frontend live state', () => {
  it('hydrates shared and dashboard state from one proxied socket', () => {
    const app = new AppState({
      server: {
        id: '01890f3e-7b2c-7abc-8def-000000000001',
        name: 'Caelestis',
        auth: 'access_token',
        liveSync: 2,
        liveSyncMin: 1,
      },
      manifest: {
        version: 'a'.repeat(64),
        season: 7,
        server: {
          id: '01890f3e-7b2c-7abc-8def-000000000001',
          name: 'Caelestis',
          auth: 'access_token',
        },
        nodes: [],
        templates: [],
        tiles: [],
      },
      statuses: [],
      statusRevision: 1,
      alarms: [],
      alarmsVersion: 'b'.repeat(64),
      canvas: [],
      needsRecovery: false,
      error: null,
    })
    const dashboard = vi.fn()
    app.subscribeDashboard([], 1_800_000_000, dashboard)
    app.startLive()
    const socket = FakeWebSocket.instances[0]
    socket?.open()
    socket?.receive({
      type: 'status-snapshot',
      status: {
        revision: 2,
        templates: [
          {
            templateId: '01890f3e-7b2c-7abc-8def-000000000002',
            correct: 1,
            wrong: 0,
            blank: 0,
            total: 1,
            observedAt: millis(1_800_000_000_000),
          },
        ],
      },
    })
    const subscription = socket?.sent
      .map((message) => JSON.parse(message) as Record<string, unknown>)
      .find((message) => message.type === 'dashboard-subscribe')
    const subscriptionId = (subscription?.subscription as { subscriptionId?: string })
      ?.subscriptionId
    socket?.receive({
      type: 'dashboard-snapshot',
      subscriptionId,
      contributions: { days: [] },
      leaderboard: { entries: [] },
    })

    expect(app.statuses.size).toBe(1)
    expect(dashboard).toHaveBeenCalledWith({
      contributions: { days: [] },
      leaderboard: { entries: [] },
    })
    expect(socket?.url.pathname).toBe('/api/v1/telemetry/live')
  })
})
