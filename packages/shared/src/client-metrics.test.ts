import { describe, expect, it } from 'vitest'
import { clientMetricsAccept, parseClientMetricsAccept } from './client-metrics.js'

describe('client metrics Accept contract', () => {
  it('round-trips bounded dimensions without exceeding the CORS safelist limit', () => {
    const dimensions = {
      client: 'third-party' as const,
      version: 'a'.repeat(32),
      transport: 'compatibility-poll' as const,
      reason: 'manifest-applied' as const,
    }
    const accept = clientMetricsAccept(dimensions)

    expect(accept.length).toBeLessThanOrEqual(128)
    expect(parseClientMetricsAccept(accept)).toEqual(dimensions)
  })

  it('does not admit arbitrary client labels or identifying values', () => {
    expect(
      parseClientMetricsAccept(
        'application/vnd.caelestis.client+json;c=mia;v=secret/token;t=x;r=username',
      ),
    ).toEqual({ client: 'unknown', version: 'unknown', transport: 'none', reason: 'unknown' })
  })

  it('keeps ordinary clients in an explicit unknown bucket', () => {
    expect(parseClientMetricsAccept('application/json')).toEqual({
      client: 'unknown',
      version: 'unknown',
      transport: 'none',
      reason: 'none',
    })
  })

  it.each(['none', 'live', 'response-applied', 'recovery', 'compatibility-poll'] as const)(
    'keeps %s sync traffic distinguishable',
    (transport) => {
      const accept = clientMetricsAccept({
        client: 'third-party',
        version: '1.0.0',
        transport,
        reason: 'revision-gap',
      })

      expect(parseClientMetricsAccept(accept).transport).toBe(transport)
    },
  )
})
