import { millis } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { parseLiveServerEvent } from './server-sync-coordinator.js'
import { ClientStatusProjection } from './status-client-projection.js'
import { statusDeltaFrom } from './telemetry.js'

describe('five-client live acceptance', () => {
  it('parses and applies one server delta to all five client states within two seconds', () => {
    const server = { url: 'https://example.test' }
    const clients = Array.from({ length: 5 }, () => new ClientStatusProjection<typeof server>())
    const templateId = '01890f3e-7b2c-7abc-8def-000000000008'
    const encoded = JSON.stringify({
      type: 'status-delta',
      delta: {
        baseRevision: 1,
        revision: 2,
        templates: [
          {
            templateId,
            correct: 1,
            wrong: 0,
            blank: 0,
            total: 1,
            observedAt: millis(1_750_000_000_000),
          },
        ],
        removedTemplateIds: [],
      },
    })

    const startedAt = performance.now()
    for (const client of clients) {
      const event = parseLiveServerEvent(encoded)
      expect(event?.type).toBe('status-delta')
      if (event?.type !== 'status-delta') throw new Error('status delta was not parsed')
      const delta = statusDeltaFrom(event.delta)
      expect(delta).not.toBeNull()
      if (delta === null) throw new Error('status delta was not admitted')
      expect(client.applyDelta(server, delta)).toBe(true)
    }

    expect(performance.now() - startedAt).toBeLessThan(2_000)
    for (const client of clients) {
      expect(client.entry(server.url, templateId)?.value).toMatchObject({ correct: 1, total: 1 })
    }
  })
})
