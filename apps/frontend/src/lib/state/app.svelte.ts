import type {
  Alarm,
  CanvasTileSummary,
  ContributionsResponse,
  LeaderboardResponse,
  Manifest,
  ServerInfo,
  StatusDelta,
  TemplateStatus,
  TileKey,
} from '@caelestis/shared'
import {
  LIVE_PROTOCOL_V1,
  LIVE_PROTOCOL_V2,
  LiveSnapshotAssembler,
  uuidV7,
} from '@caelestis/shared'
import { getContext, setContext } from 'svelte'
import {
  ApiError,
  getAlarms,
  getCanvas,
  getManifest,
  getServer,
  getStatus,
  openLiveSocket,
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
  readonly statusRevision: number | null
  readonly alarms: readonly Alarm[]
  readonly alarmsVersion: string | null
  readonly canvas: readonly CanvasTileSummary[]
  /** True when SSR returned a useful partial model that the browser must refresh. */
  readonly needsRecovery: boolean
  readonly error: string | null
}

export interface DashboardSnapshot {
  readonly contributions: ContributionsResponse
  readonly leaderboard: LeaderboardResponse
}

interface DashboardSubscription {
  readonly templateIds: readonly string[]
  readonly contributionsFrom: number
  readonly listener: (snapshot: DashboardSnapshot) => void
}

export class AppState {
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
  liveProtocol = $state<1 | 2 | null>(null)

  tree = $derived.by<TemplateTree | null>(() =>
    this.manifest === null ? null : buildTree(this.manifest, this.statuses, this.alarms),
  )

  /** Bumped per load, so a slow older load can never overwrite a newer one's answers. */
  private generation = 0
  private statusRevision: number | null
  private alarmsVersion: string | null
  private liveEnabled = false
  private liveSocket: WebSocket | null = null
  private liveReconnect: ReturnType<typeof setTimeout> | null = null
  private liveAttempts = 0
  private readonly liveSnapshots = new LiveSnapshotAssembler()
  private readonly dashboardSubscriptions = new Map<string, DashboardSubscription>()

  constructor(bootstrap: AppBootstrap) {
    this.server = bootstrap.server
    this.manifest = bootstrap.manifest
    this.statuses = new Map(bootstrap.statuses.map((status) => [status.templateId, status]))
    this.statusRevision = bootstrap.statusRevision
    this.alarms = new Map(bootstrap.alarms.map((alarm) => [alarm.templateId, alarm]))
    this.alarmsVersion = bootstrap.alarmsVersion
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
    this.statusRevision = null
    this.alarms = new Map()
    this.alarmsVersion = null
    this.canvas = new Map()
    this.isAdmin = false
    this.retireLiveSocket()
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
        this.statusRevision = status.value.revision ?? null
      }
      if (alarms.status === 'fulfilled') {
        this.alarms = new Map(alarms.value.alarms.map((alarm) => [alarm.templateId, alarm]))
        this.alarmsVersion = alarms.value.version ?? null
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
      if (generation === this.generation) {
        this.loading = false
        if (this.liveEnabled) this.openLiveSocket()
      }
    }
  }

  startLive(): void {
    this.liveEnabled = true
    this.openLiveSocket()
  }

  stopLive(): void {
    this.liveEnabled = false
    if (this.liveReconnect !== null) clearTimeout(this.liveReconnect)
    this.liveReconnect = null
    this.retireLiveSocket()
  }

  subscribeDashboard = (
    templateIds: readonly string[],
    contributionsFrom: number,
    listener: (snapshot: DashboardSnapshot) => void,
  ): (() => void) => {
    const subscriptionId = uuidV7()
    this.dashboardSubscriptions.set(subscriptionId, {
      templateIds: [...templateIds],
      contributionsFrom,
      listener,
    })
    this.sendDashboardSubscription(subscriptionId)
    return () => {
      this.dashboardSubscriptions.delete(subscriptionId)
      if (this.liveProtocol === 2 && this.liveSocket?.readyState === WebSocket.OPEN)
        this.liveSocket.send(JSON.stringify({ type: 'dashboard-unsubscribe', subscriptionId }))
    }
  }

  private retireLiveSocket(): void {
    const socket = this.liveSocket
    this.liveSocket = null
    this.liveSnapshots.clear()
    this.liveProtocol = null
    if (socket !== null && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'retired')
  }

  private reconnectLive(): void {
    if (!this.liveEnabled || this.liveReconnect !== null) return
    const delay = Math.min(1_000 * 2 ** this.liveAttempts, 30_000)
    this.liveAttempts = Math.min(this.liveAttempts + 1, 5)
    this.liveReconnect = setTimeout(() => {
      this.liveReconnect = null
      this.openLiveSocket()
    }, delay)
  }

  private openLiveSocket(): void {
    if (
      !this.liveEnabled ||
      this.liveSocket !== null ||
      this.manifest === null ||
      (this.server?.liveSyncMax ?? this.server?.liveSync) !== 2
    )
      return
    const socket = openLiveSocket(this.manifest.season, this.isAdmin)
    this.liveSocket = socket
    socket.addEventListener('open', () => {
      if (this.liveSocket !== socket || this.manifest === null) return
      this.liveAttempts = 0
      this.liveProtocol =
        socket.protocol === LIVE_PROTOCOL_V2 ? 2 : socket.protocol === LIVE_PROTOCOL_V1 ? 1 : null
      if (this.liveProtocol === null) {
        socket.close(1002, 'live protocol not negotiated')
        return
      }
      if (this.liveProtocol === 1) return
      socket.send(
        JSON.stringify({
          type: 'state-vector',
          requestId: uuidV7(),
          revision: this.statusRevision,
          projections: [
            {
              resource: 'world-manifest',
              scope: 'world',
              version: this.manifest.version,
            },
            {
              resource: 'telemetry-alarms',
              scope: 'world',
              version: this.alarmsVersion,
            },
          ],
        }),
      )
      for (const subscriptionId of this.dashboardSubscriptions.keys())
        this.sendDashboardSubscription(subscriptionId)
    })
    socket.addEventListener('message', (message) => {
      if (this.liveSocket !== socket || this.liveProtocol !== 2 || typeof message.data !== 'string')
        return
      try {
        const event = this.liveSnapshots.push(JSON.parse(message.data))
        if (event !== null) this.applyLiveEvent(event)
      } catch {
        socket.close(1002, 'invalid live event')
      }
    })
    socket.addEventListener('error', () => socket.close())
    socket.addEventListener('close', () => {
      if (this.liveSocket !== socket) return
      this.liveSocket = null
      this.reconnectLive()
    })
  }

  private sendDashboardSubscription(subscriptionId: string): void {
    const subscription = this.dashboardSubscriptions.get(subscriptionId)
    if (
      subscription === undefined ||
      this.liveProtocol !== 2 ||
      this.liveSocket?.readyState !== WebSocket.OPEN
    )
      return
    this.liveSocket.send(
      JSON.stringify({
        type: 'dashboard-subscribe',
        requestId: uuidV7(),
        subscription: {
          subscriptionId,
          templateIds: subscription.templateIds,
          contributionsFrom: subscription.contributionsFrom,
          leaderboardLimit: 100,
        },
      }),
    )
  }

  private applyLiveStatusDelta(delta: StatusDelta): void {
    if (this.statusRevision !== delta.baseRevision) {
      this.liveSocket?.close(1011, 'status revision gap')
      return
    }
    const next = new Map(this.statuses)
    for (const status of delta.templates) next.set(status.templateId, status)
    for (const templateId of delta.removedTemplateIds) next.delete(templateId)
    this.statuses = next
    this.statusRevision = delta.revision
  }

  private applyLiveEvent(value: unknown): void {
    if (typeof value !== 'object' || value === null || !('type' in value)) return
    const event = value as Record<string, unknown>
    if (event.type === 'manifest-snapshot') {
      const manifest = event.manifest as Manifest | undefined
      if (manifest === undefined || manifest.season !== this.manifest?.season)
        throw new TypeError('invalid live manifest')
      this.manifest = manifest
      return
    }
    if (event.type === 'status-snapshot') {
      const status = event.status as { revision?: unknown; templates?: unknown }
      if (!Number.isSafeInteger(status?.revision) || !Array.isArray(status?.templates))
        throw new TypeError('invalid live status')
      this.statuses = new Map(
        (status.templates as TemplateStatus[]).map((entry) => [entry.templateId, entry]),
      )
      this.statusRevision = Number(status.revision)
      return
    }
    if (event.type === 'status-delta') {
      this.applyLiveStatusDelta(event.delta as StatusDelta)
      return
    }
    if (event.type === 'status-reconcile') {
      this.liveSocket?.close(1011, 'status snapshot required')
      return
    }
    if (event.type === 'alarms-snapshot') {
      const alarms = event.alarms as { version?: unknown; alarms?: unknown }
      if (typeof alarms?.version !== 'string' || !Array.isArray(alarms?.alarms))
        throw new TypeError('invalid live alarms')
      this.alarms = new Map((alarms.alarms as Alarm[]).map((entry) => [entry.templateId, entry]))
      this.alarmsVersion = alarms.version
      return
    }
    if (event.type === 'dashboard-snapshot' && typeof event.subscriptionId === 'string') {
      const subscription = this.dashboardSubscriptions.get(event.subscriptionId)
      if (subscription === undefined) return
      subscription.listener({
        contributions: event.contributions as ContributionsResponse,
        leaderboard: event.leaderboard as LeaderboardResponse,
      })
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
