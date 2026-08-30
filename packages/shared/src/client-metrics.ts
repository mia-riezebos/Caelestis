export type ClientKind = 'userscript' | 'frontend' | 'third-party' | 'unknown'

export type SyncTransport = 'none' | 'live' | 'response-applied' | 'recovery' | 'compatibility-poll'

export type ReconciliationReason =
  | 'none'
  | 'connect'
  | 'interval'
  | 'focus'
  | 'online'
  | 'post-offer'
  | 'revision-gap'
  | 'state-change'
  | 'manifest-applied'
  | 'manual'
  | 'unknown'

export interface ClientMetricDimensions {
  readonly client: ClientKind
  readonly version: string
  readonly transport: SyncTransport
  readonly reason: ReconciliationReason
}

const MEDIA_TYPE = 'application/vnd.caelestis.client+json'
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/

const transportCode: Record<SyncTransport, string> = {
  none: 'n',
  live: 'l',
  'response-applied': 'a',
  recovery: 'r',
  'compatibility-poll': 'p',
}

const transportFromCode = new Map(
  Object.entries(transportCode).map(([transport, code]) => [code, transport as SyncTransport]),
)

const clients = new Set<ClientKind>(['userscript', 'frontend', 'third-party'])
const reasons = new Set<ReconciliationReason>([
  'none',
  'connect',
  'interval',
  'focus',
  'online',
  'post-offer',
  'revision-gap',
  'state-change',
  'manifest-applied',
  'manual',
  'unknown',
])

/**
 * Encode client telemetry into a CORS-safelisted `Accept` value.
 *
 * A custom header would add a preflight to anonymous cross-origin reads, increasing the exact
 * Worker traffic this protocol measures. This value stays below Accept's 128-byte safelist limit.
 */
export const clientMetricsAccept = (dimensions: ClientMetricDimensions): string => {
  const version = VERSION.test(dimensions.version) ? dimensions.version : 'unknown'
  return `${MEDIA_TYPE};c=${dimensions.client};v=${version};t=${transportCode[dimensions.transport]};r=${dimensions.reason}, */*;q=0.9`
}

/** Parse only the bounded, non-identifying fields emitted by `clientMetricsAccept`. */
export const parseClientMetricsAccept = (accept: string | null): ClientMetricDimensions => {
  const encoded = accept
    ?.split(',')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${MEDIA_TYPE};`))
  if (encoded === undefined) {
    return { client: 'unknown', version: 'unknown', transport: 'none', reason: 'none' }
  }
  const parameters = new Map<string, string>()
  for (const segment of encoded.slice(MEDIA_TYPE.length + 1).split(';')) {
    const separator = segment.indexOf('=')
    if (separator <= 0) continue
    parameters.set(segment.slice(0, separator), segment.slice(separator + 1))
  }
  const rawClient = parameters.get('c')
  const rawVersion = parameters.get('v')
  const rawTransport = parameters.get('t')
  const rawReason = parameters.get('r')
  return {
    client:
      rawClient !== undefined && clients.has(rawClient as ClientKind)
        ? (rawClient as ClientKind)
        : 'unknown',
    version: rawVersion !== undefined && VERSION.test(rawVersion) ? rawVersion : 'unknown',
    transport: transportFromCode.get(rawTransport ?? '') ?? 'none',
    reason:
      rawReason !== undefined && reasons.has(rawReason as ReconciliationReason)
        ? (rawReason as ReconciliationReason)
        : 'unknown',
  }
}
