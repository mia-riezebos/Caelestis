import { parseClientMetricsAccept } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { userscriptClientHeaders } from './client-metrics.js'

it('identifies userscript sync requests through a CORS-safelisted header', () => {
  const headers = userscriptClientHeaders({
    transport: 'compatibility-poll',
    reason: 'interval',
  })

  expect(Object.keys(headers)).toEqual(['accept'])
  expect(parseClientMetricsAccept(headers.accept ?? null)).toEqual({
    client: 'userscript',
    version: 'development',
    transport: 'compatibility-poll',
    reason: 'interval',
  })
})
