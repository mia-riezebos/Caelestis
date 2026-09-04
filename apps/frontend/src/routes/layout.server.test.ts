import { beforeEach, describe, expect, it, vi } from 'vitest'

const readBackendJson = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/backend.js', () => ({ readBackendJson }))

import { load } from './+layout.server.js'

beforeEach(() => {
  readBackendJson.mockReset()
})

describe('root SSR bootstrap', () => {
  it('marks a partial telemetry read failure for browser recovery', async () => {
    readBackendJson.mockImplementation((_event, path: string) => {
      switch (path) {
        case '/v1/server':
          return Promise.resolve({ id: 'server', name: 'Caelestis', auth: 'access_token' })
        case '/v1/manifest':
          return Promise.resolve({ season: 7, templates: [], folders: [] })
        case '/v1/telemetry/status?season=7':
          return Promise.reject(new Error('temporary status failure'))
        case '/v1/telemetry/alarms?season=7':
          return Promise.resolve({ alarms: [] })
        case '/v1/telemetry/canvas?season=7':
          return Promise.resolve({ tiles: [] })
        default:
          throw new Error(`unexpected backend path: ${path}`)
      }
    })

    const result = await load({} as Parameters<typeof load>[0])

    expect(result).toMatchObject({
      bootstrap: {
        manifest: { season: 7 },
        statuses: [],
        needsRecovery: true,
      },
    })
  })
})
