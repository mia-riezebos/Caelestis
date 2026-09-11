import type { PainterIdentity, TemplateSurface } from '@caelestis/shared'
import type { Scope } from '../auth/tokens.js'

/** Runtime delivery of persisted region changes. */
export interface PresencePort {
  publishRegions(season: number, surface: TemplateSurface): Promise<void>
}

/** Authenticated metadata passed from the HTTP boundary to a presence transport. */
export interface PresenceConnection {
  readonly season: number
  readonly surface: TemplateSurface
  readonly painter: PainterIdentity
  readonly credentialScope: Scope
  readonly tokenHash: string
  readonly clientHash: string
  readonly anonymous: boolean
  readonly revocable: boolean
  readonly metricClient: string
  readonly metricClientVersion: string
}

export type ConnectPresence = (
  request: Request,
  connection: PresenceConnection,
) => Promise<Response>
