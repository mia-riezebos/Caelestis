export const CLIENT_KIND_HEADER = 'x-caelestis-client'
export const CLIENT_VERSION_HEADER = 'x-caelestis-client-version'
export const SYNC_TRANSPORT_HEADER = 'x-caelestis-sync-transport'
export const SYNC_MODE_HEADER = 'x-caelestis-sync-mode'
export const SYNC_REASON_HEADER = 'x-caelestis-sync-reason'

export const CLIENT_KIND_QUERY = '__caelestis_client'
export const CLIENT_VERSION_QUERY = '__caelestis_client_version'
export const SYNC_TRANSPORT_QUERY = '__caelestis_sync_transport'
export const SYNC_MODE_QUERY = '__caelestis_sync_mode'
export const SYNC_REASON_QUERY = '__caelestis_sync_reason'

export const CLIENT_KINDS = ['userscript', 'frontend'] as const
export type ClientKind = (typeof CLIENT_KINDS)[number]

export const SYNC_TRANSPORTS = ['http', 'websocket'] as const
export type SyncTransport = (typeof SYNC_TRANSPORTS)[number]

export const SYNC_MODES = [
  'none',
  'live',
  'response-applied',
  'recovery',
  'compatibility-poll',
] as const
export type SyncMode = (typeof SYNC_MODES)[number]

export const SYNC_REASONS = [
  'none',
  'page-load',
  'connect',
  'state-change',
  'interval',
  'post-offer',
  'manifest-applied',
  'retry',
  'user-action',
  'visibility',
  'focus',
  'online',
  'revision-gap',
  'server-event',
] as const
export type SyncReason = (typeof SYNC_REASONS)[number]

export interface SyncRequestMetadata {
  readonly mode: SyncMode
  readonly reason: SyncReason
  readonly transport?: SyncTransport
}

/** Bounded, identity-free headers used to group sync traffic in Worker observability. */
export const syncRequestHeaders = (
  client: ClientKind,
  version: string,
  metadata: SyncRequestMetadata = { mode: 'none', reason: 'none' },
): Record<string, string> => ({
  [CLIENT_KIND_HEADER]: client,
  [CLIENT_VERSION_HEADER]: version,
  [SYNC_TRANSPORT_HEADER]: metadata.transport ?? 'http',
  [SYNC_MODE_HEADER]: metadata.mode,
  [SYNC_REASON_HEADER]: metadata.reason,
})
