import type {
  CanvasTileSummary,
  Manifest,
  ServerInfo,
  TemplateStatus,
  TileKey,
} from '@caelestis/shared'
import { ApiError, getCanvas, getManifest, getServer, getStatus, readToken } from '$lib/api/client'
import { buildTree, type TemplateTree } from '$lib/tree'

/**
 * The one shared session: which server we're connected to, its manifest, and the current status
 * and canvas observations everything on screen derives from. Pages layer their own reads (history,
 * leaderboard, timelapse) on top; this holds only what every page needs.
 */
class AppState {
  server = $state<ServerInfo | null>(null)
  manifest = $state<Manifest | null>(null)
  statuses = $state<ReadonlyMap<string, TemplateStatus>>(new Map())
  canvas = $state<ReadonlyMap<TileKey, CanvasTileSummary>>(new Map())
  loading = $state(false)
  /** A 401 or 403 opens the connect dialog. */
  authRequired = $state(false)
  error = $state<string | null>(null)

  tree = $derived.by<TemplateTree | null>(() =>
    this.manifest === null ? null : buildTree(this.manifest, this.statuses),
  )

  /** Bumped per load, so a slow older load can never overwrite a newer one's answers. */
  private generation = 0

  async load(): Promise<void> {
    const generation = ++this.generation
    this.loading = true
    this.error = null
    this.authRequired = false
    // Reset rather than serve stale: a reconnect must never show the previous connection's
    // manifest as if it were this server's — that reads as "my template is missing".
    this.manifest = null
    this.statuses = new Map()
    this.canvas = new Map()
    try {
      // `/server` is public and reports whether reads need a token. An open server must not show
      // the connect dialog.
      const server = await getServer()
      if (generation !== this.generation) return
      this.server = server
      if (server.auth === 'access_token' && readToken() === null) {
        this.authRequired = true
        return
      }
      const manifest = await getManifest()
      if (generation !== this.generation) return
      this.manifest = manifest
      // Status and canvas refine the picture; the tree already renders without them.
      const [status, canvas] = await Promise.allSettled([
        getStatus(manifest.season),
        getCanvas(manifest.season),
      ])
      if (generation !== this.generation) return
      if (status.status === 'fulfilled') {
        this.statuses = new Map(status.value.templates.map((t) => [t.templateId, t]))
      }
      if (canvas.status === 'fulfilled') {
        this.canvas = new Map(canvas.value.tiles.map((t) => [t.tile, t]))
      }
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

export const app = new AppState()
