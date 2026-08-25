import { encodeMismatchMask, WRONG } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  server: {
    url: 'https://templates.example',
    info: { id: 'server', name: 'Templates', auth: 'access_token' as const },
    token: 'read-token',
    status: 'connected' as const,
    isAdmin: false,
    season: 0,
  },
}))

vi.mock('./state.js', () => ({
  activeServerToken: () => harness.server.token,
  getState: () => ({ servers: [harness.server] }),
  isCurrentServerConnection: () => true,
}))

const template = {
  serverUrl: harness.server.url,
  serverTemplateId: '01890f3e-7b2c-7abc-8def-0123456789ab',
  serverVersion: '01890f3e-7b2c-7abc-8def-0123456789ac',
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

afterEach(() => vi.unstubAllGlobals())

describe('server mismatch masks', () => {
  it('loads one visible template tile with the saved server token', async () => {
    const body = encodeMismatchMask(
      { left: 0, top: 0, width: 1, height: 1 },
      new Uint8Array([WRONG]),
    )
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(body.slice().buffer as ArrayBuffer, { status: 200 }),
    )
    vi.stubGlobal('fetch', fetch)
    const { beginServerMismatchFrame, endServerMismatchFrame, serverMismatchMaskFor } =
      await import('./server-mismatch.js')

    beginServerMismatchFrame()
    expect(serverMismatchMaskFor(template, { x: 3, y: 4 })).toBeNull()
    await vi.waitFor(() => expect(serverMismatchMaskFor(template, { x: 3, y: 4 })).not.toBeNull())
    endServerMismatchFrame()

    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      `/backend/telemetry/templates/${template.serverTemplateId}/versions/${template.serverVersion}/tiles/3/4/mismatches?season=0`,
    )
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer read-token',
    )
  })
})
