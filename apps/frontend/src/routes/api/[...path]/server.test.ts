import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchBackend = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/backend.js', () => ({ fetchBackend }))

import { GET } from './+server.js'

beforeEach(() => fetchBackend.mockReset())

describe('backend browser proxy', () => {
  it('passes a WebSocket upgrade through without rebuilding its response', async () => {
    const upgraded = { status: 101, webSocket: {} }
    fetchBackend.mockResolvedValue(upgraded)
    const request = new Request('https://frontend.test/api/v1/telemetry/live?season=7', {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-protocol': 'caelestis.live.v2, caelestis.live.v1',
      },
    })

    const response = await GET({
      params: { path: 'v1/telemetry/live' },
      request,
      url: new URL(request.url),
    } as Parameters<typeof GET>[0])

    expect(response).toBe(upgraded)
    const headers = new Headers(fetchBackend.mock.calls[0]?.[2]?.headers)
    expect(headers.get('upgrade')).toBe('websocket')
    expect(headers.get('sec-websocket-protocol')).toBe('caelestis.live.v2, caelestis.live.v1')
  })
})
