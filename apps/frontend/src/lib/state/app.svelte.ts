import type {
  Alarm,
  CanvasTileSummary,
  Manifest,
  ServerInfo,
  TemplateStatus,
  TileKey,
} from '@caelestis/shared'
import { getContext, setContext } from 'svelte'
import {
  ApiError,
  getAlarms,
  getCanvas,
  getManifest,
  getServer,
  getStatus,
  probeAdminScope,
  readToken,
  usesServerReadProxy,
} from '$lib/api/client'
import { buildTree, type TemplateTree } from '$lib/tree'

/**
 * The one shared session: which server we're connected to, its manifest, and the current status
 * and canvas observations everything on screen derives from. Pages layer their own reads (history,
 * leaderboard, timelapse) on top; this holds only what every page needs.
 */
export interface AppBootstrap {
  readonly server: ServerInfo | null
  readonly manifest: Manifest | null
  readonly statuses: readonly TemplateStatus[]
  readonly alarms: readonly Alarm[]
  readonly canvas: readonly CanvasTileSummary[]
  /** True when SSR returned a useful partial model that the browser must refresh. */
  readonly needsRecovery: boolean
  readonly error: string | null
}

class AppState {
  server = $state<ServerInfo | null>(null)
  manifest = $state<Manifest | null>(null)
  statuses = $state<ReadonlyMap<string, TemplateStatus>>(new Map())
  alarms = $state<ReadonlyMap<string, Alarm>>(new Map())
  canvas = $state<ReadonlyMap<TileKey, CanvasTileSummary>>(new Map())
  loading = $state(false)
  isAdmin = $state(false)
  /** A 401 or 403 opens the connect dialog. */
  authRequired = $state(false)
  error = $state<string | null>(null)

  tree = $derived.by<TemplateTree | null>(() =>
    this.manifest === null ? null : buildTree(this.manifest, this.statuses, this.alarms),
  )

  /** Bumped per load, so a slow older load can never overwrite a newer one's answers. */
  private generation = 0

  constructor(bootstrap: AppBootstrap) {
    this.server = bootstrap.server
    this.manifest = bootstrap.manifest
    this.statuses = new Map(bootstrap.statuses.map((status) => [status.templateId, status]))
    this.alarms = new Map(bootstrap.alarms.map((alarm) => [alarm.templateId, alarm]))
    this.canvas = new Map(bootstrap.canvas.map((tile) => [tile.tile, tile]))
    this.error = bootstrap.error
  }

  async load(): Promise<void> {
    const generation = ++this.generation
    this.loading = true
    this.error = null
    this.authRequired = false
    // Reset rather than serve stale: a reconnect must never show the previous connection's
    // manifest as if it were this server's — that reads as "my template is missing".
    this.manifest = null
    this.statuses = new Map()
    this.alarms = new Map()
    this.canvas = new Map()
    this.isAdmin = false
    try {
      // `/server` is public and reports whether reads need a token. An open server must not show
      // the connect dialog.
      const server = await getServer()
      if (generation !== this.generation) return
      this.server = server
      if (server.auth === 'access_token' && readToken() === null && !usesServerReadProxy()) {
        this.authRequired = true
        return
      }
      const manifest = await getManifest()
      if (generation !== this.generation) return
      this.manifest = manifest
      // Status and canvas refine the picture; the tree already renders without them.
      const [status, alarms, canvas, admin] = await Promise.allSettled([
        getStatus(manifest.season),
        getAlarms(manifest.season),
        getCanvas(manifest.season),
        probeAdminScope(manifest.season),
      ])
      if (generation !== this.generation) return
      if (status.status === 'fulfilled') {
        this.statuses = new Map(status.value.templates.map((t) => [t.templateId, t]))
      }
      if (alarms.status === 'fulfilled') {
        this.alarms = new Map(alarms.value.alarms.map((alarm) => [alarm.templateId, alarm]))
      }
      if (canvas.status === 'fulfilled') {
        this.canvas = new Map(canvas.value.tiles.map((t) => [t.tile, t]))
      }
      if (admin.status === 'fulfilled') this.isAdmin = admin.value
    } catch (error) {
      if (generation !== this.generation) return
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        this.authRequired = true
      } else {
        this.error = error instanceof Error ? error.message : String(error)
      }
    } finally {
      if (generation === this.generation) this.loading = false
    }
  }
}

const APP_STATE = Symbol('caelestis-app-state')

export const provideApp = (bootstrap: AppBootstrap): AppState =>
  setContext(APP_STATE, new AppState(bootstrap))

export const useApp = (): AppState => {
  const app = getContext<AppState | undefined>(APP_STATE)
  if (app === undefined) throw new Error('app state was read outside the root layout')
  return app
}
