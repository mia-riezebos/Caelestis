import { parseClientMetricsAccept } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { frontendClientAccept } from './client-metrics.js'

it('identifies frontend reconciliation without exposing browser identity', () => {
  expect(parseClientMetricsAccept(frontendClientAccept('recovery', 'connect'))).toEqual({
    client: 'frontend',
    version: '0.0.0',
    transport: 'recovery',
    reason: 'connect',
  })
})
