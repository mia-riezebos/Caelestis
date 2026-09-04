import type {
  AlarmsResponse,
  CanvasTilesResponse,
  Manifest,
  ServerInfo,
  StatusResponse,
} from '@caelestis/shared'
import { readBackendJson } from '$lib/server/backend.js'
import type { AppBootstrap } from '$lib/state/app.svelte.js'
import type { LayoutServerLoad } from './$types'

const emptyBootstrap = (error: unknown): AppBootstrap => ({
  server: null,
  manifest: null,
  statuses: [],
  alarms: [],
  canvas: [],
  needsRecovery: true,
  error: error instanceof Error ? error.message : String(error),
})

export const load: LayoutServerLoad = async (event) => {
  try {
    const server = await readBackendJson<ServerInfo>(event, '/v1/server')
    const manifest = await readBackendJson<Manifest>(event, '/v1/manifest')
    const [status, alarms, canvas] = await Promise.allSettled([
      readBackendJson<StatusResponse>(event, `/v1/telemetry/status?season=${manifest.season}`),
      readBackendJson<AlarmsResponse>(event, `/v1/telemetry/alarms?season=${manifest.season}`),
      readBackendJson<CanvasTilesResponse>(event, `/v1/telemetry/canvas?season=${manifest.season}`),
    ])
    const bootstrap: AppBootstrap = {
      server,
      manifest,
      statuses: status.status === 'fulfilled' ? status.value.templates : [],
      alarms: alarms.status === 'fulfilled' ? alarms.value.alarms : [],
      canvas: canvas.status === 'fulfilled' ? canvas.value.tiles : [],
      needsRecovery: [status, alarms, canvas].some((result) => result.status === 'rejected'),
      error: null,
    }
    return { bootstrap }
  } catch (error) {
    return { bootstrap: emptyBootstrap(error) }
  }
}
