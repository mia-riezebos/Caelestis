import {
  clientMetricsAccept,
  type ReconciliationReason,
  type SyncTransport,
} from '@caelestis/shared'

declare const __CAELESTIS_FRONTEND_VERSION__: string

const frontendVersion =
  typeof __CAELESTIS_FRONTEND_VERSION__ === 'string'
    ? __CAELESTIS_FRONTEND_VERSION__
    : 'development'

export const frontendClientAccept = (
  transport: SyncTransport = 'none',
  reason: ReconciliationReason = 'none',
): string =>
  clientMetricsAccept({ client: 'frontend', version: frontendVersion, transport, reason })
